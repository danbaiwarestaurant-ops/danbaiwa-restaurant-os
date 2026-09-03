@echo off
setlocal EnableExtensions

:: ===========================================================================
::  Danbaiwa Restaurant OS - Till Setup  (SUPERSEDED)
:: ===========================================================================
::  This script no longer does anything itself. Use install-print-agent.bat.
::
::  What it used to do, and why none of it is needed any more:
::
::    * npm install + npx playwright install chromium
::        The print agent had no dependencies left once the receipt stopped
::        being rendered through a headless browser. It is one file now.
::
::    * Registered the agent as a SYSTEM task at boot, needing Administrator.
::        A task running as SYSTEM cannot see a printer that was installed
::        for one user only - it accepts the job and silently prints nothing.
::        The agent now installs per-user and runs at that user's logon, so
::        it needs no Administrator password and can actually reach the
::        printer.
::
::  Kept as a signpost rather than deleted, because copies of it are sitting
::  on tills and on USB sticks, and running the old one would put a broken
::  setup back on a machine.
:: ===========================================================================

title Danbaiwa POS - Till Setup (superseded)

echo.
echo  This setup script has been replaced.
echo  ------------------------------------------------------
echo.
echo  Use  install-print-agent.bat  instead. It needs only:
echo.
echo    1. Node.js installed  (https://nodejs.org - the LTS button)
echo    2. print-server.cjs sitting next to it in the same folder
echo.
echo  No project checkout, no npm install, no Administrator.
echo.
echo  Both files can also be downloaded from inside the app:
echo    Manager Console - Printer Setup - Step 2
echo.

if exist "%~dp0install-print-agent.bat" (
  echo  ------------------------------------------------------
  choice /C YN /N /M "  Run install-print-agent.bat now? [Y/N] "
  if errorlevel 2 goto :done
  echo.
  call "%~dp0install-print-agent.bat"
  goto :eof
) else (
  echo  install-print-agent.bat was not found next to this file.
  echo  Copy it here, or download it from the app.
  echo.
)

:done
pause
endlocal
