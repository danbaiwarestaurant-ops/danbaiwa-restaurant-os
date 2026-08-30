import React, { useState, useEffect } from 'react';
import { CloudOff, Cloud, AlertTriangle, Loader2, CheckCircle2 } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';
import { useSyncStore } from '../../store/useSyncStore';

interface CloudReconnectModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Restores this till's cloud session from the admin PIN.
 *
 * Exists because the Supabase credential is derived from the PIN specifically, so a
 * password login or a cashier login leaves the till silently cloud-less with no way back
 * except a full log out / log in. It also gives the last cloud-auth error somewhere to
 * be read: that reason used to live only in the browser console, which is no use to
 * whoever is actually standing at the till.
 */
export const CloudReconnectModal: React.FC<CloudReconnectModalProps> = ({ isOpen, onClose }) => {
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  const { reconnectCloudSession } = useAuthStore();
  const { cloudError, pendingCount, stuckCount } = useSyncStore();

  useEffect(() => {
    if (isOpen) {
      setPin('');
      setFailure(null);
      setSucceeded(false);
      setSubmitting(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (submitting || pin.length < 4) return;
    setSubmitting(true);
    setFailure(null);

    const result = await reconnectCloudSession(pin);
    setSubmitting(false);

    if (result.ok) {
      setSucceeded(true);
      setTimeout(onClose, 1600);
    } else {
      setFailure(result.message || 'Reconnect failed.');
      setPin('');
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white border-4 border-slate-900 w-full max-w-sm overflow-hidden shadow-2xl rounded-none">
        <div className="bg-slate-900 text-white p-4 flex items-center justify-between border-b-2 border-amber-500">
          <div className="flex items-center gap-2">
            <CloudOff className="w-5 h-5 text-amber-500" />
            <h3 className="font-black text-sm uppercase tracking-wider">Reconnect to Cloud</h3>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white font-bold text-xs uppercase px-2 py-1 border border-slate-700 hover:border-slate-500 rounded-none"
          >
            Esc
          </button>
        </div>

        <div className="p-6 space-y-4">
          {succeeded ? (
            <div className="py-6 text-center space-y-3">
              <CheckCircle2 className="w-10 h-10 text-emerald-600 mx-auto" />
              <p className="text-sm font-black uppercase text-emerald-900">Cloud Reconnected</p>
              <p className="text-xs font-semibold text-slate-600 normal-case">
                Queued records are being sent now and will appear on your other devices.
              </p>
            </div>
          ) : (
            <>
              {/* What is actually queued, so the stakes are concrete. */}
              {pendingCount > 0 && (
                <div className="p-3 bg-amber-50 border-2 border-amber-400 text-amber-950 text-xs font-bold uppercase rounded-none">
                  {pendingCount} record{pendingCount === 1 ? '' : 's'} waiting to reach the cloud
                  {stuckCount > 0 ? ` • ${stuckCount} needing attention` : ''}
                </div>
              )}

              {/* The real reason, verbatim — no longer console-only. */}
              {cloudError && (
                <div className="p-3 bg-slate-50 border-2 border-slate-300 rounded-none">
                  <div className="flex items-center gap-1.5 text-[11px] font-black uppercase text-slate-700 mb-1">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                    <span>Why this till is disconnected</span>
                  </div>
                  <p className="text-[11px] font-semibold text-slate-700 normal-case leading-relaxed">
                    {cloudError}
                  </p>
                </div>
              )}

              <p className="text-xs text-slate-600 font-semibold normal-case leading-relaxed">
                Your cloud sign-in is derived from the <span className="font-bold">admin PIN</span>,
                so enter it here to reconnect. Nothing is lost in the meantime — everything
                stays queued on this device until it can be sent.
              </p>

              <input
                type="password"
                inputMode="numeric"
                autoFocus
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSubmit();
                  if (e.key === 'Escape') onClose();
                }}
                placeholder="Admin PIN"
                className="w-full p-3 border-2 border-slate-300 rounded-none font-mono font-black text-center text-xl tracking-widest text-slate-900 focus:border-amber-500 focus:outline-none"
              />

              {failure && (
                <div className="p-3 bg-rose-50 border-2 border-rose-400 text-rose-900 text-[11px] font-semibold normal-case rounded-none leading-relaxed">
                  {failure}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-bold uppercase border border-slate-300 rounded-none text-slate-700 hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={submitting || pin.length < 4}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-black uppercase bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-none border border-amber-600 shadow-xs"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Connecting...</span>
                    </>
                  ) : (
                    <>
                      <Cloud className="w-3.5 h-3.5" />
                      <span>Reconnect</span>
                    </>
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
