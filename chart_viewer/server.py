"""
chart_viewer/server.py — FastAPI server for the chart viewer.

Run:
    cd chart_viewer
    uvicorn server:app --reload --port 8000

Env:
    MARKET_DATA_DIR   override default data dir (default: ../market_data/)
    NQ_DATA_DIR       backward-compat alias for MARKET_DATA_DIR
    NQ_DATA_START     ISO date string, e.g. "2023-01-01" (limits cache size)
    NQ_DATA_END       ISO date string
"""

import sys
if not (3, 10) <= sys.version_info < (3, 14):
    raise SystemExit(
        f"chart_viewer requires Python 3.10–3.13 (see pyproject.toml), "
        f"got {sys.version.split()[0]}"
    )

import os
import re
import json
import time
import uuid
import shutil
import asyncio
import subprocess
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse, FileResponse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import data_service

# User data (drawings, templates, layouts, config) — defaults to
# `chart_viewer/user_data/` for the dev workflow. In a packaged Electron
# build, main.js sets CHART_VIEWER_USER_DATA_DIR to a folder NEXT TO the
# .exe so user state survives across launches (the .exe extracts itself
# to a fresh temp dir each run; without this env override, every launch
# would lose layouts, branches, sim sessions, drawings, language choice,
# symbol-spec overrides — basically every persistent setting).
USER_DATA_DIR = os.environ.get('CHART_VIEWER_USER_DATA_DIR') \
    or os.path.join(HERE, 'user_data')
LAYOUTS_DIR   = os.path.join(USER_DATA_DIR, 'layouts')
LAYOUTS_INDEX = os.path.join(USER_DATA_DIR, 'layouts.json')   # master list + lastLayoutId
# Per-symbol contract spec overrides (tick size, point value, currency,
# commission, etc.). Built-in defaults live in static/symbol_specs.js;
# this file stores ONLY the keys the user has explicitly customised so a
# spec change in the built-ins propagates to all unmodified symbols.
SYMBOL_SPECS_PATH = os.path.join(USER_DATA_DIR, 'symbol_specs.json')

# Position-tool config (account size / default risk % / rounding mode /
# symbol override / uiLang). Now under user_data so it follows the same
# persistence rules as everything else (was previously at chart_viewer
# root which got wiped each portable .exe launch).
CONFIG_PATH = os.path.join(USER_DATA_DIR, 'config.json')
# Legacy location for one-time migration (pre-2026-05): config.json
# used to live at chart_viewer/config.json. If a user upgrades, the
# first /api/config call copies it into the new location.
_LEGACY_CONFIG_PATH = os.path.join(HERE, 'config.json')
DEFAULT_CONFIG = {
    'account_size': 10000,
    'default_risk_percent': 2.0,
    'rounding_mode': 'floor',     # 'floor' (recommended) | 'round'
    'symbol_override': None,       # null = auto-detect from chart
    # i18n-spec §5.1 — UI language. 'en' (default, English) or 'zh'
    # (Traditional Chinese). English-default chosen for shipping the
    # portable .exe more broadly; Chinese users toggle via Settings →
    # Language and the choice is persisted on first save (and cached
    # in localStorage for instant first-paint on subsequent launches).
    # Persisted via /api/config; partial-merge logic in
    # _validate_config_payload preserves untouched fields on each POST.
    'uiLang': 'en',
}
# Legacy (pre-layouts) locations — kept for one-time migration.
LEGACY_DRAWINGS_DIR = os.path.join(USER_DATA_DIR, 'drawings')
os.makedirs(LAYOUTS_DIR, exist_ok=True)

_SAFE_SYMBOL = re.compile(r'^[A-Za-z0-9_\-]{1,32}$')
_SAFE_LAYOUT_ID = re.compile(r'^[A-Za-z0-9_-]{1,64}$')


def _validate_symbol(symbol: str) -> str:
    if not symbol or not _SAFE_SYMBOL.match(symbol):
        raise HTTPException(400, f'invalid symbol: {symbol!r}')
    return symbol


def _validate_layout_id(layout_id: str) -> str:
    if not layout_id or not _SAFE_LAYOUT_ID.match(layout_id):
        raise HTTPException(400, f'invalid layout id: {layout_id!r}')
    return layout_id


def _layout_dir(layout_id: str) -> str:
    return os.path.join(LAYOUTS_DIR, _validate_layout_id(layout_id))


def _drawings_path(layout_id: str, symbol: str) -> str:
    _validate_symbol(symbol)
    d = os.path.join(_layout_dir(layout_id), 'drawings')
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f'{symbol}.json')


def _replay_path(layout_id: str, symbol: str) -> str:
    _validate_symbol(symbol)
    d = os.path.join(_layout_dir(layout_id), 'replay')
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f'{symbol}.json')


def _sim_path(layout_id: str, symbol: str) -> str:
    """SimEngine state per (layout × symbol). Symbol-level scope: each
    symbol gets its own balance / orders / positions / history because
    the user is exercising strategies on each instrument independently
    (NOT a unified account spread across symbols)."""
    _validate_symbol(symbol)
    d = os.path.join(_layout_dir(layout_id), 'sim')
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f'{symbol}.json')


def _branch_path(layout_id: str) -> str:
    """BranchSession state per layout. Branches span all symbols in a
    layout (a fork from K-bar X is a layout-level event), so this lives
    one level up from sim/<symbol>.json."""
    return os.path.join(_layout_dir(layout_id), 'branch_session.json')


def _layout_state_path(layout_id: str) -> str:
    return os.path.join(_layout_dir(layout_id), 'state.json')


def _read_json(path, default):
    if not os.path.isfile(path):
        return default
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def _write_json_atomic(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=0)
    os.replace(tmp, path)


def _load_layouts_index() -> dict:
    idx = _read_json(LAYOUTS_INDEX, {'layouts': [], 'lastLayoutId': None, 'openTabs': []})
    if 'layouts' not in idx: idx['layouts'] = []
    if 'lastLayoutId' not in idx: idx['lastLayoutId'] = None
    if 'openTabs' not in idx: idx['openTabs'] = []
    return idx


def _save_layouts_index(idx: dict):
    _write_json_atomic(LAYOUTS_INDEX, idx)


def _new_layout_id() -> str:
    # Short, URL-safe id. Collisions are astronomically unlikely but still guarded.
    return uuid.uuid4().hex[:12]


def _ensure_default_layout() -> str:
    """Make sure at least one layout exists and return its id. Migrates any
    legacy (pre-layouts) drawings from user_data/drawings/ into this layout."""
    idx = _load_layouts_index()
    if idx['layouts']:
        return idx['lastLayoutId'] or idx['layouts'][0]['id']
    # Create the default layout. Initial name follows the user's saved
    # uiLang so an English-mode first-launch gets "Default Layout"
    # instead of "預設版面". Mirrors the branch.kindMain spec §4.4
    # convention — auto-default names are i18n-controlled while
    # user-renamed names stay verbatim. Frontend's displayLayoutName
    # helper translates these canonical strings at render time so
    # toggling lang post-creation also flips the tab label.
    cfg = _load_config()
    default_name = 'Default Layout' if cfg.get('uiLang') == 'en' else '預設版面'
    now = int(time.time() * 1000)
    new_id = _new_layout_id()
    entry = {
        'id': new_id, 'name': default_name,
        'createdAt': now, 'updatedAt': now,
    }
    idx['layouts'].append(entry)
    idx['lastLayoutId'] = new_id
    _save_layouts_index(idx)
    os.makedirs(_layout_dir(new_id), exist_ok=True)
    # Migrate legacy drawings if any.
    if os.path.isdir(LEGACY_DRAWINGS_DIR):
        tgt = os.path.join(_layout_dir(new_id), 'drawings')
        os.makedirs(tgt, exist_ok=True)
        for fn in os.listdir(LEGACY_DRAWINGS_DIR):
            if fn.endswith('.json'):
                try:
                    shutil.copy2(os.path.join(LEGACY_DRAWINGS_DIR, fn),
                                 os.path.join(tgt, fn))
                except Exception:
                    pass
        # Don't delete legacy; leave as backup.
        print(f'[server] migrated legacy drawings → layout {new_id}')
    return new_id


def _find_data_dir() -> str:
    """Walk up from chart_viewer/ looking for the `market_data/` folder.
    Falls back to the default location next to chart_viewer/ if not found."""
    cur = HERE
    for _ in range(6):
        cur = os.path.dirname(cur)
        cand = os.path.join(cur, 'market_data')
        if os.path.isdir(cand):
            return cand
    return os.path.join(os.path.dirname(HERE), 'market_data')


DEFAULT_DATA_DIR = _find_data_dir()
STATIC_DIR = os.path.join(HERE, 'static')

# Resolved on startup; the onboarding endpoint needs to tell the user where
# to drop their CSV files.
ACTIVE_DATA_DIR: str = DEFAULT_DATA_DIR

# Idle watchdog — if nothing hits the server for this many seconds, the
# process self-terminates so orphaned uvicorns don't squat on port 8000.
# Electron pings /api/ping every ~2 min to keep the server alive while a
# window is open. Override via env for manual runs.
IDLE_TIMEOUT_SEC = int(os.environ.get('CHART_VIEWER_IDLE_TIMEOUT', '360'))
_LAST_ACTIVITY_TS: float = time.time()


async def _idle_watchdog():
    """Exit the process when no request has landed for IDLE_TIMEOUT_SEC.
    Setting CHART_VIEWER_IDLE_TIMEOUT=0 (or negative) disables the watchdog —
    used by start.bat for manually-launched browser sessions where the user
    is the one who decides when to Ctrl+C."""
    if IDLE_TIMEOUT_SEC <= 0:
        print("[server] idle watchdog disabled (CHART_VIEWER_IDLE_TIMEOUT=0)")
        return
    while True:
        await asyncio.sleep(60)
        idle = time.time() - _LAST_ACTIVITY_TS
        if idle > IDLE_TIMEOUT_SEC:
            print(f"[server] idle for {int(idle)}s (> {IDLE_TIMEOUT_SEC}s) — self-terminating")
            os._exit(0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # MARKET_DATA_DIR preferred, NQ_DATA_DIR kept for back-compat.
    global ACTIVE_DATA_DIR, _LAST_ACTIVITY_TS
    data_dir = (
        os.environ.get('MARKET_DATA_DIR')
        or os.environ.get('NQ_DATA_DIR')
        or DEFAULT_DATA_DIR
    )
    ACTIVE_DATA_DIR = data_dir
    os.makedirs(data_dir, exist_ok=True)
    start = os.environ.get('NQ_DATA_START') or None
    end = os.environ.get('NQ_DATA_END') or None
    data_service.init_cache(data_dir, start=start, end=end)
    _LAST_ACTIVITY_TS = time.time()
    watchdog = asyncio.create_task(_idle_watchdog())
    print(f"[server] Ready — http://localhost:8000 (idle timeout {IDLE_TIMEOUT_SEC}s)")
    try:
        yield
    finally:
        watchdog.cancel()
        print("[server] Shutting down.")


app = FastAPI(title="Chart Viewer", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _bump_activity(request: Request, call_next):
    """Any HTTP request resets the idle timer — the watchdog only kills the
    server when nothing's touched it for IDLE_TIMEOUT_SEC."""
    global _LAST_ACTIVITY_TS
    _LAST_ACTIVITY_TS = time.time()
    response = await call_next(request)
    # Force every static-file response to bypass client-side caches so the
    # Electron BrowserWindow always sees the latest JS/CSS on F5 — without
    # this, edits sometimes only show up after a full app restart.
    if request.url.path.startswith('/static'):
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
    return response


@app.get("/api/ping")
def api_ping():
    """Lightweight heartbeat — keeps the idle watchdog quiet while the
    Electron window is open even if the user isn't clicking anything."""
    return {"ok": True, "ts": int(_LAST_ACTIVITY_TS * 1000)}


@app.get("/api/symbols")
def api_symbols():
    """List all loaded symbol codes (alphabetical)."""
    return {"symbols": data_service.list_symbols()}


@app.get("/api/data_dir")
def api_data_dir():
    """Report the active market-data folder + whether it contains any files.
    The frontend uses this to render the first-run onboarding overlay."""
    has_files = False
    try:
        has_files = any(
            f.lower().endswith(('.txt', '.csv'))
            for f in os.listdir(ACTIVE_DATA_DIR)
        )
    except Exception:
        pass
    return {
        "dir": ACTIVE_DATA_DIR,
        "exists": os.path.isdir(ACTIVE_DATA_DIR),
        "has_files": has_files,
        "symbol_count": len(data_service.list_symbols()),
    }


@app.post("/api/data_dir/open")
def api_data_dir_open():
    """Open the market-data folder in the OS file manager (best-effort)."""
    os.makedirs(ACTIVE_DATA_DIR, exist_ok=True)
    try:
        if sys.platform == 'win32':
            os.startfile(ACTIVE_DATA_DIR)  # type: ignore[attr-defined]
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', ACTIVE_DATA_DIR])
        else:
            subprocess.Popen(['xdg-open', ACTIVE_DATA_DIR])
        return {"ok": True, "dir": ACTIVE_DATA_DIR}
    except Exception as e:
        raise HTTPException(500, f"could not open folder: {e}")


@app.post("/api/data_dir/reload")
def api_data_dir_reload():
    """Re-scan the market-data folder and reload symbols into memory. Called
    after the user drops new files in via the onboarding overlay."""
    start = os.environ.get('NQ_DATA_START') or None
    end = os.environ.get('NQ_DATA_END') or None
    try:
        data_service.init_cache(ACTIVE_DATA_DIR, start=start, end=end)
    except Exception as e:
        raise HTTPException(500, f"reload failed: {e}")
    return {"symbols": data_service.list_symbols()}


@app.post("/api/data_dir/rescan")
def api_data_dir_rescan():
    """Incremental rescan — only load symbols that aren't in memory yet, and
    drop any whose files have been removed. Used by the in-chart refresh
    button so the user can add symbols without restarting."""
    start = os.environ.get('NQ_DATA_START') or None
    end = os.environ.get('NQ_DATA_END') or None
    try:
        result = data_service.discover_and_load_new(
            ACTIVE_DATA_DIR, start=start, end=end)
    except Exception as e:
        raise HTTPException(500, f"rescan failed: {e}")
    return result


@app.get("/api/data_events")
def api_data_events():
    """Drain pending cache-invalidation events. The frontend calls this
    once at boot — any 'source_changed' entry triggers a Toast so the
    user sees that their .txt files were edited and the app silently
    re-parsed. The list is consumed (cleared) on read so a page reload
    won't re-Toast the same change."""
    return {'events': data_service.consume_cache_events()}


@app.get("/api/range")
def api_range(
    symbol: str | None = Query(None, description="Symbol code, e.g. 'NQ1'. Default = first loaded."),
):
    try:
        return data_service.get_data_range(symbol=symbol)
    except KeyError as e:
        raise HTTPException(404, str(e))


@app.get("/api/ohlcv")
def api_ohlcv(
    tf: str = Query('15', description="Timeframe: '15' or '15min' = 15 min, '1h', '1d', '1w', '1m' (month)"),
    symbol: str | None = Query(None, description="Symbol code, e.g. 'NQ1'. Default = first loaded."),
    start: str | None = Query(None, description="ISO date YYYY-MM-DD"),
    end: str | None = Query(None, description="ISO date YYYY-MM-DD"),
    before: int | None = Query(None, description="Return bars with ts < this (ms)"),
    limit: int | None = Query(None, description="Return at most the latest N bars"),
):
    try:
        return data_service.get_ohlcv(
            tf=tf, symbol=symbol, start=start, end=end, before=before, limit=limit)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


# --- Layouts ----------------------------------------------------------
@app.get('/api/layouts')
def api_layouts_list():
    """List all layouts + which one was last opened. Creates a default layout
    on first call so the app always has something to show."""
    _ensure_default_layout()
    return _load_layouts_index()


@app.post('/api/layouts')
async def api_layouts_create(request: Request):
    """Create a new layout. Body: { name }. Returns the new layout entry."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, 'body must be valid JSON')
    name = (body or {}).get('name', '').strip() or '未命名版面'
    now = int(time.time() * 1000)
    new_id = _new_layout_id()
    entry = {'id': new_id, 'name': name, 'createdAt': now, 'updatedAt': now}
    idx = _load_layouts_index()
    idx['layouts'].append(entry)
    idx['lastLayoutId'] = new_id
    _save_layouts_index(idx)
    os.makedirs(_layout_dir(new_id), exist_ok=True)
    return entry


@app.patch('/api/layouts/{layout_id}')
async def api_layouts_patch(layout_id: str, request: Request):
    """Rename / touch / set as last-opened. Body: { name?, setLast? }."""
    _validate_layout_id(layout_id)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, 'body must be valid JSON')
    idx = _load_layouts_index()
    target = next((l for l in idx['layouts'] if l['id'] == layout_id), None)
    if not target:
        raise HTTPException(404, f'layout not found: {layout_id}')
    if isinstance(body.get('name'), str) and body['name'].strip():
        target['name'] = body['name'].strip()
    target['updatedAt'] = int(time.time() * 1000)
    if body.get('setLast'):
        idx['lastLayoutId'] = layout_id
    _save_layouts_index(idx)
    return target


@app.delete('/api/layouts/{layout_id}')
def api_layouts_delete(layout_id: str):
    """Remove a layout and all its data (drawings, replay, state)."""
    _validate_layout_id(layout_id)
    idx = _load_layouts_index()
    before = len(idx['layouts'])
    idx['layouts'] = [l for l in idx['layouts'] if l['id'] != layout_id]
    if before == len(idx['layouts']):
        raise HTTPException(404, f'layout not found: {layout_id}')
    # If deleted layout was current, promote the first remaining (or None).
    if idx.get('lastLayoutId') == layout_id:
        idx['lastLayoutId'] = idx['layouts'][0]['id'] if idx['layouts'] else None
    _save_layouts_index(idx)
    ldir = _layout_dir(layout_id)
    if os.path.isdir(ldir):
        shutil.rmtree(ldir, ignore_errors=True)
    return {'deleted': layout_id, 'remaining': len(idx['layouts'])}


@app.put('/api/layouts/tabs')
async def api_layouts_tabs(request: Request):
    """Replace the list of layouts currently shown as tabs.
    Body: { openTabs: [layoutId, ...], active?: layoutId }
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, 'body must be valid JSON')
    open_tabs = body.get('openTabs') if isinstance(body, dict) else None
    if not isinstance(open_tabs, list):
        raise HTTPException(400, 'body.openTabs must be an array')
    idx = _load_layouts_index()
    valid_ids = {l['id'] for l in idx['layouts']}
    idx['openTabs'] = [t for t in open_tabs if isinstance(t, str) and t in valid_ids]
    active = body.get('active')
    if isinstance(active, str) and active in valid_ids:
        idx['lastLayoutId'] = active
    _save_layouts_index(idx)
    return {'openTabs': idx['openTabs'], 'lastLayoutId': idx['lastLayoutId']}


@app.get('/api/layouts/{layout_id}/state')
def api_layout_state_get(layout_id: str):
    _validate_layout_id(layout_id)
    return _read_json(_layout_state_path(layout_id), {})


@app.put('/api/layouts/{layout_id}/state')
async def api_layout_state_put(layout_id: str, request: Request):
    _validate_layout_id(layout_id)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, 'body must be valid JSON')
    if not isinstance(body, dict):
        raise HTTPException(400, 'body must be a JSON object')
    _write_json_atomic(_layout_state_path(layout_id), body)
    # Also mark the layout as most-recently-used so "open last" works.
    idx = _load_layouts_index()
    for l in idx['layouts']:
        if l['id'] == layout_id:
            l['updatedAt'] = int(time.time() * 1000)
            break
    idx['lastLayoutId'] = layout_id
    _save_layouts_index(idx)
    return {'ok': True}


# --- Drawings (per layout × symbol) ----------------------------------
@app.get("/api/drawings")
def api_drawings_get(layout: str = Query(..., description="Layout id"),
                     symbol: str = Query(..., description="Symbol code, e.g. 'NQ1'")):
    """Read the saved drawings for a layout + symbol. Returns [] if none exist."""
    path = _drawings_path(layout, symbol)
    return _read_json(path, [])


@app.put("/api/drawings")
async def api_drawings_put(request: Request,
                           layout: str = Query(..., description="Layout id"),
                           symbol: str = Query(..., description="Symbol code, e.g. 'NQ1'")):
    """Replace the saved drawings for a layout + symbol. Body: JSON array."""
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, 'body must be valid JSON')
    if not isinstance(payload, list):
        raise HTTPException(400, 'body must be a JSON array')
    path = _drawings_path(layout, symbol)
    _write_json_atomic(path, payload)
    return {"saved": len(payload), "layout": layout, "symbol": symbol}


# --- Drawing templates (GLOBAL — shared across all layouts) ---------
# Templates are style presets (color / thickness / text settings) the user
# saves from the settings panel and re-applies to other drawings. They're
# intentionally NOT scoped by layout or symbol — a template built on NQ1
# should be available to reuse on TXF1 in a different layout too.
TEMPLATES_PATH = os.path.join(USER_DATA_DIR, 'templates.json')


@app.get('/api/templates')
def api_templates_get():
    return _read_json(TEMPLATES_PATH, {})


@app.put('/api/templates')
async def api_templates_put(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, 'body must be valid JSON')
    if not isinstance(body, dict):
        raise HTTPException(400, 'body must be a JSON object keyed by bucket')
    _write_json_atomic(TEMPLATES_PATH, body)
    return {'ok': True}


# --- Position-tool config (account size / risk % / rounding mode) ----
def _load_config() -> dict:
    """Read config.json, merging onto DEFAULT_CONFIG so newly-added fields
    don't break older saved files. One-time legacy migration: if the old
    chart_viewer/config.json exists but the new user_data/config.json
    doesn't, move the file into the new location so the user's settings
    don't reset after upgrading to the env-var-aware layout."""
    if (not os.path.isfile(CONFIG_PATH)
            and CONFIG_PATH != _LEGACY_CONFIG_PATH
            and os.path.isfile(_LEGACY_CONFIG_PATH)):
        try:
            os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
            with open(_LEGACY_CONFIG_PATH, 'rb') as src, open(CONFIG_PATH, 'wb') as dst:
                dst.write(src.read())
            print(f"[server] migrated legacy config.json from {_LEGACY_CONFIG_PATH} → {CONFIG_PATH}")
        except Exception as e:
            print(f"[server] config migration failed: {e}")
    raw = _read_json(CONFIG_PATH, {}) or {}
    merged = {**DEFAULT_CONFIG}
    for k, v in raw.items():
        if k in DEFAULT_CONFIG:
            merged[k] = v
    return merged


def _validate_config_payload(body) -> dict:
    if not isinstance(body, dict):
        raise HTTPException(400, 'body must be a JSON object')
    out = {**_load_config()}
    if 'account_size' in body:
        try:
            v = float(body['account_size'])
        except (TypeError, ValueError):
            raise HTTPException(400, 'account_size must be a number')
        if v < 0:
            raise HTTPException(400, 'account_size must be non-negative')
        out['account_size'] = v
    if 'default_risk_percent' in body:
        try:
            v = float(body['default_risk_percent'])
        except (TypeError, ValueError):
            raise HTTPException(400, 'default_risk_percent must be a number')
        if v < 0 or v > 100:
            raise HTTPException(400, 'default_risk_percent must be in [0, 100]')
        out['default_risk_percent'] = v
    if 'rounding_mode' in body:
        v = body['rounding_mode']
        if v not in ('floor', 'round'):
            raise HTTPException(400, "rounding_mode must be 'floor' or 'round'")
        out['rounding_mode'] = v
    if 'symbol_override' in body:
        v = body['symbol_override']
        if v is not None and (not isinstance(v, str) or not _SAFE_SYMBOL.match(v)):
            raise HTTPException(400, 'symbol_override must be null or a safe symbol string')
        out['symbol_override'] = v
    # i18n-spec §5.1 — UI language. Silently drop invalid values (no 400)
    # so a typo from a future client doesn't kill the whole save.
    if 'uiLang' in body:
        v = body.get('uiLang')
        if v in ('zh', 'en'):
            out['uiLang'] = v
    return out


@app.get('/api/config')
def api_config_get():
    """Return position-tool config, creating config.json with defaults on
    first call so the client can rely on it always existing."""
    if not os.path.isfile(CONFIG_PATH):
        _write_json_atomic(CONFIG_PATH, DEFAULT_CONFIG)
    return _load_config()


@app.post('/api/config')
async def api_config_post(request: Request):
    """Validate + persist position-tool config. Unknown keys are silently
    dropped; missing keys keep their previous values."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, 'body must be valid JSON')
    new_cfg = _validate_config_payload(body)
    _write_json_atomic(CONFIG_PATH, new_cfg)
    return new_cfg


# --- Symbol contract-spec overrides ----------------------------------
# Per-symbol overrides for tick size, point value, currency, commission,
# etc. Built-in defaults live in static/symbol_specs.js; this storage
# layers on top so unmodified symbols continue to track upstream
# defaults if the built-ins are ever updated.

# Field allowlist + per-field validators. Anything not in here is
# silently dropped (mirrors _validate_config_payload's policy).
_SPEC_NUMERIC_FIELDS = (
    'pointValue', 'lotSize', 'qtyStep', 'tickSize',
    'spread', 'slippageTicks', 'commissionPerSide',
)
_SPEC_ALLOWED_CURRENCIES = {'USD', 'NTD', 'EUR', 'JPY', 'GBP', 'HKD', 'CNY', 'AUD', 'CAD'}
_SPEC_ALLOWED_KINDS = {'future', 'spot'}


def _validate_spec_payload(body: dict) -> dict:
    """Filter + coerce a spec override. Returns a clean dict containing
    only valid fields. Invalid types/values are silently dropped (the
    user's UI prevents most of these; this is a back-stop)."""
    if not isinstance(body, dict):
        return {}
    out: dict = {}
    for f in _SPEC_NUMERIC_FIELDS:
        if f in body:
            try:
                v = float(body[f])
            except (TypeError, ValueError):
                continue
            # Negative values would invert P&L math everywhere; reject
            # silently. tickSize / pointValue == 0 would div-by-zero
            # downstream, also reject.
            if v < 0:
                continue
            if f in ('tickSize', 'pointValue', 'lotSize') and v <= 0:
                continue
            out[f] = v
    if 'currency' in body:
        v = str(body.get('currency') or '').upper()
        if v in _SPEC_ALLOWED_CURRENCIES:
            out['currency'] = v
    if 'kind' in body:
        v = str(body.get('kind') or '').lower()
        if v in _SPEC_ALLOWED_KINDS:
            out['kind'] = v
    if 'displayName' in body:
        v = str(body.get('displayName') or '').strip()
        if v:
            out['displayName'] = v[:80]   # cap length to avoid abuse
    return out


def _load_symbol_specs() -> dict:
    """Read user_data/symbol_specs.json. Missing file → {}."""
    return _read_json(SYMBOL_SPECS_PATH, {}) or {}


@app.get('/api/symbol-specs')
def api_symbol_specs_get():
    """Return the user's per-symbol overrides. Built-in defaults are
    NOT included — the frontend already has them via symbol_specs.js
    and the merge happens client-side."""
    return {'overrides': _load_symbol_specs()}


@app.put('/api/symbol-specs/{symbol}')
async def api_symbol_specs_put(symbol: str, request: Request):
    """Save (or replace) the override for one symbol. Body is a partial
    spec dict; only allowlisted fields land in the saved JSON."""
    sym = (symbol or '').strip().upper()
    if not sym or len(sym) > 16 or not all(c.isalnum() or c == '_' for c in sym):
        raise HTTPException(400, 'invalid symbol code')
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, 'body must be valid JSON')
    cleaned = _validate_spec_payload(body)
    if not cleaned:
        raise HTTPException(400, 'no valid spec fields in body')
    specs = _load_symbol_specs()
    specs[sym] = cleaned
    _write_json_atomic(SYMBOL_SPECS_PATH, specs)
    return {'symbol': sym, 'spec': cleaned, 'overrides': specs}


@app.delete('/api/symbol-specs/{symbol}')
def api_symbol_specs_delete(symbol: str):
    """Drop the user override for a symbol → frontend reverts to the
    built-in default. Idempotent — silent no-op if no override existed."""
    sym = (symbol or '').strip().upper()
    if not sym:
        raise HTTPException(400, 'invalid symbol code')
    specs = _load_symbol_specs()
    if sym in specs:
        del specs[sym]
        _write_json_atomic(SYMBOL_SPECS_PATH, specs)
    return {'symbol': sym, 'overrides': specs}


# --- Replay state (per layout × symbol) ------------------------------
@app.get("/api/replay")
def api_replay_get(layout: str = Query(...),
                   symbol: str = Query(...)):
    path = _replay_path(layout, symbol)
    return _read_json(path, None)


@app.put("/api/replay")
async def api_replay_put(request: Request,
                         layout: str = Query(...),
                         symbol: str = Query(...)):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, 'body must be valid JSON')
    path = _replay_path(layout, symbol)
    _write_json_atomic(path, body)
    return {'ok': True}


@app.delete("/api/replay")
def api_replay_delete(layout: str = Query(...),
                      symbol: str = Query(...)):
    path = _replay_path(layout, symbol)
    if os.path.isfile(path):
        try: os.remove(path)
        except Exception: pass
    return {'ok': True}


# --- SimEngine state (per layout × symbol) ---------------------------
# Body schema is opaque to the server — it's whatever
# SimEngine.serialize() produces (version 1: balance, orders, positions,
# history). Server only validates that it's a JSON object with a
# numeric `version` field. Migration of older saved files is the
# client's responsibility (sim_engine.restore returns false on
# version mismatch).
@app.get("/api/sim")
def api_sim_get(layout: str = Query(...),
                symbol: str = Query(...)):
    path = _sim_path(layout, symbol)
    return _read_json(path, None)


@app.put("/api/sim")
async def api_sim_put(request: Request,
                      layout: str = Query(...),
                      symbol: str = Query(...)):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, 'body must be valid JSON')
    if not isinstance(body, dict):
        raise HTTPException(400, 'body must be a JSON object')
    if not isinstance(body.get('version'), int):
        raise HTTPException(400, 'body.version (int) is required')
    path = _sim_path(layout, symbol)
    _write_json_atomic(path, body)
    return {'ok': True}


@app.delete("/api/sim")
def api_sim_delete(layout: str = Query(...),
                   symbol: str = Query(...)):
    path = _sim_path(layout, symbol)
    if os.path.isfile(path):
        try: os.remove(path)
        except Exception: pass
    return {'ok': True}


# --- BranchSession state (per layout, spans all symbols) -------------
# A branch is a layout-level concept (forks from a K-bar timestamp,
# affects how SimEngine trades are attributed). Single JSON file at
# the layout root: `user_data/layouts/<id>/branch_session.json`.
@app.get("/api/branch")
def api_branch_get(layout: str = Query(...)):
    path = _branch_path(layout)
    return _read_json(path, None)


@app.put("/api/branch")
async def api_branch_put(request: Request,
                         layout: str = Query(...)):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, 'body must be valid JSON')
    if not isinstance(body, dict):
        raise HTTPException(400, 'body must be a JSON object')
    if not isinstance(body.get('version'), int):
        raise HTTPException(400, 'body.version (int) is required')
    # Make sure the layout dir exists before writing — branch_session
    # lives at the layout root, so we don't get the makedirs side-
    # effect from `_sim_path` / `_drawings_path`.
    os.makedirs(_layout_dir(layout), exist_ok=True)
    path = _branch_path(layout)
    _write_json_atomic(path, body)
    return {'ok': True}


@app.delete("/api/branch")
def api_branch_delete(layout: str = Query(...)):
    path = _branch_path(layout)
    if os.path.isfile(path):
        try: os.remove(path)
        except Exception: pass
    return {'ok': True}


if os.path.isdir(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR, html=True), name="static")


@app.get("/")
def root():
    # Redirect (NOT FileResponse) so the browser's base URL becomes
    # /static/, which is what the relative <link href="style.css"> /
    # <script src="*.js"> tags in index.html expect. Serving the file
    # directly at "/" worked but broke every relative asset path.
    #
    # Unconditional — the previous "if isfile(idx)" guard with a JSON
    # fallback was the original orphan-masking bug: an orphan uvicorn
    # whose STATIC_DIR pointed to a deleted TEMP dir would silently flip
    # to JSON mode and Electron would reuse it. With unconditional
    # redirect, a stale orphan now routes to /static/index.html which
    # 404s loudly — caught by the health check in main.js anyway.
    return RedirectResponse(url="/static/index.html")


if __name__ == '__main__':
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
