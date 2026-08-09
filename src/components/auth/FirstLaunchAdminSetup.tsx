import React, { useState } from 'react';
import { ShieldCheck, UserPlus, KeyRound, Copy, Check, Mail } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';

interface FirstLaunchAdminSetupProps {
  onAdminCreated: () => void;
}

export const FirstLaunchAdminSetup: React.FC<FirstLaunchAdminSetupProps> = ({ onAdminCreated }) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [generatedRecoveryKey, setGeneratedRecoveryKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { createFirstAdmin } = useAuthStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim() || !email.trim()) {
      setError('Please fill in all account fields');
      return;
    }

    if (!email.includes('@') || !email.includes('.')) {
      setError('Please enter a valid owner email address');
      return;
    }

    if (pin.length < 4 || pin.length > 8) {
      setError('PIN must be 4 to 8 numeric digits');
      return;
    }

    if (pin !== confirmPin) {
      setError('PINs do not match');
      return;
    }

    try {
      setIsSubmitting(true);
      const res = await createFirstAdmin(name, email, pin);
      setGeneratedRecoveryKey(res.recoveryKey);
    } catch (err: any) {
      setError(err?.message || 'Failed to create Admin Account');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCopyKey = () => {
    if (generatedRecoveryKey) {
      navigator.clipboard.writeText(generatedRecoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (generatedRecoveryKey) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4 selection:bg-amber-500 selection:text-white">
        <div className="bg-white border-4 border-amber-500 w-full max-w-md shadow-2xl p-8 rounded-none space-y-6">
          <div className="flex items-center gap-3 border-b-2 border-slate-200 pb-4">
            <KeyRound className="w-8 h-8 text-amber-500 flex-shrink-0" />
            <div>
              <h1 className="text-lg font-black uppercase text-slate-900 tracking-wider">
                Save Master Offline Recovery Key
              </h1>
              <p className="text-xs text-slate-500 font-bold uppercase">
                Emergency Admin Account Recovery
              </p>
            </div>
          </div>

          <p className="text-xs text-slate-700 font-semibold leading-relaxed">
            IMPORTANT: Store this key safely! If you ever forget your Admin PIN while offline, this key allows you to reset your PIN instantly. An account record has also been registered under <span className="font-bold text-slate-900">{email}</span>.
          </p>

          <div className="bg-slate-50 border-2 border-slate-300 p-4 text-center rounded-none">
            <div className="text-[10px] font-bold uppercase text-slate-500 mb-1">
              Your Master Offline Recovery Key
            </div>
            <div className="text-xl font-mono font-black text-slate-900 tracking-widest selection:bg-amber-200">
              {generatedRecoveryKey}
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleCopyKey}
              className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold uppercase text-xs border border-slate-300 rounded-none flex items-center justify-center gap-1.5"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
              <span>{copied ? 'Copied to Clipboard' : 'Copy Key'}</span>
            </button>

            <button
              onClick={onAdminCreated}
              className="flex-1 py-3 bg-amber-500 hover:bg-amber-600 text-white font-black uppercase text-xs border border-amber-600 rounded-none shadow-xs"
            >
              Done & Start Till
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4 selection:bg-amber-500 selection:text-white">
      <div className="bg-white border-4 border-amber-500 w-full max-w-md shadow-2xl p-8 rounded-none">
        <div className="flex items-center gap-3 border-b-2 border-slate-200 pb-4 mb-6">
          <ShieldCheck className="w-8 h-8 text-amber-500 flex-shrink-0" />
          <div>
            <h1 className="text-lg font-black uppercase text-slate-900 tracking-wider">
              First-Launch Admin Setup
            </h1>
            <p className="text-xs text-slate-500 font-bold uppercase">
              Danbaiwa POS • Email & Salted Hashing Auth
            </p>
          </div>
        </div>

        <p className="text-xs text-slate-600 font-semibold mb-6">
          Welcome! Please create the primary Admin account for this POS terminal. Your registered email address is used for profile management, multi-terminal syncing, and password recovery.
        </p>

        {error && (
          <div className="mb-4 p-3 bg-rose-50 border-2 border-rose-400 text-rose-900 text-xs font-bold uppercase rounded-none">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
              Admin Full Name / Owner Name
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Danbaiwa Owner"
              className="w-full p-3 border-2 border-slate-300 rounded-none font-semibold text-slate-900 focus:border-amber-500 focus:outline-none"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1 flex items-center gap-1">
              <Mail className="w-3.5 h-3.5 text-amber-600" />
              <span>Owner Email Address</span>
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="owner@danbaiwarestaurant.com"
              className="w-full p-3 border-2 border-slate-300 rounded-none font-mono text-sm font-bold text-slate-900 focus:border-amber-500 focus:outline-none"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
                Custom Admin PIN
              </label>
              <input
                type="password"
                value={pin}
                onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
                placeholder="4-8 Digits"
                maxLength={8}
                className="w-full p-3 border-2 border-slate-300 rounded-none font-mono font-black text-center text-lg text-slate-900 focus:border-amber-500 focus:outline-none"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
                Confirm Admin PIN
              </label>
              <input
                type="password"
                value={confirmPin}
                onChange={e => setConfirmPin(e.target.value.replace(/\D/g, ''))}
                placeholder="Confirm"
                maxLength={8}
                className="w-full p-3 border-2 border-slate-300 rounded-none font-mono font-black text-center text-lg text-slate-900 focus:border-amber-500 focus:outline-none"
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isSubmitting || !name || !email || !pin}
            className="w-full py-3.5 mt-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-black uppercase text-sm tracking-wider border-2 border-amber-600 shadow-xs flex items-center justify-center gap-2 rounded-none transition active:scale-95"
          >
            <UserPlus className="w-4 h-4" />
            <span>Create Admin Account</span>
          </button>
        </form>

        <div className="mt-6 pt-4 border-t text-center text-[10px] text-slate-400 font-mono">
          Security Protocol • Email Auth • Cryptographic Hashing • SQLite Storage
        </div>
      </div>
    </div>
  );
};
