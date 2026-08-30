/**
 * print-server.cjs
 *
 * Danbaiwa Restaurant OS — Silent Thermal Print Server
 *
 * Listens on http://127.0.0.1:9100. The React app (whether running on
 * localhost during development OR loaded from the Vercel-hosted PWA over
 * HTTPS) POSTs receipt HTML to /print. This server renders it with
 * Playwright's headless Chromium into a 58mm PDF and sends it straight to
 * the connected thermal printer via pdf-to-printer — zero browser or OS
 * print dialog, ever.
 *
 * Vercel PWA → HTTPS page → fetch('http://127.0.0.1:9100/print')
 *   Chrome allows this via the Private Network Access spec.
 *   We respond with Access-Control-Allow-Private-Network: true so Chrome's
 *   preflight passes, and we whitelist the Vercel domain in CORS.
 *
 * Run with:  node print-server.cjs
 * Set printer: PRINT_PRINTER="My Printer" node print-server.cjs
 * Set Vercel URL: VERCEL_URL="https://your-app.vercel.app" node print-server.cjs
 */

'use strict';

const express    = require('express');
const { chromium } = require('playwright');
const printer    = require('pdf-to-printer');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');

const PORT = 9100;
// Default to the POS-58 thermal printer. Can be overridden per request.
const DEFAULT_PRINTER = process.env.PRINT_PRINTER || 'POS-58 11.3.0.1';
const app  = express();

// ── Allowed origins ───────────────────────────────────────────────────────────
// Add your production Vercel URL via the VERCEL_URL env var, e.g.:
//   VERCEL_URL=https://danbaiwa-restaurant-os.vercel.app node print-server.cjs
// Or set it permanently in the Windows Service environment (see till-setup.bat).

const VERCEL_ORIGIN = process.env.VERCEL_URL ? process.env.VERCEL_URL.replace(/\/$/, '') : null;

const ALLOWED_ORIGINS = new Set([
  // Local dev (any Vite port 5173–5180)
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:5177',
  'http://localhost:5178',
  'http://localhost:5179',
  'http://localhost:5180',
  'http://127.0.0.1:5173',
  // Production Vercel PWA (set via env var)
  ...(VERCEL_ORIGIN ? [VERCEL_ORIGIN] : []),
]);

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));

// CORS + Chrome Private Network Access
// Chrome requires Access-Control-Allow-Private-Network: true when an HTTPS
// page (Vercel) makes a request to an HTTP local server (127.0.0.1:9100).
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // Required for Chrome Private Network Access preflight (HTTPS → localhost)
  res.header('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Health check (used by PrintAdapter to detect if server is running) ────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'Danbaiwa Print Server', port: PORT });
});

// ── Silent print endpoint ─────────────────────────────────────────────────────

app.post('/print', async (req, res) => {
  const { html, ticketId, printerName } = req.body;

  if (!html) {
    return res.status(400).json({ success: false, error: 'Missing html body' });
  }

  const tmpFile = path.join(
    os.tmpdir(),
    `danbaiwa-receipt-${ticketId || Date.now()}.pdf`
  );

  let browser = null;

  try {
    // 1. Render receipt HTML → PDF via headless Chromium (Playwright).
    //    page.pdf() never calls window.print() — it directly generates PDF
    //    bytes, so no dialog can appear at this stage.
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Wrap the raw HTML snippet in a minimal page so fonts and styles load
    const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Courier New', monospace;
      width: 58mm;
      padding: 2mm 1mm;
      background: #fff;
      color: #000;
    }
  </style>
</head>
<body>${html}</body>
</html>`;

    await page.setContent(fullHtml, { waitUntil: 'load' });

    await page.pdf({
      path: tmpFile,
      width: '58mm',         // POS-58 thermal roll width
      height: '297mm',       // Tall enough for any receipt; unused space trimmed by printer
      printBackground: true,
      margin: { top: '2mm', right: '1mm', bottom: '2mm', left: '1mm' },
    });

    await browser.close();
    browser = null;

    // 2. Send PDF silently to the named thermal printer.
    //    pdf-to-printer uses SumatraPDF internally — zero dialog, zero UI.
    const targetPrinter = printerName || DEFAULT_PRINTER;
    await printer.print(tmpFile, { printer: targetPrinter });

    console.log(`[Print Server] ✓ Printed ticket #${ticketId} → ${printerName || 'default printer'}`);
    res.json({ success: true, ticketId });

  } catch (err) {
    console.error('[Print Server] ✗ Error:', err.message);
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    res.status(500).json({ success: false, error: err.message });

  } finally {
    // Clean up temp PDF regardless of outcome
    fs.unlink(tmpFile, () => {});
  }
});

// ── List available printers (useful for configuration UI) ─────────────────────

app.get('/printers', async (_req, res) => {
  try {
    const list = await printer.getPrinters();
    res.json({ printers: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Danbaiwa Restaurant OS — Print Server      ║');
  console.log(`║   Silent thermal printing on port ${PORT}      ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Health : http://127.0.0.1:${PORT}/health`);
  console.log(`  Print  : POST http://127.0.0.1:${PORT}/print`);
  console.log(`  Printers: GET http://127.0.0.1:${PORT}/printers`);
  console.log('');
  console.log('  Waiting for print jobs...');
  console.log('');
});
