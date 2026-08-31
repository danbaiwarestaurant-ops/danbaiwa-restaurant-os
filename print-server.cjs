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

// Roll width. 58mm is the POS-58; set PRINT_WIDTH_MM=80 for an 80mm printer.
const WIDTH_MM = Number(process.env.PRINT_WIDTH_MM) || 58;
/**
 * Blank paper fed after the last line, in mm.
 *
 * Zero by default: the page is cut to the exact height of the receipt, so the roll
 * advances by the receipt and nothing more. Raise it (PRINT_FEED_MM=4) only if the
 * printer's tear bar sits far enough past the head that the final line needs pushing
 * clear before it can be torn off.
 */
const FEED_MM = Number(process.env.PRINT_FEED_MM) || 0;

/** CSS reference pixels per millimetre, at the 96dpi Chromium lays out to. */
const PX_PER_MM = 96 / 25.4;

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

// ── Receipt → PDF ─────────────────────────────────────────────────────────────

/**
 * Renders a receipt HTML snippet to a PDF page cut to exactly the receipt's height.
 *
 * Exported so the page sizing can be checked without sending anything to a printer.
 * Returns the page dimensions actually used.
 */
async function renderReceiptPdf(html, outFile) {
  // page.pdf() never calls window.print() — it generates PDF bytes directly, so no
  // dialog can appear at this stage.
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    // Side padding only. Vertical padding here would reappear as blank roll at the top
    // and bottom of every ticket, which is exactly what we are removing. #receipt gets
    // `overflow: hidden` so it establishes a block formatting context: without it the
    // first and last children's margins collapse *through* it and the measurement below
    // comes out short, clipping the last line.
    const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: #fff; color: #000; }
    body {
      font-family: 'Courier New', monospace;
      width: ${WIDTH_MM}mm;
      padding: 0 1mm;
    }
    #receipt { overflow: hidden; }
  </style>
</head>
<body><div id="receipt">${html}</div></body>
</html>`;

    // Lay out at the true roll width and under print rules, so the height measured is
    // the height the PDF will actually be.
    await page.setViewportSize({ width: Math.round(WIDTH_MM * PX_PER_MM), height: 800 });
    await page.emulateMedia({ media: 'print' });
    await page.setContent(fullHtml, { waitUntil: 'load' });

    /**
     * Cut the page to the receipt.
     *
     * This used to be a fixed `height: '297mm'` — very nearly a full A4 sheet — on the
     * assumption that the printer would trim what it did not need. It does not: the roll
     * advances by the whole declared page length, so a 60mm ticket fed roughly 300mm of
     * paper and came out surrounded by blank tape.
     */
    const contentPx = await page.evaluate(() => {
      const el = document.getElementById('receipt');
      return Math.ceil(el ? el.getBoundingClientRect().height : document.body.scrollHeight);
    });
    const heightMm = Math.max(10, contentPx / PX_PER_MM + FEED_MM);

    await page.pdf({
      path: outFile,
      width: `${WIDTH_MM}mm`,
      height: `${heightMm.toFixed(2)}mm`,
      printBackground: true,
      // No page margin at all — the receipt's own spacing is the only spacing.
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
    });

    return { widthMm: WIDTH_MM, heightMm, contentPx };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

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

  try {
    const { heightMm } = await renderReceiptPdf(html, tmpFile);

    // Send the PDF silently to the named thermal printer. pdf-to-printer uses
    // SumatraPDF internally — zero dialog, zero UI.
    //
    // scale 'noscale' matters: left to shrink-to-fit, SumatraPDF would rescale the
    // exact-height page onto whatever paper size the driver reports and re-centre it,
    // reintroducing the blank margin above and below that the sizing above removes.
    const targetPrinter = printerName || DEFAULT_PRINTER;
    await printer.print(tmpFile, { printer: targetPrinter, scale: 'noscale' });

    console.log(
      `[Print Server] ✓ Printed ticket #${ticketId} → ${printerName || 'default printer'} ` +
      `(${WIDTH_MM}mm × ${heightMm.toFixed(1)}mm)`
    );
    res.json({ success: true, ticketId });

  } catch (err) {
    console.error('[Print Server] ✗ Error:', err.message);
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

// Only listen when run directly, so the renderer above can be required and checked
// without starting a server or touching a printer.
if (require.main === module) {
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
    console.log(`  Paper  : ${WIDTH_MM}mm roll, page cut to the receipt${FEED_MM ? `, +${FEED_MM}mm feed` : ', no feed'}`);
    console.log('');
    console.log('  Waiting for print jobs...');
    console.log('');
  });
}

module.exports = { app, renderReceiptPdf, WIDTH_MM, FEED_MM };
