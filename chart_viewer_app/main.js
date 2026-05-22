// Electron entry for NQ Chart Viewer.
//
// Lifecycle:
//   1. App ready → spawn the FastAPI backend (chart_viewer/server.py) as a
//      background Python process on port 8000.
//   2. Poll http://127.0.0.1:8000 until it responds.
//   3. Open a native BrowserWindow pointing at that URL.
//   4. On window close / app quit → kill the Python process.

const { app, BrowserWindow, Menu, shell, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

// By default app.getPath('userData') is keyed off package.json `name`
// ("chart-viewer-app") — making the userData dir on macOS land at
// ~/Library/Application Support/chart-viewer-app/. Override to match the
// productName the user actually sees in Finder / Dock.
app.setName('Chart_Viewer');

// Disable Chromium's HTTP cache so updates to chart_viewer/static/* show up
// on every `npm start` without a manual hard-refresh.
app.commandLine.appendSwitch('disable-http-cache');

const PORT = 8000;
const APP_URL = `http://127.0.0.1:${PORT}`;

let pythonProcess = null;
let mainWindow = null;
let heartbeatTimer = null;

// Where the chart_viewer FastAPI project lives.
//   - In dev (npm start): ../chart_viewer (sibling folder)
//   - In packaged app: resources/chart_viewer/ inside the bundle
function getChartViewerDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'chart_viewer');
  }
  return path.join(__dirname, '..', 'chart_viewer');
}

// Prefer a `.venv/` next to chart_viewer/server.py (created by `python -m
// venv .venv && pip install -r requirements.txt` per the README) so we
// don't fight system-Python PEP-668 rules on macOS, and so users don't
// need fastapi/pandas/etc on their global interpreter. Falls back to the
// platform default `python` / `python3` if no venv is present.
function getPythonCmd() {
  const venvBin = process.platform === 'win32'
    ? path.join(getChartViewerDir(), '.venv', 'Scripts', 'python.exe')
    : path.join(getChartViewerDir(), '.venv', 'bin', 'python');
  if (fs.existsSync(venvBin)) return venvBin;
  return process.platform === 'win32' ? 'python' : 'python3';
}

// Where market_data/, user_data/ and debug logs live in a packaged build.
//   - macOS: ~/Library/Application Support/Chart_Viewer/  (Apple HIG; .app
//     usually lives in /Applications which is read-only without admin, so
//     "next to the .app" is not viable).
//   - Windows portable: next to the .exe — keeps the whole thing
//     self-contained so the user can move/delete the folder as one unit.
//   - Dev: null — fall through to chart_viewer's own repo-relative defaults.
function getAppDataRoot() {
  if (!app.isPackaged) return null;
  if (process.platform === 'darwin') {
    return app.getPath('userData');
  }
  return process.env.PORTABLE_EXECUTABLE_DIR
      || path.dirname(app.getPath('exe'));
}

// Where users drop their broker CSV exports in a packaged build. Location
// per platform — see getAppDataRoot above. Dev builds return null and let
// server.py fall back to its repo-level `market_data/` lookup.
function getExternalDataDir() {
  const root = getAppDataRoot();
  if (!root) return null;
  return path.join(root, 'market_data');
}

// Drop a bilingual README + a 3-row sample CSV into the data folder so the
// user knows what column format is expected BEFORE they boot the app for
// the first time (the in-app onboarding card only shows after launch, by
// which point they may already be staring at an empty folder wondering
// what to put in it).
//
// Files start with double underscore so they sort to the top in Explorer
// AND get filtered out by data_service.py's glob (which skips '_*' to
// reserve underscore-prefix as a "not a symbol" namespace).
//
// Idempotent: only writes if the file is missing. Doesn't overwrite if
// the user has edited or deleted it.
const DATA_FOLDER_README = `\
================================================================
 Chart Viewer  --  market_data folder guide
================================================================

[ 繁體中文 ]

把您的商品歷史資料放進這個資料夾，Chart Viewer 啟動時會自動載入。

★ 檔名規則
   檔名（不含副檔名）= 商品代號。例：
     NQ1.txt   → 載入為「NQ1」
     TXF1.csv  → 載入為「TXF1」
   底線 _ 開頭的檔案會被忽略（本說明檔與範例檔都是）。

★ 副檔名
   .txt 或 .csv 都可以，內容都是 CSV 格式。

★ 必要欄位（順序與大小寫必須完全一致）
   Date,Time,Open,High,Low,Close,TotalVolume

★ 欄位格式
   Date         YYYY/M/D 或 YYYY/MM/DD     例: 2024/9/3 或 2024/09/03
   Time         HH:MM:SS（24 小時制）     例: 09:30:00
   Open / High / Low / Close   浮點數   例: 15523.25
   TotalVolume  整數                          例: 1842

★ 時區與粒度
   時區：US Eastern (ET / 美東)
   粒度：1 分鐘 K 棒（資料表內每一行 = 1 分鐘）

★ 範例
   見同資料夾內的 __EXAMPLE.csv。

================================================================

[ English ]

Drop your historical OHLCV files into this folder. Chart Viewer
auto-loads them on startup.

* Filename
   Filename minus extension becomes the symbol code:
     NQ1.txt   -> loads as "NQ1"
     TXF1.csv  -> loads as "TXF1"
   Files starting with underscore (_) are ignored -- including
   this README and the EXAMPLE file.

* Extension
   .txt or .csv (both contents are CSV-formatted).

* Required columns (exact order, case-sensitive header)
   Date,Time,Open,High,Low,Close,TotalVolume

* Column format
   Date         YYYY/M/D or YYYY/MM/DD     e.g. 2024/9/3 or 2024/09/03
   Time         HH:MM:SS (24-hour)          e.g. 09:30:00
   Open / High / Low / Close   float        e.g. 15523.25
   TotalVolume  integer                     e.g. 1842

* Timezone & granularity
   Timezone:    US Eastern (ET)
   Granularity: 1-minute bars (each row = 1 minute)

* Example
   See __EXAMPLE.csv in this folder.

================================================================
`;

const DATA_FOLDER_EXAMPLE_CSV = `\
Date,Time,Open,High,Low,Close,TotalVolume
2024/09/03,09:30:00,15523.25,15530.00,15521.50,15528.75,1842
2024/09/03,09:31:00,15528.75,15532.25,15526.00,15530.50,1207
2024/09/03,09:32:00,15530.50,15535.00,15528.75,15533.25,1456
`;

function dropDataFolderGuide(dir) {
  const files = [
    { name: '__README.txt',  body: DATA_FOLDER_README },
    { name: '__EXAMPLE.csv', body: DATA_FOLDER_EXAMPLE_CSV },
  ];
  for (const { name, body } of files) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) continue;
    try {
      fs.writeFileSync(p, body, 'utf8');
      console.log('[main] dropped guide file', p);
    } catch (e) {
      console.error('[main] could not write guide file', p, e.message);
    }
  }
}

function startPython() {
  const cwd = getChartViewerDir();
  const cmd = getPythonCmd();
  const fullArgs = [
    '-m', 'uvicorn', 'server:app',
    '--host', '127.0.0.1',
    '--port', String(PORT),
  ];
  // Reuse the same NQ_DATA_START narrowing the .bat uses so first-launch is
  // fast. Users can override via their shell env before `npm start`.
  const env = { ...process.env };
  if (!env.NQ_DATA_START) env.NQ_DATA_START = '2024-09-01';

  const externalDataDir = getExternalDataDir();
  if (externalDataDir && !env.MARKET_DATA_DIR) {
    try {
      fs.mkdirSync(externalDataDir, { recursive: true });
      dropDataFolderGuide(externalDataDir);
    } catch (e) {
      console.error('[main] could not create data dir', externalDataDir, e.message);
    }
    env.MARKET_DATA_DIR = externalDataDir;
    console.log('[main] MARKET_DATA_DIR =', externalDataDir);
  }

  // CRITICAL for portable .exe: by default server.py keeps user_data /
  // config.json / symbol_specs.json next to its own files (HERE), but
  // HERE points into the per-launch temp extraction folder for a
  // packaged build. Every relaunch would land in a fresh temp dir →
  // every layout, branch, drawing, language choice, symbol-spec
  // override would be wiped on close. Fix: pin user_data to a stable
  // folder NEXT TO the .exe (same parent as market_data/) so user
  // state survives across launches.
  const root = getAppDataRoot();
  if (root) {
    const userDataDir = path.join(root, 'user_data');
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
    } catch (e) { /* ignore — server.py also makedirs */ }
    env.CHART_VIEWER_USER_DATA_DIR = userDataDir;
    console.log('[main] CHART_VIEWER_USER_DATA_DIR =', userDataDir);
  }

  console.log('[Python] cwd =', cwd);
  console.log('[Python] cmd =', cmd, fullArgs.join(' '));
  pythonProcess = spawn(cmd, fullArgs, { cwd, shell: false, env });
  pythonProcess.stdout.on('data', d => process.stdout.write(`[py] ${d}`));
  pythonProcess.stderr.on('data', d => process.stderr.write(`[py] ${d}`));
  pythonProcess.on('error', (err) => {
    console.error('[Python] spawn failed:', err.message);
    console.error('Hint: make sure Python 3 is installed and on PATH.');
  });
  pythonProcess.on('close', (code) => {
    console.log('[Python] exited with code', code);
    // If the backend dies after the window is open, quit so user notices.
    if (mainWindow && !mainWindow.isDestroyed()) app.quit();
  });
}

// Ping the backend every 2 min so the idle watchdog doesn't self-kill it
// while the user has the window open but isn't interacting with anything
// (pure "stare at the chart" mode does zero HTTP requests otherwise).
function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    const req = http.get(`${APP_URL}/api/ping`, (res) => res.resume());
    req.on('error', () => { /* server might be mid-restart — ignore */ });
    req.setTimeout(3000, () => req.destroy());
  }, 120 * 1000);
}
function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function killPython() {
  stopHeartbeat();
  if (pythonProcess && !pythonProcess.killed) {
    try {
      if (process.platform === 'win32') {
        // execSync (NOT spawn) so the kill actually completes before
        // app.quit returns. Previously we used spawn() which is async +
        // fire-and-forget — the Electron process exited before taskkill
        // had finished, leaving the uvicorn child alive as an orphan
        // listening on :8000. Next launch then "reused" the orphan
        // (whose STATIC_DIR pointed to a now-deleted temp dir) and the
        // user got a broken page. /T = tree (kills uvicorn worker too),
        // /F = force.
        require('child_process').execSync(
          `taskkill /pid ${pythonProcess.pid} /T /F`,
          { stdio: 'ignore' }
        );
      } else {
        pythonProcess.kill('SIGTERM');
      }
    } catch (e) { /* process may already be gone — ignore */ }
    pythonProcess = null;
  }
}

// Poll the server with GET / until 200 OK, or bail after `timeoutMs`.
// 60s default — initial data_service.init_cache parses 5 symbols ×
// ~500K bars each (CSV → pandas DataFrame → ET-tz localize → resample
// indices), which on a cold disk + first-time .pkl-cache miss takes
// 20-40s on typical hardware. With caching warmed up subsequent boots
// are near-instant; the timeout just guards against truly hung Python
// processes (e.g. Python not on PATH, port collision, etc).
function waitForServer(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve();
        schedule();
      });
      req.on('error', schedule);
      req.setTimeout(1000, () => { req.destroy(); schedule(); });
    };
    const schedule = () => {
      if (Date.now() - started > timeoutMs) {
        return reject(new Error('FastAPI did not come up in time'));
      }
      setTimeout(tryOnce, 300);
    };
    tryOnce();
  });
}

// Self-contained splash page shown the moment the BrowserWindow opens
// — covers the 5-10 seconds where uvicorn boots + data_service.init_cache
// scans market_data. Without this the user sees nothing at all between
// double-clicking the .exe and the chart appearing.
//
// Renders in ONE language (not bilingual) — picked by reading the user's
// previously-saved uiLang from user_data/config.json. First-time users
// default to English (matches DEFAULT_CONFIG in server.py); after they
// toggle to Chinese once, every subsequent splash is Chinese.
function _splashHtml(lang) {
  const isZh = lang === 'zh';
  const langAttr = isZh ? 'zh-TW' : 'en';
  const message  = isZh ? '正在啟動' : 'Starting';
  const fontStack = isZh
    ? '"Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif'
    : 'system-ui,-apple-system,"Segoe UI",sans-serif';
  return `<!DOCTYPE html>
<html lang="${langAttr}"><head><meta charset="utf-8"><title>Chart_Viewer</title>
<style>
  html, body { margin:0; padding:0; height:100%; background:#131722;
    color:#d1d4dc; overflow:hidden; font-family:${fontStack}; }
  body { display:flex; align-items:center; justify-content:center;
    flex-direction:column; gap:22px; }
  .loader-wave { display:flex; gap:6px; align-items:center; height:22px; }
  .loader-wave span { width:10px; height:10px; background:#2962ff; border-radius:2px;
    animation: loader-wave 1.1s ease-in-out infinite; }
  .loader-wave span:nth-child(1) { animation-delay: -0.50s; }
  .loader-wave span:nth-child(2) { animation-delay: -0.40s; }
  .loader-wave span:nth-child(3) { animation-delay: -0.30s; }
  .loader-wave span:nth-child(4) { animation-delay: -0.20s; }
  .loader-wave span:nth-child(5) { animation-delay: -0.10s; }
  .loader-wave span:nth-child(6) { animation-delay:  0.00s; }
  @keyframes loader-wave {
    0%,60%,100% { transform: scale(0.6); opacity:0.45; }
    30%         { transform: scale(1.4); opacity:1;    }
  }
  .msg { text-align:center; font-size:15px; letter-spacing:0.4px; color:#d1d4dc; }
  .brand { color:#2962ff; font-weight:600; }
</style></head>
<body>
  <div class="loader-wave"><span></span><span></span><span></span><span></span><span></span><span></span></div>
  <div class="msg">${message} <span class="brand">Chart_Viewer</span> …</div>
</body></html>`;
}

// Read the user's previously-saved uiLang from disk so the splash can
// render in their language from the very first frame. Sync I/O — fast
// (small JSON, local disk) and the alternative would be a flash-of-
// wrong-language while we wait for the page-side localStorage to load.
// Returns 'zh' or 'en'; defaults to 'en' (matches DEFAULT_CONFIG).
function _readSavedUiLang() {
  const root = getAppDataRoot();
  if (!root) return 'en';   // dev — match production default
  const cfgPath = path.join(root, 'user_data', 'config.json');
  try {
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg.uiLang === 'zh' || cfg.uiLang === 'en') return cfg.uiLang;
    }
  } catch (e) { /* ignore — fall through to default */ }
  return 'en';
}

function _splashDataUrl() {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(_splashHtml(_readSavedUiLang()));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    title: 'Chart_Viewer',
    backgroundColor: '#131722',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Allow localStorage / service workers from http://127.0.0.1 (same origin).
      partition: 'persist:chartviewer',
    },
  });
  // Open any _blank/external links in the user's default browser instead of
  // a new Electron window (e.g. the klinecharts CDN docs).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // Splash first — caller swaps to APP_URL once waitForServer resolves
  // (see app.whenReady below). Until then the user sees an animated
  // spinner instead of either a blank window or — worse — nothing at
  // all because the window hadn't opened yet.
  mainWindow.loadURL(_splashDataUrl());

  // Forward renderer console.log to a debug file (GUI .exe has no
  // attached console, so process.stdout writes go nowhere on Windows).
  // Path is next to the .exe in packaged mode — easy for the user to
  // find. Only enabled when CHART_VIEWER_DEBUG_LOG=1 to avoid disk
  // churn on normal runs.
  if (process.env.CHART_VIEWER_DEBUG_LOG === '1' || !app.isPackaged) {
    const logDir = getAppDataRoot() || path.dirname(app.getPath('exe'));
    const logPath = path.join(logDir, 'chart_viewer_debug.log');
    try { fs.writeFileSync(logPath, `--- session start ${new Date().toISOString()} ---\n`); } catch (e) {}
    mainWindow.webContents.on('console-message', (event, level, message, line, source) => {
      const tag = ['', 'INFO', 'WARN', 'ERROR'][level] || 'LOG';
      try { fs.appendFileSync(logPath, `[renderer ${tag}] ${message}\n`); } catch (e) {}
    });
  }

  // Force F5 (and Ctrl+R / Cmd+R) to bypass any client-side cache. Even with
  // disable-http-cache and the server's no-store header, Electron's render
  // pipeline sometimes serves stale JS/CSS on a soft reload — switching to
  // reloadIgnoringCache makes every reload feel like Ctrl+Shift+R.
  // `input.meta` covers macOS Cmd+R; `input.control` covers Win/Linux Ctrl+R.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isReload = input.key === 'F5'
                  || ((input.control || input.meta) && input.key.toLowerCase() === 'r');
    if (isReload) {
      event.preventDefault();
      mainWindow.webContents.reloadIgnoringCache();
    }
  });
}

// macOS convention: an app needs an application menu for Cmd+Q / Cmd+W /
// Cmd+M and the standard edit-menu shortcuts (Cmd+C/X/V/A/Z) to work
// inside web inputs. Without this, copy/paste in textareas silently
// breaks on Mac. Roles are auto-localized + auto-bound to the platform's
// expected keys, so we don't hard-code any accelerators here.
//
// Windows/Linux: keep the existing `autoHideMenuBar: true` behavior —
// no menu bar shown, no extra hotkeys needed (close = ✕, etc).
function installPlatformMenu() {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

// Verify that whatever's on :8000 is actually a healthy chart_viewer
// (not an orphan from a previous portable launch whose STATIC_DIR points
// to a now-deleted TEMP folder, which would silently 500-page-load every
// HTML request). Two probes:
//   1. /api/symbols — confirms the FastAPI routes are alive AND the
//      response shape matches (catches "something else is squatting on
//      :8000" e.g. another dev server).
//   2. /static/index.html — confirms the static-files mount points at a
//      live directory (catches the orphan-with-deleted-TEMP case where
//      /api/symbols passes from in-memory state but /static/* 404s).
function _probe(url, opts = {}) {
  const { timeoutMs = 1500, method = 'GET' } = opts;
  return new Promise((resolve) => {
    const req = http.request(url, { method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.end();
  });
}

async function isHealthyChartViewer(url) {
  const sym = await _probe(`${url}/api/symbols`);
  if (sym.status !== 200) return false;
  try {
    const j = JSON.parse(sym.body);
    if (!Array.isArray(j.symbols)) return false;
  } catch (e) { return false; }
  // Static-mount sanity: HEAD is enough — we don't need the body.
  const idx = await _probe(`${url}/static/index.html`, { method: 'HEAD' });
  return idx.status === 200;
}

// Mirror chart_viewer/start.bat's auto-clean: kill any LISTENING process
// on the given port. Used when the port is busy with something we
// couldn't health-verify (orphan uvicorn, broken process, etc.). Skipped
// silently on non-Windows — Linux/macOS have their own conventions and
// this is .exe-distribution-focused anyway.
function killStalePort(port) {
  if (process.platform !== 'win32') return;
  const { execSync } = require('child_process');
  let out = '';
  try {
    out = execSync(
      `netstat -ano | findstr ":${port} " | findstr "LISTENING"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch (e) { return; }   // no LISTENING match → nothing to kill
  const pids = new Set(
    out.trim().split(/\r?\n/)
       .map((line) => line.trim().split(/\s+/).pop())
       .filter((pid) => /^\d+$/.test(pid))
  );
  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      console.log('[main] killed stale process on port', port, 'PID', pid);
    } catch (e) { /* already gone — ignore */ }
  }
}

app.whenReady().then(async () => {
  installPlatformMenu();

  // Open the BrowserWindow IMMEDIATELY with the splash so the user
  // sees an animated spinner the moment they double-click — without
  // this the entire Electron window stayed hidden until waitForServer
  // resolved (5-10s of "did the .exe even open?" anxiety while uvicorn
  // started + data_service.init_cache parsed market_data files).
  createWindow();

  // Purge any stale cached HTML/JS from previous runs.
  try {
    await session.fromPartition('persist:chartviewer').clearCache();
  } catch (e) { /* ignore */ }

  // Reuse an existing healthy chart_viewer on :8000 (e.g. user has
  // start.bat running). If port is busy with something unhealthy
  // (orphan uvicorn from a previous portable run whose static path is
  // dead, or some unrelated dev server), kill it and start fresh —
  // otherwise we'd reuse a broken instance and the user would see
  // 500/JSON-fallback on every page load.
  const healthy = await isHealthyChartViewer(APP_URL);
  if (healthy) {
    console.log('[Python] healthy chart_viewer detected on', APP_URL, '— reusing');
  } else {
    killStalePort(PORT);
    startPython();
  }
  try {
    await waitForServer(APP_URL);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(APP_URL);   // swap from splash to real app
    }
    startHeartbeat();
  } catch (err) {
    console.error('Startup failed:', err.message);
    // Replace the splash with a readable error page (window already
    // exists from the eager createWindow above).
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(
        'data:text/html;charset=utf-8,' + encodeURIComponent(
          `<pre style="background:#131722;color:#f66;padding:24px;font:14px monospace">`
          + `Failed to start FastAPI backend.\n\n${err.message}\n\n`
          + `Check the console (View → Toggle Developer Tools) and the terminal`
          + ` where you ran "npm start". Most common cause: Python 3 not on PATH.</pre>`
        )
      );
    }
  }
});

app.on('window-all-closed', () => {
  killPython();
  app.quit();
});

app.on('before-quit', killPython);
