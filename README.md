# Chart Viewer

A TradingView-style desktop chart for manual drawing practice, replay-driven
trade simulation, and branching what-if exploration against historical
OHLCV data. Built as a thin Electron shell around a local FastAPI server +
KLineChart frontend — no cloud, no account, your data stays on disk.

![status](https://img.shields.io/badge/status-pre--release-orange)
![license](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Replay engine** — pick any historical bar as the cursor, step forward
  (`.`) / back (`,`) one bar at a time, swap timeframes mid-replay, drop
  trades while the future is hidden
- **Drawing tools** — trendline / rectangle / path / Fibonacci retracement
  & trend-based extension / measure (date & price range) / long & short
  position projection. Snap modifiers (Ctrl = OHLC, Shift = axis-lock)
- **Trade simulation** — pending limit / stop / stop-limit orders with
  brackets (OCO TP / SL), realistic fills (commissions + slippage), MAE /
  MFE tracking, trade history with xlsx export
- **Branching replay** — fork a timeline at any cursor point to explore
  counterfactuals (tighter stop? longer hold? went short instead?), with
  built-in friction (cooldown + type-to-confirm + ≥20-char reason) on the
  promote-to-main flow to discourage overfitting
- **Mini chart** — pin one branch to a sub-pane, viewport-synced with the
  main chart
- **Multi-symbol** — drop `.txt` files into `market_data/`, app picks them
  up on launch / rescan. Symbol specs (tick size, point value, commission)
  configurable per instrument
- **Layouts** — multiple chart workspaces, browser-style tabs, persisted
  drawings + replay cursors per layout

## Two ways to run

### A. Standalone (Python only — no Electron)

```bash
cd chart_viewer
pip install -r requirements.txt
python -m uvicorn server:app --port 8000
# → http://localhost:8000
```

Drop your OHLCV `.txt` files into `market_data/` (one file per symbol,
filename minus extension = symbol code). Format: 1-minute bars with
columns `Date,Time,Open,High,Low,Close,Volume` in Eastern Time.

### B. Desktop app (Electron wrapper)

```bash
cd chart_viewer_app
npm install
npm start                    # dev mode
npm run build:win            # Windows portable .exe
npm run build:mac            # macOS .dmg
```

Python 3 must be on `PATH` (the Electron shell spawns it as a child
process). Symbol data lives next to the .exe in `market_data/`, plus
`user_data/` (drawings / layouts / branch sessions) under
`%APPDATA%/chart-viewer-app/` (Windows) or
`~/Library/Application Support/chart-viewer-app/` (macOS).

## Data format

```
Date,Time,Open,High,Low,Close,Volume
2025-01-02,09:30,21100.50,21102.75,21100.25,21101.50,1245
2025-01-02,09:31,21101.50,21103.00,21101.00,21102.25,892
...
```

- 1-minute bars (everything else is resampled in-memory at request time)
- Timestamps in Eastern Time (handles DST + day/week/month resample
  boundaries correctly)
- Volume optional but recommended (powers volume profile, sim engine)

## Stack

| Layer | What |
|---|---|
| Chart  | [KLineChart v9.8.10](https://klinecharts.com) (CDN, no build) |
| Backend | FastAPI + pandas (1-min cache as pickle, resample on demand) |
| Frontend | Vanilla JS modules (no framework, no bundler) |
| Desktop shell | Electron 33 + electron-builder |
| i18n | Custom dictionary (~520 keys), zh-TW / en bilingual |

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, sell it, embed it. Just
keep the copyright notice.

## Inspiration

UI patterns adapted from TradingView's Supercharts and Pine Script docs.
This project is unaffiliated with TradingView Inc.
