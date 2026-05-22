"""
data_service.py — Historical OHLCV loader & cache for chart viewer.

Multi-symbol: scans the data dir for *.txt files; each file's basename
(minus extension) is treated as the symbol code. E.g. `NQ1.txt` → "NQ1".

Loads 1-min OHLCV per symbol at startup (all symbols held in memory so
switching is instant); supports resampling to arbitrary timeframes.
"""

import os
import glob
import time
import pickle
import threading
import pandas as pd
import numpy as np
from concurrent.futures import ThreadPoolExecutor, as_completed
from zoneinfo import ZoneInfo

ET_TZ = ZoneInfo("US/Eastern")
UTC_TZ = ZoneInfo("UTC")

# Per-source-file pickle cache. Keyed by (mtime, size) of the source so
# we can skip the expensive pandas.read_csv → tz_localize round-trip on
# subsequent boots. Pickled DataFrames load 20-50× faster than parsing
# CSV from scratch (typical 543K-bar NQ1.txt: ~3s parse vs ~80ms unpickle).
# The cache lives next to the source, named "<file>.cache.pkl".
# data_service._scan_data_files filters these out so they're never
# treated as symbols.
_CACHE_SUFFIX = '.cache.pkl'
_CACHE_VERSION = 2   # bump when load_1min_file's output schema changes
                     # to invalidate stale caches across upgrades.
# Cache files live in a subfolder so the user's market_data/ root stays
# clean (just their own .txt / .csv plus the bundled __README / __EXAMPLE
# guide files). Folder is auto-created on first cache write. Underscore
# prefix matches the convention for "non-data" entries in market_data/.
_CACHE_DIRNAME = '_cache'


def _cache_path_for(file_path: str) -> str:
    """Return the cache path for a source file. Lives under
    `<source dir>/_cache/<filename>.cache.pkl`. The _cache subfolder is
    NOT scanned by _scan_data_files (glob is non-recursive)."""
    src_dir = os.path.dirname(file_path)
    return os.path.join(src_dir, _CACHE_DIRNAME,
                        os.path.basename(file_path) + _CACHE_SUFFIX)


def _migrate_legacy_cache(file_path: str, new_cache_path: str) -> None:
    """One-time migration: move a pre-2026-05 same-folder cache file to
    the new _cache/ subfolder location. Idempotent — silent if there's
    no legacy file or the new path already exists."""
    legacy = file_path + _CACHE_SUFFIX     # the old "next to source" path
    if os.path.isfile(new_cache_path) or not os.path.isfile(legacy):
        return
    try:
        os.makedirs(os.path.dirname(new_cache_path), exist_ok=True)
        os.replace(legacy, new_cache_path)   # atomic rename across same drive
        print(f"[data_service] migrated cache: {os.path.basename(legacy)}"
              f" → {_CACHE_DIRNAME}/")
    except OSError as e:
        # Migration failure is non-fatal — load_1min_file's own miss
        # path will simply re-parse and write to the new location, then
        # the legacy file becomes orphaned (user can delete manually).
        print(f"[data_service] cache migration failed for"
              f" {os.path.basename(file_path)}: {e}")

# Cache invalidation events recorded during load_1min_file runs.
# Drained via consume_cache_events() (called by /api/data_events). The
# frontend turns these into Toasts at boot so the user knows when their
# .txt source files have been edited / replaced and the app has
# transparently re-parsed. Thread-safe because init_cache runs file
# loads in a ThreadPoolExecutor.
_cache_events_lock = threading.Lock()
_cache_events: list[dict] = []


def _record_cache_event(file_path: str, kind: str, **details) -> None:
    """Append a cache-event entry. `kind` is one of:
       - 'source_changed'  : cache exists but source mtime/size changed
       - 'version_mismatch': cache from older _CACHE_VERSION
       - 'cache_corrupt'   : pickle.load raised
    User-facing Toasts only fire for 'source_changed' (the others are
    upgrade/dev-side artefacts the user shouldn't care about)."""
    sym = os.path.splitext(os.path.basename(file_path))[0]
    entry = {'symbol': sym, 'kind': kind, **details}
    with _cache_events_lock:
        _cache_events.append(entry)


def consume_cache_events() -> list[dict]:
    """Return + clear the recorded events. Idempotent re-fetch returns
    [] (cleared on first call) so a page reload won't re-Toast the same
    change."""
    with _cache_events_lock:
        events = list(_cache_events)
        _cache_events.clear()
    return events

_TF_MAP = {
    # Backward-compat / explicit aliases. Plain digits like "15" or "5" are
    # handled by the regex fallback (no suffix = minutes).
    '1d': '1D', '1D': '1D',
    '1w': '1W', '1W': '1W', '2w': '2W',
    '1T': '1min', '5T': '5min', '15T': '15min', '30T': '30min',
    '1H': '1h', '4H': '4h',
    '1min': '1min', '5min': '5min', '15min': '15min', '30min': '30min',
}

# { 'NQ1': DataFrame, 'TXF1': DataFrame, ... }
_frames: dict[str, pd.DataFrame] = {}
# Default symbol to use when caller doesn't specify one. Set to the first
# symbol discovered on init (sorted alphabetically for stable order).
_default_symbol: str | None = None


import re
# Supports: "15" (plain = minutes), "15m" (month), "1h", "1d", "1w", "1min" (alias)
_TF_PATTERN = re.compile(r'^(\d+)([a-zA-Z]*)$')


def _normalize_tf(tf: str) -> str:
    """Normalize TF to pandas resample freq.

    Convention (TradingView-style):
        "15"   / "15min"   → 15 minutes
        "15m"              → 15 months
        "1h"               → 1 hour
        "1d"               → 1 day
        "1w"               → 1 week
    """
    if tf in _TF_MAP:
        return _TF_MAP[tf]
    m = _TF_PATTERN.match(tf)
    if m:
        n, unit = m.group(1), m.group(2).lower()
        if not unit or unit == 'min':
            return f'{n}min'
        return {
            'm': f'{n}MS',      # m = month (month-start)
            'h': f'{n}h',
            'd': f'{n}D',
            'w': f'{n}W',
        }.get(unit, tf)
    return tf


def _parse_csv_to_df(file_path: str) -> pd.DataFrame:
    """Slow path: pd.read_csv + ET-tz localize + UTC convert. Pulled out
    of load_1min_file so the cache layer below can call this only on
    miss / invalidation."""
    df = pd.read_csv(file_path, dtype={'TotalVolume': np.int64})
    dt_str = df['Date'].astype(str) + ' ' + df['Time'].astype(str)
    dt_naive = pd.to_datetime(dt_str, format='%Y/%m/%d %H:%M:%S')
    dt_et = dt_naive.dt.tz_localize(
        ET_TZ, ambiguous='infer', nonexistent='shift_forward'
    )
    dt_utc = dt_et.dt.tz_convert(UTC_TZ)
    df.index = dt_utc
    df.index.name = 'datetime'
    df = df.rename(columns={
        'Open': 'open', 'High': 'high', 'Low': 'low',
        'Close': 'close', 'TotalVolume': 'volume',
    })
    df = df[['open', 'high', 'low', 'close', 'volume']]
    df = df.sort_index()
    df = df[~df.index.duplicated(keep='last')]
    return df


def load_1min_file(file_path: str) -> pd.DataFrame:
    """Read a 1-min OHLCV CSV/TXT into a DataFrame, using a side-by-side
    pickle cache to skip CSV parsing on warm boots.

    Cache invalidation: source file's (mtime, size) AND a version int
    are stored in the pickle. Any mismatch → reparse + rewrite cache.
    Corrupt cache (unreadable pickle) is also treated as miss; we never
    block on a stale cache."""
    cache_path = _cache_path_for(file_path)
    _migrate_legacy_cache(file_path, cache_path)
    try:
        src_stat = os.stat(file_path)
    except OSError:
        # Source gone — let pd.read_csv raise the canonical error.
        return _parse_csv_to_df(file_path)

    if os.path.isfile(cache_path):
        try:
            with open(cache_path, 'rb') as f:
                cached = pickle.load(f)
            if (isinstance(cached, dict)
                    and cached.get('version') == _CACHE_VERSION
                    and cached.get('mtime') == src_stat.st_mtime
                    and cached.get('size') == src_stat.st_size
                    and isinstance(cached.get('df'), pd.DataFrame)):
                return cached['df']
            # Cache exists but invalid — figure out why so we can record
            # the right event kind. source_changed = user edited the .txt
            # since the last cache write; version_mismatch = upgraded the
            # parser. Either way we'll re-parse below.
            if isinstance(cached, dict) and cached.get('version') != _CACHE_VERSION:
                _record_cache_event(file_path, 'version_mismatch',
                                    cached_version=cached.get('version'),
                                    current_version=_CACHE_VERSION)
            elif isinstance(cached, dict) and (
                    cached.get('mtime') != src_stat.st_mtime
                    or cached.get('size') != src_stat.st_size):
                _record_cache_event(file_path, 'source_changed',
                                    old_mtime=cached.get('mtime'),
                                    new_mtime=src_stat.st_mtime,
                                    old_size=cached.get('size'),
                                    new_size=src_stat.st_size)
        except Exception as e:
            print(f"[data_service] cache read failed for {os.path.basename(file_path)}"
                  f" — reparsing ({e})")
            _record_cache_event(file_path, 'cache_corrupt', error=str(e))

    # Miss / invalid / corrupt → parse + rewrite cache.
    df = _parse_csv_to_df(file_path)
    try:
        # Ensure _cache/ subfolder exists. exist_ok handles the
        # multi-thread race where multiple workers all try to create it.
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        with open(cache_path, 'wb') as f:
            pickle.dump({
                'version': _CACHE_VERSION,
                'mtime':   src_stat.st_mtime,
                'size':    src_stat.st_size,
                'df':      df,
            }, f, protocol=pickle.HIGHEST_PROTOCOL)
    except Exception as e:
        # Cache write failure is non-fatal — we still have the parsed df
        # in memory. User's data folder might be read-only (rare) or
        # disk full; warn but continue.
        print(f"[data_service] cache write failed for {os.path.basename(file_path)}: {e}")
    return df


def resample(df: pd.DataFrame, tf: str) -> pd.DataFrame:
    """Resample 1-min OHLCV to given TF.

    For day/week/month TFs the index is first converted to US/Eastern so that
    bin boundaries align to ET calendar day (matches MultiCharts and the
    US futures trading convention). Intraday TFs resample in UTC (naturally
    aligned on hour/minute marks).
    """
    tf = _normalize_tf(tf)
    if tf in ('1min', '1T'):
        return df

    agg_cfg = {
        'open': 'first', 'high': 'max', 'low': 'min',
        'close': 'last', 'volume': 'sum',
    }

    # Upper-letter unit part tells us day/week/month
    unit = ''.join(ch for ch in tf if ch.isalpha())
    needs_et = unit in ('D', 'W', 'MS', 'ME')

    if needs_et:
        src = df.tz_convert(ET_TZ)
        out = src.resample(tf, label='left', closed='left').agg(agg_cfg)
        out.index = out.index.tz_convert(UTC_TZ)
    else:
        out = df.resample(tf, label='left', closed='left').agg(agg_cfg)

    out = out.dropna(subset=['open'])
    out['volume'] = out['volume'].astype(np.int64)
    return out


# Worker-thread count for the parallel CSV loader. 8 saturates SSD I/O
# without spawning a runaway pool when 20+ symbols sit in market_data/.
# Capped to len(files) at the call site so we don't oversubscribe.
_LOAD_WORKERS = 8


def _load_and_slice(path: str, start: str | None, end: str | None) -> tuple[str, pd.DataFrame]:
    """Load + date-filter one CSV. Runs in a worker thread; safe because
    pandas.read_csv + date arithmetic release the GIL during their C-level
    work, and the only mutation here is to a local DataFrame the caller
    will assign into the dict from the main thread."""
    symbol = os.path.splitext(os.path.basename(path))[0]
    df = load_1min_file(path)
    if start:
        df = df[df.index >= pd.Timestamp(start, tz='UTC')]
    if end:
        df = df[df.index <= pd.Timestamp(end, tz='UTC')]
    return symbol, df


def _scan_data_files(data_dir: str) -> list[str]:
    """Return sorted list of *.txt / *.csv files in data_dir, EXCLUDING:
      - filename starting with '_' (reserved for non-symbol files like
        the bundled __README.txt and __EXAMPLE.csv that Electron drops
        into market_data/ on first launch — see chart_viewer_app/main.js
        `dropDataFolderGuide`)
      - filename ending in .cache.pkl (per-symbol pickle cache written
        next to the source by load_1min_file; not a data file itself)
    """
    patterns = [os.path.join(data_dir, '*.txt'), os.path.join(data_dir, '*.csv')]
    files = []
    for p in patterns:
        files.extend(glob.glob(p))
    files = [
        f for f in files
        if not os.path.basename(f).startswith('_')
        and not f.endswith(_CACHE_SUFFIX)
    ]
    return sorted(files)


def init_cache(data_dir: str, start: str | None = None, end: str | None = None):
    """Scan data_dir for *.txt / *.csv files, one per symbol. Each file's
    basename (minus extension) is the symbol code. All symbols are loaded
    into memory so switching is a dict lookup. Loads are run in parallel
    via a ThreadPoolExecutor — pandas.read_csv + tz conversion release
    the GIL, so threading scales near-linearly with disk concurrency."""
    global _frames, _default_symbol
    _frames = {}
    files = _scan_data_files(data_dir)
    if not files:
        # Empty data dir is a valid first-run state — the frontend will show an
        # onboarding overlay pointing the user to drop files in here.
        print(f"[data_service] No *.txt / *.csv files in {data_dir} — starting with no symbols")
        return

    # _scan_data_files returns sorted — needed for the deterministic
    # default-symbol pick below. Log order may still interleave (workers
    # finish in different order); _frames assignment is main-thread.
    workers = min(_LOAD_WORKERS, len(files))
    sliceTag = ''
    if start: sliceTag += f' start={start}'
    if end:   sliceTag += f' end={end}'
    print(f"[data_service] Loading {len(files)} symbols across {workers} threads"
          f"{f' ({sliceTag.strip()})' if sliceTag else ''}...")

    t0 = time.monotonic()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_load_and_slice, f, start, end): f for f in files}
        for fut in as_completed(futures):
            f = futures[fut]
            try:
                symbol, df = fut.result()
            except Exception as e:
                print(f"[data_service]   {os.path.basename(f)}: FAILED — {e}")
                continue
            if df.empty:
                print(f"[data_service]   {symbol}: 0 bars after date slice — skipped")
                continue
            _frames[symbol] = df
            print(f"[data_service]   {symbol}: {len(df):,} 1-min bars  "
                  f"({df.index.min()} → {df.index.max()})")

    elapsed = time.monotonic() - t0
    if not _frames:
        print(f"[data_service] All files in {data_dir} were empty after date slicing — starting with no symbols")
        return
    _default_symbol = sorted(_frames.keys())[0]
    print(f"[data_service] Loaded {len(_frames)} symbols in {elapsed:.2f}s: "
          f"{sorted(_frames.keys())} (default: {_default_symbol})")


def list_symbols() -> list[str]:
    """Return the list of available symbol codes (alphabetical)."""
    return sorted(_frames.keys())


def discover_and_load_new(
    data_dir: str, start: str | None = None, end: str | None = None,
) -> dict:
    """Scan data_dir for symbols not yet loaded and append them to the cache
    without re-reading anything that's already in memory. Returns metadata
    about what was added / removed. New symbols are loaded in parallel
    (same threadpool pattern as init_cache)."""
    global _default_symbol
    if not os.path.isdir(data_dir):
        return {'added': [], 'removed': [], 'symbols': sorted(_frames.keys())}
    found_files = _scan_data_files(data_dir)
    disk_symbols = {os.path.splitext(os.path.basename(f))[0]: f for f in found_files}
    new_paths = [path for sym, path in sorted(disk_symbols.items()) if sym not in _frames]
    added: list[str] = []
    if new_paths:
        workers = min(_LOAD_WORKERS, len(new_paths))
        print(f"[data_service] (rescan) Loading {len(new_paths)} new symbols across {workers} threads...")
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(_load_and_slice, p, start, end): p for p in new_paths}
            for fut in as_completed(futures):
                p = futures[fut]
                try:
                    symbol, df = fut.result()
                except Exception as e:
                    print(f"[data_service] (rescan)   {os.path.basename(p)}: FAILED — {e}")
                    continue
                if df.empty:
                    print(f"[data_service] (rescan)   {symbol}: 0 bars after date slice — skipped")
                    continue
                _frames[symbol] = df
                added.append(symbol)
                print(f"[data_service] (rescan)   {symbol}: {len(df):,} bars")
    # Symbols whose file has disappeared — drop them so the UI stays in sync.
    removed = [s for s in list(_frames.keys()) if s not in disk_symbols]
    for s in removed:
        print(f"[data_service] (rescan) Symbol {s} file gone — dropping from cache")
        del _frames[s]
    if _default_symbol is None and _frames:
        _default_symbol = sorted(_frames.keys())[0]
    elif _default_symbol not in _frames:
        _default_symbol = sorted(_frames.keys())[0] if _frames else None
    return {'added': sorted(added), 'removed': removed, 'symbols': sorted(_frames.keys())}


def _resolve_symbol(symbol: str | None) -> str:
    """Validate or default the symbol argument."""
    if symbol is None:
        if _default_symbol is None:
            raise RuntimeError("data not loaded — call init_cache() first")
        return _default_symbol
    if symbol not in _frames:
        raise KeyError(f"Unknown symbol: {symbol!r} (have: {sorted(_frames.keys())})")
    return symbol


def get_ohlcv(
    tf: str = '15',
    symbol: str | None = None,
    start: str | None = None,
    end: str | None = None,
    before: int | None = None,     # ms timestamp — return bars with ts < before
    limit: int | None = None,      # return only the LAST N bars after filtering
) -> list[dict]:
    """Return OHLCV in KLineChart format: [{timestamp, open, high, low, close, volume}, ...]

    Pagination:
        before=<ms>   returns bars strictly earlier than this timestamp
        limit=N       returns only the most recent N bars after date/before filters
    """
    sym = _resolve_symbol(symbol)
    df = _frames[sym]
    if start:
        df = df[df.index >= pd.Timestamp(start, tz='UTC')]
    if end:
        df = df[df.index <= pd.Timestamp(end, tz='UTC')]
    df = resample(df, tf)
    if before is not None:
        bts = pd.Timestamp(int(before), unit='ms', tz='UTC')
        df = df[df.index < bts]
    if limit is not None and limit > 0 and len(df) > limit:
        df = df.tail(int(limit))
    ts = (df.index.astype(np.int64) // 10**6).tolist()  # ms
    out = []
    for i, (_, row) in enumerate(df.iterrows()):
        out.append({
            'timestamp': int(ts[i]),
            'open': float(row['open']),
            'high': float(row['high']),
            'low': float(row['low']),
            'close': float(row['close']),
            'volume': int(row['volume']),
        })
    return out


def get_data_range(symbol: str | None = None) -> dict:
    sym = _resolve_symbol(symbol)
    df = _frames.get(sym)
    if df is None or df.empty:
        return {'symbol': sym, 'start': None, 'end': None, 'count': 0}
    return {
        'symbol': sym,
        'start': df.index.min().isoformat(),
        'end': df.index.max().isoformat(),
        'count': len(df),
    }
