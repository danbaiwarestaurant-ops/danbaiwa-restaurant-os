import React, { useState } from 'react';
import { useAuthStore } from '../../store/useAuthStore';
import { Panel, StatusBadge, ConsoleButton } from './ConsoleUI';
import { KeyRound, AlertTriangle } from 'lucide-react';

/**
 * Issuing (and re-issuing) the admin's offline recovery key.
 *
 * Needed as much for existing accounts as for new ones: every account created before keys
 * were issued has none at all, so the "Forgot Admin PIN?" route on the PIN pad has nothing
 * to check against until one is generated here.
 */
export const RecoveryKeySettings: React.FC = () => {
  const { users, regenerateRecoveryKey } = useAuthStore();
  const admin = users.find((u) => u.role === 'admin' && u.status === 'active');
  const hasKey = !!admin?.recoveryKeyHash;

  const [asking, setAsking] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await regenerateRecoveryKey(pin);
    setBusy(false);
    if (!res.ok) {
      setError(res.message || 'Could not issue a new key.');
      return;
    }
    // The key itself is shown by RecoveryKeyNotice, which is the only place it can appear.
    setAsking(false);
    setPin('');
  };

  return (
    <Panel
      title="Admin Recovery Key"
      subtitle="Resets the admin PIN with no internet connection"
      icon={KeyRound}
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-2 max-w-xl">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-700">Status</span>
            <StatusBadge tone={hasKey ? 'ok' : 'danger'}>
              {hasKey ? 'A key is active' : 'No key issued'}
            </StatusBadge>
          </div>
          <p className="text-[11px] text-slate-600 font-semibold leading-relaxed">
            {hasKey
              ? 'One key is active. Issuing a new one immediately voids it, so do that if the old one may have been seen by someone else — or if you no longer know where it is.'
              : 'This account has no recovery key. If the admin PIN is forgotten while this till is offline, there is currently no way back in — the emailed password reset needs internet. Issue one now.'}
          </p>
          <p className="text-[11px] text-slate-500 font-semibold leading-relaxed">
            Because the cloud password is derived from the PIN, a key used offline restores
            the till but not cloud sync; the emailed reset restores both.
          </p>
        </div>

        {!asking && (
          <ConsoleButton variant={hasKey ? 'ghost' : 'primary'} onClick={() => setAsking(true)}>
            {hasKey ? 'Issue a New Key' : 'Issue Recovery Key'}
          </ConsoleButton>
        )}
      </div>

      {asking && (
        <form onSubmit={handleSubmit} className="mt-4 pt-4 border-t-2 border-slate-200 space-y-3 max-w-sm">
          {hasKey && (
            <div className="p-2.5 bg-amber-50 border-2 border-amber-400 text-amber-950 text-[11px] font-semibold rounded-none flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <span>The key currently in circulation stops working the moment this one is issued.</span>
            </div>
          )}

          {error && (
            <div className="p-2.5 bg-rose-50 border-2 border-rose-400 text-rose-900 text-[11px] font-semibold rounded-none">
              {error}
            </div>
          )}

          <div>
            <label className="block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1.5">
              Confirm with the current admin PIN
            </label>
            <input
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
              placeholder="Admin PIN"
              autoFocus
              className="w-full p-2.5 border-2 border-slate-300 rounded-none font-mono font-black text-center tracking-widest text-slate-900 focus:border-amber-500 focus:outline-none"
            />
          </div>

          <div className="flex gap-2">
            <ConsoleButton
              onClick={() => {
                setAsking(false);
                setPin('');
                setError(null);
              }}
            >
              Cancel
            </ConsoleButton>
            <button
              type="submit"
              disabled={pin.length < 4 || busy}
              className="px-3 py-1.5 text-[11px] font-black uppercase tracking-wide border rounded-none bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-white border-amber-600"
            >
              {busy ? 'Issuing…' : 'Issue Key'}
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
};
