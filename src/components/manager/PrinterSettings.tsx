import React, { useEffect, useState } from 'react';
import { Printer, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Panel, ConsoleButton } from './ConsoleUI';
import { useDeviceStore } from '../../store/useDeviceStore';
import {
  loadPrinterLink,
  clearPrinterLink,
  pairSerial,
  pairUsb,
  isSerialSupported,
  isUsbSupported,
  directPrintUnavailableReason,
  printDirect,
  PrinterLink,
} from '../../services/print/directPrinter';
import { buildTicketReceipt } from '../../services/print/escpos';

/**
 * Pairing a till with its printer, and telling the account which roll it runs on.
 *
 * The two settings live together but belong to different things, and the panel says so:
 * the roll width is the business's and follows the account to every till, while the
 * pairing is one machine's relationship with one piece of hardware and never leaves it.
 */
export const PrinterSettings: React.FC = () => {
  const { config, updateConfig } = useDeviceStore();
  const [link, setLink] = useState<PrinterLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [showUsb, setShowUsb] = useState(false);

  const blocked = directPrintUnavailableReason();
  const widthMm = config.paperWidthMm ?? 58;

  useEffect(() => {
    loadPrinterLink().then(setLink);
  }, []);

  const run = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true);
    setNote(null);
    try {
      const result = await fn();
      setNote({ ok: result.ok, text: result.message });
      setLink(await loadPrinterLink());
    } finally {
      setBusy(false);
    }
  };

  const handleUnpair = async () => {
    await clearPrinterLink();
    setLink(null);
    setNote({ ok: true, text: 'Printer unpaired. This till will use the print server or the browser dialog.' });
  };

  /** Proves the whole path end to end — bytes, transport, roll width — on real paper. */
  const handleTest = () =>
    run(async () => {
      try {
        const bytes = await buildTicketReceipt({
          businessName: config.businessName,
          amountText: 'TEST PRINT',
          ticketId: 'TEST-0000',
          timestampText: new Date().toLocaleString(),
          qrData: 'DANBAIWA|PRINTER|TEST',
          paperWidthMm: widthMm,
          footerText: 'If you can read this, silent printing works',
        });
        await printDirect(bytes);
        return { ok: true, message: 'Test receipt sent. Check the printer.' };
      } catch (e: any) {
        return { ok: false, message: e?.message || 'Test print failed.' };
      }
    });

  const label = 'block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1.5';

  return (
    <Panel
      title="Receipt Printer"
      subtitle="Silent printing straight from this page — no dialog, nothing installed"
      icon={Printer}
    >
      <div className="space-y-5">
        {/* ── Roll width: the account's, not the machine's ─────────────────── */}
        <div>
          <label className={label}>Roll Width</label>
          <div className="grid grid-cols-2 gap-2 max-w-xs">
            {([58, 80] as const).map((mm) => (
              <button
                key={mm}
                type="button"
                onClick={() => updateConfig({ paperWidthMm: mm })}
                className={`py-2.5 text-xs font-black uppercase tracking-wider border-2 rounded-none transition ${
                  widthMm === mm
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-300 hover:border-slate-400'
                }`}
              >
                {mm}mm
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] font-semibold text-slate-500">
            Follows your account to every till you sign in on. Change it once, wherever you are.
          </p>
        </div>

        {/* ── Pairing: this machine only ───────────────────────────────────── */}
        {blocked ? (
          <div className="p-3 bg-amber-50 border-2 border-amber-400 text-[11px] font-semibold text-amber-950 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <span>{blocked}</span>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className={label}>This Till&apos;s Printer</label>
              {link ? (
                <div className="flex items-center gap-2 text-xs font-bold text-emerald-800 bg-emerald-50 border-2 border-emerald-300 p-2.5">
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                  <span className="font-mono">{link.label || link.transport}</span>
                  <span className="text-[10px] font-semibold text-emerald-700 uppercase">
                    ({link.transport})
                  </span>
                </div>
              ) : (
                <div className="text-xs font-bold text-slate-500 bg-slate-50 border-2 border-slate-300 p-2.5">
                  Not paired — receipts go to the print server or the browser dialog.
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {isSerialSupported() && (
                <ConsoleButton onClick={() => run(() => pairSerial())} disabled={busy} variant="primary">
                  {link ? 'Re-pair Printer' : 'Pair Printer'}
                </ConsoleButton>
              )}
              {link && (
                <>
                  <ConsoleButton onClick={handleTest} disabled={busy}>
                    Test Print
                  </ConsoleButton>
                  <ConsoleButton onClick={handleUnpair} disabled={busy}>
                    Unpair
                  </ConsoleButton>
                </>
              )}
            </div>

            <p className="text-[11px] font-semibold text-slate-500">
              Pair once per till. The browser remembers the printer for this address, including
              offline. If the chooser is empty, the printer has no COM port — see the USB option below.
            </p>

            {/* ── WebUSB: deliberately behind a disclosure ─────────────────── */}
            {isUsbSupported() && (
              <div className="border-t border-slate-200 pt-3">
                <button
                  type="button"
                  onClick={() => setShowUsb((v) => !v)}
                  className="text-[11px] font-black uppercase tracking-wider text-slate-500 hover:text-slate-800"
                >
                  {showUsb ? '− ' : '+ '}My printer has no COM port
                </button>

                {showUsb && (
                  <div className="mt-2 space-y-2">
                    <div className="p-3 bg-rose-50 border-2 border-rose-300 text-[11px] font-semibold text-rose-900 space-y-1.5">
                      <div className="font-black uppercase">Read this before pairing over USB</div>
                      <p>
                        Windows gives the printer to its own print driver and will not share it.
                        To let the browser talk to it, the printer must be rebound to WinUSB
                        (with a tool such as Zadig) — and that <strong>removes it from Printers
                        &amp; scanners</strong>, so Word, the print server and everything else on
                        this machine lose access to it. The till becomes the only thing that can
                        print to it.
                      </p>
                      <p>
                        If the printer already works through the print server, leave this alone.
                      </p>
                    </div>
                    <ConsoleButton onClick={() => run(() => pairUsb())} disabled={busy}>
                      Pair over USB anyway
                    </ConsoleButton>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {note && (
          <div
            className={`p-2.5 border-2 text-[11px] font-bold ${
              note.ok
                ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                : 'bg-rose-50 border-rose-300 text-rose-900'
            }`}
          >
            {note.text}
          </div>
        )}
      </div>
    </Panel>
  );
};
