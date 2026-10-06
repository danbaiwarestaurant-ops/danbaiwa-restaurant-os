import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';
import { repairLegacyDeviceScope } from '../services/db/accountRepair';
import { saveDeviceIdentity } from '../services/supabase/deviceIdentity';
import { OutboxItem } from '../types/sync';

let serverScope: string | null = 'owner';
let membership: any = { account_id: 'owner', status: 'active' };
vi.mock('../services/supabase/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'owner' } } } }) },
    rpc: async () => ({ data: serverScope, error: null }),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: membership, error: null }) }) }) }),
  },
}));

describe('proven legacy device scope recovery', () => {
  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map(name => (db as any)[name].clear()));
    serverScope = 'owner'; membership = { account_id: 'owner', status: 'active' };
    await saveDeviceIdentity({ authUserId: 'till-auth', accountId: 'owner', email: 'qa@example.test', password: 'test-only', enrolledAt: new Date().toISOString() });
  });
  async function seed(source: string) {
    const payload = { id: 'ticket', accountId: source, amount: 500, createdAt: new Date().toISOString() };
    const item: OutboxItem = { id: 'queued', tableName: 'tickets', action: 'INSERT', payload,
      createdAt: payload.createdAt, status: 'pending', retryCount: 8, lastError: 'wrong account' };
    await db.tickets.put(payload as any); await db.outbox.put(item);
    return item;
  }
  it('corrects only a proven enrolled device ID, retaining the record and queue atomically', async () => {
    const result = await repairLegacyDeviceScope([await seed('till-auth')], 'owner');
    expect(result[0].payload.accountId).toBe('owner');
    expect(result[0].retryCount).toBe(0);
    expect(result[0].status).toBe('pending'); // must still be acknowledged by cloud
    expect((await db.tickets.get('ticket'))?.accountId).toBe('owner');
    expect((await db.tickets.get('ticket'))?.amount).toBe(500);
  });
  it('never reassigns another real admin account', async () => {
    await repairLegacyDeviceScope([await seed('another-owner')], 'owner');
    expect((await db.outbox.get('queued'))?.payload.accountId).toBe('another-owner');
    expect((await db.tickets.get('ticket'))?.accountId).toBe('another-owner');
  });
  it.each(['revoked', 'other-membership', 'scope-mismatch', 'missing-membership'])('retains all data when proof is absent: %s', async failure => {
    if (failure === 'revoked') membership.status = 'revoked';
    if (failure === 'other-membership') membership.account_id = 'other';
    if (failure === 'scope-mismatch') serverScope = 'other';
    if (failure === 'missing-membership') membership = null;
    const item = await seed('till-auth');
    expect((await repairLegacyDeviceScope([item], 'owner'))[0]).toEqual(item);
    expect((await db.tickets.get('ticket'))?.accountId).toBe('till-auth');
  });
});
