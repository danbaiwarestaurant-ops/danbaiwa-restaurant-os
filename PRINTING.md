# Danbaiwa Restaurant OS — Thermal Printing Setup Guide

This document covers the two silent printing paths available for the Ticket POS system.
Both paths work **fully offline** — the internet is only needed on first setup.

---

## Overview

The app calls `window.print()` internally when a ticket is issued. By default this shows
a browser print dialog. Both paths below eliminate that dialog entirely, sending receipts
directly to the thermal printer with zero staff interaction.

| | Path 1 — Chrome Kiosk Flag | Path 2 — Local Print Server |
|---|---|---|
| **Silent printing** | ✅ | ✅ |
| **Works offline** | ✅ | ✅ |
| **Software to install** | Chrome only | Node.js + dependencies |
| **Setup time** | ~5 minutes | ~10 minutes |
| **Maintenance** | None | None (auto-starts at boot) |
| **Receipt layout control** | OS decides | Exact 58mm PDF |
| **Multi-printer support** | Default printer only | Per-till configuration |
| **Browser dependency** | Chrome + flag (may change) | Any browser |
| **Best for** | Single till, quick setup | Multiple tills, production use |

---

## Prerequisites (both paths)

### 1. Set the thermal printer as the Windows default printer

1. Click **Start** → type `Printers` → open **Printers & scanners**
2. Click your thermal printer (e.g. `POS-58 11.3.0.1`)
3. Click **Set as default**

This must be done on every till machine before either path will work.

### 2. First-time internet setup (install the PWA)

On each till machine, **with internet**, do this once:

1. Open Chrome and go to your Vercel app URL
2. Wait for the app to fully load (the service worker pre-caches everything in the background)
3. Click the install icon (⊕) in Chrome's address bar → **Install Ticket POS**
4. A standalone app window opens — the PWA is now installed
5. After this, the app works **fully offline** from the local service worker cache

---

---

# Path 1 — Chrome Kiosk Flag (`--kiosk-printing`)

## How it works

Chrome is launched with the `--kiosk-printing` flag on a **fresh process**.
This flag makes Chrome intercept every `window.print()` call and send the job
directly to the Windows default printer — no dialog, no click, no delay.

```
User taps ticket → window.print() → Chrome --kiosk-printing → POS-58 → receipt
```

**Critical rule:** Chrome must be fully closed before launching with this flag.
If Chrome is already open, the new window joins the existing process which was
started without the flag, and the dialog will reappear. The launcher batch file
handles this automatically with `taskkill`.

## Setup

### Step 1 — Copy the launcher to the till desktop

Copy `Launch POS (Offline PWA).bat` from the project root to the till machine's Desktop.

You can also create it manually — right-click the Desktop → New → Text Document,
paste the contents below, then save as `Launch POS.bat` (not `.txt`):

```bat
@echo off
taskkill /F /IM chrome.exe >nul 2>&1
timeout /t 2 /nobreak >nul
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --app=https://your-app.vercel.app ^
  --kiosk-printing ^
  --disable-print-preview ^
  --no-first-run ^
  --disable-infobars ^
  --disable-session-crashed-bubble
```

Replace `https://your-app.vercel.app` with your actual Vercel deployment URL.

### Step 2 — (Optional) Auto-launch at Windows startup

1. Press `Win + R` → type `shell:startup` → press Enter
2. A folder opens — copy `Launch POS.bat` into that folder

The POS will now open automatically every time the PC boots. Staff never
need to touch Windows or know the URL.

### Step 3 — Daily use

```
Power on PC
  → Windows boots → launcher runs automatically
  → Chrome opens full screen (kiosk mode, no address bar)
  → Cashier sees PIN login
  → Tap ticket → prints silently on thermal printer
```

To exit kiosk mode (manager only): press **Alt + F4**

## Configuration

| Setting | How to change |
|---|---|
| **Vercel URL** | Edit the URL in the `.bat` file |
| **Printer** | Set a different printer as the Windows default |
| **Full screen** | Remove `--kiosk` to keep windowed mode (keeps `--kiosk-printing`) |
| **Auto-start** | Place `.bat` in `shell:startup` folder |

## Advantages

- Zero software to install beyond Chrome
- Zero ongoing maintenance
- Works fully offline after first PWA install
- Takes 5 minutes to set up per till

## Limitations

- Chrome must be fully killed and restarted for the flag to apply
- Only one printer supported per machine (Windows default)
- `--kiosk-printing` is a Chrome flag — Google could deprecate it in a future version
- Full kiosk mode (`--kiosk`) hides the address bar — exit requires `Alt + F4`
- Does not work on non-Chrome browsers (Edge, Firefox, Safari)
- Receipt page size is controlled by the OS, not the app

---

---

# Path 2 — Local Print Server (`print-server.cjs`)

## How it works

A Node.js server runs invisibly on the till machine and listens on port `9100`.
When a ticket is issued, the app POSTs the receipt HTML to this server instead
of calling `window.print()`. The server renders it into an exact 58mm PDF using
Playwright's headless Chromium, then sends the PDF silently to the named thermal
printer via `pdf-to-printer`.

```
User taps ticket
  → PrintAdapter checks http://127.0.0.1:9100/health
  → POSTs receipt HTML to http://127.0.0.1:9100/print
  → print-server.cjs renders HTML → 58mm PDF (Playwright, headless, invisible)
  → pdf-to-printer sends PDF → thermal printer
  → receipt prints, zero dialog
```

If the print server is not running, the app automatically falls back to
`window.print()` — the till never breaks, it just loses silent printing.

## Setup

### Step 1 — Install Node.js

Download and install Node.js (LTS) from https://nodejs.org.
Accept all defaults during installation.

Verify it installed: open PowerShell and run:
```powershell
node --version
```
You should see something like `v22.x.x`.

### Step 2 — Copy the project to the till machine

Either:
- **Git clone**: `git clone https://github.com/danbaiwarestaurant-ops/danbaiwa-restaurant-os.git`
- **USB copy**: Copy the project folder directly (without `node_modules`)

### Step 3 — Run `till-setup.bat` as Administrator

Right-click `till-setup.bat` in the project root → **Run as administrator**.

The script will:
1. Check Node.js is installed
2. Run `npm install` (downloads all dependencies)
3. Run `npx playwright install chromium` (downloads headless Chromium, ~150MB, once)
4. Register a **Windows Task Scheduler** job called `DanbaiwaRestaurantOS_PrintServer`
   that starts the print server automatically at every boot, running as SYSTEM
   (no user login required, completely invisible)

This takes 5–10 minutes on first run depending on internet speed.

### Step 4 — Configure for this till

Before running `till-setup.bat`, open it in Notepad and set these two lines:

```bat
set VERCEL_URL=https://your-app.vercel.app
set PRINTER_NAME=POS-58 11.3.0.1
```

| Variable | Description |
|---|---|
| `VERCEL_URL` | Your Vercel deployment URL. Allows CORS from that origin. |
| `PRINTER_NAME` | Exact Windows printer name. Must match what appears in Printers & scanners. |

To find your exact printer name, open PowerShell and run:
```powershell
Get-Printer | Select-Object Name
```

### Step 5 — Test the print server

After setup, open PowerShell and run:
```powershell
Invoke-RestMethod http://127.0.0.1:9100/health
```

You should see:
```json
{ "ok": true, "service": "Danbaiwa Print Server", "port": 9100 }
```

To see all printers the server can see:
```powershell
Invoke-RestMethod http://127.0.0.1:9100/printers
```

### Step 6 — Open the PWA

Open the installed Ticket POS PWA (or use the Vercel URL in Chrome).
Issue a test ticket — the receipt should print silently on the thermal printer.
Check the print server console for confirmation:
```
[Print Server] ✓ Printed ticket #LOC01-DEV01-XXXXX → POS-58 11.3.0.1
```

## Configuration

### Environment variables

Set these before starting the print server (or permanently in `till-setup.bat`):

| Variable | Default | Description |
|---|---|---|
| `PRINT_PRINTER` | `POS-58 11.3.0.1` | Exact name of the thermal printer |
| `VERCEL_URL` | *(none)* | Your Vercel URL, e.g. `https://danbaiwa-restaurant-os.vercel.app` |

Example — start manually with a different printer:
```powershell
$env:PRINT_PRINTER="EPSON TM-T20III"; node print-server.cjs
```

### Receipt paper size

The server renders receipts at **58mm width** by default (matching the POS-58 roll).
To change to 80mm, edit `print-server.cjs`:

```javascript
// Around line 96 — change width:
await page.pdf({
  width: '80mm',   // change from '58mm'
  ...
});
```

### Allowed browser origins

The server whitelists these origins by default:
- `http://localhost:5173` through `5180` (local Vite dev)
- Your `VERCEL_URL` (production)

To add a custom domain, add it to the `ALLOWED_ORIGINS` set in `print-server.cjs`.

### API endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Returns `{ ok: true }` — used by PrintAdapter to detect the server |
| `/print` | POST | Accepts `{ html, ticketId, printerName? }` — renders and prints |
| `/printers` | GET | Returns all available printers on this machine |

## Running manually (without Windows startup task)

```powershell
# From the project root:
npm run print-server

# Or directly:
node print-server.cjs
```

## Removing the startup task

To uninstall the Windows startup task:
```powershell
schtasks /delete /tn "DanbaiwaRestaurantOS_PrintServer" /f
```

## Advantages

- Works with any browser (Chrome, Edge, Firefox, Safari, tablet browsers)
- Exact 58mm PDF receipt layout — consistent on every print
- Survives Chrome updates (independent of Chrome flags)
- Supports multiple printers — different tills can target different printers
- Completely invisible to staff — zero interaction required
- Robust fallback: app uses `window.print()` if server is down
- Full offline support — Node.js, Playwright, and the printer are all local

## Limitations

- Requires Node.js installed on each till machine (~80MB)
- Requires one-time `till-setup.bat` run per machine (10 minutes)
- Playwright's headless Chromium takes ~150MB of disk space
- Print job takes ~1–2 seconds (PDF render + print spool) vs near-instant for Path 1
- Requires the project folder to be present on the machine

---

---

## Choosing between Path 1 and Path 2

```
Single till, quick setup needed?              → Path 1
Multiple tills across locations?              → Path 2
Consistent 58mm receipt layout critical?      → Path 2
Want zero software on till beyond Chrome?     → Path 1
Need to work on tablets / non-Chrome?         → Path 2
Want to set it up in under 5 minutes?         → Path 1
Production restaurant, long-term reliability? → Path 2
```

## Can I run both at the same time?

Yes. The `PrintAdapter` checks for the local print server first. If it's running,
it uses Path 2 (silent, precise PDF). If it's not running, it falls back to
`window.print()`, which Path 1's `--kiosk-printing` then intercepts silently.

Running both gives you **maximum resilience**: if the print server ever crashes,
Path 1 catches it automatically without any staff action.

---

## Troubleshooting

### Print dialog still appears
- **Path 1**: Chrome was already open. The `.bat` file must kill Chrome first. Verify `taskkill /F /IM chrome.exe` runs before Chrome launches.
- **Path 2**: Print server is not running. Check: `Invoke-RestMethod http://127.0.0.1:9100/health`

### Print server won't start
- Check Node.js is installed: `node --version`
- Check port 9100 is free: `netstat -ano | findstr :9100`
- Check Task Scheduler: open Task Scheduler → Task Scheduler Library → look for `DanbaiwaRestaurantOS_PrintServer`

### Receipt prints to wrong printer
- **Path 1**: Go to Settings → Printers & scanners → set correct printer as default
- **Path 2**: Check `PRINT_PRINTER` env variable in `till-setup.bat` matches exact printer name

### Receipt is cut off or wrong size
- Edit `print-server.cjs` and change `width` in `page.pdf()` to match your roll (58mm or 80mm)

### App shows white screen on launch (offline)
- The PWA service worker was not installed. Open the Vercel URL in Chrome **with internet** and wait 30 seconds for full load, then install the PWA.

### CORS error in browser console (Path 2)
- Set `VERCEL_URL` in `till-setup.bat` to your exact Vercel URL (no trailing slash)
- Restart the print server after changing env vars
