import { Ticket } from '../../types/ticket';
import { formatCurrency, formatTimestamp } from '../../utils/currency';
import { buildTicketReceipt, bytesToBase64, paperSpec } from './escpos';
import { isDirectPrinterReady, printDirect, resetDirectPrinterCache } from './directPrinter';

export interface PrintResult {
  success: boolean;
  ticketId: string;
  message: string;
  /** Which route actually carried the receipt — surfaced so a till that has silently
   *  fallen back to the print dialog can be noticed before a busy service. */
  route?: 'direct' | 'agent' | 'dialog';
}

/**
 * The print server always runs on the LOCAL till machine at port 9100.
 * 127.0.0.1 always resolves to the machine the browser is running on —
 * so this works identically whether the PWA is loaded from localhost (dev)
 * or from the Vercel-hosted production URL.
 *
 * Second choice rather than first: an HTTPS page reaching http://127.0.0.1 depends on a
 * loopback exemption Chrome is moving behind a permission prompt, and which Safari and
 * Firefox never granted. Direct printing has no such dependency.
 */
const PRINT_SERVER_URL = 'http://127.0.0.1:9100';

/**
 * Check once per session if the local silent-print server is reachable.
 * Cached so we don't /health-check on every single ticket.
 */
let _printServerAvailable: boolean | null = null;

async function isPrintServerAvailable(): Promise<boolean> {
  if (_printServerAvailable !== null) return _printServerAvailable;
  try {
    const res = await fetch(`${PRINT_SERVER_URL}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    _printServerAvailable = res.ok;
  } catch {
    _printServerAvailable = false;
  }
  return _printServerAvailable;
}

/** Invalidate the cached availability so the next print re-checks. */
export function resetPrintServerCache(): void {
  _printServerAvailable = null;
}

export class PrintAdapter {
  /**
   * Prints a ticket, silently wherever the till is able to.
   *
   * Three routes, tried in order of how little they depend on:
   *
   *  1. Direct to the printer from this page (Web Serial / WebUSB). Nothing installed,
   *     nothing to keep running, works from the Vercel PWA exactly as it is. Needs the
   *     printer paired once per till from Settings.
   *  2. The local agent on 127.0.0.1:9100, which now receives the same ESC/POS bytes and
   *     hands them to the Windows spooler raw. For tills whose printer the browser
   *     cannot reach directly.
   *  3. window.print(). Not silent on its own — Chrome's --kiosk-printing makes it so,
   *     and without that the operator gets a dialog. Reported as such rather than
   *     claimed as a success, because a till quietly falling back to a dialog is how a
   *     queue of unprinted tickets builds up behind a busy counter.
   *
   * The receipt itself is identical on all three: the same escpos.ts bytes, laid out for
   * whichever roll width the account is configured for.
   */
  static async printTicket(
    ticket: Ticket,
    businessName: string = 'Danbaiwa Restraunt',
    paperWidthMm?: number
  ): Promise<PrintResult> {
    const formattedAmount = formatCurrency(ticket.amount, ticket.currency || '₦');

    try {
      const formattedTime = formatTimestamp(ticket.createdAt);

      const receipt = await buildTicketReceipt({
        businessName,
        amountText: formattedAmount,
        ticketId: ticket.id,
        timestampText: formattedTime,
        paperWidthMm,
      });

      // ── Route 1: straight to the printer from this page ───────────────────
      if (await isDirectPrinterReady()) {
        try {
          await printDirect(receipt);
          return {
            success: true,
            ticketId: ticket.id,
            route: 'direct',
            message: `Printed ticket #${ticket.id} (${formattedAmount}) — silent`,
          };
        } catch (e: any) {
          // An unplugged printer must not lose the ticket: fall through to the routes
          // below rather than failing the sale.
          // The cached 'yes, a printer is there' is now suspect — re-check next ticket.
          resetDirectPrinterCache();
          console.warn('[PrintAdapter] Direct print failed, falling back:', e?.message);
        }
      }

      // ── Route 2: local agent ──────────────────────────────────────────────
      if (await isPrintServerAvailable()) {
        const resp = await fetch(`${PRINT_SERVER_URL}/print`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            escpos: bytesToBase64(receipt),
            ticketId: ticket.id,
          }),
          signal: AbortSignal.timeout(15000),
        });

        const result = await resp.json();
        if (!resp.ok || !result.success) {
          throw new Error(result.error || `Print server responded ${resp.status}`);
        }

        return {
          success: true,
          ticketId: ticket.id,
          route: 'agent',
          message: `Printed ticket #${ticket.id} (${formattedAmount}) — silent`,
        };
      }

      // ── Route 3: the browser's own print path ─────────────────────────────
      await PrintAdapter.printViaDialog(ticket, businessName, paperWidthMm);

      return {
        success: true,
        ticketId: ticket.id,
        route: 'dialog',
        message: `Ticket #${ticket.id} sent to the browser print dialog — no printer is paired with this till.`,
      };
    } catch (error: any) {
      // If the agent call itself threw, invalidate the cache so the next ticket
      // re-checks availability rather than hammering a broken server.
      resetPrintServerCache();
      console.error('[Thermal Print Adapter Error]:', error);
      return {
        success: false,
        ticketId: ticket.id,
        message: error?.message || 'Print dispatch failed',
      };
    }
  }

  /**
   * The window.print() fallback, still driven off HTML because that is the only thing
   * the browser's own print path can render. Kept in step with the ESC/POS layout above
   * so a till on this route produces a recognisably identical ticket.
   */
  private static async printViaDialog(
    ticket: Ticket,
    businessName: string,
    paperWidthMm?: number
  ): Promise<void> {
    const paper = paperSpec(paperWidthMm);
    const formattedAmount = formatCurrency(ticket.amount, ticket.currency || '₦');
    const formattedTime = formatTimestamp(ticket.createdAt);

    const receiptHtml = `
      <div style="width: ${paper.widthMm}mm; margin: 0 auto; font-family: 'Courier New', monospace;">
        <div style="text-align: center; font-weight: 900; font-size: 22px; line-height: 1.1; margin-bottom: 4px;">
          ${businessName}
        </div>
        <div style="border-top: 1px dashed #000; margin: 4px 0;"></div>
        <div style="text-align: center; font-size: 52px; font-weight: 900; line-height: 1; margin: 6px 0;">
          ${formattedAmount}
        </div>
        <div style="border-bottom: 1px dashed #000; margin: 4px 0;"></div>
        <div style="text-align: center; font-size: 12px; font-weight: bold; word-break: break-all;">
          ${ticket.id}
        </div>
        <div style="text-align: center; font-size: 11px; color: #333;">
          ${formattedTime}
        </div>
      </div>
    `;

    const printContainer = document.getElementById('thermalPrintArea');
    if (printContainer) printContainer.innerHTML = receiptHtml;
    if (typeof window !== 'undefined' && window.print) {
      setTimeout(() => window.print(), 50);
    }
  }
}
