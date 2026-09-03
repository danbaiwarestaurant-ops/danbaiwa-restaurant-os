# Danbaiwa Restaurant OS — Thermal Printing Setup

Three printing routes. The app tries them in order and uses the first that works, so a
till is never left unable to issue a ticket.

| | Route 1 — Direct from the page | Route 2 — Local print agent | Route 3 — `--kiosk-printing` |
|---|---|---|---|
| **Silent** | ✅ | ✅ | ✅ |
| **Installed on the till** | Nothing | Node.js + 2 files | Nothing |
| **Works from the Vercel link** | ✅ | ✅ (see caveat) | ✅ |
| **Works offline** | ✅ | ✅ | ✅ |
| **Browsers** | Chrome / Edge, desktop | Chrome / Edge | Chrome only |
| **Setup per till** | One click to pair | ~3 min, no admin | Launch from a `.bat` |

All three print **the same receipt**. It is built once, as ESC/POS bytes, in
`src/services/print/escpos.ts`, at whichever roll width the account is set to.

---

## Roll width — 58mm or 80mm

Set it in **Manager Console → Settings → Receipt Printer**.

It is stored with the **account**, not the machine, so it follows the owner to every till
they sign in on. An account that moves to 80mm printers changes it once, from anywhere.
Accounts that have never touched the setting print at 58mm.

---

# Route 1 — Direct from the page (recommended)

## How it works

The page writes receipt bytes to the printer itself over **Web Serial**, so no server,
no agent and no installed software is involved at any point.

```
Cashier taps ticket → escpos.ts builds the bytes → Web Serial → printer
```

Permission is granted once per till and remembered by the browser for that address,
including offline. This route works exactly as-is from the Vercel PWA — nothing about
your deployment changes.

## Will my installed printer driver be a problem?

**No, if the printer has a COM port.** Web Serial talks to the COM port; the Windows
print driver is a separate thing and the two coexist happily. Nothing needs uninstalling
or changing.

Check first — **Device Manager → Ports (COM & LPT)**:

- **The printer (or a USB-serial bridge such as CH340, CP210x, FTDI, Prolific) is listed**
  → you are ready. Go to Setup below.
- **Nothing there, printer only under "Printers"** → the browser cannot reach it this
  way. Use **Route 2**. There is a WebUSB option in Settings, but read the warning on it
  first: making it work means rebinding the printer to WinUSB with a tool like Zadig,
  which **removes it from Printers & scanners for everything else on that PC**. Not worth
  it when Route 2 exists.

## Setup

1. Open the till and sign in as admin.
2. **Manager Console → Settings → Receipt Printer**.
3. Set the roll width (58mm or 80mm).
4. Click **Pair Printer**. Chrome shows its own device chooser — pick the printer's COM
   port.
5. Click **Test Print**. A test receipt should come out.

That is the whole setup. Repeat per till.

## If the chooser is empty

No COM port exists — see the Device Manager check above.

## If the test print comes out as garbage characters

The baud rate is wrong. Most of these printers are 9600 (the default here); some are
19200, 38400 or 115200. The printer's self-test page (hold FEED while powering on)
usually prints its baud rate. Tell me which and I will make it selectable in Settings.

---

# Route 2 — Local print agent

For tills whose printer has no COM port.

## How it works

A small Node server runs invisibly on the till and listens on `127.0.0.1:9100`. The app
posts the **same ESC/POS bytes** to it, and it hands them to the Windows spooler as a
**RAW** job — passed to the device untouched, with no driver rendering and no dialog.

```
Cashier taps ticket → escpos.ts → POST 127.0.0.1:9100 → winspool RAW → printer
```

> **Caveat.** An HTTPS page (the Vercel PWA) is allowed to call `http://127.0.0.1` only
> because Chrome treats loopback as trustworthy. Chrome is moving that behind a user
> permission prompt, and Safari and Firefox never allowed it at all. This is why Route 1
> is preferred where the hardware permits it.

The agent no longer uses Express, Playwright or `pdf-to-printer`. It previously rendered
receipt HTML through a headless Chromium into a PDF — about 230MB of dependency and 1–2
seconds per ticket, producing a layout the driver then rescaled onto whatever paper size
it believed it had. It is now a single file with zero dependencies, and printing is
immediate.

## Setup — two files and Node

The agent has **no npm dependencies**. There is no project to clone, no `npm install`,
and nothing to download once Node is on the PC.

1. On the till, install **Node.js (LTS)** from https://nodejs.org and accept the defaults.
2. Copy these two files, together, into any folder on the till (a USB stick is fine):
   - `print-server.cjs`
   - `install-print-agent.bat`
3. Double-click **`install-print-agent.bat`**.

It lists the printers installed on that PC, asks you to type the one to use, asks for
the app URL, installs itself into the user's AppData, registers itself to start at
logon with no visible window, starts it, and confirms it is answering.

### Starting at logon

Three mechanisms are tried in order, and the installer reports which one took:

1. **Task Scheduler** — the tidiest, and where an administrator would look for it.
2. **Startup folder** (`shell:startup`) — the oldest and most permissive mechanism
   Windows has. No Administrator rights, no scheduler service.
3. **The current user’s Run key** — `HKCU\…\CurrentVersion\Run`.

All three are cleared before any is set, so re-running the installer never leaves two
entries racing to bind port 9100. Only if all three are refused does it fall back to
asking you to start the agent by hand — and that points at a Group Policy or a security
product rather than at the till.

If you have been starting it from a shortcut yourself, delete that shortcut after
running the installer again. A duplicate is harmless — the second copy exits because the
port is taken — but it is one more thing to explain later.

**No Administrator rights needed.** It installs per-user and runs at that user's logon,
deliberately: a task running as SYSTEM cannot see a printer that was installed for one
user only, and would silently print nothing.

### Speed, and where the wait actually is

The agent starts the raw-print helper once and keeps it alive with an open printer
handle. A receipt costs a pipe write — about **1ms**, measured — where launching a
process per receipt cost **129ms** on a fast machine and more on a till.

That is the whole of the app’s share. Anything left is the **Windows print spooler**,
which queues each job to disk and schedules it, and which no amount of work in this
repository can shorten. To remove it:

> Settings → Printers & scanners → your printer → Printer properties → **Advanced** →
> **Print directly to the printer**. On the same tab, make sure *Start printing after
> last page is spooled* is not selected.

To tell the two apart, print a test receipt from Manager Console → Printer Setup: it
reports how many milliseconds the app took. A small number there with a slow paper feed
means the spooler, not the app. The agent also logs its own timing per job
(`OK ticket #123 -> PRINTER (raw, 4ms)`).

### Updating it later

Copy the newer `print-server.cjs` over
`%LOCALAPPDATA%\DanbaiwaPOS\PrintAgent\print-server.cjs` and log out and back in. The
till's printer name and URL live in `run-agent.cmd` beside it and are left alone.

### Changing the printer

Run `install-print-agent.bat` again and type a different name.

## Check it

```powershell
Invoke-RestMethod http://127.0.0.1:9100/health
# { ok = True; service = Danbaiwa Print Agent; port = 9100; raw = True }

Invoke-RestMethod http://127.0.0.1:9100/printers
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PRINT_PRINTER` | `POS-58 11.3.0.1` | Exact Windows printer name |
| `VERCEL_URL` | *(none)* | Your app URL, allowed through CORS |

The agent binds to `127.0.0.1` only, so it is not reachable from the network.

## Removing it

```powershell
schtasks /delete /tn "DanbaiwaPOS_PrintAgent" /f
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\DanbaiwaPOS"
```

---

# Route 3 — `--kiosk-printing`

The last resort, used automatically when neither route above is available.

A browser launched with `--kiosk-printing` intercepts `window.print()` and sends the job
straight to the Windows default printer. Use `Launch POS (Vercel).bat`, which finds
Chrome or Edge automatically — set `BROWSER` at the top of that file to force one.

**The browser must be fully closed first.** If it is already running, the new window joins
the existing process, which was started without the flag, and the dialog comes back. The
`.bat` handles this with `taskkill`.

Limitations: Chromium browsers only (Chrome, Edge), page size decided by the driver rather
than the app, and a client who simply opens the URL in an ordinary browser gets the print
dialog.

### A till stuck on an old version

A service worker registration belongs to the browser, not to the machine, and can get
wedged for one site: that browser alone keeps serving an old build however often it is
reloaded, while every other device — and the other browser on the same PC — is fine.

In the app: Settings > App Version shows the build, and **Reinstall the app on this till**
clears it. From outside: F12 > Application > Service workers > Unregister, then
Ctrl+Shift+R. Or set `BROWSER=EDGE` in the launcher and move on; nothing is lost by it.

---

## Troubleshooting

**A print dialog appears**
No printer is paired and the agent is not running — the till has fallen through to
Route 3. Pair the printer in Settings, or check `http://127.0.0.1:9100/health`.

**"Not paired" and the Pair button is missing**
The Settings panel says why. Usually the address is not a secure origin (plain `http://`
on a LAN IP), which blocks Web Serial entirely. Open the till over `https://` or
`localhost`.

**Receipt prints but the QR does not scan**
The QR is sent as a raster image sized to the head, so this is normally the roll width
being wrong — an 80mm layout on a 58mm head is cropped. Check Settings → Roll Width.

**Receipt is cut mid-line**
The cutter sits past the print head. `escpos.ts` feeds before cutting; if your printer
needs more, raise the feed in `cutAndFeed()`.

**Nothing prints and nothing errors**
Check the printer is not paused or offline in Printers & scanners. A RAW job to a paused
queue is accepted and simply waits.
