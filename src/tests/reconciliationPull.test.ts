import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';

const fixtures: Record<string, any[]> = {
  users: [],
  tickets: [],
  shifts: [],
  expenses: [],
  audit_logs: [],
};
let failTable: string | null = null;

function makeQuery(table: string) {
  const resolve = () => {
    if (failTable === table) return { data: null, error: { message: 'boom' } };
    return { data: fixtures[table] ?? [], error: null };
  };
  const builder: any = {
    eq: () => builder,
    then: (onFulfilled: any) => Promise.resolve(resolve()).then(onFulfilled),
  };
  return builder;
}

vi.mock('../services/supabase/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'test-token' } } }),
      getUser: vi.fn().mockResolvedValue({ data: { user: { user_metadata: { location_id: 'LOC01' } } } }),
    },
    from: vi.fn((table: string) => ({ select: () => makeQuery(table) })),
  },
}));

import { runReconciliationPull } from '../services/db/realtimeSync';

describe('runReconciliationPull', () => {
  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    fixtures.users = [];
    fixtures.tickets = [];
    fixtures.shifts = [];
    fixtures.expenses = [];
    fixtures.audit_logs = [];
    failTable = null;
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
