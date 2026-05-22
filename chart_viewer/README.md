# NQ Chart Viewer

Lightweight TradingView-style chart for manually reviewing NQ historical data and practicing drawing analysis.

Built on KLineChart v9 (open-source, Apache-2.0). Backend: FastAPI serving OHLCV from the `market_data/` 1-min files (one `.txt` per symbol).

## Features

- Candlestick + volume sub-pane (separate panes, not overlay)
- Drawing tools: **trend line**, **rectangle**, **path** (multi-point polyline)
- Snap modifiers while drawing:
  - **Ctrl** — snap y-value to the nearest OHLC of the bar under the cursor
  - **Shift** — lock to horizontal/vertical relative to the previous point
- Hotkeys:
  - `Alt+T` trend line, `Alt+R` rectangle, `Alt+P` path
  - `Esc` cancel current draw, `Del` remove selected drawing
  - `R` toggle replay, `Space` play/pause replay
  - **Number key** = minutes (e.g. `5` → `5m`); **number + suffix** = `1d`, `4h`, `30m`
- TradingView-style **replay**:
  - Pick a starting bar, then watch the chart "build" each display bar from sub-TF (default 1m) ticks
  - Play / pause / step / speed (0.5x – 10x) / jump-to-end
  - Switch sub-TF granularity (1m / 3m / 5m) live

## Install

```bash
cd chart_viewer
python -m venv .venv
. .venv/Scripts/activate           # Windows
pip install -r requirements.txt
```

## Run

```bash
uvicorn server:app --reload --port 8000
```

Then open http://localhost:8000

### Optional env vars

To limit cache size for faster startup:

```bash
NQ_DATA_START=2024-01-01 uvicorn server:app --reload --port 8000
```

| Env var          | Purpose                                  |
|------------------|------------------------------------------|
| `MARKET_DATA_DIR`| Override default `../market_data/`       |
| `NQ_DATA_START`  | ISO date — clip data before this date    |
| `NQ_DATA_END`    | ISO date — clip data after this date     |

## Files

```
chart_viewer/
├── server.py            FastAPI entry
├── data_service.py      OHLCV loading, resampling
├── requirements.txt
├── README.md
└── static/
    ├── index.html       Layout shell
    ├── style.css        Dark theme styling
    ├── app.js           Chart init + timeframe switching
    ├── drawing.js       Drawing tools, snap, settings panel
    └── replay.js        TradingView-style replay engine
```

## Notes

- Times displayed in **US/Eastern** (NQ session timezone). Configurable in `app.js` via `DISPLAY_TZ`.
- KLineChart loaded from CDN: `klinecharts@9.8.10`. No build step required.
- Snap key bindings live in `drawing.js` — `isOhlcSnapKey` and `isAxisLockKey` predicates.
