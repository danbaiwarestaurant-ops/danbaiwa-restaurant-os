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
 * A staff name and a business name are operator-entered and end up in innerHTML on the
 * dialog route. Nothing here is hostile in practice, but an apostrophe or an ampersand
 * in a name is ordinary and should print as itself rather than as markup.
 */
function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
    paperWidthMm?: number,
    /**
     * Facts the ticket row does not carry, resolved by the caller who has the roster.
     *
     * Kept off the stored ticket on purpose: the employee's role can change and the
     * issuer is already recorded as `cashierId`, so neither is worth a column that would
     * have to migrate, sync and then disagree with the roster later.
     */
    context?: { staffRoleText?: string; issuedByName?: string }
  ): Promise<PrintResult> {
    const formattedAmount = formatCurrency(ticket.amount, ticket.currency || '₦');

    try {
      const formattedTime = formatTimestamp(ticket.createdAt);

      const receipt = await buildTicketReceipt({
        businessName,
        amountText: formattedAmount,
        ticketId: ticket.id,
        timestampText: formattedTime,
        // Cash prints nothing — see ReceiptSpec.tenderText.
        tenderText: ticket.tender === 'transfer' ? 'PAID BY TRANSFER / POS' : undefined,
        // Selects the staff-meal layout entirely — see composeStaffMeal. Driven off the
        // stored tender, so a reprint is the same document as the original.
        staffMeal:
          ticket.tender === 'staff'
            ? {
                forName: ticket.staffName || 'Staff',
                roleText: context?.staffRoleText,
                description: ticket.mealDescription,
                issuedBy: context?.issuedByName,
              }
            : undefined,
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
      await PrintAdapter.printViaDialog(ticket, businessName, paperWidthMm, context);

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
   * the browser's own print path can render.
   *
   * This is the route a till without a paired printer lands on, which makes it the most
   * visible one, not the least — and it has to render BOTH documents. It previously
   * rendered only the sale layout, so a till on this route printed staff meals as
   * ordinary tickets with the amount four times the body height: exactly the misreading
   * the separate layout exists to prevent, on the route most likely to be in use.
   */
  private static async printViaDialog(
    ticket: Ticket,
    businessName: string,
    paperWidthMm?: number,
    context?: { staffRoleText?: string; issuedByName?: string }
  ): Promise<void> {
    const paper = paperSpec(paperWidthMm);
    const formattedAmount = formatCurrency(ticket.amount, ticket.currency || '₦');
    const formattedTime = formatTimestamp(ticket.createdAt);
    const wrap = (inner: string) =>
      `<div style="width: ${paper.widthMm}mm; margin: 0 auto; font-family: 'Courier New', monospace;">${inner}</div>`;

    const receiptHtml =
      ticket.tender === 'staff'
        ? // The same inverted hierarchy as composeStaffMeal: the person is the headline,
          // the amount is a record line. Kept in step with it by eye — the two renderers
          // have no shared representation, so any change to one belongs in both.
          wrap(`
        <div style="text-align: center; font-weight: 900; font-size: 22px; line-height: 1.1;">
          STAFF MEAL
        </div>
        <div style="text-align: center; font-weight: 900; font-size: 13px; letter-spacing: 1px;">
          NOT FOR SALE
        </div>
        <div style="text-align: center; font-size: 12px; margin-top: 2px;">
          ${escapeHtml(businessName)}
        </div>
        <div style="border-top: 1px dashed #000; margin: 5px 0;"></div>
        <div style="text-align: center; font-size: 26px; font-weight: 900; line-height: 1.1;">
          ${escapeHtml(ticket.staffName || 'Staff')}
        </div>
        ${
          context?.staffRoleText
            ? `<div style="text-align: center; font-size: 12px;">${escapeHtml(context.staffRoleText)}</div>`
            : ''
        }
        <div style="border-top: 1px dashed #000; margin: 5px 0;"></div>
        ${
          ticket.mealDescription
            ? `<div style="font-size: 12px; font-weight: 900;">Meal</div><div style="font-size: 36px; line-height: 1.05; text-align: center; font-weight: 900; overflow-wrap: anywhere; margin: 3px 0 6px;">${escapeHtml(
                ticket.mealDescription
              )}</div>`
            : ''
        }
        <div style="font-size: 12px; display: flex; justify-content: space-between;">
          <span>Meal value</span><span>${escapeHtml(formattedAmount)}</span>
        </div>
        ${
          context?.issuedByName
            ? `<div style="font-size: 12px; display: flex; justify-content: space-between;"><span>Issued by</span><span>${escapeHtml(
                context.issuedByName
              )}</span></div>`
            : ''
        }
        <div style="font-size: 11px; word-break: break-all;">${escapeHtml(ticket.id)}</div>
        <div style="font-size: 11px; color: #333;">${escapeHtml(formattedTime)}</div>
      `)
        : wrap(`
        <div style="text-align: center; font-weight: 900; font-size: 22px; line-height: 1.1; margin-bottom: 4px;">
          ${escapeHtml(businessName)}
        </div>
        <div style="border-top: 1px dashed #000; margin: 4px 0;"></div>
        <div style="text-align: center; font-size: 52px; font-weight: 900; line-height: 1; margin: 6px 0;">
          ${escapeHtml(formattedAmount)}
        </div>
        <div style="border-bottom: 1px dashed #000; margin: 4px 0;"></div>
        <div style="text-align: center; font-size: 12px; font-weight: bold; word-break: break-all;">
          ${escapeHtml(ticket.id)}
        </div>
        <div style="text-align: center; font-size: 11px; color: #333;">
          ${escapeHtml(formattedTime)}
        </div>
      `);

    const printContainer = document.getElementById('thermalPrintArea');
    if (printContainer) printContainer.innerHTML = receiptHtml;
    if (typeof window !== 'undefined' && window.print) {
      setTimeout(() => window.print(), 50);
    }
  }
}
