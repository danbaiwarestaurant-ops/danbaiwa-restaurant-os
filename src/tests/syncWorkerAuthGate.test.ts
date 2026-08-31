/**
 * syncWorkerAuthGate.test.ts
 *
 * The root cause of the cross-device data loss: the sync worker checked only
 * navigator.onLine and isSupabaseConfigured, never whether a Supabase session existed.
 * With no session every upsert is rejected by RLS, and each rejection was charged to the
 * queued row — so being online-but-unauthenticated burned through every row's retry
 * budget and wrote the data off.
 *
 * A missing session is an environment problem, not the row's fault. These tests pin that
 * distinction down.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';

let sessionValue: any = null;
let upsertError: { code?: string; message: string } | null = null;
let upsertCallCount = 0;

vi.mock('../services/supabase/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: sessionValue } })),
      getUser: vi.fn(async () => ({ data: { user: { user_metadata: { location_id: 'LOC01' } } } })),
    },
    from: vi.fn(() => ({
      upsert: vi.fn(async () => {
        upsertCallCount++;
        return { error: upsertError };
      }),
    })),
  },
}));

import { useSyncStore } from '../store/useSyncStore';
import { IndexedDbService } from '../services/db/IndexedDbService';
import { Ticket } from '../types/ticket';

const ticket: Ticket = {
  id: 'LOC01-DEV01-GATE001',
  locationId: 'LOC01',
  deviceId: 'DEV01',
  localSeq: 1,
  amount: 500,
  currency: '₦',
  status: 'paid',
  cashierId: 'cashier-1',
  createdAt: '2026-08-30T12:00:00.000Z',
  qrPayload: 'TICKET|1|500',
};

describe('sync worker cloud-session gate', () => {
  let svc: IndexedDbService;

  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    svc = new IndexedDbService();
    await svc.init();
    sessionValue = null;
    upsertError = null;
    upsertCallCount = 0;
    // The worker must believe it is online, so that the session gate is what is
    // actually under test rather than the offline short-circuit. globalThis.navigator
    // is getter-only under Node, so it has to be redefined rather than assigned.
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true },
      configurable: true,
      writable: true,
    });
    useSyncStore.setState({ isSyncing: false, pendingCount: 0, stuckCount: 0, cloudConnected: false });
  });

  it('does not attempt a push, or charge any row a retry, when there is no cloud session', async () => {
    await svc.saveTicket(ticket);
    await useSyncStore.getState().checkOutbox();
    expect(useSyncStore.getState().pendingCount).toBe(1);

    await useSyncStore.getState().triggerSyncWorker();

    expect(upsertCallCount).toBe(0); // never even tried
    const rows = await db.outbox.toArray();
    expect(rows[0].retryCount).toBe(0); // budget untouched
    expect(rows[0].status).toBe('pending'); // still queued, still owed
    expect(useSyncStore.getState().cloudConnected).toBe(false);
  });

  it('aborts the batch without charging retries when the session is genuinely gone', async () => {
    sessionValue = { access_token: 'valid-at-first' };
    await svc.saveTicket(ticket);
    await svc.saveTicket({ ...ticket, id: 'LOC01-DEV01-GATE002', localSeq: 2 });
    await useSyncStore.getState().checkOutbox();

    // The JWT died mid-batch, and the session check confirms it.
    sessionValue = null;
    upsertError = { code: '42501', message: 'new row violates row-level security policy' };
    await useSyncStore.getState().triggerSyncWorker();

    const rows = await db.outbox.toArray();
    for (const row of rows) {
      expect(row.status).toBe('pending');
      expect(row.retryCount).toBe(0); // not this row's fault — nothing written off
    }
    expect(useSyncStore.getState().cloudConnected).toBe(false);
  });

  it('keeps the session marked healthy when RLS rejects a row but the session is valid', async () => {
    // Postgres returns 42501 both for "not authenticated" and for "this row is scoped to
    // a tenant your token does not cover". Reading the second as the first made a
    // successful reconnect flip straight back to "Not Signed In to Cloud".
    sessionValue = { access_token: 'perfectly-valid' };
    await svc.saveTicket(ticket);
    await useSyncStore.getState().checkOutbox();

    upsertError = { code: '42501', message: 'new row violates row-level security policy for table "shifts"' };
    await useSyncStore.getState().triggerSyncWorker();

    // Still connected — the token is fine, the row's scope is not.
    expect(useSyncStore.getState().cloudConnected).toBe(true);
    // And it is treated as a row fault: backed off, still queued, never dropped.
    const rows = await db.outbox.toArray();
    expect(rows[0].retryCount).toBe(1);
    expect(rows[0].status).toBe('pending');
    // The reported reason must name the real problem, not blame the credentials.
    expect(useSyncStore.getState().cloudError).toMatch(/different location/i);
  });

  it('does charge a retry when the row itself is genuinely rejected', async () => {
    sessionValue = { access_token: 'valid' };
    await svc.saveTicket(ticket);
    await useSyncStore.getState().checkOutbox();

    // A real row-level problem (bad FK, schema mismatch) — this one IS attributable.
    upsertError = { code: '23503', message: 'insert or update violates foreign key constraint' };
    await useSyncStore.getState().triggerSyncWorker();

    const rows = await db.outbox.toArray();
    expect(rows[0].retryCount).toBe(1);
    expect(rows[0].status).toBe('pending'); // backed off, still never abandoned
    expect(rows[0].nextAttemptAt).toBeDefined();
  });

  it('marks rows synced and reports a clean state on success', async () => {
    sessionValue = { access_token: 'valid' };
    await svc.saveTicket(ticket);
    await useSyncStore.getState().checkOutbox();

    await useSyncStore.getState().triggerSyncWorker();

    const rows = await db.outbox.toArray();
    expect(rows.every((r) => r.status === 'synced')).toBe(true);
    expect(useSyncStore.getState().pendingCount).toBe(0);
    expect(useSyncStore.getState().cloudConnected).toBe(true);
  });
});
