import React, { useState, useEffect } from 'react';
import { ShieldCheck, LogIn, UserPlus, Mail, Lock, AlertCircle, CheckCircle2, ArrowLeft, Send, Info, KeyRound, Clock } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';
import { supabase, isSupabaseConfigured, authRedirectUrl } from '../../services/supabase/supabaseClient';
import { TillDiagnostics } from './TillDiagnostics';

export const AuthPage: React.FC = () => {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'recovery_complete'>('login');
  
  // Login State
  const [loginEmail, setLoginEmail] = useState('');
  const [loginSecret, setLoginSecret] = useState('');
  
  // Register State (first-launch primary Admin setup only — see hasAnyUsers gating below)
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regPin, setRegPin] = useState('');

  // Supabase Online Email Reset & Recovery State
  const [resetEmail, setResetEmail] = useState('');
  const [newRecoveryPassword, setNewRecoveryPassword] = useState('');
  const [newRecoveryPin, setNewRecoveryPin] = useState('');
  const [resetSuccessMsg, setResetSuccessMsg] = useState<string | null>(null);
  
  // UI State — an error is a specific reason plus the "what to do about it" line that
  // goes with it, so the banner never degrades to a bare "login failed".
  const [error, setErrorState] = useState<{ message: string; hint?: string | null } | null>(null);
  const [loading, setLoading] = useState(false);

  const clearError = () => setErrorState(null);
  const showError = (message: string, hint?: string | null) => setErrorState({ message, hint });

  const { loginUser, registerUser, updatePasswordAfterRecovery, lockoutUntil, failedAttempts, hasAnyUsers } = useAuthStore();

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

  // A reset link that has expired, been opened twice, or was sent to a URL the Supabase
  // project does not allow comes back carrying the reason in the URL and nothing else.
  // The app used to drop it silently and render a plain login form, which reads to the
  // operator as "the link did nothing".
  useEffect(() => {
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const fromQuery = new URLSearchParams(window.location.search);
    const reason =
      fromHash.get('error_description') ||
      fromQuery.get('error_description') ||
      fromHash.get('error') ||
      fromQuery.get('error');

    if (reason) {
      showError(reason.replace(/\+/g, ' '), 'Send yourself a new reset link below — each one works once, and expires about an hour after it is sent.');
      setMode('forgot');
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  // Account creation is only for first-launch setup. If this device already has an
  // account, never leave the visitor sitting on the registration form.
  useEffect(() => {
    if (hasAnyUsers && mode === 'register') {
      setMode('login');
    }
  }, [hasAnyUsers, mode]);

  const isLockedOut = lockoutUntil ? Date.now() < lockoutUntil : false;
  const remainingLockoutSec = lockoutUntil ? Math.ceil((lockoutUntil - Date.now()) / 1000) : 0;

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    setResetSuccessMsg(null);

    try {
      setLoading(true);
      // The store owns every failure reason (empty field, lockout, unknown account,
      // wrong PIN, cloud restore problems) so the banner can state the actual one.
      const result = await loginUser(loginEmail, loginSecret);
      if (!result.ok) {
        showError(result.message, result.hint);
        return;
      }
      if (result.restoredFromCloud) {
        setResetSuccessMsg('Account restored to this till from the cloud backup. Signing in...');
      }
    } catch (err: any) {
      showError(err?.message || 'Login failed for an unexpected reason.', 'Check the browser console for details.');
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();

    if (!regName.trim() || !regEmail.trim() || !regPassword || !regPin) {
      showError('Please fill in all registration fields');
      return;
    }

    if (!regEmail.includes('@') || !regEmail.includes('.')) {
      showError('Please enter a valid email address');
      return;
    }

    if (regPassword.length < 6) {
      showError('Password must be at least 6 characters long');
      return;
    }

    if (regPin.length < 4 || regPin.length > 8) {
      showError('PIN must be 4 to 8 numeric digits');
      return;
    }

    try {
      setLoading(true);
      await registerUser(regName, regEmail, regPassword, regPin);
    } catch (err: any) {
      // This browser profile has never held the account, so the registration form was
      // offered in good faith — but the email already belongs to a live business. Hand
      // them the login tab with the email filled in: signing in there pulls the real
      // account and its records down onto this machine, which is what they wanted.
      if (err?.code === 'account_exists') {
        setLoginEmail(regEmail.trim().toLowerCase());
        setLoginSecret('');
        setMode('login');
        showError(err.message, 'Enter the admin PIN for that account below. Do not create a second one — it would overwrite the real account.');
        return;
      }
      showError(err?.message || 'Registration failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleOnlineSupabaseReset = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    setResetSuccessMsg(null);

    const cleanEmail = resetEmail.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      showError('Please enter a valid email address');
      return;
    }

    if (!isSupabaseConfigured) {
      showError('Supabase is not configured yet. Please paste your VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY into your .env file to enable live cloud email resets.');
      return;
    }

    try {
      setLoading(true);
      if (!navigator.onLine) {
        throw new Error('Internet connection is required to send Supabase Password Reset email.');
      }

      // window.location.origin alone was not enough: Supabase only honours redirectTo
      // when the exact URL is on the project's Redirect URLs allow-list, and silently
      // substitutes the project's Site URL otherwise — which is why every reset link
      // opened the Vercel deployment rather than the till the operator was standing at.
      // The URL is echoed back in the confirmation below so it can be allow-listed.
      const redirectTo = authRedirectUrl();
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
        redirectTo,
      });

      if (resetErr) {
        throw new Error(resetErr.message);
      }

      setResetSuccessMsg(`Reset link sent to ${cleanEmail}. It will open ${redirectTo} — if it opens somewhere else instead, add that address under Supabase > Authentication > URL Configuration > Redirect URLs.`);
    } catch (err: any) {
      showError(err?.message || 'Failed to send reset email.');
    } finally {
      setLoading(false);
    }
  };

  const handleCompletePasswordRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();

    if (!resetEmail || !newRecoveryPassword || newRecoveryPin.length < 4) {
      showError('Please fill in all recovery password fields');
      return;
    }

    try {
      setLoading(true);
      await updatePasswordAfterRecovery(resetEmail, newRecoveryPassword, newRecoveryPin);
      setResetSuccessMsg('Account Password & PIN updated successfully! Logging in...');
    } catch (err: any) {
      showError(err?.message || 'Failed to update recovery password.');
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

        {/* Tab Toggle — "Create Account" only ever appears for true first-launch setup */}
        {mode === 'login' || mode === 'register' ? (
          hasAnyUsers ? null : (
            <div className="grid grid-cols-2 border-2 border-slate-300 rounded-none overflow-hidden">
              <button
                type="button"
                onClick={() => { setMode('login'); clearError(); }}
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
                onClick={() => { setMode('register'); clearError(); }}
                className={`py-2.5 text-xs font-black uppercase tracking-wider transition ${
                  mode === 'register'
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                Create Account
              </button>
            </div>
          )
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setMode('login'); clearError(); }}
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

        {/* Error Display — one specific reason, plus the concrete next step */}
        {error && (
          <div className="p-3 bg-rose-50 border-2 border-rose-400 text-rose-950 text-xs font-bold uppercase rounded-none flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div>{error.message}</div>
              {error.hint && (
                <div className="text-[11px] font-semibold normal-case text-rose-800">{error.hint}</div>
              )}
            </div>
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
                <span>Email Address / Staff ID</span>
              </label>
              {/*
                Deliberately type="text", not type="email".
                A cashier signs in with the staff ID the admin gave them ("amina", "till-2"),
                which has no @ in it — so an email input's own validation blocked the form
                before it could ever be submitted, and there was no way for a cashier to log
                in at all. The lookup has always accepted either: getUserByEmail matches on
                loginKeys, which holds both the email and the username.
              */}
              <input
                type="text"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={loginEmail}
                onChange={e => setLoginEmail(e.target.value)}
                placeholder="owner@gmail.com or staff ID"
                className="w-full p-3 border-2 border-slate-300 rounded-none font-mono text-sm font-bold text-slate-900 focus:border-amber-500 focus:outline-none"
                disabled={isLockedOut}
                required
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="block text-xs font-bold uppercase text-slate-700 flex items-center gap-1">
                  <Lock className="w-3.5 h-3.5 text-amber-600" />
                  <span>Password or PIN</span>
                </label>
                <button
                  type="button"
                  onClick={() => { setMode('forgot'); clearError(); }}
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

        {/* Registration Form — first-launch primary Admin setup only */}
        {mode === 'register' && !hasAnyUsers && (
          <form onSubmit={handleRegisterSubmit} className="space-y-3">
            <div className="p-3 bg-slate-50 border border-slate-300 text-slate-700 text-[11px] font-bold uppercase rounded-none">
              First-time setup — this creates the primary Admin account for this till.
              Add staff cashier accounts later from the Admin dashboard.
            </div>
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
                placeholder="john@gmail.com"
                className="w-full p-2.5 border-2 border-slate-300 rounded-none font-mono text-xs font-bold text-slate-900 focus:border-amber-500 focus:outline-none"
                required
              />
              <p className="mt-1 text-[10px] font-semibold text-slate-500 normal-case">
                Any email you can check works — personal or business. A confirmation
                may be sent here, and it doubles as your cloud account for backup &amp; recovery.
              </p>
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
                placeholder="owner@gmail.com"
                className="w-full p-3 border-2 border-slate-300 rounded-none font-mono text-sm font-bold text-slate-900 focus:border-amber-500 focus:outline-none"
                required
              />
            </div>

            <div className="p-3 bg-slate-50 border border-slate-300 text-slate-700 text-[11px] font-semibold normal-case rounded-none">
              The link will be sent to open{' '}
              <code className="font-mono font-bold text-slate-900 break-all">{authRedirectUrl()}</code>.
              If it opens a different site, that address is not on your Supabase project's
              Redirect URLs list — add it under Authentication &gt; URL Configuration.
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
                readOnly
                placeholder="registered@gmail.com"
                className="w-full p-3 border-2 border-slate-300 rounded-none font-mono text-xs font-bold text-slate-900 bg-slate-100 cursor-not-allowed"
                title="This is determined by the authenticated reset link and cannot be changed here."
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

        {(mode === 'login' || mode === 'register') && <TillDiagnostics />}

        <div className="pt-3 border-t text-center text-[10px] text-slate-400 font-mono">
          Supabase Auth Cloud Reset • Multi-Tenant Data Isolation
        </div>
      </div>
    </div>
  );
};
