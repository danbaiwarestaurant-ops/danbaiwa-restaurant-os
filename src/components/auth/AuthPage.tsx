import React, { useState, useEffect } from 'react';
import { ShieldCheck, LogIn, UserPlus, Mail, Lock, AlertCircle, CheckCircle2, ArrowLeft, Send, Info, KeyRound, Clock } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';
import { supabase, isSupabaseConfigured } from '../../services/supabase/supabaseClient';

export const AuthPage: React.FC = () => {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'recovery_complete'>('login');
  
  // Login State
  const [loginEmail, setLoginEmail] = useState('');
  const [loginSecret, setLoginSecret] = useState('');
  
  // Register State
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regPin, setRegPin] = useState('');
  const [regRole, setRegRole] = useState<'admin' | 'cashier'>('admin');

  // Supabase Online Email Reset & Recovery State
  const [resetEmail, setResetEmail] = useState('');
  const [newRecoveryPassword, setNewRecoveryPassword] = useState('');
  const [newRecoveryPin, setNewRecoveryPin] = useState('');
  const [resetSuccessMsg, setResetSuccessMsg] = useState<string | null>(null);
  
  // UI State
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const { loginUser, registerUser, updatePasswordAfterRecovery, lockoutUntil, failedAttempts } = useAuthStore();

  // Check if user arrives via Supabase Email Reset Link (#type=recovery or PASSWORD_RECOVERY event)
  useEffect(() => {
    if (isSupabaseConfigured) {
      const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'PASSWORD_RECOVERY' || window.location.hash.includes('type=recovery')) {
          setMode('recovery_complete');
          if (session?.user?.email) {
            setResetEmail(session.user.email);
          }
        }
      });

      return () => {
        authListener.subscription.unsubscribe();
      };
    }
  }, []);

  const isLockedOut = lockoutUntil ? Date.now() < lockoutUntil : false;
  const remainingLockoutSec = lockoutUntil ? Math.ceil((lockoutUntil - Date.now()) / 1000) : 0;

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (isLockedOut) {
      setError(`Security Lockout Active: Too many failed attempts. Try again in ${remainingLockoutSec}s.`);
      return;
    }

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

  const handleOnlineSupabaseReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResetSuccessMsg(null);

    const cleanEmail = resetEmail.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setError('Please enter a valid email address');
      return;
    }

    if (!isSupabaseConfigured) {
      setError('Supabase is not configured yet. Please paste your VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY into your .env file to enable live cloud email resets.');
      return;
    }

    try {
      setLoading(true);
      if (!navigator.onLine) {
        throw new Error('Internet connection is required to send Supabase Password Reset email.');
      }

      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
        redirectTo: window.location.origin,
      });

      if (resetErr) {
        throw new Error(resetErr.message);
      }

      setResetSuccessMsg(`Password reset instructions sent to ${cleanEmail}. Please check your inbox.`);
    } catch (err: any) {
      setError(err?.message || 'Failed to send reset email.');
    } finally {
      setLoading(false);
    }
  };

  const handleCompletePasswordRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!resetEmail || !newRecoveryPassword || newRecoveryPin.length < 4) {
      setError('Please fill in all recovery password fields');
      return;
    }

    try {
      setLoading(true);
      await updatePasswordAfterRecovery(resetEmail, newRecoveryPassword, newRecoveryPin);
      setResetSuccessMsg('Account Password & PIN updated successfully! Logging in...');
    } catch (err: any) {
      setError(err?.message || 'Failed to update recovery password.');
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
                Real Supabase Auth • Multi-Tenant Scoping
              </p>
            </div>
          </div>
        </div>

        {/* Tab Toggle */}
        {mode === 'login' || mode === 'register' ? (
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
            <span className="text-xs font-black uppercase text-slate-800">
              {mode === 'recovery_complete' ? 'Set New Credentials' : 'Online Password Reset'}
            </span>
          </div>
        )}

        {/* Security Rate-Limiting Lockout Banner */}
        {isLockedOut && (
          <div className="p-3 bg-amber-50 border-2 border-amber-500 text-amber-950 text-xs font-bold uppercase rounded-none flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-600 flex-shrink-0 animate-pulse" />
            <span>Brute-Force Protection Lockout: Retry in {remainingLockoutSec}s</span>
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
        {resetSuccessMsg && (
          <div className="p-3 bg-emerald-50 border-2 border-emerald-400 text-emerald-950 text-xs font-bold uppercase rounded-none flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            <span>{resetSuccessMsg}</span>
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
                disabled={isLockedOut}
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
                disabled={isLockedOut}
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading || isLockedOut || !loginEmail || !loginSecret}
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

        {/* Online Supabase Reset Password Form */}
        {mode === 'forgot' && (
          <form onSubmit={handleOnlineSupabaseReset} className="space-y-4">
            {!isSupabaseConfigured && (
              <div className="p-3 bg-amber-50 border-2 border-amber-400 text-amber-950 text-xs font-bold uppercase rounded-none flex items-start gap-2">
                <Info className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-black mb-0.5">Supabase Credentials Unconfigured</div>
                  <div className="text-[11px] font-normal lowercase">
                    Add your real <code className="font-mono bg-amber-200 px-1 font-bold">VITE_SUPABASE_URL</code> and <code className="font-mono bg-amber-200 px-1 font-bold">VITE_SUPABASE_ANON_KEY</code> to your <code className="font-mono bg-amber-200 px-1 font-bold">.env</code> file to enable live Supabase email resets.
                  </div>
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold uppercase text-slate-700 mb-1 flex items-center gap-1">
                <Mail className="w-3.5 h-3.5 text-amber-600" />
                <span>Account Email Address</span>
              </label>
              <input
                type="email"
                value={resetEmail}
                onChange={e => setResetEmail(e.target.value)}
                placeholder="owner@danbaiwarestaurant.com"
                className="w-full p-3 border-2 border-slate-300 rounded-none font-mono text-sm font-bold text-slate-900 focus:border-amber-500 focus:outline-none"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading || !resetEmail}
              className="w-full py-3.5 mt-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-black uppercase text-sm tracking-wider border-2 border-amber-600 shadow-xs flex items-center justify-center gap-2 rounded-none transition active:scale-95"
            >
              <Send className="w-4 h-4" />
              <span>Send Supabase Reset Link</span>
            </button>
          </form>
        )}

        {/* Recovery Password Completion Form (Magic Link Redirect Target) */}
        {mode === 'recovery_complete' && (
          <form onSubmit={handleCompletePasswordRecovery} className="space-y-4">
            <div className="p-3 bg-emerald-50 border border-emerald-300 text-emerald-900 text-xs font-bold uppercase rounded-none">
              Authenticated via Supabase Reset Link! Set your new password and custom PIN below.
            </div>

            <div>
              <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
                Account Email Address
              </label>
              <input
                type="email"
                value={resetEmail}
                onChange={e => setResetEmail(e.target.value)}
                placeholder="registered@danbaiwarestaurant.com"
                className="w-full p-3 border-2 border-slate-300 rounded-none font-mono text-xs font-bold text-slate-900 bg-slate-100"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-bold uppercase text-slate-700 mb-1 flex items-center gap-1">
                <Lock className="w-3.5 h-3.5 text-amber-600" />
                <span>New Account Password</span>
              </label>
              <input
                type="password"
                value={newRecoveryPassword}
                onChange={e => setNewRecoveryPassword(e.target.value)}
                placeholder="Enter new password (min 6 chars)"
                className="w-full p-3 border-2 border-slate-300 rounded-none font-mono text-sm text-slate-900 focus:border-amber-500 focus:outline-none"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-bold uppercase text-slate-700 mb-1 flex items-center gap-1">
                <KeyRound className="w-3.5 h-3.5 text-amber-600" />
                <span>New Custom PIN (4-8 Digits)</span>
              </label>
              <input
                type="password"
                value={newRecoveryPin}
                onChange={e => setNewRecoveryPin(e.target.value.replace(/\D/g, ''))}
                placeholder="Enter 4-8 digit PIN"
                maxLength={8}
                className="w-full p-3 border-2 border-slate-300 rounded-none font-mono font-black text-center text-lg text-slate-900 focus:border-amber-500 focus:outline-none"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading || !newRecoveryPassword || newRecoveryPin.length < 4}
              className="w-full py-3.5 mt-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-black uppercase text-sm tracking-wider border-2 border-amber-600 shadow-xs flex items-center justify-center gap-2 rounded-none transition active:scale-95"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>Update Credentials & Log In</span>
            </button>
          </form>
        )}

        <div className="pt-3 border-t text-center text-[10px] text-slate-400 font-mono">
          Supabase Auth Cloud Reset • Multi-Tenant Data Isolation
        </div>
      </div>
    </div>
  );
};
