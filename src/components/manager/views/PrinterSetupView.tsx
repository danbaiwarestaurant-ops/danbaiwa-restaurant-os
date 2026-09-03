import React, { useCallback, useEffect, useState } from 'react';
import {
  Printer, CheckCircle2, AlertTriangle, XCircle, Download, ExternalLink,
  RefreshCw, Usb, HelpCircle,
} from 'lucide-react';
import { Panel, ConsoleButton } from '../ConsoleUI';
import { useDeviceStore } from '../../../store/useDeviceStore';
import {
  loadPrinterLink, clearPrinterLink, pairSerial, pairUsb,
  isSerialSupported, isUsbSupported, directPrintUnavailableReason,
  printDirect, PrinterLink,
} from '../../../services/print/directPrinter';
import { buildTicketReceipt, bytesToBase64 } from '../../../services/print/escpos';

/**
 * Printer setup, written for whoever is standing at the till rather than for whoever
 * wrote the code.
 *
 * The three printing routes and their trade-offs are a genuinely awkward thing to explain
 * — one needs a COM port, one needs Node installed, one needs Chrome launched a
 * particular way — and none of that is a shop owner's problem. So this page does not
 * present the choice at all. It checks what this machine can actually do, states in one
 * line whether receipts will print silently, and offers only the next step that applies.
 *
 * The helper files are served from the app itself (public/print-agent/), because "get
 * these two files out of a git repository" is where every till setup was going to stop.
 */

type Status = 'ready-direct' | 'ready-agent' | 'not-ready';

interface Probe {
  status: Status;
  agentRunning: boolean;
  /** null when no agent answered; a number when one did. */
  agentVersion: number | null;
  link: PrinterLink | null;
  blockedReason: string | null;
}

const AGENT_HEALTH = 'http://127.0.0.1:9100/health';

/**
 * What the current app expects the helper on this machine to be.
 *
 * Must match AGENT_VERSION in print-server.cjs. An older helper answers every health
 * check perfectly while behaving nothing like the current one — the version before this
 * spent about a second recompiling itself for every receipt — so "it is running" is not
 * the same question as "it is the right one", and the page has to ask both.
 */
const EXPECTED_AGENT_VERSION = 3;

async function probeAgent(): Promise<number | null> {
  try {
    const res = await fetch(AGENT_HEALTH, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return null;
    const body = await res.json();
    // A helper predating version reporting is version 1 by definition.
    return typeof body?.version === 'number' ? body.version : 1;
  } catch {
    return null;
  }
}

const StepNumber: React.FC<{ n: number }> = ({ n }) => (
  <span className="flex-shrink-0 w-6 h-6 bg-slate-900 text-white text-[11px] font-black flex items-center justify-center">
    {n}
  </span>
);

const Step: React.FC<{ n: number; title: string; children?: React.ReactNode }> = ({ n, title, children }) => (
  <li className="flex gap-3">
    <StepNumber n={n} />
    <div className="flex-1 pt-0.5 space-y-1.5">
      <div className="text-xs font-bold text-slate-800">{title}</div>
      {children && <div className="text-[11px] font-semibold text-slate-600 space-y-1.5">{children}</div>}
    </div>
  </li>
);

export const PrinterSetupView: React.FC = () => {
  const { config, updateConfig } = useDeviceStore();
  const [probe, setProbe] = useState<Probe | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [showUsb, setShowUsb] = useState(false);

  const widthMm = config.paperWidthMm ?? 58;

  const refresh = useCallback(async () => {
    const [link, agentVersion] = await Promise.all([loadPrinterLink(), probeAgent()]);
    const agentRunning = agentVersion !== null;
    const blockedReason = directPrintUnavailableReason();
    const status: Status = link ? 'ready-direct' : agentRunning ? 'ready-agent' : 'not-ready';
    setProbe({ status, agentRunning, agentVersion, link, blockedReason });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true);
    setNote(null);
    try {
      const result = await fn();
      setNote({ ok: result.ok, text: result.message });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  /**
   * Proves the whole path on real paper — bytes, transport and roll width together.
   *
   * It goes down whichever route a real ticket would, and reports how long that route
   * took. The timing is not decoration: it separates a slow app from a slow printer,
   * which is otherwise guesswork. If this says 200ms and the paper still appears a
   * second later, nothing left in this app can help — the wait is the Windows spooler
   * and the printer, and the note below says what to do about it.
   */
  const handleTest = () =>
    run(async () => {
      try {
        const bytes = await buildTicketReceipt({
          businessName: config.businessName,
          amountText: 'TEST',
          ticketId: 'PRINTER-TEST',
          timestampText: new Date().toLocaleString(),
          paperWidthMm: widthMm,
        });

        const startedAt = performance.now();

        if (probe?.status === 'ready-direct') {
          await printDirect(bytes);
        } else if (probe?.agentRunning) {
          const res = await fetch('http://127.0.0.1:9100/print', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ escpos: bytesToBase64(bytes), ticketId: 'PRINTER-TEST' }),
            signal: AbortSignal.timeout(20000),
          });
          const result = await res.json();
          if (!res.ok || !result.success) {
            throw new Error(result.error || `The helper answered ${res.status}.`);
          }
        } else {
          return {
            ok: false,
            message:
              'Nothing on this till can print silently yet. Finish Step 1 or Step 2 below first.',
          };
        }

        const ms = Math.round(performance.now() - startedAt);
        return {
          ok: true,
          message:
            `Test receipt sent in ${ms}ms. Check the printer. ` +
            (ms > 800
              ? 'That is slower than it should be — see "If receipts are slow" below.'
              : 'If the paper still takes noticeably longer than that, the delay is in Windows, not the app — see "If receipts are slow" below.'),
        };
      } catch (e: any) {
        return { ok: false, message: e?.message || 'Test print failed.' };
      }
    });

  const handleUnpair = () =>
    run(async () => {
      await clearPrinterLink();
      return { ok: true, message: 'Printer unpaired.' };
    });

  const banner = (() => {
    if (!probe) return { tone: 'wait', icon: RefreshCw, title: 'Checking this till...', body: '' };
    if (probe.status === 'ready-direct')
      return {
        tone: 'good', icon: CheckCircle2,
        title: 'Receipts print silently on this till',
        body: `Connected straight to ${probe.link?.label || 'the printer'}. Nothing else to do here.`,
      };
    if (probe.status === 'ready-agent')
      return {
        tone: 'good', icon: CheckCircle2,
        title: 'Receipts print silently on this till',
        body: 'Using the printer helper installed on this computer.',
      };
    return {
      tone: 'bad', icon: XCircle,
      title: 'Receipts will show a print dialog',
      body: 'Someone has to click Print on every ticket. Follow the steps below to fix it.',
    };
  })();

  const BannerIcon = banner.icon;

  return (
    <div className="space-y-4">
      {/* ── One line: does this till print silently or not ───────────────── */}
      <div
        className={`border-2 p-4 flex items-start gap-3 ${
          banner.tone === 'good'
            ? 'bg-emerald-50 border-emerald-400'
            : banner.tone === 'bad'
              ? 'bg-rose-50 border-rose-400'
              : 'bg-slate-50 border-slate-300'
        }`}
      >
        <BannerIcon
          className={`w-6 h-6 flex-shrink-0 ${
            banner.tone === 'good' ? 'text-emerald-600' : banner.tone === 'bad' ? 'text-rose-600' : 'text-slate-400'
          }`}
        />
        <div className="flex-1">
          <div className="text-sm font-black uppercase tracking-wide text-slate-900">{banner.title}</div>
          {banner.body && <div className="text-xs font-semibold text-slate-700 mt-0.5">{banner.body}</div>}
        </div>
        <button
          type="button"
          onClick={refresh}
          className="text-[10px] font-black uppercase tracking-wider text-slate-500 hover:text-slate-900 flex items-center gap-1"
        >
          <RefreshCw className="w-3 h-3" />
          Re-check
        </button>
      </div>

      {probe?.agentRunning && probe.agentVersion !== null && probe.agentVersion < EXPECTED_AGENT_VERSION && (
        <div className="border-2 border-amber-400 bg-amber-50 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
          <div className="space-y-1.5">
            <div className="text-xs font-black uppercase tracking-wide text-amber-950">
              The printer helper on this computer is out of date
            </div>
            <p className="text-[11px] font-semibold text-amber-900">
              Receipts still print, but slower than they need to — every version of the
              helper so far has been mainly about removing delay between the button and the
              paper. Download both files again from Step 2 below and run the installer; it
              replaces the running helper in place.
            </p>
          </div>
        </div>
      )}

      {note && (
        <div
          className={`p-3 border-2 text-xs font-bold ${
            note.ok ? 'bg-emerald-50 border-emerald-300 text-emerald-900' : 'bg-rose-50 border-rose-300 text-rose-900'
          }`}
        >
          {note.text}
        </div>
      )}

      {/* ── Paper size: the account's, not the machine's ──────────────────── */}
      <Panel title="Paper Size" subtitle="Which receipt roll this business uses" icon={Printer}>
        <div className="grid grid-cols-2 gap-2 max-w-xs">
          {([58, 80] as const).map((mm) => (
            <button
              key={mm}
              type="button"
              onClick={() => updateConfig({ paperWidthMm: mm })}
              className={`py-3 text-sm font-black uppercase tracking-wider border-2 rounded-none transition ${
                widthMm === mm
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-300 hover:border-slate-400'
              }`}
            >
              {mm}mm
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] font-semibold text-slate-500">
          Not sure? Measure the paper roll across. Most small till rolls are 58mm; the wider
          ones are 80mm. This is saved to your account, so every till you sign in on uses it —
          you only set it once.
        </p>
      </Panel>

      {/* ── Step 1: connect the printer ───────────────────────────────────── */}
      <Panel
        title="Step 1 — Connect the printer to this till"
        subtitle="Takes about ten seconds, and nothing gets installed"
        icon={Printer}
      >
        {probe?.blockedReason ? (
          <div className="p-3 bg-amber-50 border-2 border-amber-400 text-[11px] font-semibold text-amber-950 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <span>{probe.blockedReason}</span>
          </div>
        ) : (
          <div className="space-y-3">
            {probe?.link ? (
              <div className="flex items-center gap-2 text-xs font-bold text-emerald-900 bg-emerald-50 border-2 border-emerald-300 p-3">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-600" />
                <span className="font-mono">{probe.link.label || probe.link.transport}</span>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-600">
                  Make sure the printer is plugged in and switched on, then press the button
                  below. Your browser will show a small list — pick the printer and press
                  Connect.
                </p>
                <p className="text-[11px] font-semibold text-amber-900 bg-amber-50 border border-amber-300 p-2">
                  <strong>Printer plugged in by USB and already set up in Windows?</strong>{' '}
                  It will usually not work here — Windows keeps that printer to itself. Try
                  this once, and if it fails, go straight to Step 2. That is the normal
                  route for USB printers, and it works just as silently.
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {isSerialSupported() && (
                <ConsoleButton onClick={() => run(() => pairSerial())} disabled={busy} variant="primary">
                  {probe?.link ? 'Connect a different printer' : 'Connect Printer'}
                </ConsoleButton>
              )}
              {probe?.link && (
                <>
                  <ConsoleButton onClick={handleTest} disabled={busy}>
                    Print a test receipt
                  </ConsoleButton>
                  <ConsoleButton onClick={handleUnpair} disabled={busy}>
                    Disconnect
                  </ConsoleButton>
                </>
              )}
            </div>

            <p className="text-[11px] font-semibold text-slate-500">
              You only do this once per till. The browser remembers the printer, even with no
              internet.
            </p>
          </div>
        )}
      </Panel>

      {/* ── Step 2: only shown when step 1 could not work ─────────────────── */}
      {probe && probe.status !== 'ready-direct' && (
        <Panel
          title="Step 2 — If the list was empty"
          subtitle="Some printers cannot be reached this way. This is the fix for those."
          icon={Download}
        >
          <div className="space-y-4">
            <p className="text-xs font-semibold text-slate-600">
              If no printer appeared in the list, this computer needs a small helper program.
              It runs quietly in the background and prints receipts with no dialog. It takes
              about three minutes and does <strong>not</strong> need an administrator password.
            </p>

            <ol className="space-y-3">
              <Step n={1} title="Install Node.js on this computer">
                <p>Click below, download the big green LTS button, and click Next until it finishes.</p>
                <a
                  href="https://nodejs.org/en/download"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white text-[11px] font-black uppercase tracking-wide hover:bg-slate-700"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open nodejs.org
                </a>
              </Step>

              <Step n={2} title="Download these two files into the same folder">
                <p>Your Downloads folder is fine, as long as both end up together.</p>
                <div className="flex flex-wrap gap-2">
                  <a
                    href="/print-agent/install-print-agent.bat"
                    download
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 text-white text-[11px] font-black uppercase tracking-wide border border-amber-600 hover:bg-amber-600"
                  >
                    <Download className="w-3.5 h-3.5" />
                    install-print-agent.bat
                  </a>
                  <a
                    href="/print-agent/print-server.cjs"
                    download
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 text-white text-[11px] font-black uppercase tracking-wide border border-amber-600 hover:bg-amber-600"
                  >
                    <Download className="w-3.5 h-3.5" />
                    print-server.cjs
                  </a>
                </div>
                <p className="text-slate-500">
                  If Windows warns you about the .bat file, choose Keep. It is the installer.
                </p>
              </Step>

              <Step n={3} title="Double-click install-print-agent.bat">
                <p>
                  A black window opens and shows a list of the printers on this computer.
                  Type the printer&apos;s name <strong>exactly</strong> as it appears, press
                  Enter, then press Enter again to accept the address it offers.
                </p>
              </Step>

              <Step n={4} title="Come back here and press Re-check">
                <p>
                  The banner at the top should turn green. If it does not, restart the
                  computer and check again.
                </p>
              </Step>
            </ol>

            <p className="text-[11px] font-semibold text-slate-600 border-t border-slate-200 pt-3">
              <strong>Already have the helper and just need a newer one?</strong> Same steps —
              download both files again and run the installer. It stops the old helper first,
              so nothing is left running the previous version.
            </p>

            <div className="flex items-center gap-2 pt-1">
              <ConsoleButton onClick={refresh} variant="primary">
                Re-check now
              </ConsoleButton>
              <span className="text-[11px] font-semibold text-slate-500">
                Helper currently {probe.agentRunning ? 'running' : 'not running'} on this computer
                {probe.agentRunning && ` (version ${probe.agentVersion}, current is ${EXPECTED_AGENT_VERSION})`}.
              </span>
            </div>
          </div>
        </Panel>
      )}

      {/* ── The USB route, behind a warning it deserves ───────────────────── */}
      {probe && !probe.blockedReason && isUsbSupported() && probe.status !== 'ready-direct' && (
        <Panel title="Advanced" subtitle="Only if the steps above did not work" icon={Usb}>
          <button
            type="button"
            onClick={() => setShowUsb((v) => !v)}
            className="text-[11px] font-black uppercase tracking-wider text-slate-500 hover:text-slate-900"
          >
            {showUsb ? '− ' : '+ '}Connect over USB instead
          </button>

          {showUsb && (
            <div className="mt-3 space-y-2">
              <div className="p-3 bg-rose-50 border-2 border-rose-300 text-[11px] font-semibold text-rose-900 space-y-1.5">
                <div className="font-black uppercase">Do not do this unless you have to</div>
                <p>
                  Windows will not share the printer with the browser until the printer is
                  switched to a different driver, using a tool called Zadig. Once that is
                  done, the printer <strong>disappears from Printers &amp; scanners</strong> —
                  Word, PDFs and everything else on this computer lose the ability to print
                  to it. Only this till can use it after that.
                </p>
                <p>Ask whoever supports your computers before doing this.</p>
              </div>
              <ConsoleButton onClick={() => run(() => pairUsb())} disabled={busy}>
                I understand — connect over USB
              </ConsoleButton>
            </div>
          )}
        </Panel>
      )}

      {/* ── Plain-language troubleshooting ────────────────────────────────── */}
      <Panel title="Something not right?" icon={HelpCircle}>
        <dl className="space-y-3 text-[11px]">
          {[
            ['A print box keeps appearing on screen',
              'This till has no printer connected. Do Step 1 above. If the list was empty, do Step 2.'],
            ['Receipts stopped printing after a restart',
              'The helper starts when someone logs in. Log out and back in, then press Re-check. If you connected the printer directly in Step 1, just press Connect Printer again.'],
            ['The receipt prints as strange symbols',
              'The printer is set to a different speed than the app expects. Tell your developer — it is a one-line change.'],
            ['The receipt is cut off, or too wide',
              'The paper size is wrong. Change it at the top of this page and print a test receipt.'],
            ['The printer list was empty',
              'That printer cannot be reached directly. Do Step 2 — the helper program handles it.'],
            ['"Failed to open serial port"',
              'Windows is holding that port — normally because the printer is installed under Printers & scanners, which does not share. Nothing here can change that. Do Step 2; the helper prints through Windows instead of around it.'],
            ['Nothing prints and there is no error',
              'Check the printer is not paused in Windows: Settings, then Printers & scanners, then your printer. Also check it has paper.'],
            ['If receipts are slow',
              'Print a test receipt above and read the time it reports. Under about 300ms means the app has already handed the receipt over and the remaining wait is Windows queuing it. Fix that in Printers & scanners: open your printer, Printer properties, Advanced tab, and choose "Print directly to the printer". That removes the queue entirely. On the same tab make sure "Start printing after last page is spooled" is not selected. If the test itself reports a slow time, your helper is out of date — redo Step 2.'],
          ].map(([q, a]) => (
            <div key={q}>
              <dt className="font-black uppercase tracking-wide text-slate-800">{q}</dt>
              <dd className="font-semibold text-slate-600 mt-0.5">{a}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </div>
  );
};
