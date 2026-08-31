import QRCode from 'qrcode';
import { Ticket } from '../../types/ticket';
import { formatCurrency, formatTimestamp } from '../../utils/currency';

export interface PrintResult {
  success: boolean;
  ticketId: string;
  message: string;
}

/**
 * The print server always runs on the LOCAL till machine at port 9100.
 * 127.0.0.1 always resolves to the machine the browser is running on —
 * so this works identically whether the PWA is loaded from localhost (dev)
 * or from the Vercel-hosted production URL (https://danbaiwa-restaurant-os.vercel.app).
 * Chrome allows HTTPS pages to call http://127.0.0.1 via Private Network Access.
 */
const PRINT_SERVER_URL = 'http://127.0.0.1:9100';

/**
 * Check once per session if the local silent-print server is reachable.
 * Cached so we don't /health-check on every single ticket.
 */
let _printServerAvailable: boolean | null = null;
let _lastCheckedAt: number = 0;
const AVAILABILITY_TTL_MS = 30_000; // re-check every 30s so a slow boot doesn't kill the session

async function isPrintServerAvailable(): Promise<boolean> {
  const now = Date.now();
  // Re-check if: never checked, or last result was false and 30s have passed
  const isStale = _printServerAvailable === false && (now - _lastCheckedAt) > AVAILABILITY_TTL_MS;
  if (_printServerAvailable !== null && !isStale) return _printServerAvailable;

  try {
    const res = await fetch(`${PRINT_SERVER_URL}/health`, {
      method: 'GET',
      // Required for Chrome Private Network Access preflight when PWA is loaded
      // from HTTPS (Vercel) and print server is on http://127.0.0.1
      headers: { 'Access-Control-Request-Private-Network': 'true' },
      signal: AbortSignal.timeout(4000), // 4s — generous enough for a cold Node boot
    });
    _printServerAvailable = res.ok;
  } catch {
    _printServerAvailable = false;
  }
  _lastCheckedAt = Date.now();
  return _printServerAvailable;
}

/** Invalidate the cached availability so the next print re-checks immediately. */
export function resetPrintServerCache(): void {
  _printServerAvailable = null;
  _lastCheckedAt = 0;
}

export class PrintAdapter {
  /**
   * Prints ticket instantly using thermal layout template.
   *
   * Strategy (in order):
   *  1. POST receipt HTML to the local Node print server (print-server.cjs).
   *     The server renders it with Playwright → PDF → pdf-to-printer.
   *     Result: completely silent, zero browser or OS dialog.
   *  2. If the print server is not running, fall back to window.print().
   *     This still works for development / non-kiosk use.
   */
  static async printTicket(
    ticket: Ticket,
    businessName: string = 'Danbaiwa Restraunt'
  ): Promise<PrintResult> {
    try {
      const formattedAmount = formatCurrency(ticket.amount, ticket.currency || '₦');
      const formattedTime = formatTimestamp(ticket.createdAt);
      const qrData = ticket.qrPayload || `TICKET|${ticket.id}|${ticket.amount}|${ticket.createdAt}`;

      // Generate SVG string for QR Code
      const qrSvgString = await QRCode.toString(qrData, {
        type: 'svg',
        margin: 0,
        width: 120,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      });

      // Build the receipt HTML (shared by both print paths)
      const receiptHtml = `
        <div style="text-align: center; font-weight: bold; font-size: 16px; margin-bottom: 6px;">
          ${businessName}
        </div>
        <div style="text-align: center; font-size: 12px; color: #333; margin-bottom: 4px;">
          OFFICIAL RECEIPT / TICKET
        </div>
        <div style="border-top: 1px dashed #000; border-bottom: 1px dashed #000; padding: 8px 0; margin: 8px 0; text-align: center;">
          <div style="font-size: 34px; font-weight: 900; line-height: 1;">
            ${formattedAmount}
          </div>
        </div>
        <div style="text-align: center; font-size: 11px; margin-bottom: 6px; font-weight: bold;">
          TICKET #${ticket.id}
        </div>
        <div style="text-align: center; font-size: 10px; color: #444; margin-bottom: 10px;">
          ${formattedTime}
        </div>
        <div style="display: flex; justify-content: center; margin-bottom: 8px;">
          ${qrSvgString}
        </div>
        <div style="text-align: center; font-size: 9px; color: #666; margin-top: 4px;">
          Scan to Verify • Non-Transferable
        </div>
      `;

      // Update DOM Thermal Print Area (used by the window.print() fallback)
      const printContainer = document.getElementById('thermalPrintArea');
      if (printContainer) {
        printContainer.innerHTML = receiptHtml;
      }

      // Console ESC/POS Payload Logging (per specification)
      console.log('%c[ESC/POS Thermal Printer Job Dispatched]', 'color: #d97706; font-weight: bold;', {
        ticketId: ticket.id,
        amount: ticket.amount,
        businessName,
        qrPayload: qrData,
        timestamp: ticket.createdAt,
      });

      // ── Path 1: Silent local print server ─────────────────────────────────
      const serverAvailable = await isPrintServerAvailable();

      if (serverAvailable) {
        console.log('[PrintAdapter] Using silent print server →', PRINT_SERVER_URL);
        const resp = await fetch(`${PRINT_SERVER_URL}/print`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html: receiptHtml, ticketId: ticket.id }),
          signal: AbortSignal.timeout(15000),
        });

        const result = await resp.json();

        if (!resp.ok || !result.success) {
          throw new Error(result.error || `Print server responded ${resp.status}`);
        }

        return {
          success: true,
          ticketId: ticket.id,
          message: `Printed ticket #${ticket.id} (${formattedAmount}) — silent`,
        };
      }

      // ── Path 2: Fallback — window.print() ─────────────────────────────────
      console.warn('[PrintAdapter] Print server not available — falling back to window.print()');
      if (typeof window !== 'undefined' && window.print) {
        setTimeout(() => {
          window.print();
        }, 50);
      }

      return {
        success: true,
        ticketId: ticket.id,
        message: `Printed ticket #${ticket.id} (${formattedAmount})`,
      };

    } catch (error: any) {
      // If the print server call itself threw, invalidate the cache so the
      // next ticket re-checks availability rather than hammering a broken server.
      resetPrintServerCache();
      console.error('[Thermal Print Adapter Error]:', error);
      return {
        success: false,
        ticketId: ticket.id,
        message: error?.message || 'Print dispatch failed',
      };
    }
  }
}
