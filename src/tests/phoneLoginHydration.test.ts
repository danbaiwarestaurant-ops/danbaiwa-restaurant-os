import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';
import { dbService } from '../services/db/IndexedDbService';
import { hashSecretWithSalt } from '../services/auth/pinAuth';

const cloud = vi.hoisted(() => ({ row: null as any, error: null as any }));
vi.mock('../services/supabase/supabaseClient', async original => ({
  ...(await original<any>()), isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'owner' }, access_token: 'qa' } } }),
      signInWithPassword: async () => ({ data: { user: { id: 'owner', email: 'owner@example.test' } }, error: null }),
    },
    from: () => { const query: any = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: cloud.row, error: cloud.error }) }; return query; },
  },
}));
vi.mock('../services/db/realtimeSync', () => ({
  // Simulates an arbitrarily large or stalled history download. Sign-in must
  // authenticate the profile without waiting for this maintenance operation.
  runCloudCatchUp: vi.fn(() => new Promise(() => {})),
  startRealtimeSync: vi.fn(), stopRealtimeSync: vi.fn(),
}));
import { useAuthStore } from '../store/useAuthStore';
import { useSyncStore } from '../store/useSyncStore';
import { startRealtimeSync } from '../services/db/realtimeSync';

beforeEach(async () => {
  await Promise.all(TABLE_NAMES.map(name => (db as any)[name].clear()));
  await db.config.clear();
  useAuthStore.setState({ activeUser: null, isLoaded: true, isAuthenticated: false, failedAttempts: 0, lockoutUntil: null, hasAnyUsers: false });
  useSyncStore.setState({ checkOutbox: async () => {} });
  vi.stubGlobal('navigator', { onLine: true });
  cloud.error = null;
  cloud.row = { id: 'owner', account_id: 'owner', name: 'Owner', email: 'owner@example.test', username: 'owner@example.test', role: 'admin', status: 'active', pin_salt: 'new-salt', pin_hash: await hashSecretWithSalt('9876', 'new-salt'), created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-06T12:00:00Z' };
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe('phone login does not wait for operational history', () => {
  it('authenticates the genuine owner profile and starts background sync immediately', async () => {
    const result = await useAuthStore.getState().loginUser('owner@example.test', '9876');
    expect(result.ok).toBe(true);
    expect(useAuthStore.getState().activeUser?.id).toBe('owner');
    expect(startRealtimeSync).toHaveBeenCalled();
    expect((await db.users.get('owner'))?.pinHash).toBe(cloud.row.pin_hash);
    expect(await db.outbox.count()).toBe(0); // incoming profile is not re-uploaded
  });
  it('refreshes stale local credentials through the verified cloud owner profile', async () => {
    await dbService.saveUserLocalOnly({ id: 'owner', accountId: 'owner', name: 'Owner', email: 'owner@example.test', username: 'owner@example.test', role: 'admin', status: 'active', pinSalt: 'old-salt', pinHash: await hashSecretWithSalt('1234', 'old-salt'), createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
    const result = await useAuthStore.getState().loginUser('owner@example.test', '9876');
    expect(result.ok).toBe(true);
    expect(useAuthStore.getState().activeUser?.pinHash).toBe(cloud.row.pin_hash);
    expect(await db.outbox.count()).toBe(0);
  });
  it('reports a profile read failure without fabricating a replacement owner', async () => {
    cloud.error = { message: 'Profile read unavailable' }; cloud.row = null;
    const result = await useAuthStore.getState().loginUser('owner@example.test', '9876');
    expect(result.ok).toBe(false);
    expect(await db.users.count()).toBe(0);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});
