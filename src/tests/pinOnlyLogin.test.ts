import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../store/useAuthStore';
import { generateSalt, hashSecretWithSalt } from '../services/auth/pinAuth';
import { UserAccount } from '../types/user';

const storage = new Map<string, string>();

describe('PIN-only till login', () => {
  afterEach(() => { vi.unstubAllGlobals(); storage.clear(); });

  it('identifies and signs in the single staff member whose PIN matches', async () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const salt = generateSalt();
    const user = { id: 'cashier-1', name: 'Amina', email: 'amina', username: 'amina', role: 'cashier', status: 'active', createdAt: new Date().toISOString(), pinSalt: salt, pinHash: await hashSecretWithSalt('2468', salt) } as UserAccount;
    useAuthStore.setState({ users: [user], activeUser: null, isAuthenticated: false, failedAttempts: 0, lockoutUntil: null });
    expect(await useAuthStore.getState().loginWithPin('2468')).toEqual({ ok: true });
    expect(useAuthStore.getState().activeUser?.id).toBe('cashier-1');
    expect(storage.get('ticket_pos_session_user_id')).toBe('cashier-1');
  });

  it('refuses an ambiguous duplicate PIN instead of choosing a person', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    const saltA = generateSalt(); const saltB = generateSalt();
    const base = { email: 'staff', username: 'staff', role: 'cashier', status: 'active', createdAt: new Date().toISOString() } as const;
    const users = [
      { ...base, id: 'one', name: 'One', pinSalt: saltA, pinHash: await hashSecretWithSalt('1111', saltA) },
      { ...base, id: 'two', name: 'Two', pinSalt: saltB, pinHash: await hashSecretWithSalt('1111', saltB) },
    ] as UserAccount[];
    useAuthStore.setState({ users, activeUser: null, isAuthenticated: false, failedAttempts: 0, lockoutUntil: null });
    const result = await useAuthStore.getState().loginWithPin('1111');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ambiguous_login_key');
    expect(useAuthStore.getState().activeUser).toBeNull();
  });
});
