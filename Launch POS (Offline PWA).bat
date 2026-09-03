@echo off
setlocal EnableExtensions EnableDelayedExpansion

:: ===========================================================================
::  Danbaiwa Restaurant OS - PWA Launcher (Offline-Ready)
:: ===========================================================================
::  Opens the till in its own window (not a browser tab), ready to work
::  offline, with silent printing enabled.
::
::  FIRST TIME ON A MACHINE (needs internet, once):
::    1. Open the app URL below in Chrome or Edge
::    2. Wait for it to finish loading - the service worker pre-caches it
::    3. Install it from the address bar, and pin it to the taskbar
::    4. After that, use this file or the taskbar icon. No internet needed.
::
::  Works with Chrome OR Edge. Both are Chromium, so nothing is lost by
::  using either - and a browser can get a service worker wedged for one
::  site, leaving that browser alone stuck on an old build while the other
::  is perfectly current. Set BROWSER to switch.
::
::  BROWSER: AUTO (Chrome first), CHROME, or EDGE.
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
  echo         Install one, or edit the BROWSER line in this file.
  echo.
  pause
  exit /b 1
)

:: --kiosk-printing is only honoured by a FRESH process. If the browser is
:: already running, the new window joins the old process - started without
:: the flag - and the print dialog comes back.
taskkill /F /IM "!PROC!" >nul 2>&1
timeout /t 2 /nobreak >nul

start "" "!EXE!" ^
  --app="%APPURL%" ^
  --kiosk-printing ^
  --disable-print-preview ^
  --no-first-run ^
  --disable-infobars ^
  --disable-session-crashed-bubble

endlocal
