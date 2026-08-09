import QRCode from 'qrcode';
import { Ticket } from '../../types/ticket';
import { formatCurrency, formatTimestamp } from '../../utils/currency';

export interface PrintResult {
  success: boolean;
  ticketId: string;
  message: string;
}

export class PrintAdapter {
  /**
   * Prints ticket instantly using thermal layout template and ESC/POS payload generator.
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

      // Update DOM Thermal Print Area
      const printContainer = document.getElementById('thermalPrintArea');
      if (printContainer) {
        printContainer.innerHTML = `
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
      }

      // Console ESC/POS Payload Logging (per specification)
      console.log('%c[ESC/POS Thermal Printer Job Dispatched]', 'color: #d97706; font-weight: bold;', {
        ticketId: ticket.id,
        amount: ticket.amount,
        businessName,
        qrPayload: qrData,
        timestamp: ticket.createdAt,
      });

      // Execute window.print() in browser preview
      if (typeof window !== 'undefined' && window.print) {
        // Trigger window print without blocking main thread
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
      console.error('[Thermal Print Adapter Error]:', error);
      return {
        success: false,
        ticketId: ticket.id,
        message: error?.message || 'Print dispatch failed',
      };
    }
  }
}
