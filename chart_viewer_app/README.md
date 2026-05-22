# NQ Chart Viewer — Desktop App

Electron wrapper around [`../chart_viewer`](../chart_viewer). Double-click the
exe, FastAPI starts in the background, a native window opens. No browser tab,
no manually running `start.bat`.

The frontend code (`../chart_viewer/static/*`) is **unchanged** — this is just a
packaging shell.

## First-time setup

Requires:

- **Node.js 18+** — from <https://nodejs.org> (pick LTS)
- **Python 3** — same as the web version; must be on PATH as `py` on Windows
  or `python3` on macOS/Linux

```
cd chart_viewer_app
npm install
```

## Run (dev)

```
npm start
```

An Electron window opens ~1–3 seconds later. Python FastAPI starts in the
background and is killed when the window closes.

Dev Tools: `Ctrl+Shift+I` (hidden menu — `autoHideMenuBar: true` — but shortcut
still works).

## Build a portable .exe

```
npm run build:win
```

Output: `dist/NQ Chart Viewer 0.1.0.exe` (single-file portable — no installer
needed, no Program Files pollution). Bundles the whole `chart_viewer/` folder
inside `resources/chart_viewer/`, but **NOT** Python itself — the exe expects
the target machine to have Python 3 installed.

If you want to ship to a machine without Python, see the "Bundling Python"
section below.

## Architecture

```
┌─ Electron main process (main.js) ────────────────────┐
│  on app.whenReady():                                 │
│    spawn py -m uvicorn server:app --port 8000        │
│    wait for http://127.0.0.1:8000 to respond         │
│    open BrowserWindow pointing at that URL           │
│                                                      │
│  on quit: taskkill the python process                │
└──────────────────────────────────────────────────────┘
         │
         ▼
  localhost:8000 (FastAPI)
         │
         ▼
  chart_viewer/static/index.html
  chart_viewer/static/drawing.js   ← unchanged
  chart_viewer/static/replay.js    ← unchanged
  ...
```

localStorage works inside Electron's Chromium; drawings still persist across
restarts (different origin key than your normal browser though, so it's a
clean slate the first time).

## Bundling Python (optional, future)

Current setup requires the user to have Python 3 on PATH. To make a truly
single-file distributable:

1. Use [PyInstaller](https://pyinstaller.org) to freeze `chart_viewer/server.py`
   into a standalone `chart_viewer_backend.exe`.
2. Change `main.js::startPython()` to spawn that exe instead of `py -m uvicorn`.
3. Add the frozen exe to `extraResources` in `package.json`.

Adds ~30–50 MB to the bundle but works on machines with no Python.

## Folder layout

```
chart_viewer_app/
├── main.js                ← Electron entry + Python sidecar
├── package.json           ← Electron + electron-builder config
├── .gitignore
├── README.md              ← this file
├── assets/
│   └── icon.ico           ← (add your own; optional)
└── (after `npm install`)
    └── node_modules/
    └── dist/              ← build output
```
