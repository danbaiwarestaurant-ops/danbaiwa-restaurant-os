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

:: Stop an agent that is already running, FIRST.
::
:: Without this, re-running the installer to pick up a newer print-server.cjs
:: silently changes nothing: the old agent still holds port 9100, so the new one
:: exits immediately with EADDRINUSE, and the health check at the end is answered
:: by the old process. The installer reports success and the till carries on
:: running the version you were trying to replace.
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":9100" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%P >nul 2>&1
)

:: The agent keeps a small helper process alive holding the printer open. It exits by
:: itself when the agent's pipe closes, but a killed parent gets no chance to say so
:: politely, and a helper still running would hold the file we are about to replace.
taskkill /F /IM danbaiwa-rawprint.exe >nul 2>&1
for /f "delims=" %%E in ('dir /b "!DEST!\danbaiwa-rawprint-v*.exe" 2^>nul') do (
  taskkill /F /IM "%%E" >nul 2>&1
)
timeout /t 1 /nobreak >nul
if not exist "!DEST!" mkdir "!DEST!" >nul 2>&1
copy /y "%SRC%" "!DEST!\print-server.cjs" >nul
if errorlevel 1 (
  echo  ERROR: Could not copy print-server.cjs into place.
  pause
  exit /b 1
)

:: Rebuilt from the new source on next start. Deleting it costs one second, and
:: keeping a stale one would pair a new agent with the old spooling behaviour.
:: The agent now names the helper after its own version and cleans up the rest itself,
:: so this is belt and braces for a machine upgraded from an older build.
del /f /q "!DEST!\danbaiwa-rawprint.exe" >nul 2>&1
del /f /q "!DEST!\danbaiwa-rawprint-v*.exe" >nul 2>&1

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

:: The Startup folder needs its own copy that does NOT locate run-agent.cmd relative to
:: itself - from the Startup folder that resolves to the wrong place. This one carries
:: the absolute path.
::
:: It is written HERE, at the top level of the script, and not inside the `if` block that
:: registers it. Written inside a block, cmd's parser ended the block at the first `)` of
:: CreateObject("WScript.Shell") and the `)` never reached the file, so every till got a
:: VBScript that could not parse. The installer still reported success - it only checked
:: the file existed - the agent it started by hand kept printing all day, and nothing came
:: back after the next reboot. That is the whole of the "does not auto start" bug.
> "!DEST!\start-hidden-abs.vbs" echo Set sh = CreateObject("WScript.Shell")
>>"!DEST!\start-hidden-abs.vbs" echo sh.Run """!DEST!\run-agent.cmd""", 0, False
echo        OK

:: --- 5. Start at logon ----------------------------------------------------
echo.
echo  [4/5] Registering it to start at logon...

:: Three ways to start at logon, tried in order.
::
:: This used to try Task Scheduler alone and, when schtasks returned non-zero, print a
:: warning telling the operator to double-click a file after every reboot. That was a
:: false surrender: schtasks is refused often enough (Group Policy, a non-admin account,
:: security software) and it is not the only mechanism Windows has. The Startup folder
:: and the per-user Run key both need no Administrator rights and no scheduler service.
:: A till should never depend on somebody remembering to click something.

set "STARTUPDIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "STARTUPFILE=!STARTUPDIR!\DanbaiwaPOS Print Agent.vbs"
set "RUNKEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
set "AUTOSTART="

:: Clear all three first, so re-running the installer can never leave two entries
:: fighting to bind the same port.
schtasks /delete /tn "%TASKNAME%" /f >nul 2>&1
if exist "!STARTUPFILE!" del /f /q "!STARTUPFILE!" >nul 2>&1
reg delete "!RUNKEY!" /v "%TASKNAME%" /f >nul 2>&1

:: Each mechanism is now PROVEN before it is accepted: the agent is stopped, the entry is
:: triggered exactly the way a logon would trigger it, and the port is asked whether an
:: agent answered. A mechanism that registers cleanly but cannot actually start anything -
:: a malformed schtasks /tr, a script host blocked by policy, a broken .vbs - is undone and
:: the next one is tried, instead of being reported as success.

:: 1. Task Scheduler - the tidiest, and visible in a place administrators look.
schtasks /create /tn "%TASKNAME%" /tr "wscript.exe \"!DEST!\start-hidden.vbs\"" /sc ONLOGON /f >nul 2>&1
if errorlevel 1 goto try_startup
call :stopAgent
schtasks /run /tn "%TASKNAME%" >nul 2>&1
call :waitHealth
if errorlevel 1 (
  schtasks /delete /tn "%TASKNAME%" /f >nul 2>&1
  goto try_startup
)
set "AUTOSTART=Task Scheduler"
goto autostart_done

:try_startup
:: 2. Startup folder - the oldest and most permissive mechanism Windows has.
if not exist "!STARTUPDIR!" mkdir "!STARTUPDIR!" >nul 2>&1
copy /y "!DEST!\start-hidden-abs.vbs" "!STARTUPFILE!" >nul 2>&1
if not exist "!STARTUPFILE!" goto try_runkey
call :stopAgent
wscript.exe "!STARTUPFILE!"
call :waitHealth
if errorlevel 1 (
  del /f /q "!STARTUPFILE!" >nul 2>&1
  goto try_runkey
)
set "AUTOSTART=Startup folder"
goto autostart_done

:try_runkey
:: 3. The current user's Run key - no folder to be tidied away by anyone.
reg add "!RUNKEY!" /v "%TASKNAME%" /t REG_SZ /d "wscript.exe \"!DEST!\start-hidden.vbs\"" /f >nul 2>&1
if errorlevel 1 goto autostart_done
call :stopAgent
wscript.exe "!DEST!\start-hidden.vbs"
call :waitHealth
if errorlevel 1 (
  reg delete "!RUNKEY!" /v "%TASKNAME%" /f >nul 2>&1
  goto autostart_done
)
set "AUTOSTART=Run key"

:autostart_done
if defined AUTOSTART (
  echo        OK - via !AUTOSTART! ^(started and answered, not just registered^)
) else (
  echo  WARNING: None of the three startup methods could be made to start the agent on
  echo           this PC, which is unusual and suggests a policy or security product is
  echo           blocking all of them. Until that is lifted, someone must run this
  echo           after each reboot:
  echo           !DEST!\start-hidden.vbs
)

:: --- 6. Confirm it is up --------------------------------------------------
echo.
echo  [5/5] Checking the agent...

:: Registering above already started it through the real logon entry, so normally it is
:: answering by now. Only start it by hand if every mechanism was refused.
call :waitHealth
if errorlevel 1 (
  start "" wscript.exe "!DEST!\start-hidden.vbs"
  call :waitHealth
)
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
echo  Manager Console - Printer Setup.
echo.
echo  To remove later, whichever of these was used:
echo        schtasks /delete /tn "%TASKNAME%" /f
echo        del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DanbaiwaPOS Print Agent.vbs"
echo        reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "%TASKNAME%" /f
echo  ---------------------------------------------
echo.
pause
endlocal
exit /b 0

:: ===========================================================================
::  Subroutines
:: ===========================================================================

:: Stop whatever is holding port 9100, plus the raw-print helper it keeps alive, so the
:: next health check can only be answered by the agent we just started - never by one
:: left running from a moment ago.
:stopAgent
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":9100" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%P >nul 2>&1
)
taskkill /F /IM danbaiwa-rawprint.exe >nul 2>&1
for /f "delims=" %%E in ('dir /b "!DEST!\danbaiwa-rawprint-v*.exe" 2^>nul') do (
  taskkill /F /IM "%%E" >nul 2>&1
)
exit /b 0

:: Wait for the agent to answer on 9100. Returns 0 if it did, 1 if it never came up.
:: Polls rather than sleeping a fixed time: a cold till compiling the helper on first run
:: needs several seconds, a warm one answers immediately.
:waitHealth
powershell -NoProfile -Command "for ($i=0; $i -lt 20; $i++) { try { $r = Invoke-RestMethod http://127.0.0.1:9100/health -TimeoutSec 2; if ($r.ok) { exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 1"
exit /b !errorlevel!
