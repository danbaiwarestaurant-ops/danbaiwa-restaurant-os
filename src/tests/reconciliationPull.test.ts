import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';

const TEST_ACCOUNT_ID = 'acct-0000-1111';

const fixtures: Record<string, any[]> = {
  users: [],
  tickets: [],
  shifts: [],
  expenses: [],
  audit_logs: [],
  account_settings: [],
};
let failTable: string | null = null;

/**
 * How many rows this fake API will return in one response, whatever is asked for —
 * PostgREST's "Max rows" cap, which is silent: no error, no flag, just a short answer
 * that is indistinguishable from a short table.
 */
let maxRows = 1000;

/** Every read the pull issued: which table, and what it asked to start from. */
let reads: { table: string; since?: string }[] = [];

function makeQuery(table: string) {
  // Set by .range(); undefined until then, which is the unpaged case.
  let from = 0;
  let to: number | undefined;
  let since: string | undefined;

  const resolve = () => {
    if (from === 0) reads.push({ table, since });
    if (failTable === table) return { data: null, error: { message: 'boom' } };
    const all = (fixtures[table] ?? []).filter(
      (r) => since === undefined || String(r.updated_at ?? '') >= since
    );
    const end = to === undefined ? all.length : to + 1;
    return { data: all.slice(from, Math.min(end, from + maxRows)), error: null };
  };
  const builder: any = {
    eq: () => builder,
    gte: (_col: string, val: string) => {
      since = val;
      return builder;
    },
    order: () => builder,
    range: (start: number, last: number) => {
      from = start;
      to = last;
      return builder;
    },
    maybeSingle: () => Promise.resolve({ data: (fixtures[table] ?? [])[0] ?? null, error: null }),
    then: (onFulfilled: any) => Promise.resolve(resolve()).then(onFulfilled),
  };
  return builder;
}

vi.mock('../services/supabase/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      // The account id is the tenant key the whole pull scopes by, and it comes from
      // the session's user id — so the mocked session must carry one. Inlined rather
      // than referencing a const: vi.mock is hoisted above every top-level binding.
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: 'test-token', user: { id: 'acct-0000-1111' } } },
      }),
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'acct-0000-1111' } } }),
    },
    from: vi.fn((table: string) => ({ select: () => makeQuery(table) })),
  },
}));

import { runReconciliationPull } from '../services/db/realtimeSync';
import { watermarkFor } from '../services/db/syncWatermarks';

/** A cloud ticket row, as PostgREST would hand it back. */
function ticketRow(id: string, updatedAt: string) {
  return {
    id,
    location_id: 'LOC01',
    device_id: 'DEV01',
    local_seq: 1,
    amount: 500,
    currency: '₦',
    status: 'paid',
    cashier_id: 'cashier-1',
    created_at: '2026-08-29T12:00:00.000Z',
    qr_payload: `TICKET|${id}|500`,
    updated_at: updatedAt,
  };
}

describe('runReconciliationPull', () => {
  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    fixtures.users = [];
    fixtures.tickets = [];
    fixtures.shifts = [];
    fixtures.expenses = [];
    fixtures.audit_logs = [];
    fixtures.account_settings = [];
    failTable = null;
    maxRows = 1000;
    reads = [];
    await db.config.clear();
  });

  it('reads only what changed once it has read a table through', async () => {
    // The whole point of the watermark. Re-reading the account's entire history every
    // minute is what made a busy restaurant impossible to run: a month of tickets is
    // ~100 MB, per till, per minute, to discover that nothing had changed.
    fixtures.tickets = [ticketRow('LOC01-DEV01-000001', '2026-08-29T12:00:00.000Z')];

    await runReconciliationPull();
    expect(reads.find((r) => r.table === 'tickets')?.since).toBeUndefined(); // first: all of it

    reads = [];
    fixtures.tickets.push(ticketRow('LOC01-DEV01-000002', '2026-08-29T12:05:00.000Z'));
    await runReconciliationPull();

    const second = reads.find((r) => r.table === 'tickets');
    expect(second?.since).toBeDefined(); // second: only what is new
    expect(Date.parse(second!.since!)).toBeLessThan(Date.parse('2026-08-29T12:00:00.000Z'));
    expect(await db.tickets.count()).toBe(2); // and the new row still lands
  });

  it('starts from scratch for a different account on the same device', async () => {
    fixtures.tickets = [ticketRow('LOC01-DEV01-000001', '2026-08-29T12:00:00.000Z')];
    await runReconciliationPull();

    // Carrying a position across accounts would tell the second admin's session it had
    // already read history it has never seen, and it would never pull that history down.
    expect(await watermarkFor(TEST_ACCOUNT_ID, 'tickets')).not.toBeNull();
    expect(await watermarkFor('acct-9999-8888', 'tickets')).toBeNull();
  });

  it('asks for the whole history again when told to', async () => {
    fixtures.tickets = [ticketRow('LOC01-DEV01-000001', '2026-08-29T12:00:00.000Z')];
    await runReconciliationPull();

    reads = [];
    await runReconciliationPull({ full: true });

    expect(reads.find((r) => r.table === 'tickets')?.since).toBeUndefined();
  });

  it('reaches back behind its own position on a deep sweep, but only that far', async () => {
    // The periodic net for a row that was somehow never applied while the position moved
    // past it. It must widen the window — and it must NOT widen it to "everything", which
    // is the cost that made the old sweep unaffordable.
    fixtures.tickets = [ticketRow('LOC01-DEV01-000001', new Date().toISOString())];
    await runReconciliationPull();

    reads = [];
    await runReconciliationPull({ lookBackMs: 24 * 60 * 60_000 });

    const since = reads.find((r) => r.table === 'tickets')?.since;
    expect(since).toBeDefined();
    const behindBy = Date.now() - Date.parse(since!);
    expect(behindBy).toBeGreaterThan(23 * 60 * 60_000);
    expect(behindBy).toBeLessThan(25 * 60 * 60_000);
  });

  it('pulls the whole history down, not just the first page the API will return', async () => {
    // The API caps a response at 1000 rows and says nothing about it. Read unpaged, a
    // till with a longer history than that simply never receives the rest of it — and
    // the backfill sweep, which diffs against this same read, concludes the cloud is
    // missing every row past the cap and re-uploads them on every pass, for ever.
    // The real cap is 1000; the number is immaterial to the bug, and a smaller one keeps
    // the test from spending seconds writing rows to prove a point about paging.
    maxRows = 100;
    fixtures.tickets = Array.from({ length: 257 }, (_, i) => ({
      id: `LOC01-DEV01-${String(i).padStart(6, '0')}`,
      location_id: 'LOC01',
      device_id: 'DEV01',
      local_seq: i,
      amount: 100,
      currency: '₦',
      status: 'paid',
      cashier_id: 'cashier-1',
      created_at: '2026-08-29T12:00:00.000Z',
      qr_payload: `TICKET|${i}|100`,
      updated_at: '2026-08-29T12:00:00.000Z',
    }));

    await runReconciliationPull();

    expect(await db.tickets.count()).toBe(257);
  });

  it('pages correctly when the API caps responses below the page size', async () => {
    // Advancing by the page size asked for rather than by what came back would step
    // straight over the rows a smaller cap held back, losing them silently.
    maxRows = 40;
    fixtures.shifts = Array.from({ length: 130 }, (_, i) => ({
      id: `shift-${String(i).padStart(4, '0')}`,
      cashier_id: 'cashier-1',
      cashier_name: 'Amina',
      location_id: 'LOC01',
      device_id: 'DEV01',
      status: 'closed',
      opening_float: 0,
      opened_at: '2026-08-29T08:00:00.000Z',
      updated_at: '2026-08-29T12:00:00.000Z',
    }));

    await runReconciliationPull();

    expect(await db.shifts.count()).toBe(130);
  });

  it('populates local Dexie tables with camelCase rows pulled from each table', async () => {
    fixtures.tickets = [
      {
        id: 'LOC01-DEV02-SEQ001',
        location_id: 'LOC01',
        device_id: 'DEV02',
        local_seq: 1,
        amount: 750,
        currency: '₦',
        status: 'paid',
        cashier_id: 'cashier-2',
        created_at: '2026-08-29T12:00:00.000Z',
        qr_payload: 'TICKET|1|750',
        updated_at: '2026-08-29T12:00:00.000Z',
      },
    ];

    const changed = await runReconciliationPull();
    expect(changed).toBe(true);

    const stored = await db.tickets.get('LOC01-DEV02-SEQ001');
    expect(stored?.amount).toBe(750);
    expect(stored?.deviceId).toBe('DEV02'); // confirms snake_case -> camelCase mapping
  });

  it('preserves a locally-dirty row even when the mocked remote returns a conflicting value', async () => {
    const id = 'LOC01-DEV01-SEQ001';
    await db.tickets.add({
      id,
      locationId: 'LOC01',
      deviceId: 'DEV01',
      localSeq: 1,
      amount: 999,
      currency: '₦',
      status: 'void',
      cashierId: 'cashier-1',
      createdAt: '2026-08-29T12:00:00.000Z',
      qrPayload: 'TICKET|1|999',
      updatedAt: '2026-08-29T12:30:00.000Z',
    });
    await db.outbox.add({
      id: 'outbox-1',
      tableName: 'tickets',
      action: 'UPDATE',
      payload: { id },
      createdAt: '2026-08-29T12:30:00.000Z',
      status: 'pending',
      retryCount: 0,
    });

    fixtures.tickets = [
      {
        id,
        location_id: 'LOC01',
        device_id: 'DEV01',
        local_seq: 1,
        amount: 999,
        currency: '₦',
        status: 'paid', // conflicting remote value
        cashier_id: 'cashier-1',
        created_at: '2026-08-29T12:00:00.000Z',
        qr_payload: 'TICKET|1|999',
        updated_at: '2026-08-29T13:00:00.000Z', // "newer" on paper — still must lose
      },
    ];

    await runReconciliationPull();
    const stored = await db.tickets.get(id);
    expect(stored?.status).toBe('void'); // untouched
  });

  it('does not abort other tables when one table query fails', async () => {
    failTable = 'tickets';
    fixtures.users = [
      {
        id: 'user-1',
        name: 'Remote User',
        email: 'remote@example.com',
        username: 'remote@example.com',
        pin_hash: 'h',
        pin_salt: 's',
        role: 'admin',
        created_at: '2026-08-29T12:00:00.000Z',
        status: 'active',
        updated_at: '2026-08-29T12:00:00.000Z',
      },
    ];

    const changed = await runReconciliationPull();
    expect(changed).toBe(true); // users still landed despite tickets failing
    const stored = await db.users.get('user-1');
    expect(stored?.email).toBe('remote@example.com');
  });
});
