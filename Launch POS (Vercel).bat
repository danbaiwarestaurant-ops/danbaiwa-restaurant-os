@echo off
setlocal EnableExtensions EnableDelayedExpansion

:: ===========================================================================
::  Danbaiwa Restaurant OS - Till Launcher
:: ===========================================================================
::  Double-click to open the till full screen with silent printing.
::
::  Works with Chrome OR Edge. Both are Chromium underneath, so every flag
::  below behaves the same in either, and the till loses nothing by running
::  on Edge.
::
::  That matters more than it sounds: a browser can get a service worker
::  registration wedged for one site, and then that browser alone keeps
::  serving an old build no matter how often it is reloaded. The other
::  browser is unaffected, because the registration belongs to the browser
::  and not to the machine. Switching is a legitimate fix, not a workaround.
::
::  To force one browser, set BROWSER below to CHROME or EDGE.
::  Leave it as AUTO to use whichever is installed (Chrome first).
:: ===========================================================================

set "BROWSER=AUTO"
set "APPURL=https://danbaiwa-restaurant-os.vercel.app"

title Danbaiwa Restaurant POS

set "CHROME="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do if exist %%P if not defined CHROME set "CHROME=%%~P"

set "EDGE="
for %%P in (
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do if exist %%P if not defined EDGE set "EDGE=%%~P"

if /i "%BROWSER%"=="CHROME" ( set "EXE=!CHROME!" & set "PROC=chrome.exe" )
if /i "%BROWSER%"=="EDGE"   ( set "EXE=!EDGE!"   & set "PROC=msedge.exe" )
if /i "%BROWSER%"=="AUTO" (
  if defined CHROME ( set "EXE=!CHROME!" & set "PROC=chrome.exe" ) else ( set "EXE=!EDGE!" & set "PROC=msedge.exe" )
)

if not defined EXE (
  echo.
  echo  ERROR: Neither Chrome nor Edge could be found on this PC.
  echo         Install one of them, or edit the BROWSER line in this file.
  echo.
  pause
  exit /b 1
)

:: --kiosk-printing is only honoured by a FRESH process. If the browser is
:: already running, the new window joins the old process - which was started
:: without the flag - and the print dialog comes back.
echo  Closing !PROC! ...
taskkill /F /IM "!PROC!" >nul 2>&1
timeout /t 2 /nobreak >nul

echo  Launching the till...
start "" "!EXE!" ^
  --kiosk ^
  --kiosk-printing ^
  --disable-print-preview ^
  --no-first-run ^
  --disable-infobars ^
  --disable-session-crashed-bubble ^
  --disable-restore-session-state ^
  "%APPURL%"

endlocal
