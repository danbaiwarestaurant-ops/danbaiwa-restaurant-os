/**
 * loginErrors.ts
 *
 * One code per distinct reason a sign-in can fail, and the exact sentence the till
 * shows for it. "Invalid email address, password, or PIN." is three different
 * problems with three different fixes wearing one message — on a till that is the
 * difference between "you typed the PIN wrong" and "this machine has never seen your
 * account and needs the internet to pull it down".
 *
 * Enumeration note: this deliberately confirms whether an account exists on the till.
 * The device is staff-only, single-venue hardware behind a 3-strike lockout, and a
 * cashier who cannot tell "wrong PIN" from "wrong till" simply cannot open the shop.
 */

export type LoginFailureCode =
  // Nothing was submitted
  | 'missing_email'
  | 'missing_secret'
  // Blocked before any credential check
  | 'locked_out'
  | 'crypto_unavailable'
  // Account is not on this machine
  | 'unknown_account_local_only'
  | 'unknown_account_offline'
  | 'cloud_credentials_rejected'
  | 'cloud_email_unconfirmed'
  | 'cloud_profile_missing'
  | 'cloud_lookup_failed'
  // Account is on this machine
  | 'wrong_pin'
  | 'wrong_password'
  | 'account_disabled';

export interface LoginFailure {
  ok: false;
  code: LoginFailureCode;
  /** The single specific thing that went wrong. */
  message: string;
  /** What to do about it. */
  hint?: string;
  retryAfterSeconds?: number;
  attemptsRemaining?: number;
}

export interface LoginSuccess {
  ok: true;
  /** True when this machine had to pull the account down from a cloud backup. */
  restoredFromCloud?: boolean;
}

export type LoginResult = LoginSuccess | LoginFailure;

export interface LoginFailureContext {
  email?: string;
  retryAfterSeconds?: number;
  attemptsRemaining?: number;
  /** Underlying provider/lookup message, surfaced verbatim so failures stay diagnosable. */
  detail?: string;
}

/** A 4-8 digit secret was meant as a till PIN; anything else was meant as a password. */
export function isPinShaped(secret: string): boolean {
  return /^\d{4,8}$/.test(secret ?? '');
}

/** Browsers withhold crypto.subtle on insecure origins, which breaks every hash check. */
export function hasWebCrypto(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle?.digest === 'function';
}

export function buildLoginFailure(code: LoginFailureCode, ctx: LoginFailureContext = {}): LoginFailure {
  const who = ctx.email ? `"${ctx.email}"` : 'that account';
  const detail = ctx.detail ? ` (${ctx.detail})` : '';

  const copy: Record<LoginFailureCode, { message: string; hint?: string }> = {
    missing_email: {
      message: 'Enter the email address or username for your account.',
    },
    missing_secret: {
      message: 'Enter your password or till PIN.',
    },
    locked_out: {
      message: `Locked for ${ctx.retryAfterSeconds ?? 0}s after too many failed attempts.`,
      hint: 'This is brute-force protection — the account itself is fine. Wait for the timer, then try again.',
    },
    crypto_unavailable: {
      message: "This browser won't let the till verify PINs: its secure crypto engine is unavailable.",
      hint: 'Open the app over https:// or on localhost. Browsers disable crypto on plain http:// addresses.',
    },
    unknown_account_local_only: {
      message: `No account for ${who} exists on this till, and cloud sign-in is not configured.`,
      hint: 'Ask an admin to create the account here, or add the Supabase keys so it can be restored from a cloud backup.',
    },
    unknown_account_offline: {
      message: `No account for ${who} exists on this till, and this machine is offline.`,
      hint: 'Connect to the internet and try again — the account and its data can then be restored from the cloud backup.',
    },
    cloud_credentials_rejected: {
      message: `${who} is not set up on this till, and the cloud rejected that email and PIN.`,
      hint: 'On a machine the account has never used, sign in with the admin PIN — not the account password. Check the email spelling too.',
    },
    cloud_email_unconfirmed: {
      message: `The cloud account for ${who} exists but its email has not been confirmed yet.`,
      hint: 'Check that inbox (and spam folder) for a confirmation link from Supabase, then try again. An admin can also confirm it manually from the Supabase dashboard under Authentication > Users.',
    },
    cloud_profile_missing: {
      message: `Cloud sign-in for ${who} worked, but no backup or profile was found to restore onto this till${detail}.`,
      hint: 'The account exists but has never backed up. Sign in on the original till once so it uploads a snapshot.',
    },
    cloud_lookup_failed: {
      message: `Could not reach the cloud to restore ${who}${detail}.`,
      hint: 'Check the internet connection, then try again.',
    },
    wrong_pin: {
      message: `That PIN does not match the account for ${who}.`,
      hint:
        ctx.attemptsRemaining !== undefined
          ? `${ctx.attemptsRemaining} attempt(s) left before a 30s lockout. Your account password works here too.`
          : 'Your account password works in this box too.',
    },
    wrong_password: {
      message: `That password does not match the account for ${who}.`,
      hint:
        ctx.attemptsRemaining !== undefined
          ? `${ctx.attemptsRemaining} attempt(s) left before a 30s lockout. Your till PIN works here too.`
          : 'Your till PIN works in this box too.',
    },
    account_disabled: {
      message: `The account for ${who} is deactivated.`,
      hint: 'An admin has to reactivate it from the Manager dashboard before it can sign in.',
    },
  };

  return {
    ok: false,
    code,
    message: copy[code].message,
    hint: copy[code].hint,
    retryAfterSeconds: ctx.retryAfterSeconds,
    attemptsRemaining: ctx.attemptsRemaining,
  };
}
