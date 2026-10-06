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
let statusChanged: ((status: string) => void) | undefined;
let holdTable: string | null = null;
let heldRead: Promise<void> = Promise.resolve();
let onRead: ((table: string, after?: string) => void) | undefined;

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
  let after: string | undefined;
  let upper: string | undefined;
  const ordering: { col: string; ascending: boolean }[] = [];

  const resolve = () => {
    if (from === 0) reads.push({ table, since });
    if (failTable === table) return { data: null, error: { message: 'boom' } };
    onRead?.(table, after);
    const all = (fixtures[table] ?? []).filter(
      (r) => (since === undefined || String(r.updated_at ?? '') >= since) && (after === undefined || r.id > after)
        && (upper === undefined || r.updated_at <= upper)
    ).sort((a, b) => {
      for (const { col, ascending } of ordering) {
        const cmp = String(a[col]).localeCompare(String(b[col]));
        if (cmp) return ascending ? cmp : -cmp;
      }
      return 0;
    });
    const end = to === undefined ? all.length : to + 1;
    return { data: all.slice(from, Math.min(end, from + maxRows)), error: null };
  };
  const builder: any = {
    eq: () => builder,
    gt: (_col: string, val: string) => { after = val; return builder; },
    gte: (_col: string, val: string) => {
      since = val;
      return builder;
    },
    lte: (_col: string, val: string) => { upper = val; return builder; },
    order: (col: string, opts: { ascending: boolean }) => { ordering.push({ col, ascending: opts.ascending }); return builder; },
    range: (start: number, last: number) => {
      from = start;
      to = last;
      return builder;
    },
    maybeSingle: () => Promise.resolve({ data: (fixtures[table] ?? [])[0] ?? null, error: null }),
    then: (onFulfilled: any) => (holdTable === table ? heldRead.then(resolve) : Promise.resolve(resolve())).then(onFulfilled),
  };
  return builder;
}

vi.mock('../services/supabase/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    channel: vi.fn(() => {
      const builder = { on: () => builder, subscribe: (callback: (status: string) => void) => { statusChanged = callback; return builder; } };
      return builder;
    }),
    removeChannel: vi.fn(),
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

import { runReconciliationPull, runCloudCatchUp, startRealtimeSync, stopRealtimeSync } from '../services/db/realtimeSync';
import { watermarkFor, advanceWatermark } from '../services/db/syncWatermarks';
import { useSyncStore } from '../store/useSyncStore';

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
    holdTable = null;
    onRead = undefined;
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
    expect(useSyncStore.getState().pullError).toContain('tickets');
    expect(useSyncStore.getState().isPulling).toBe(false);
  });

  it('shows current till data while the phone upload is still held', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = useSyncStore.getState().triggerSyncWorker;
    const trigger = vi.fn(() => held);
    useSyncStore.setState({ triggerSyncWorker: trigger, lastPulledAt: undefined });
    const stamp = new Date().toISOString();
    fixtures.tickets = [ticketRow('CURRENT', stamp), ticketRow('OLD', '2026-08-29T12:00:00.000Z')];
    try {
      expect(await runCloudCatchUp()).toBe(true);
      expect(trigger).toHaveBeenCalled();
      expect(reads[0].table).toBe('tickets');
      expect(reads[0].since).toBeDefined();
      expect(await db.tickets.count()).toBe(2); // preview did not skip historical rows
      expect(await watermarkFor(TEST_ACCOUNT_ID, 'tickets')).not.toBeNull();
      expect(useSyncStore.getState().lastPulledAt).toBeDefined();
    } finally { release(); useSyncStore.setState({ triggerSyncWorker: original }); }
  });

  it('keeps concurrent watermark updates for different tables', async () => {
    const stamp = new Date().toISOString();
    await Promise.all([advanceWatermark(TEST_ACCOUNT_ID, 'tickets', stamp), advanceWatermark(TEST_ACCOUNT_ID, 'shifts', stamp)]);
    expect(await watermarkFor(TEST_ACCOUNT_ID, 'tickets')).not.toBeNull();
    expect(await watermarkFor(TEST_ACCOUNT_ID, 'shifts')).not.toBeNull();
  });

  it('does not advance past a new sale inserted behind the history ID cursor', async () => {
    maxRows = 2;
    fixtures.tickets = ['A', 'B', 'D', 'E'].map(id => ticketRow(id, '2026-08-29T12:00:00.000Z'));
    let inserted = false;
    onRead = (table, after) => {
      if (table !== 'tickets' || after !== 'B' || inserted) return;
      inserted = true;
      fixtures.tickets.push(ticketRow('AA', '2026-08-29T12:04:00.000Z'));
      fixtures.tickets.push(ticketRow('Z', '2026-08-29T12:08:00.000Z'));
    };
    await runReconciliationPull();
    expect(inserted).toBe(true);
    await runReconciliationPull();
    expect(await db.tickets.get('AA')).toBeDefined();
    expect(await db.tickets.get('Z')).toBeDefined();
    expect(await db.tickets.count()).toBe(6);
  });

  it('previews the newest sales first without downloading the entire trading day', async () => {
    const stamp = Date.now() - 10000;
    fixtures.tickets = Array.from({ length: 1300 }, (_, i) => ticketRow(
      `SALE-${String(i).padStart(5, '0')}`, new Date(stamp + i).toISOString()
    ));
    let release!: () => void;
    heldRead = new Promise(resolve => { release = resolve; }); holdTable = 'audit_logs';
    const history = runReconciliationPull({ recentFirst: true });
    try {
      await vi.waitFor(async () => expect(await db.tickets.get('SALE-01299')).toBeDefined());
      await vi.waitFor(async () => expect(await db.tickets.count()).toBe(500));
      expect(await watermarkFor(TEST_ACCOUNT_ID, 'tickets')).toBeNull();
    } finally { holdTable = null; release(); await history; }
    expect(await db.tickets.count()).toBe(1300);
  });

  it('refreshes a new sale while historical downloading is still blocked', async () => {
    let release!: () => void;
    heldRead = new Promise(resolve => { release = resolve; }); holdTable = 'audit_logs';
    const history = runReconciliationPull();
    await new Promise(resolve => setTimeout(resolve, 10));
    fixtures.tickets = [ticketRow('LIVE-DURING-HISTORY', new Date().toISOString())];
    void runReconciliationPull({ recentFirst: true });
    try {
      await vi.waitFor(async () => expect(await db.tickets.get('LIVE-DURING-HISTORY')).toBeDefined());
      expect(await watermarkFor(TEST_ACCOUNT_ID, 'tickets')).toBeNull();
      expect(useSyncStore.getState().isPulling).toBe(true);
    } finally { holdTable = null; release(); await history; }
  });

  it('refreshes on phone wake and socket reconnection, and removes listeners on stop', async () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', { onLine: true });
    const original = useSyncStore.getState().triggerSyncWorker;
    useSyncStore.setState({ triggerSyncWorker: async () => {} });
    const finish = async () => {
      // startRealtimeSync resolves the account before starting its first pull.
      await new Promise(resolve => setTimeout(resolve, 10));
      await runReconciliationPull();
    };
    try {
      startRealtimeSync(); await finish();
      fixtures.tickets = [ticketRow('WAKE-SALE', new Date().toISOString())];
      doc.dispatchEvent(new Event('visibilitychange')); await finish();
      expect(await db.tickets.get('WAKE-SALE')).toBeDefined();
      fixtures.tickets.push(ticketRow('SOCKET-SALE', new Date().toISOString()));
      statusChanged!('SUBSCRIBED'); await finish();
      expect(useSyncStore.getState().realtimeConnected).toBe(true);
      expect(await db.tickets.get('SOCKET-SALE')).toBeDefined();
      statusChanged!('CHANNEL_ERROR');
      expect(useSyncStore.getState().realtimeConnected).toBe(false);
      stopRealtimeSync(); reads = [];
      win.dispatchEvent(new Event('focus'));
      doc.dispatchEvent(new Event('visibilitychange'));
      statusChanged!('SUBSCRIBED');
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(reads).toHaveLength(0);
      expect(useSyncStore.getState().realtimeConnected).toBe(false);
    } finally {
      stopRealtimeSync(); useSyncStore.setState({ triggerSyncWorker: original }); vi.unstubAllGlobals();
      clearInterval((globalThis as any)._syncStoreInterval); delete (globalThis as any)._syncStoreInterval;
    }
  });
});
