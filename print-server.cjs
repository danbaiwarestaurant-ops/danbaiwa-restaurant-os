/**
 * print-server.cjs
 *
 * Danbaiwa Restaurant OS — Silent Thermal Print Agent
 *
 * Listens on http://127.0.0.1:9100 and hands receipt bytes to the Windows spooler as a
 * RAW job, so nothing renders them and no dialog can appear.
 *
 * This used to render receipt HTML through a headless Chromium into a PDF and spool that
 * — about 230MB of dependency and a second or two per ticket, to produce a layout the
 * printer driver then rescaled onto whatever paper size it believed it had. The app now
 * builds the receipt as ESC/POS bytes itself (src/services/print/escpos.ts) and posts
 * them here, so this process only has to deliver them. Playwright, the PDF step and
 * pdf-to-printer are all gone.
 *
 * RAW matters: a spooler job of type RAW is passed to the device untouched, bypassing
 * the driver's rendering entirely. That is what makes the output identical to the
 * browser writing to the printer directly, and what removes the page-size guesswork.
 *
 * This agent is now the SECOND choice, not the first. A till whose printer the browser
 * can reach over Web Serial or WebUSB needs nothing installed at all — see
 * src/services/print/directPrinter.ts. Keep this for tills where it cannot.
 *
 * Run with:  node print-server.cjs
 * Set printer: PRINT_PRINTER="My Printer" node print-server.cjs
 * Set app URL: VERCEL_URL="https://your-app.vercel.app" node print-server.cjs
 */

'use strict';

const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 9100;
const DEFAULT_PRINTER = process.env.PRINT_PRINTER || 'POS-58 11.3.0.1';
const IS_WINDOWS = process.platform === 'win32';

const app = express();

// ── Allowed origins ───────────────────────────────────────────────────────────
const VERCEL_ORIGIN = process.env.VERCEL_URL ? process.env.VERCEL_URL.replace(/\/$/, '') : null;

const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:5177',
  'http://localhost:5178',
  'http://localhost:5179',
  'http://localhost:5180',
  'http://127.0.0.1:5173',
  ...(VERCEL_ORIGIN ? [VERCEL_ORIGIN] : []),
]);

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));

// CORS + Chrome Private Network Access.
//
// An HTTPS page calling http://127.0.0.1 is allowed only because Chrome treats loopback
// as trustworthy, and only with this header on the preflight. Chrome is in the process
// of putting that behind a user permission prompt, and Safari and Firefox never allowed
// it at all — which is the reason the browser-direct path exists and is tried first.
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Health check (used by PrintAdapter to detect if the agent is running) ─────

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'Danbaiwa Print Agent', port: PORT, raw: true });
});

// ── Raw spooling ──────────────────────────────────────────────────────────────

/**
 * The Windows half, as a PowerShell script that P/Invokes the spooler directly.
 *
 * There is no way to submit a RAW job from Node without either a native module (which
 * would put a C++ toolchain on every till) or the printer being shared over SMB (which
 * needs configuring per machine and breaks when the share name changes). winspool.drv is
 * already present on every Windows install and takes the printer by the exact name that
 * appears in Printers & scanners — the same name the operator already knows.
 *
 * OpenPrinter → StartDocPrinter(RAW) → WritePrinter → close. Anything that fails throws,
 * and PowerShell's non-zero exit is what the caller sees.
 */
const RAW_PRINT_PS1 = `
param([Parameter(Mandatory=$true)][string]$PrinterName,
      [Parameter(Mandatory=$true)][string]$FilePath)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;

public class RawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFO {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

    public static void Send(string printerName, byte[] bytes) {
        IntPtr hPrinter;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            throw new Exception("Cannot open printer '" + printerName + "'. Check the name in Printers & scanners. (Win32 " + Marshal.GetLastWin32Error() + ")");
        try {
            DOCINFO di = new DOCINFO();
            di.pDocName = "Danbaiwa Receipt";
            di.pDataType = "RAW";
            if (!StartDocPrinter(hPrinter, 1, di)) throw new Exception("StartDocPrinter failed (Win32 " + Marshal.GetLastWin32Error() + ")");
            try {
                if (!StartPagePrinter(hPrinter)) throw new Exception("StartPagePrinter failed (Win32 " + Marshal.GetLastWin32Error() + ")");
                try {
                    IntPtr buf = Marshal.AllocCoTaskMem(bytes.Length);
                    try {
                        Marshal.Copy(bytes, 0, buf, bytes.Length);
                        int written;
                        if (!WritePrinter(hPrinter, buf, bytes.Length, out written))
                            throw new Exception("WritePrinter failed (Win32 " + Marshal.GetLastWin32Error() + ")");
                    } finally { Marshal.FreeCoTaskMem(buf); }
                } finally { EndPagePrinter(hPrinter); }
            } finally { EndDocPrinter(hPrinter); }
        } finally { ClosePrinter(hPrinter); }
    }
}
"@

[RawPrinter]::Send($PrinterName, [System.IO.File]::ReadAllBytes($FilePath))
`;

let cachedScriptPath = null;

/** The helper is written once per process run, into the temp directory. */
function rawPrintScriptPath() {
  if (cachedScriptPath && fs.existsSync(cachedScriptPath)) return cachedScriptPath;
  cachedScriptPath = path.join(os.tmpdir(), 'danbaiwa-rawprint.ps1');
  fs.writeFileSync(cachedScriptPath, RAW_PRINT_PS1, 'utf8');
  return cachedScriptPath;
}

function sendRawWindows(printerName, filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', rawPrintScriptPath(),
        '-PrinterName', printerName,
        '-FilePath', filePath,
      ],
      { windowsHide: true, timeout: 20000 },
      (err, _stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim()));
        resolve();
      }
    );
  });
}

/** macOS and Linux already have a raw path through CUPS. */
function sendRawUnix(printerName, filePath) {
  return new Promise((resolve, reject) => {
    execFile('lp', ['-d', printerName, '-o', 'raw', filePath], { timeout: 20000 }, (err, _o, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve();
    });
  });
}

async function sendRaw(printerName, bytes) {
  const tmpFile = path.join(os.tmpdir(), `danbaiwa-receipt-${Date.now()}-${process.pid}.bin`);
  fs.writeFileSync(tmpFile, bytes);
  try {
    if (IS_WINDOWS) await sendRawWindows(printerName, tmpFile);
    else await sendRawUnix(printerName, tmpFile);
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

// ── Silent print endpoint ─────────────────────────────────────────────────────

app.post('/print', async (req, res) => {
  const { escpos, ticketId, printerName } = req.body || {};

  if (!escpos) {
    // The old contract posted { html }. Saying so beats "Missing escpos body" for anyone
    // running a till that has not picked up the new build yet.
    return res.status(400).json({
      success: false,
      error: req.body && req.body.html
        ? 'This agent expects ESC/POS bytes, not HTML. Reload the till so it picks up the current app build.'
        : 'Missing escpos body',
    });
  }

  const targetPrinter = printerName || DEFAULT_PRINTER;

  try {
    await sendRaw(targetPrinter, Buffer.from(escpos, 'base64'));
    console.log(`[Print Agent] ✓ Printed ticket #${ticketId} → ${targetPrinter} (raw)`);
    res.json({ success: true, ticketId });
  } catch (err) {
    console.error('[Print Agent] ✗ Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── List available printers (useful for configuration) ────────────────────────

app.get('/printers', async (_req, res) => {
  const cmd = IS_WINDOWS
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name']]
    : ['lpstat', ['-a']];

  execFile(cmd[0], cmd[1], { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: (stderr || err.message).trim() });
    const printers = String(stdout)
      .split(/\r?\n/)
      .map((l) => (IS_WINDOWS ? l.trim() : l.split(/\s+/)[0]))
      .filter(Boolean);
    res.json({ printers });
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   Danbaiwa Restaurant OS — Print Agent       ║');
    console.log(`║   Raw ESC/POS spooling on port ${PORT}         ║`);
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
    console.log(`  Health  : http://127.0.0.1:${PORT}/health`);
    console.log(`  Print   : POST http://127.0.0.1:${PORT}/print  { escpos: <base64>, ticketId }`);
    console.log(`  Printers: GET http://127.0.0.1:${PORT}/printers`);
    console.log(`  Printer : ${DEFAULT_PRINTER}`);
    console.log('');
    console.log('  Waiting for print jobs...');
    console.log('');
  });
}

module.exports = { app, sendRaw };
