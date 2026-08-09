import React, { useState, useEffect } from 'react';
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

  const { validatePin, recoverAdminPinWithKey } = useAuthStore();

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

  useEffect(() => {
    if (!isOpen || isRecoveryMode) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') {
        if (pin.length < 8) {
          setPin(prev => prev + e.key);
        }
      } else if (e.key === 'Backspace') {
        setPin(prev => prev.slice(0, -1));
      } else if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter' && pin.length >= 4) {
        handleVerify(pin);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, pin, isRecoveryMode]);

  if (!isOpen) return null;

  const handleVerify = async (pinToTest: string) => {
    if (isSubmitting || pinToTest.length < 4) return;
    setIsSubmitting(true);
    setError(false);

    const valid = await validatePin(pinToTest);
    setIsSubmitting(false);

    if (!valid) {
      setError(true);
      setPin('');
    }
  };

  const handleRecoverySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRecoveryError(null);

    if (!recoveryUsername || !recoveryKeyInput || newAdminPin.length < 4) {
      setRecoveryError('Please fill in all recovery fields');
      return;
    }

    const success = await recoverAdminPinWithKey(recoveryUsername, recoveryKeyInput, newAdminPin);
    if (success) {
      setRecoverySuccess(true);
      setTimeout(() => {
        setIsRecoveryMode(false);
        setRecoverySuccess(false);
        setPin(newAdminPin);
      }, 1500);
    } else {
      setRecoveryError('Invalid Master Recovery Key or Admin Username');
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
              {isRecoveryMode ? 'Admin Recovery' : 'Manager Authorization'}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white font-bold text-xs uppercase px-2 py-1 border border-slate-700 hover:border-slate-500 rounded-none"
          >
            Esc
          </button>
        </div>

        {/* Body */}
        <div className="p-6">
          {!isRecoveryMode ? (
            <>
              <p className="text-xs text-slate-600 font-bold uppercase mb-4 text-center">
                {purpose || 'Enter Manager PIN to Proceed'}
              </p>

              {/* PIN Display Dots */}
              <div className="flex justify-center gap-3 mb-6">
                {[0, 1, 2, 3].map((_, index) => (
                  <div
                    key={index}
                    className={`w-10 h-12 border-2 flex items-center justify-center font-mono font-black text-2xl rounded-none ${
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
                      if (pin.length < 8) setPin(prev => prev + num);
                    }}
                    className="py-3 bg-slate-100 hover:bg-slate-200 active:bg-amber-50 border-2 border-slate-300 font-mono font-black text-xl text-slate-800 transition rounded-none select-none"
                  >
                    {num}
                  </button>
                ))}
                <button
                  onClick={() => setPin('')}
                  className="py-3 bg-rose-100 hover:bg-rose-200 border-2 border-rose-300 font-bold text-xs uppercase text-rose-900 transition rounded-none"
                >
                  Clear
                </button>
                <button
                  onClick={() => {
                    if (pin.length < 8) setPin(prev => prev + '0');
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

              {/* Emergency Recovery Option */}
              <div className="text-center border-t border-slate-200 pt-3">
                <button
                  type="button"
                  onClick={() => setIsRecoveryMode(true)}
                  className="text-[11px] font-bold text-slate-500 hover:text-amber-800 uppercase flex items-center justify-center gap-1 mx-auto"
                >
                  <KeyRound className="w-3 h-3 text-amber-600" />
                  <span>Forgot Admin PIN? Use Master Offline Key</span>
                </button>
              </div>
            </>
          ) : (
            /* Recovery Key Reset Mode */
            <form onSubmit={handleRecoverySubmit} className="space-y-4">
              <div className="flex items-center gap-1.5 text-xs font-bold uppercase text-slate-800">
                <ShieldAlert className="w-4 h-4 text-amber-600" />
                <span>Offline Admin Key Reset</span>
              </div>

              {recoverySuccess && (
                <div className="p-2.5 bg-emerald-50 border border-emerald-400 text-emerald-950 text-xs font-bold uppercase rounded-none flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span>Admin PIN Reset Successfully!</span>
                </div>
              )}

              {recoveryError && (
                <div className="p-2 bg-rose-50 border border-rose-400 text-rose-900 text-xs font-bold uppercase rounded-none">
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
