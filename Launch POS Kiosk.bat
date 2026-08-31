@echo off
title Danbaiwa Restaurant POS ? Kiosk Launcher

:: Step 1: Kill any existing Chrome processes (required for --kiosk-printing)
echo [1/4] Closing existing Chrome instances...
taskkill /F /IM chrome.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: Step 2: Start silent thermal print server in background
echo [2/4] Starting silent print server on port 9100...
cd /d "C:\Users\SURFACE\danbaiwa-restaurant-os"
start /min "" cmd /c "node print-server.cjs"
timeout /t 2 /nobreak >nul

:: Step 3: Start Vite dev server in background
echo [3/4] Starting POS server...
start /min "" cmd /c "npm run dev"
timeout /t 4 /nobreak >nul

:: Step 4: Launch Chrome in kiosk mode
echo [4/4] Launching POS in kiosk mode...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --kiosk ^
  --kiosk-printing ^
  --disable-print-preview ^
  --no-first-run ^
  --disable-infobars ^
  --disable-session-crashed-bubble ^
  --disable-restore-session-state ^
  http://localhost:5173/

echo.
echo Done! POS is running in kiosk mode with silent printing.
echo Press Alt+F4 to exit kiosk when needed.
