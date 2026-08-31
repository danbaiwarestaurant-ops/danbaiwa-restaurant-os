/**
 * staffRoster.test.ts
 *
 * Removing a staff account is the one roster action that destroys something. Two things
 * have to hold for it to be honest:
 *
 *  - it must reach the cloud as a *removal*. The sync worker upserted every queued row
 *    regardless of its action, so a DELETE would have written the account straight back;
 *    and the next reconciliation pull would restore it anyway.
 *  - it must be refused whenever the account owns history, because nothing cascades and a
 *    ticket keeps only a cashierId.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';

// getAccountId reads session.user.id — the tenant key every RLS policy compares against.
let sessionValue: any = { access_token: 'valid', user: { id: 'ACCOUNT-1' } };
const calls: { table: string; op: 'upsert' | 'delete'; filters: Record<string, any> }[] = [];

vi.mock('../services/supabase/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: sessionValue } })),
      getUser: vi.fn(async () => ({ data: { user: { id: 'ACCOUNT-1' } } })),
    },
    from: vi.fn((table: string) => ({
      upsert: vi.fn(async () => {
        calls.push({ table, op: 'upsert', filters: {} });
        return { error: null };
      }),
      delete: vi.fn(() => {
        const filters: Record<string, any> = {};
        const chain: any = {
          eq: vi.fn((col: string, val: any) => {
            filters[col] = val;
            return chain;
          }),
          then: (resolve: any) => {
            calls.push({ table, op: 'delete', filters });
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return chain;
      }),
    })),
  },
}));

import { useSyncStore } from '../store/useSyncStore';
import { IndexedDbService } from '../services/db/IndexedDbService';
import { UserAccount } from '../types/user';
import { Ticket } from '../types/ticket';

function cashier(over: Partial<UserAccount> = {}): UserAccount {
  return {
    id: 'cashier-1',
    name: 'Amina Yusuf',
    email: 'amina',
    username: 'amina',
    pinHash: 'h',
    pinSalt: 's',
    role: 'cashier',
    createdAt: '2026-08-01T09:00:00.000Z',
    status: 'active',
    ...over,
  };
}

const ticketBy = (cashierId: string): Ticket => ({
  id: `LOC01-DEV01-${cashierId}`,
  locationId: 'LOC01',
  deviceId: 'DEV01',
  localSeq: 1,
  amount: 500,
  currency: '₦',
  status: 'paid',
  cashierId,
  createdAt: '2026-08-30T12:00:00.000Z',
  qrPayload: 'q',
});

describe('staff account removal', () => {
  let svc: IndexedDbService;

  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    svc = new IndexedDbService();
    await svc.init();
    calls.length = 0;
    sessionValue = { access_token: 'valid', user: { id: 'ACCOUNT-1' } };
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true },
      configurable: true,
      writable: true,
    });
    useSyncStore.setState({ isSyncing: false, pendingCount: 0, stuckCount: 0, cloudConnected: false });
  });

  it('removes the row locally and queues the removal for the cloud', async () => {
    await svc.saveUser(cashier());
    await db.outbox.clear(); // ignore the creation row; the deletion is what is under test

    await svc.deleteUser('cashier-1');

    expect(await db.users.get('cashier-1')).toBeUndefined();
    const queued = await db.outbox.toArray();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ tableName: 'users', action: 'DELETE' });
    expect(queued[0].payload.id).toBe('cashier-1');
  });

  it('sends a DELETE to the cloud, not an upsert that would restore the account', async () => {
    await svc.saveUser(cashier());
    await db.outbox.clear();
    await svc.deleteUser('cashier-1');
    await useSyncStore.getState().checkOutbox();

    await useSyncStore.getState().triggerSyncWorker();

    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe('delete');
    expect(calls[0].table).toBe('users');
    expect(calls[0].filters.id).toBe('cashier-1');
    // Scoped to the tenant as well as the id, so a malformed queue entry cannot reach
    // beyond this account.
    expect(calls[0].filters.account_id).toBe('ACCOUNT-1');

    const rows = await db.outbox.toArray();
    expect(rows[0].status).toBe('synced');
  });

  it('still upserts ordinary rows', async () => {
    await svc.saveUser(cashier());
    await useSyncStore.getState().checkOutbox();
    await useSyncStore.getState().triggerSyncWorker();

    expect(calls.every((c) => c.op === 'upsert')).toBe(true);
  });
});

describe('countRecordsForUser', () => {
  let svc: IndexedDbService;

  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    svc = new IndexedDbService();
    await svc.init();
  });

  it('reports zero for an account that has never recorded anything', async () => {
    await svc.saveUser(cashier());
    const counts = await svc.countRecordsForUser('cashier-1');
    expect(counts).toEqual({ tickets: 0, shifts: 0, expenses: 0, auditLogs: 0 });
  });

  it('counts only that account’s records', async () => {
    await svc.saveUser(cashier());
    await svc.saveTicket(ticketBy('cashier-1'));
    await svc.saveTicket(ticketBy('cashier-2'));
    await svc.saveShift({
      id: 'shift-1',
      locationId: 'LOC01',
      deviceId: 'DEV01',
      cashierId: 'cashier-1',
      cashierName: 'Amina Yusuf',
      status: 'open',
      openedAt: '2026-08-30T08:00:00.000Z',
      openingFloat: 0,
    });

    const counts = await svc.countRecordsForUser('cashier-1');
    expect(counts.tickets).toBe(1);
    expect(counts.shifts).toBe(1);
    expect(counts.expenses).toBe(0);
  });
});
