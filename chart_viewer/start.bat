@echo off
chcp 65001 > nul
cd /d "%~dp0"

REM ---- Optional: limit data load range for fast startup ----
REM Comment out the next line to load ALL historical data
set NQ_DATA_START=2024-09-01

REM ---- Disable idle watchdog for browser sessions ----
REM Browser tabs don't ping /api/ping (only Electron does), so the default
REM 6-minute timeout would self-kill the server while the user is staring
REM at the chart, making subsequent F5 hang on a dead port. Manual runs
REM trust the user to Ctrl+C; the stale-process kill below handles orphans
REM from prior sessions.
set CHART_VIEWER_IDLE_TIMEOUT=0

REM ---- Auto-clean stale uvicorn on port 8000 ----
REM Prior sessions sometimes leave the Python server orphaned (e.g. if the
REM cmd window was closed instead of Ctrl+C'd). We taskkill any LISTENING
REM process on 8000 before starting so this run doesn't trip "address in use".
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000 " ^| findstr "LISTENING"') do (
    echo [start.bat] killing stale process %%a on port 8000
    taskkill /PID %%a /F >nul 2>&1
)

echo ============================================================
echo  Chart Viewer
echo  Open in browser:  http://localhost:8000
echo  Press Ctrl+C to stop
echo ============================================================
echo.

python -m uvicorn server:app --reload --port 8000

pause
