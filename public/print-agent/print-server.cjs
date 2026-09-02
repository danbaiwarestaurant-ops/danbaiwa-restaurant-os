/**
 * print-server.cjs
 *
 * Danbaiwa Restaurant OS — Silent Thermal Print Agent
 *
 * Listens on http://127.0.0.1:9100 and hands receipt bytes to the Windows spooler as a
 * RAW job, so nothing renders them and no dialog can appear.
 *
 * ── Zero dependencies, on purpose ────────────────────────────────────────────
 *
 * This file requires nothing but Node itself. That is the whole install story on a till:
 * install Node, copy this one file, run the installer batch. No project checkout, no
 * npm install, no node_modules, no internet after Node is on the machine.
 *
 * It used to need Express, Playwright and pdf-to-printer — about 230MB — because it
 * rendered receipt HTML through a headless Chromium into a PDF and spooled that, taking
 * a second or two per ticket and letting the printer driver rescale the result onto
 * whatever paper size it believed it had. The app now builds the receipt as ESC/POS
 * bytes itself (src/services/print/escpos.ts), so this process only has to deliver them.
 *
 * RAW matters: a spooler job of type RAW is passed to the device untouched, bypassing
 * the driver's rendering entirely. That is what makes the output identical to the
 * browser writing to the printer directly, and what removes the page-size guesswork.
 *
 * This agent is the SECOND choice. A till whose printer the browser can reach over Web
 * Serial needs nothing installed at all — see src/services/print/directPrinter.ts. Keep
 * this for tills where it cannot.
 *
 * Run with:  node print-server.cjs
 * Set printer: PRINT_PRINTER="My Printer" node print-server.cjs
 * Set app URL: VERCEL_URL="https://your-app.vercel.app" node print-server.cjs
 */

'use strict';

const http = require('node:http');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = Number(process.env.PRINT_PORT) || 9100;
const DEFAULT_PRINTER = process.env.PRINT_PRINTER || 'POS-58 11.3.0.1';
const IS_WINDOWS = process.platform === 'win32';

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
        if (err) return reject(new Error(String(stderr || err.message).trim()));
        resolve();
      }
    );
  });
}

/** macOS and Linux already have a raw path through CUPS. */
function sendRawUnix(printerName, filePath) {
  return new Promise((resolve, reject) => {
    execFile('lp', ['-d', printerName, '-o', 'raw', filePath], { timeout: 20000 }, (err, _o, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim()));
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

function listPrinters() {
  return new Promise((resolve, reject) => {
    const [cmd, args] = IS_WINDOWS
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name']]
      : ['lpstat', ['-a']];

    execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim()));
      resolve(
        String(stdout)
          .split(/\r?\n/)
          .map((l) => (IS_WINDOWS ? l.trim() : l.split(/\s+/)[0]))
          .filter(Boolean)
      );
    });
  });
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // An HTTPS page reaching http://127.0.0.1 is allowed only because Chrome treats
  // loopback as trustworthy, and only with this header on the preflight. Chrome is
  // moving that behind a permission prompt, and Safari and Firefox never allowed it —
  // which is why the browser-direct path exists and is tried first.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/** Body reader with a hard ceiling, so a stuck or hostile client cannot exhaust memory. */
function readJsonBody(req, limitBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, service: 'Danbaiwa Print Agent', port: PORT, raw: true });
  }

  if (req.method === 'GET' && url.pathname === '/printers') {
    try {
      return sendJson(res, 200, { printers: await listPrinters() });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/print') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { success: false, error: err.message });
    }

    const { escpos, ticketId, printerName } = body;

    if (!escpos) {
      // The old contract posted { html }. Saying so beats "Missing escpos body" for
      // anyone running a till that has not picked up the new build yet.
      return sendJson(res, 400, {
        success: false,
        error: body.html
          ? 'This agent expects ESC/POS bytes, not HTML. Reload the till so it picks up the current app build.'
          : 'Missing escpos body',
      });
    }

    const targetPrinter = printerName || DEFAULT_PRINTER;

    try {
      await sendRaw(targetPrinter, Buffer.from(escpos, 'base64'));
      console.log(`[Print Agent] OK  ticket #${ticketId} -> ${targetPrinter} (raw)`);
      return sendJson(res, 200, { success: true, ticketId });
    } catch (err) {
      console.error('[Print Agent] ERR', err.message);
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  sendJson(res, 404, { error: 'Not found' });
});

// ── Start ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  // Loopback only: the app always calls 127.0.0.1, so there is no reason for this to be
  // reachable from the network, and every reason for it not to be.
  server.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('  Danbaiwa Restaurant OS - Print Agent');
    console.log('  ------------------------------------');
    console.log(`  Health  : http://127.0.0.1:${PORT}/health`);
    console.log(`  Print   : POST http://127.0.0.1:${PORT}/print  { escpos: <base64>, ticketId }`);
    console.log(`  Printers: GET  http://127.0.0.1:${PORT}/printers`);
    console.log(`  Printer : ${DEFAULT_PRINTER}`);
    console.log('');
    console.log('  Waiting for print jobs...');
    console.log('');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Print Agent] Port ${PORT} is already in use — the agent is probably already running.`);
      process.exit(1);
    }
    throw err;
  });
}

module.exports = { server, sendRaw, listPrinters };
