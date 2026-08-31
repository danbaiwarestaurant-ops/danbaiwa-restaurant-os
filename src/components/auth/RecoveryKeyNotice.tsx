import React, { useState } from 'react';
import { useAuthStore } from '../../store/useAuthStore';
import { KeyRound, Copy, Check, Printer, ShieldAlert } from 'lucide-react';

/**
 * The one and only time a recovery key can be read.
 *
 * Only a salted hash of the key is stored — on this device and in the cloud — so there is
 * no "show it again" and no support route that can recover it. The dialog therefore blocks
 * on an explicit confirmation rather than a dismiss button, and offers copy and print,
 * because a key that is never written down is the same as no key at all.
 *
 * Renders nothing unless a key has just been issued.
 */
export const RecoveryKeyNotice: React.FC = () => {
  const { pendingRecoveryKey, acknowledgeRecoveryKey } = useAuthStore();
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  if (!pendingRecoveryKey) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(pendingRecoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard access can be refused; the key is on screen to copy by hand regardless.
      setCopied(false);
    }
  };

  const handlePrint = () => {
    const w = window.open('', '_blank', 'width=420,height=520');
    if (!w) return;
    w.document.write(
      `<title>Admin Recovery Key</title>` +
        `<body style="font-family:'Courier New',monospace;padding:24px;text-align:center">` +
        `<h2 style="font-size:14px;letter-spacing:2px">DANBAIWA ADMIN RECOVERY KEY</h2>` +
        `<p style="font-size:11px;color:#444">Resets the admin PIN with no internet. Keep it somewhere only the owner can reach.</p>` +
        `<div style="font-size:22px;font-weight:900;letter-spacing:3px;margin:22px 0;border:2px solid #000;padding:14px">${pendingRecoveryKey}</div>` +
        `<p style="font-size:10px;color:#666">Issued ${new Date().toLocaleString()} · single use</p>` +
        `</body>`
    );
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/85 backdrop-blur-xs z-[60] flex items-center justify-center p-4">
      <div className="bg-white border-4 border-amber-500 w-full max-w-md rounded-none shadow-2xl">
        <div className="bg-slate-900 text-white px-5 py-4 flex items-center gap-2 border-b-2 border-amber-500">
          <KeyRound className="w-5 h-5 text-amber-500" />
          <h3 className="font-black text-sm uppercase tracking-wider">Admin Recovery Key</h3>
        </div>

        <div className="p-6 space-y-4">
          <p className="text-xs font-semibold text-slate-700 normal-case leading-relaxed">
            Write this down now and keep it somewhere only the owner can reach. It resets the
            admin PIN on this till with no internet connection — the only way back in if the
            PIN is forgotten while offline.
          </p>

          <div className="border-2 border-slate-900 bg-slate-50 p-4 text-center">
            <div className="font-mono font-black text-xl tracking-[0.18em] text-slate-900 break-all">
              {pendingRecoveryKey}
            </div>
          </div>

          <div className="p-3 bg-amber-50 border-2 border-amber-400 text-amber-950 text-[11px] font-semibold normal-case rounded-none leading-relaxed flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <span>
              This is shown once. Only a scrambled copy is stored, so it cannot be looked up
              later — not on this till, not in the cloud, not by anyone. It also works once:
              after it is used, issue a new one under Settings.
            </span>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-black uppercase border-2 border-slate-300 bg-white hover:bg-slate-100 text-slate-700 rounded-none"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
            <button
              type="button"
              onClick={handlePrint}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-black uppercase border-2 border-slate-300 bg-white hover:bg-slate-100 text-slate-700 rounded-none"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Print</span>
            </button>
          </div>

          <label className="flex items-start gap-2.5 cursor-pointer border-t-2 border-slate-200 pt-4">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-amber-500"
            />
            <span className="text-xs font-bold text-slate-800 normal-case">
              I have written this key down somewhere safe.
            </span>
          </label>

          <button
            type="button"
            onClick={acknowledgeRecoveryKey}
            disabled={!confirmed}
            className="w-full py-3 bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-white font-black uppercase text-sm tracking-wider border-2 border-amber-600 rounded-none shadow-xs"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
};
