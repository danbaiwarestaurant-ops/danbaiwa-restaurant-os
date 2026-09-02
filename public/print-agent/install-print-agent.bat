@echo off
setlocal EnableExtensions EnableDelayedExpansion

:: ===========================================================================
::  Danbaiwa Restaurant OS - Print Agent Installer
:: ===========================================================================
::  Installs the silent print agent on a till.
::
::  What it needs: Node.js, and print-server.cjs sitting next to this file.
::  That is all. The agent has no npm dependencies, so there is no project to
::  clone, no "npm install", and nothing to download once Node is on the PC.
::
::  Deliberately does NOT require Administrator. It installs into the user's
::  own AppData and runs at that user's logon, which is also what makes
::  printing reliable: a task running as SYSTEM cannot see a printer that was
::  installed for one user only, and silently prints nothing.
:: ===========================================================================

title Danbaiwa POS - Print Agent Installer

set "SRC=%~dp0print-server.cjs"
set "DEST=%LOCALAPPDATA%\DanbaiwaPOS\PrintAgent"
set "TASKNAME=DanbaiwaPOS_PrintAgent"

echo.
echo  Danbaiwa Restaurant OS - Print Agent Installer
echo  ---------------------------------------------
echo.

:: --- 1. Node.js -----------------------------------------------------------
echo  [1/5] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo  ERROR: Node.js is not installed.
  echo         Download the LTS installer from https://nodejs.org, accept the
  echo         defaults, then run this file again.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do set "NODEVER=%%v"
echo        OK - Node !NODEVER!

:: --- 2. The agent file ----------------------------------------------------
if not exist "%SRC%" (
  echo.
  echo  ERROR: print-server.cjs was not found next to this installer.
  echo         Both files must be in the same folder. Copy them together.
  echo.
  pause
  exit /b 1
)

:: --- 3. Which printer -----------------------------------------------------
echo.
echo  [2/5] Printers installed on this PC:
echo.
powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name | ForEach-Object { '        ' + $_ }"
echo.
echo  Type the printer name EXACTLY as shown above.
set "PRINTER="
set /p "PRINTER=  Printer name: "
if "!PRINTER!"=="" (
  echo.
  echo  ERROR: No printer name given. Nothing installed.
  echo.
  pause
  exit /b 1
)

echo.
echo  App address the till will be opened at.
echo  Press Enter to accept the default.
set "APPURL=https://danbaiwa-restaurant-os.vercel.app"
set /p "APPURL=  App URL [!APPURL!]: "

:: --- 4. Install -----------------------------------------------------------
echo.
echo  [3/5] Installing to !DEST! ...
if not exist "!DEST!" mkdir "!DEST!" >nul 2>&1
copy /y "%SRC%" "!DEST!\print-server.cjs" >nul
if errorlevel 1 (
  echo  ERROR: Could not copy print-server.cjs into place.
  pause
  exit /b 1
)

:: The launcher carries this till's settings, so the agent itself stays generic
:: and can be replaced by copying a newer file over it.
> "!DEST!\run-agent.cmd" echo @echo off
>>"!DEST!\run-agent.cmd" echo set "PRINT_PRINTER=!PRINTER!"
>>"!DEST!\run-agent.cmd" echo set "VERCEL_URL=!APPURL!"
>>"!DEST!\run-agent.cmd" echo node "%%~dp0print-server.cjs"

:: Windows has no way to start a console program with no window from Task
:: Scheduler alone - a black box flashes up at every logon and stays in the
:: taskbar. A one-line WSH shim launches it genuinely hidden.
> "!DEST!\start-hidden.vbs" echo Set sh = CreateObject("WScript.Shell")
>>"!DEST!\start-hidden.vbs" echo here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
>>"!DEST!\start-hidden.vbs" echo sh.Run """" ^& here ^& "run-agent.cmd""", 0, False
echo        OK

:: --- 5. Start at logon ----------------------------------------------------
echo.
echo  [4/5] Registering it to start at logon...
schtasks /delete /tn "%TASKNAME%" /f >nul 2>&1
schtasks /create /tn "%TASKNAME%" /tr "wscript.exe \"!DEST!\start-hidden.vbs\"" /sc ONLOGON /f >nul
if errorlevel 1 (
  echo  WARNING: Could not register the startup task. The agent still works,
  echo           but someone must start it after each reboot by running:
  echo           !DEST!\start-hidden.vbs
) else (
  echo        OK
)

:: --- 6. Start now and verify ---------------------------------------------
echo.
echo  [5/5] Starting the agent...
start "" wscript.exe "!DEST!\start-hidden.vbs"

:: Give it a moment to bind the port before asking whether it did.
powershell -NoProfile -Command "Start-Sleep -Milliseconds 1500" >nul 2>&1

powershell -NoProfile -Command "try { $r = Invoke-RestMethod http://127.0.0.1:9100/health -TimeoutSec 5; if ($r.ok) { exit 0 } else { exit 1 } } catch { exit 1 }"
if errorlevel 1 (
  echo.
  echo  The agent did not answer on port 9100.
  echo  Run this to see the reason:
  echo        "!DEST!\run-agent.cmd"
  echo.
  pause
  exit /b 1
)

echo        OK - answering on http://127.0.0.1:9100
echo.
echo  ---------------------------------------------
echo  Done. Receipts will now print silently to:
echo        !PRINTER!
echo.
echo  Set the roll width (58mm or 80mm) in the app under
echo  Manager Console - Settings - Receipt Printer.
echo.
echo  To remove later:
echo        schtasks /delete /tn "%TASKNAME%" /f
echo  ---------------------------------------------
echo.
pause
endlocal
