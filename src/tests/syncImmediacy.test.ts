/**
 * syncImmediacy.test.ts
 *
 * Why a queued record used to take so long to reach the cloud, even on a good line.
 * Batching had already cut the number of requests; what was left was waiting:
 *
 *   1. The worker refuses to run twice at once, and it used to drop any trigger that
 *      arrived mid-push on the floor. On a busy till a push is in flight most of the
 *      time, so the ticket just rung up sat there until the background poll came round.
 *   2. A dropped connection was charged to every row in flight as if the row had been
 *      rejected, and each one earned an exponential backoff. The link came back seconds
 *      later; the queue then trickled out over the following half hour.
 *
 * Both are behaviours of the worker, not of the network, so both are pinned here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';
import { OutboxItem } from '../types/sync';

let sessionValue: any = { access_token: 'valid', user: { id: 'ACCOUNT-1' } };
let calls: { table: string; rows: any[] }[] = [];
/** Error the fake cloud returns, or null for success. */
let upsertError: { code?: string; message: string } | null = null;
/** When set, the *next* request blocks until this is resolved — a push "in flight". */
let hold: Promise<void> | null = null;

vi.mock('../services/supabase/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: sessionValue } })),
      getUser: vi.fn(async () => ({
        data: { user: { id: 'ACCOUNT-1', user_metadata: { location_id: 'LOC01' } } },
      })),
    },
    from: vi.fn((table: string) => ({
      upsert: vi.fn(async (rows: any) => {
        const list = Array.isArray(rows) ? rows : [rows];
        calls.push({ table, rows: list });
        const waiting = hold;
        hold = null;
        if (waiting) await waiting;
        return { error: upsertError };
      }),
    })),
  },
}));

import { useSyncStore } from '../store/useSyncStore';
import { dbService } from '../services/db/IndexedDbService';

function queued(tableName: string, id: string): OutboxItem {
  return {
    id: crypto.randomUUID(),
    tableName,
    action: 'INSERT',
    payload: { id, amount: 100 },
    createdAt: new Date().toISOString(),
    status: 'pending',
    retryCount: 0,
  } as OutboxItem;
}

describe('sync immediacy', () => {
  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    await dbService.init();
    calls = [];
    upsertError = null;
    hold = null;
    sessionValue = { access_token: 'valid', user: { id: 'ACCOUNT-1' } };
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true },
      configurable: true,
      writable: true,
    });
    useSyncStore.setState({ isSyncing: false, pendingCount: 0, stuckCount: 0, cloudConnected: false });
  });

  it('sends a record queued mid-push as soon as that push lands, without waiting for a poll', async () => {
    await db.outbox.add(queued('tickets', 'T1'));
    await useSyncStore.getState().checkOutbox();

    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const firstPush = useSyncStore.getState().triggerSyncWorker();
    // Let the pass get as far as the (now blocked) request.
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    // A second ticket is rung up while that request is still in the air.
    await db.outbox.add(queued('tickets', 'T2'));
    await useSyncStore.getState().checkOutbox();
    await useSyncStore.getState().triggerSyncWorker(); // returns at once; must not be lost
    expect(calls).toHaveLength(1); // nothing sent twice, nothing sent concurrently

    release();
    await firstPush;

    expect(calls).toHaveLength(2);
    expect(calls[1].rows.map((r) => r.id)).toEqual(['T2']);
    expect(useSyncStore.getState().pendingCount).toBe(0);
    expect((await db.outbox.toArray()).every((r) => r.status === 'synced')).toBe(true);
  });

  it('charges no retry and sets no backoff when the connection drops mid-push', async () => {
    for (let i = 0; i < 5; i++) await db.outbox.add(queued('tickets', `T${i}`));
    await useSyncStore.getState().checkOutbox();

    upsertError = { message: 'TypeError: Failed to fetch' };
    await useSyncStore.getState().triggerSyncWorker();

    // One attempt, then the pass stops — no point isolating rows against a dead link.
    expect(calls).toHaveLength(1);

    const rows = await db.outbox.toArray();
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(rows.every((r) => r.retryCount === 0)).toBe(true);
    expect(rows.every((r) => !r.nextAttemptAt)).toBe(true); // due now, not in half an hour
    expect(useSyncStore.getState().pendingCount).toBe(5);

    // And the moment the line is back, the whole queue goes in one request — it was
    // never parked behind a timer it had to wait out first.
    upsertError = null;
    await useSyncStore.getState().triggerSyncWorker();

    expect(calls).toHaveLength(2);
    expect(calls[1].rows).toHaveLength(5);
    expect(useSyncStore.getState().pendingCount).toBe(0);
  });

  it('still charges a retry when the cloud genuinely rejects the record', async () => {
    // The distinction the fix rests on: a refusal is the row's problem, a dropped
    // connection is not.
    await db.outbox.add(queued('tickets', 'T1'));
    await useSyncStore.getState().checkOutbox();

    upsertError = { code: '23503', message: 'insert or update violates foreign key constraint' };
    await useSyncStore.getState().triggerSyncWorker();

    const [row] = await db.outbox.toArray();
    expect(row.retryCount).toBe(1);
    expect(row.nextAttemptAt).toBeDefined();
  });
});
