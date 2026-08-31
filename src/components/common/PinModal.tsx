import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuthStore } from '../../store/useAuthStore';
import { Lock, KeyRound, ShieldAlert, CheckCircle2 } from 'lucide-react';

interface PinModalProps {
  isOpen: boolean;
  purpose: string | null;
  onClose: () => void;
}

export const PinModal: React.FC<PinModalProps> = ({ isOpen, purpose, onClose }) => {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Recovery mode state
  const [isRecoveryMode, setIsRecoveryMode] = useState(false);
  const [recoveryUsername, setRecoveryUsername] = useState('admin');
  const [recoveryKeyInput, setRecoveryKeyInput] = useState('');
  const [newAdminPin, setNewAdminPin] = useState('');
  const [recoverySuccess, setRecoverySuccess] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryNote, setRecoveryNote] = useState<string | null>(null);

  const { validatePin, recoverAdminPinWithKey, pinModalScope, activeUser } = useAuthStore();
  // A screen lock is not an authority check, so it should not call itself one — and the
  // admin-key recovery route has no business on it.
  const isScreenLock = pinModalScope === 'session';

  useEffect(() => {
    if (isOpen) {
      setPin('');
      setError(false);
      setIsRecoveryMode(false);
      setRecoveryKeyInput('');
      setNewAdminPin('');
      setRecoveryError(null);
      setRecoverySuccess(false);
    }
  }, [isOpen]);

  // A ref, not the isSubmitting state: the auto-submit effect below can fire again before
  // React has re-rendered with the new state, which would let two verifications overlap.
  const verifyingRef = useRef(false);

  const handleVerify = useCallback(
    async (pinToTest: string, silent = false): Promise<boolean> => {
      if (verifyingRef.current || pinToTest.length < 4) return false;
      verifyingRef.current = true;
      setIsSubmitting(true);
      if (!silent) setError(false);

      const valid = await validatePin(pinToTest);

      verifyingRef.current = false;
      setIsSubmitting(false);

      if (!valid && !silent) {
        setError(true);
        setPin('');
      }
      return valid;
    },
    [validatePin]
  );

  /**
   * Submit the PIN as soon as it is right, without waiting for a press of ENTER.
   *
   * A till is a touch screen: the on-screen keypad is the only way in, so "type four digits
   * then reach for a separate confirm key" is one deliberate tap too many on an action
   * staff perform dozens of times a shift.
   *
   * PINs here are 4 to 8 digits, so a wrong answer at four digits may simply be an
   * unfinished longer one. Each attempt is therefore made silently, and only becomes a
   * visible failure once the user has stopped typing for long enough to have finished — or
   * has filled all eight digits, where there is nothing left to add. Pressing ENTER (on
   * screen or on a keyboard) still forces an immediate, non-silent attempt.
   */
  useEffect(() => {
    if (!isOpen || isRecoveryMode || pin.length < 4 || error) return;

    let cancelled = false;
    let settleTimer: ReturnType<typeof setTimeout>;

    const attemptTimer = setTimeout(async () => {
      const ok = await handleVerify(pin, true);
      if (ok || cancelled) return;

      if (pin.length >= 8) {
        setError(true);
        setPin('');
        return;
      }
      settleTimer = setTimeout(() => {
        if (cancelled) return;
        setError(true);
        setPin('');
      }, 1400);
    }, 420);

    return () => {
      cancelled = true;
      clearTimeout(attemptTimer);
      clearTimeout(settleTimer);
    };
  }, [pin, isOpen, isRecoveryMode, error, handleVerify]);

  useEffect(() => {
    if (!isOpen || isRecoveryMode) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') {
        if (pin.length < 8) {
          setError(false);
          setPin(prev => prev + e.key);
        }
      } else if (e.key === 'Backspace') {
        setError(false);
        setPin(prev => prev.slice(0, -1));
      } else if (e.key === 'Escape') {
        // A lock you can dismiss is not a lock. Escape cancels an authority check —
        // where cancelling simply means not doing the thing — but must not walk past a
        // locked screen.
        if (!isScreenLock) onClose();
      } else if (e.key === 'Enter' && pin.length >= 4) {
        handleVerify(pin);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, pin, isRecoveryMode, isScreenLock, handleVerify, onClose]);

  if (!isOpen) return null;

  const handleRecoverySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRecoveryError(null);

    if (!recoveryUsername || !recoveryKeyInput || newAdminPin.length < 4) {
      setRecoveryError('Please fill in all recovery fields');
      return;
    }

    const res = await recoverAdminPinWithKey(recoveryUsername, recoveryKeyInput, newAdminPin);
    if (res.ok) {
      // Held long enough to be read: it says whether cloud sync came back with the PIN,
      // which is the difference between a working till and one that has silently stopped
      // syncing.
      setRecoveryNote(res.message ?? null);
      setRecoverySuccess(true);
      setTimeout(() => {
        setIsRecoveryMode(false);
        setRecoverySuccess(false);
        setRecoveryNote(null);
        // Clear the failure that sent them here in the first place. Leaving it set would
        // drop the admin back onto the keypad still reading "Invalid PIN" — about their
        // *old* PIN — with the new one pre-filled and the auto-submit refusing to fire.
        setError(false);
        setPin(newAdminPin);
      }, 6000);
    } else {
      setRecoveryError(res.message || 'Invalid master recovery key or admin username');
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-xs z-50 flex items-center justify-center p-4 selection:bg-amber-500 selection:text-white">
      <div className="bg-white border-4 border-slate-900 w-full max-w-sm overflow-hidden shadow-2xl rounded-none">
        {/* Header */}
        <div className="bg-slate-900 text-white p-4 flex items-center justify-between border-b-2 border-amber-500">
          <div className="flex items-center gap-2">
            <Lock className="w-5 h-5 text-amber-500" />
            <h3 className="font-black text-sm uppercase tracking-wider">
              {isRecoveryMode ? 'Admin Recovery' : isScreenLock ? 'Till Locked' : 'Manager Authorization'}
            </h3>
          </div>
          {/* Same reason: no dismiss control on a locked screen. */}
          {!isScreenLock && (
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-white font-bold text-xs uppercase px-2 py-1 border border-slate-700 hover:border-slate-500 rounded-none"
            >
              Esc
            </button>
          )}
        </div>

        {/* Body */}
        <div className="p-6">
          {!isRecoveryMode ? (
            <>
              <p className="text-xs text-slate-600 font-bold uppercase mb-1 text-center">
                {purpose || 'Enter Manager PIN to Proceed'}
              </p>
              {isScreenLock && activeUser && (
                <p className="text-[11px] text-slate-500 font-semibold normal-case mb-4 text-center">
                  Signed in as {activeUser.name}. Enter your own PIN to carry on — a manager's
                  PIN also works.
                </p>
              )}
              {!isScreenLock && <div className="mb-4" />}

              {/* PIN display. Grows past four boxes as a longer PIN is typed — it was fixed
                  at four, so digits five to eight vanished as they were entered and a
                  six-digit PIN looked like a keypad that had stopped responding. */}
              <div className="flex justify-center gap-2.5 mb-6">
                {Array.from({ length: Math.min(8, Math.max(4, pin.length)) }).map((_, index) => (
                  <div
                    key={index}
                    className={`w-9 h-12 border-2 flex items-center justify-center font-mono font-black text-2xl rounded-none ${
                      error
                        ? 'border-rose-500 bg-rose-50 text-rose-900'
                        : index < pin.length
                        ? 'border-amber-500 bg-amber-50 text-slate-900'
                        : 'border-slate-300 bg-slate-50 text-slate-300'
                    }`}
                  >
                    {index < pin.length ? '•' : ''}
                  </div>
                ))}
              </div>

              {error && (
                <p className="text-center text-xs font-bold text-rose-600 uppercase mb-4 animate-shake">
                  Invalid PIN • Salted Hash Mismatch
                </p>
              )}

              {/* On-Screen Keypad */}
              <div className="grid grid-cols-3 gap-2 mb-4">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(num => (
                  <button
                    key={num}
                    onClick={() => {
                      if (pin.length >= 8) return;
                      setError(false);
                      setPin(prev => prev + num);
                    }}
                    className="py-3 bg-slate-100 hover:bg-slate-200 active:bg-amber-50 border-2 border-slate-300 font-mono font-black text-xl text-slate-800 transition rounded-none select-none"
                  >
                    {num}
                  </button>
                ))}
                <button
                  onClick={() => { setError(false); setPin(''); }}
                  className="py-3 bg-rose-100 hover:bg-rose-200 border-2 border-rose-300 font-bold text-xs uppercase text-rose-900 transition rounded-none"
                >
                  Clear
                </button>
                <button
                  onClick={() => {
                    if (pin.length >= 8) return;
                    setError(false);
                    setPin(prev => prev + '0');
                  }}
                  className="py-3 bg-slate-100 hover:bg-slate-200 active:bg-amber-50 border-2 border-slate-300 font-mono font-black text-xl text-slate-800 transition rounded-none select-none"
                >
                  0
                </button>
                <button
                  onClick={() => handleVerify(pin)}
                  disabled={pin.length < 4 || isSubmitting}
                  className="py-3 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 border-2 border-amber-600 font-black text-xs uppercase text-white transition rounded-none shadow-xs"
                >
                  Enter
                </button>
              </div>

              {/* Emergency Recovery Option — an admin-account route, not an unlock one. */}
              {!isScreenLock && (
              <div className="text-center border-t border-slate-200 pt-3">
                <button
                  type="button"
                  onClick={() => { setError(false); setPin(''); setIsRecoveryMode(true); }}
                  className="text-[11px] font-bold text-slate-500 hover:text-amber-800 uppercase flex items-center justify-center gap-1 mx-auto"
                >
                  <KeyRound className="w-3 h-3 text-amber-600" />
                  <span>Forgot Admin PIN? Use Master Offline Key</span>
                </button>
              </div>
              )}
            </>
          ) : (
            /* Recovery Key Reset Mode */
            <form onSubmit={handleRecoverySubmit} className="space-y-4">
              <div className="flex items-center gap-1.5 text-xs font-bold uppercase text-slate-800">
                <ShieldAlert className="w-4 h-4 text-amber-600" />
                <span>Offline Admin Key Reset</span>
              </div>

              {recoverySuccess && (
                <div className="p-2.5 bg-emerald-50 border border-emerald-400 text-emerald-950 rounded-none space-y-1.5">
                  <div className="text-xs font-bold uppercase flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span>Admin PIN Reset Successfully</span>
                  </div>
                  {recoveryNote && (
                    <p className="text-[11px] font-semibold normal-case leading-relaxed text-emerald-900">
                      {recoveryNote}
                    </p>
                  )}
                </div>
              )}

              {recoveryError && (
                <div className="p-2.5 bg-rose-50 border border-rose-400 text-rose-900 text-[11px] font-semibold normal-case leading-relaxed rounded-none">
                  {recoveryError}
                </div>
              )}

              <div>
                <label className="block text-[11px] font-bold uppercase text-slate-600 mb-1">
                  Admin Username
                </label>
                <input
                  type="text"
                  value={recoveryUsername}
                  onChange={e => setRecoveryUsername(e.target.value)}
                  className="w-full p-2 border-2 border-slate-300 text-xs font-mono font-bold text-slate-900 rounded-none focus:border-amber-500 focus:outline-none"
                  required
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold uppercase text-slate-600 mb-1">
                  24-Char Master Recovery Key
                </label>
                <input
                  type="text"
                  value={recoveryKeyInput}
                  onChange={e => setRecoveryKeyInput(e.target.value.toUpperCase())}
                  placeholder="DANB-XXXX-XXXX-XXXX"
                  className="w-full p-2 border-2 border-slate-300 font-mono font-bold text-xs tracking-wider text-slate-900 rounded-none focus:border-amber-500 focus:outline-none"
                  required
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold uppercase text-slate-600 mb-1">
                  New Custom Admin PIN
                </label>
                <input
                  type="password"
                  value={newAdminPin}
                  onChange={e => setNewAdminPin(e.target.value.replace(/\D/g, ''))}
                  placeholder="4-8 Digits"
                  maxLength={8}
                  className="w-full p-2 border-2 border-slate-300 text-center font-mono font-black text-base text-slate-900 rounded-none focus:border-amber-500 focus:outline-none"
                  required
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t">
                <button
                  type="button"
                  onClick={() => setIsRecoveryMode(false)}
                  className="px-3 py-1.5 text-xs font-bold uppercase border border-slate-300 rounded-none text-slate-700"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={!recoveryKeyInput || newAdminPin.length < 4}
                  className="px-4 py-1.5 text-xs font-black uppercase bg-amber-500 text-white rounded-none border border-amber-600 shadow-xs"
                >
                  Reset Admin PIN
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
