@echo off
rem ============================================================================
rem Companion, one double-click.
rem
rem  - If the server is already running, this just opens the page.
rem  - Otherwise it starts the server minimised and opens the page when ready.
rem  - Phone access (same Wi-Fi) is on by default because the app is a second
rem    screen; pass --local to keep it loopback-only:  Companion.cmd --local
rem
rem Make a desktop shortcut: right-click this file > Send to > Desktop.
rem ============================================================================
setlocal
cd /d "%~dp0"
set PORT=4126
set LANFLAG=--lan
if /i "%~1"=="--local" set LANFLAG=

rem Already running? Just open it.
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient('127.0.0.1', %PORT%)).Close(); exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 goto open

start "Companion server" /min cmd /c "npm run serve -- %LANFLAG% & pause"

rem Wait up to 60s for the first parse (a big save takes a few seconds).
powershell -NoProfile -Command "for ($i = 0; $i -lt 120; $i++) { try { (New-Object Net.Sockets.TcpClient('127.0.0.1', %PORT%)).Close(); exit 0 } catch { Start-Sleep -Milliseconds 500 } }; exit 1" >nul 2>&1
if not %errorlevel%==0 (
  rem Launched hidden via Companion.vbs, an echo would vanish - use a dialog.
  powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show('Companion did not start. Open the minimised Companion server window in the taskbar to read the error.', 'Companion')"
  exit /b 1
)

:open
start "" "http://127.0.0.1:%PORT%"
endlocal
