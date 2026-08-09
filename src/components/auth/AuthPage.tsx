import React, { useState } from 'react';
import { ShieldCheck, LogIn, UserPlus, Mail, Lock, KeyRound, AlertCircle, CheckCircle2, ArrowLeft } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';

export const AuthPage: React.FC = () => {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  
  // Login State
  const [loginEmail, setLoginEmail] = useState('');
  const [loginSecret, setLoginSecret] = useState('');
  
  // Register State
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regPin, setRegPin] = useState('');
  const [regRole, setRegRole] = useState<'admin' | 'cashier'>('admin');

  // Reset Password / Recovery State
  const [resetEmail, setResetEmail] = useState('');
  const [resetKey, setResetKey] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPin, setNewPin] = useState('');
  const [resetSuccess, setResetSuccess] = useState(false);
  
  // UI State
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const { loginUser, registerUser, recoverAdminPinWithKey } = useAuthStore();

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!loginEmail.trim() || !loginSecret) {
      setError('Please enter your email and password or PIN');
      return;
    }

    try {
      setLoading(true);
      const success = await loginUser(loginEmail, loginSecret);
      if (!success) {
        setError('Invalid email address, password, or PIN.');
      }
    } catch (err: any) {
      setError(err?.message || 'Login failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!regName.trim() || !regEmail.trim() || !regPassword || !regPin) {
      setError('Please fill in all registration fields');
      return;
    }

    if (!regEmail.includes('@') || !regEmail.includes('.')) {
      setError('Please enter a valid email address');
      return;
    }

    if (regPassword.length < 6) {
      setError('Password must be at least 6 characters long');
      return;
    }

    if (regPin.length < 4 || regPin.length > 8) {
      setError('PIN must be 4 to 8 numeric digits');
      return;
    }

    try {
      setLoading(true);
      await registerUser(regName, regEmail, regPassword, regPin, regRole);
    } catch (err: any) {
      setError(err?.message || 'Registration failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!resetEmail.trim() || !resetKey.trim() || newPin.length < 4) {
      setError('Please fill in all recovery fields');
      return;
    }

    try {
      setLoading(true);
      const success = await recoverAdminPinWithKey(resetEmail, resetKey, newPin);
      if (success) {
        setResetSuccess(true);
        setTimeout(() => {
          setMode('login');
          setLoginEmail(resetEmail);
          setResetSuccess(false);
        }, 2000);
      } else {
        setError('Invalid Master Recovery Key or Email address');
      }
    } catch (err: any) {
      setError(err?.message || 'Password reset failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4 selection:bg-amber-500 selection:text-white">
      <div className="bg-white border-4 border-amber-500 w-full max-w-md shadow-2xl p-8 rounded-none space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between border-b-2 border-slate-200 pb-4">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-8 h-8 text-amber-500 flex-shrink-0" />
            <div>
              <h1 className="text-lg font-black uppercase text-slate-900 tracking-wider">
                Danbaiwa POS Auth
              </h1>
              <p className="text-xs text-slate-500 font-bold uppercase">
                Salted Hashing • User Data Isolation
              </p>
            </div>
          </div>
        </div>

        {/* Tab Toggle */}
        {mode !== 'forgot' ? (
          <div className="grid grid-cols-2 border-2 border-slate-300 rounded-none overflow-hidden">
            <button
              type="button"
              onClick={() => { setMode('login'); setError(null); }}
              className={`py-2.5 text-xs font-black uppercase tracking-wider transition ${
                mode === 'login'
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              Log In
            </button>
            <button
              type="button"
              onClick={() => { setMode('register'); setError(null); }}
              className={`py-2.5 text-xs font-black uppercase tracking-wider transition ${
                mode === 'register'
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              Create Account
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setMode('login'); setError(null); }}
              className="text-xs font-bold uppercase text-slate-600 hover:text-slate-900 flex items-center gap-1 border border-slate-300 px-3 py-1.5 rounded-none"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Login</span>
            </button>
            <span className="text-xs font-black uppercase text-slate-800">Reset Account Password</span>
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div className="p-3 bg-rose-50 border-2 border-rose-400 text-rose-950 text-xs font-bold uppercase rounded-none flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Success Feedback */}
        {resetSuccess && (
          <div className="p-3 bg-emerald-50 border-2 border-emerald-400 text-emerald-950 text-xs font-bold uppercase rounded-none flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            <span>Password & PIN Reset Successfully! Redirecting...</span>
          </div>
        )}

        {/* Login Form */}
        {mode === 'login' && (
          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-bold uppercase text-slate-700 mb-1 flex items-center gap-1">
                <Mail className="w-3.5 h-3.5 text-amber-600" />
                <span>Email Address / Username</span>
              </label>
              <input
                type="email"
                value={loginEmail}
                onChange={e => setLoginEmail(e.target.value)}
                placeholder="user@danbaiwarestaurant.com"
                className="w-full p-3 border-2 border-slate-300 rounded-none font-mono text-sm font-bold text-slate-900 focus:border-amber-500 focus:outline-none"
                required
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="block text-xs font-bold uppercase text-slate-700 flex items-center gap-1">
                  <Lock className="w-3.5 h-3.5 text-amber-600" />
                  <span>Password or Custom PIN</span>
                </label>
                <button
                  type="button"
                  onClick={() => { setMode('forgot'); setError(null); }}
                  className="text-[11px] font-bold text-amber-600 hover:text-amber-800 uppercase"
                >
                  Forgot Password?
                </button>
              </div>
              <input
                type="password"
                value={loginSecret}
                onChange={e => setLoginSecret(e.target.value)}
                placeholder="Enter Password or PIN"
                className="w-full p-3 border-2 border-slate-300 rounded-none font-mono text-sm font-bold text-slate-900 focus:border-amber-500 focus:outline-none"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading || !loginEmail || !loginSecret}
              className="w-full py-3.5 mt-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-black uppercase text-sm tracking-wider border-2 border-amber-600 shadow-xs flex items-center justify-center gap-2 rounded-none transition active:scale-95"
            >
              <LogIn className="w-4 h-4" />
              <span>Log In to Terminal</span>
            </button>
          </form>
        )}

        {/* Registration Form */}
        {mode === 'register' && (
          <form onSubmit={handleRegisterSubmit} className="space-y-3">
            <div>
              <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
                Full Name
              </label>
              <input
                type="text"
                value={regName}
                onChange={e => setRegName(e.target.value)}
                placeholder="e.g. John Doe"
                className="w-full p-2.5 border-2 border-slate-300 rounded-none text-xs font-semibold text-slate-900 focus:border-amber-500 focus:outline-none"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
                Email Address
              </label>
              <input
                type="email"
                value={regEmail}
                onChange={e => setRegEmail(e.target.value)}
                placeholder="john@danbaiwarestaurant.com"
                className="w-full p-2.5 border-2 border-slate-300 rounded-none font-mono text-xs font-bold text-slate-900 focus:border-amber-500 focus:outline-none"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
                  Account Password
                </label>
                <input
                  type="password"
                  value={regPassword}
                  onChange={e => setRegPassword(e.target.value)}
                  placeholder="Min 6 Chars"
                  className="w-full p-2.5 border-2 border-slate-300 rounded-none font-mono text-xs text-slate-900 focus:border-amber-500 focus:outline-none"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
                  Quick Till PIN
                </label>
                <input
                  type="password"
                  value={regPin}
                  onChange={e => setRegPin(e.target.value.replace(/\D/g, ''))}
                  placeholder="4-8 Digits"
                  maxLength={8}
                  className="w-full p-2.5 border-2 border-slate-300 rounded-none font-mono text-center font-black text-sm text-slate-900 focus:border-amber-500 focus:outline-none"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
                Account Role
              </label>
              <select
                value={regRole}
                onChange={e => setRegRole(e.target.value as 'admin' | 'cashier')}
                className="w-full p-2.5 border-2 border-slate-300 rounded-none text-xs font-bold text-slate-900 bg-white"
              >
                <option value="admin">Primary Admin / Manager</option>
                <option value="cashier">Staff Cashier</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={loading || !regName || !regEmail || !regPassword || !regPin}
              className="w-full py-3 mt-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-black uppercase text-xs tracking-wider border-2 border-amber-600 shadow-xs flex items-center justify-center gap-2 rounded-none transition active:scale-95"
            >
              <UserPlus className="w-4 h-4" />
              <span>Create Account & Log In</span>
            </button>
          </form>
        )}

        {/* Reset Password Form */}
        {mode === 'forgot' && (
          <form onSubmit={handleResetSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-bold uppercase text-slate-700 mb-1 flex items-center gap-1">
                <Mail className="w-3.5 h-3.5 text-amber-600" />
                <span>Account Email Address</span>
              </label>
              <input
                type="email"
                value={resetEmail}
                onChange={e => setResetEmail(e.target.value)}
                placeholder="registered@danbaiwarestaurant.com"
                className="w-full p-3 border-2 border-slate-300 rounded-none font-mono text-sm font-bold text-slate-900 focus:border-amber-500 focus:outline-none"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-bold uppercase text-slate-700 mb-1 flex items-center gap-1">
                <KeyRound className="w-3.5 h-3.5 text-amber-600" />
                <span>24-Char Master Recovery Key</span>
              </label>
              <input
                type="text"
                value={resetKey}
                onChange={e => setResetKey(e.target.value.toUpperCase())}
                placeholder="DANB-XXXX-XXXX-XXXX"
                className="w-full p-3 border-2 border-slate-300 rounded-none font-mono text-xs font-bold text-slate-900 tracking-wider focus:border-amber-500 focus:outline-none"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
                New Custom PIN
              </label>
              <input
                type="password"
                value={newPin}
                onChange={e => setNewPin(e.target.value.replace(/\D/g, ''))}
                placeholder="4-8 Digits"
                maxLength={8}
                className="w-full p-3 border-2 border-slate-300 rounded-none font-mono font-black text-center text-lg text-slate-900 focus:border-amber-500 focus:outline-none"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading || !resetEmail || !resetKey || newPin.length < 4}
              className="w-full py-3.5 mt-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-black uppercase text-sm tracking-wider border-2 border-amber-600 shadow-xs flex items-center justify-center gap-2 rounded-none transition active:scale-95"
            >
              <KeyRound className="w-4 h-4" />
              <span>Reset Account Credentials</span>
            </button>
          </form>
        )}

        <div className="pt-3 border-t text-center text-[10px] text-slate-400 font-mono">
          Cryptographic Hashing • User Data Isolation • SQLite Persistence
        </div>
      </div>
    </div>
  );
};
