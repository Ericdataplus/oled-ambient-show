@echo off
REM ============================================================================
REM  OLED Ambient Show - always-on launcher
REM  Opens the show in a clean, borderless fullscreen window on your OLED.
REM  Double-click to run. Put a shortcut in shell:startup to run it at boot.
REM ============================================================================

REM --- 1) What to show: the live site, or a local file ------------------------
set "URL=https://ericdataplus.github.io/oled-ambient-show/"
REM   For a LOCAL copy instead, comment the line above and use (mind the path):
REM   set "URL=file:///E:/Projects/Personal/personal-notes/oled%%20background%%20videos/index.html"

REM --- 2) Where your OLED is: its top-left pixel ------------------------------
REM   Find it in Settings > System > Display (drag-arrange the monitors).
REM   OLED to the RIGHT of a 2560-wide main screen -> 2560,0
REM   OLED to the LEFT  -> use a negative X, e.g. -1920,0
set "POSX=1920"
set "POSY=0"

REM --- 3) Fullscreen style ----------------------------------------------------
REM   --start-fullscreen = borderless, exit with Alt+F4 (recommended)
REM   --kiosk            = fully locked kiosk (harder to exit)
set "MODE=--start-fullscreen"

REM ---------------------------------------------------------------------------
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (
  start "" "%CHROME%" --app=%URL% --new-window --window-position=%POSX%,%POSY% %MODE%
  goto :eof
)

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=%URL% --new-window --window-position=%POSX%,%POSY% %MODE%
  goto :eof
)

REM Fallback: open in the default browser (then drag to the OLED and press F11).
start "" "%URL%"
