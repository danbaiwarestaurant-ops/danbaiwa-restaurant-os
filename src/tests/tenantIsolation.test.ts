/**
 * tenantIsolation.test.ts
 *
 * The regression that matters most in this change.
 *
 * The previous model scoped every row by `location_id`, which defaults to the literal
 * string 'LOC01' on every install — so unrelated accounts all landed in one pool and
 * could read each other's tickets (confirmed against the live project: 8 separate
 * signups sharing one data set). Worse, the claim it compared against was only written
 * at signup, so accounts predating that code carried no claim, matched nothing, and were
 * locked out of their own data entirely.
 *
 * These tests encode both halves of the fix: a push always carries the pushing account's
 * id, and a pull only ever returns rows belonging to the account doing the pulling.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';

let currentAccountId: string | null = 'account-A';
const upserts: { table: string; payload: any; onConflict?: string }[] = [];

// Rows sitting in the "cloud", each owned by an account. The mock enforces the filter
// the way Postgres RLS would, so a pull that forgets to scope shows up as a failure here.
const cloudRows: Record<string, any[]> = {
  users: [],
  tickets: [],
  shifts: [],
  expenses: [],
  audit_logs: [],
  account_settings: [],
};

function makeSelect(table: string) {
  let filterAccount: string | undefined;
  // Set by .range(), which the paged reads use — see selectAllPages.
  let from = 0;
  let to: number | undefined;
  const builder: any = {
    eq: (col: string, val: string) => {
      if (col === 'account_id') filterAccount = val;
      return builder;
    },
    order: () => builder,
    // The incremental pull narrows by updated_at once it has a position stored; these
    // tests are about *whose* rows come back, so every row here is treated as new.
    gte: () => builder,
    range: (start: number, last: number) => {
      from = start;
      to = last;
      return builder;
    },
    maybeSingle: () => {
      const rows = (cloudRows[table] ?? []).filter((r) => r.account_id === filterAccount);
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    },
    then: (onFulfilled: any) => {
      const rows = (cloudRows[table] ?? []).filter(
        (r) => filterAccount === undefined || r.account_id === filterAccount
      );
      const page = to === undefined ? rows : rows.slice(from, to + 1);
      return Promise.resolve({ data: page, error: null }).then(onFulfilled);
    },
  };
  return builder;
}

vi.mock('../services/supabase/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: (globalThis as any).__acct
          ? { session: { access_token: 't', user: { id: (globalThis as any).__acct } } }
          : { session: null },
      })),
    },
    from: vi.fn((table: string) => ({
      select: () => makeSelect(table),
      // The worker sends a batch of rows per request. Recorded one row per entry so
      // these tests stay about what each row carries, which is what tenant isolation
      // turns on, rather than about how many rows share a request.
      upsert: vi.fn(async (payload: any, opts: any) => {
        for (const row of Array.isArray(payload) ? payload : [payload]) {
          upserts.push({ table, payload: row, onConflict: opts?.onConflict });
        }
        return { error: null };
      }),
    })),
    channel: vi.fn(),
    removeChannel: vi.fn(),
  },
}));

import { runReconciliationPull } from '../services/db/realtimeSync';
import { useSyncStore } from '../store/useSyncStore';
import { IndexedDbService } from '../services/db/IndexedDbService';
import { Ticket } from '../types/ticket';

function cloudTicket(id: string, accountId: string) {
  return {
    id,
    account_id: accountId,
    location_id: 'LOC01',
    device_id: 'DEV01',
    local_seq: 1,
    amount: 500,
    currency: '₦',
    status: 'paid',
    cashier_id: 'c1',
    created_at: '2026-08-30T12:00:00.000Z',
    qr_payload: 'q',
    updated_at: '2026-08-30T12:00:00.000Z',
  };
}

describe('tenant isolation', () => {
  let svc: IndexedDbService;

  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    svc = new IndexedDbService();
    await svc.init();
    upserts.length = 0;
    currentAccountId = 'account-A';
    (globalThis as any).__acct = 'account-A';
    for (const k of Object.keys(cloudRows)) cloudRows[k] = [];
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true },
      configurable: true,
      writable: true,
    });
    useSyncStore.setState({ isSyncing: false, pendingCount: 0, stuckCount: 0, cloudConnected: false });
  });

  it('never pulls another account\'s rows', async () => {
    cloudRows.tickets = [
      cloudTicket('mine-1', 'account-A'),
      cloudTicket('theirs-1', 'account-B'),
      cloudTicket('theirs-2', 'account-B'),
    ];

    await runReconciliationPull();

    const local = await db.tickets.toArray();
    const ids = local.map((t) => t.id).sort();
    expect(ids).toEqual(['mine-1']);
    // The failure this guards: 'theirs-1'/'theirs-2' landing here is precisely the
    // shared-LOC01 pool bug.
    expect(ids).not.toContain('theirs-1');
  });

  it('stamps every pushed row with the pushing account, whatever the table', async () => {
    const ticket: Ticket = {
      id: 'LOC01-DEV01-AAAAAA-000001',
      locationId: 'LOC01',
      deviceId: 'DEV01',
      localSeq: 1,
      amount: 500,
      currency: '₦',
      status: 'paid',
      cashierId: 'c1',
      createdAt: '2026-08-30T12:00:00.000Z',
      qrPayload: 'q',
    };
    await svc.saveTicket(ticket);
    await useSyncStore.getState().checkOutbox();
    await useSyncStore.getState().triggerSyncWorker();

    expect(upserts.length).toBeGreaterThan(0);
    for (const u of upserts) {
      expect(u.payload.account_id).toBe('account-A');
    }
  });

  it('routes account_settings upserts to the account_id key, not the row id', async () => {
    await svc.saveDeviceConfig({
      locationId: 'LOC02',
      locationName: 'Second Site',
      deviceId: 'DEV09',
      deviceName: 'Till 9',
      businessName: 'Danbaiwa',
      currencySymbol: '₦',
      presetAmounts: [100, 200],
      isConfigured: true,
    });
    await useSyncStore.getState().checkOutbox();
    await useSyncStore.getState().triggerSyncWorker();

    const settingsPush = upserts.find((u) => u.table === 'account_settings');
    expect(settingsPush).toBeDefined();
    // account_settings holds one row per account; conflicting on 'id' would fail since
    // the table has no such column.
    expect(settingsPush!.onConflict).toBe('account_id');
    expect(settingsPush!.payload.account_id).toBe('account-A');
  });

  it('pulls nothing at all when there is no session to identify an account', async () => {
    (globalThis as any).__acct = null;
    cloudRows.tickets = [cloudTicket('mine-1', 'account-A')];

    expect(await runReconciliationPull()).toBe(false);
    expect(await db.tickets.count()).toBe(0);
  });

  it('gives two accounts on the same device disjoint views', async () => {
    cloudRows.tickets = [cloudTicket('a-1', 'account-A'), cloudTicket('b-1', 'account-B')];

    await runReconciliationPull();
    expect((await db.tickets.toArray()).map((t) => t.id)).toEqual(['a-1']);

    // A different admin signs in on this same browser.
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    (globalThis as any).__acct = 'account-B';

    await runReconciliationPull();
    expect((await db.tickets.toArray()).map((t) => t.id)).toEqual(['b-1']);
  });
});
