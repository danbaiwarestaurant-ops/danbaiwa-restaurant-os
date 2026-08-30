/**
 * loginErrors.test.ts
 *
 * Guards the promise that a login failure names one specific, actionable reason instead
 * of the old catch-all "Invalid email address, password, or PIN."
 */

import { describe, it, expect } from 'vitest';
import {
  LoginFailureCode,
  buildLoginFailure,
  isPinShaped,
} from '../services/auth/loginErrors';

describe('Atomic login failure vocabulary', () => {
  it('classifies a secret as a PIN only when it is 4-8 digits', () => {
    expect(isPinShaped('1234')).toBe(true);
    expect(isPinShaped('12345678')).toBe(true);
    expect(isPinShaped('123')).toBe(false); // too short
    expect(isPinShaped('123456789')).toBe(false); // too long
    expect(isPinShaped('hunter2')).toBe(false); // has letters -> password
  });

  it('gives every failure code a distinct, non-empty message', () => {
    const codes: LoginFailureCode[] = [
      'missing_email',
      'missing_secret',
      'locked_out',
      'crypto_unavailable',
      'unknown_account_local_only',
      'unknown_account_offline',
      'cloud_credentials_rejected',
      'cloud_email_unconfirmed',
      'cloud_profile_missing',
      'cloud_lookup_failed',
      'wrong_pin',
      'wrong_password',
      'account_disabled',
    ];

    const messages = codes.map((code) => buildLoginFailure(code, { email: 'a@b.com' }).message);
    for (const m of messages) expect(m.trim().length).toBeGreaterThan(0);

    // No two reasons collapse to the same sentence — that collapse is the bug.
    expect(new Set(messages).size).toBe(codes.length);
  });

  it('never falls back to the old generic three-in-one message', () => {
    const wrongPin = buildLoginFailure('wrong_pin', { email: 'a@b.com', attemptsRemaining: 2 });
    expect(wrongPin.message.toLowerCase()).toContain('pin');
    expect(wrongPin.message).not.toMatch(/email address, password, or PIN/i);
    // A wrong PIN points the user at the still-valid password, and vice versa.
    expect(wrongPin.hint).toMatch(/password/i);
    expect(buildLoginFailure('wrong_password', { attemptsRemaining: 1 }).hint).toMatch(/pin/i);
  });

  it('separates "wrong secret" from "account not on this machine"', () => {
    const wrong = buildLoginFailure('wrong_pin', { email: 'a@b.com' });
    const missing = buildLoginFailure('unknown_account_offline', { email: 'a@b.com' });
    expect(wrong.message).not.toBe(missing.message);
    expect(missing.message.toLowerCase()).toContain('this till');
    expect(missing.hint?.toLowerCase()).toContain('internet');
  });

  it('threads the retry countdown and remaining-attempt count through', () => {
    const locked = buildLoginFailure('locked_out', { retryAfterSeconds: 27 });
    expect(locked.message).toContain('27s');
    expect(locked.retryAfterSeconds).toBe(27);

    const wrong = buildLoginFailure('wrong_password', { attemptsRemaining: 1 });
    expect(wrong.attemptsRemaining).toBe(1);
    expect(wrong.hint).toContain('1');
  });

  it('surfaces the underlying provider detail for cloud failures', () => {
    const failed = buildLoginFailure('cloud_lookup_failed', {
      email: 'a@b.com',
      detail: 'network timeout',
    });
    expect(failed.message).toContain('network timeout');
  });
});
