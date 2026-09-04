/**
 * syncBatching.test.ts
 *
 * The worker used to send one row per HTTP round trip, strictly sequentially, so a
 * backlog drained at the speed of the network times the number of rows — the "Sync (N
 * pending)" badge visibly ticking down one at a time for minutes. Batching fixes that,
 * but only if it preserves two things the per-row loop got for free:
 *
 *   1. queue order — a record's later DELETE must never be sent before its earlier
 *      UPDATE, or the update recreates the row that was just removed;
 *   2. fault isolation — one genuinely bad record must not drag every other row in its
 *      batch into a backoff it did not earn.
 *
 * Both are pinned down here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';
import { OutboxItem } from '../types/sync';

let sessionValue: any = { access_token: 'valid', user: { id: 'ACCOUNT-1' } };

/** Every call the worker made to the cloud, in order. */
let calls: { table: string; op: 'upsert' | 'delete'; rows: any[] }[] = [];
/** Rows (by record id) the fake cloud rejects. */
let rejectIds = new Set<string>();

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
        calls.push({ table, op: 'upsert', rows: list });
        const bad = list.find((r) => rejectIds.has(String(r.id)));
        return bad
          ? { error: { code: '23503', message: `insert or update violates foreign key constraint (${bad.id})` } }
          : { error: null };
      }),
      delete: vi.fn(() => {
        const captured: any = { ids: [] as string[] };
        const builder: any = {
          in: (_col: string, ids: string[]) => {
            captured.ids = ids;
            return builder;
          },
          eq: async () => {
            calls.push({ table, op: 'delete', rows: captured.ids.map((id: string) => ({ id })) });
            return { error: null };
          },
        };
        return builder;
      }),
    })),
  },
}));

import { useSyncStore, batchOutbox, dedupeBatch } from '../store/useSyncStore';
import { dbService } from '../services/db/IndexedDbService';

function queued(over: Partial<OutboxItem> & { tableName: string; payload: Record<string, any> }): OutboxItem {
  return {
    id: crypto.randomUUID(),
    action: 'INSERT',
    createdAt: new Date().toISOString(),
    status: 'pending',
    retryCount: 0,
    ...over,
  } as OutboxItem;
}

describe('outbox batching', () => {
  describe('batchOutbox', () => {
    it('collapses a run of same-table writes into one request', () => {
      const items = Array.from({ length: 300 }, (_, i) =>
        queued({ tableName: 'tickets', payload: { id: `T${i}` } })
      );
      const batches = batchOutbox(items, 200);
      expect(batches).toHaveLength(2); // not 300
      expect(batches[0].items).toHaveLength(200);
      expect(batches[1].items).toHaveLength(100);
    });

    it('never reorders an update ahead of the delete that follows it', () => {
      // Grouping by table alone would merge the two UPDATEs across the DELETE, sending
      // the second update after the removal and resurrecting the row.
      const items = [
        queued({ tableName: 'tickets', action: 'UPDATE', payload: { id: 'A' } }),
        queued({ tableName: 'tickets', action: 'DELETE', payload: { id: 'A' } }),
        queued({ tableName: 'tickets', action: 'UPDATE', payload: { id: 'B' } }),
      ];
      const batches = batchOutbox(items);
      expect(batches.map((b) => b.action)).toEqual(['UPDATE', 'DELETE', 'UPDATE']);
    });

    it('splits batches at a table boundary', () => {
      const items = [
        queued({ tableName: 'tickets', payload: { id: 'T1' } }),
        queued({ tableName: 'expenses', payload: { id: 'E1' } }),
        queued({ tableName: 'tickets', payload: { id: 'T2' } }),
      ];
      expect(batchOutbox(items).map((b) => b.tableName)).toEqual(['tickets', 'expenses', 'tickets']);
    });
  });

  describe('dedupeBatch', () => {
    it('sends only the newest snapshot of a record, keeping the older one accounted for', () => {
      // Postgres rejects an ON CONFLICT upsert that touches the same row twice, so an
      // un-deduped batch would fail wholesale over something that is not an error.
      const first = queued({ tableName: 'tickets', payload: { id: 'T1', amount: 100 } });
      const second = queued({ tableName: 'tickets', payload: { id: 'T1', amount: 250 } });
      const other = queued({ tableName: 'tickets', payload: { id: 'T2', amount: 50 } });

      const { send, superseded } = dedupeBatch([first, second, other]);
      expect(send.map((i) => i.id)).toEqual([second.id, other.id]);
      expect(superseded.map((i) => i.id)).toEqual([first.id]);
      expect(send[0].payload.amount).toBe(250); // the later value wins
    });
  });

  describe('the worker end to end', () => {
    beforeEach(async () => {
      await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
      await dbService.init();
      calls = [];
      rejectIds = new Set();
      sessionValue = { access_token: 'valid', user: { id: 'ACCOUNT-1' } };
      Object.defineProperty(globalThis, 'navigator', {
        value: { onLine: true },
        configurable: true,
        writable: true,
      });
      useSyncStore.setState({ isSyncing: false, pendingCount: 0, stuckCount: 0, cloudConnected: false });
    });

    const seed = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await db.outbox.add(queued({ tableName: 'tickets', payload: { id: `T${i}`, amount: 100 } }));
      }
      await useSyncStore.getState().checkOutbox();
    };

    it('drains a 50-row backlog in a single request, not fifty', async () => {
      await seed(50);
      expect(useSyncStore.getState().pendingCount).toBe(50);

      await useSyncStore.getState().triggerSyncWorker();

      expect(calls).toHaveLength(1);
      expect(calls[0].rows).toHaveLength(50);
      expect(useSyncStore.getState().pendingCount).toBe(0);
      expect((await db.outbox.toArray()).every((r) => r.status === 'synced')).toBe(true);
    });

    it('isolates one bad record without charging the rest of its batch', async () => {
      await seed(10);
      rejectIds.add('T4');

      await useSyncStore.getState().triggerSyncWorker();

      const rows = await db.outbox.toArray();
      const bad = rows.filter((r) => r.payload.id === 'T4');
      const good = rows.filter((r) => r.payload.id !== 'T4');

      expect(bad[0].status).toBe('pending'); // still queued, never dropped
      expect(bad[0].retryCount).toBe(1); // and it alone is charged
      expect(good.every((r) => r.status === 'synced')).toBe(true);
      expect(good.every((r) => r.retryCount === 0)).toBe(true);
      expect(useSyncStore.getState().pendingCount).toBe(1);
    });

    it('gives a legacy ticket an explicit tender so it cannot poison the batch', async () => {
      // tickets.tender is NOT NULL with a 'cash' default, and a default only applies to a
      // request that never names the column. One modern ticket in the batch names it for
      // all of them, so every pre-split ticket would go up as tender=NULL and take the
      // whole batch down with it (23502) on every pass — a till's whole history stuck.
      await db.outbox.add(queued({ tableName: 'tickets', payload: { id: 'T-legacy', amount: 100 } }));
      await db.outbox.add(
        queued({ tableName: 'tickets', payload: { id: 'T-new', amount: 250, tender: 'transfer' } })
      );
      await useSyncStore.getState().checkOutbox();

      await useSyncStore.getState().triggerSyncWorker();

      expect(calls).toHaveLength(1);
      expect(calls[0].rows.map((r) => r.tender)).toEqual(['cash', 'transfer']);
      expect(useSyncStore.getState().pendingCount).toBe(0);
    });

    it('sends removals as removals even when batched', async () => {
      await db.outbox.add(queued({ tableName: 'users', action: 'DELETE', payload: { id: 'U1' } }));
      await db.outbox.add(queued({ tableName: 'users', action: 'DELETE', payload: { id: 'U2' } }));
      await useSyncStore.getState().checkOutbox();

      await useSyncStore.getState().triggerSyncWorker();

      expect(calls).toHaveLength(1);
      expect(calls[0].op).toBe('delete');
      expect(calls[0].rows.map((r) => r.id)).toEqual(['U1', 'U2']);
      expect(useSyncStore.getState().pendingCount).toBe(0);
    });
  });

  describe('forceSyncNow', () => {
    beforeEach(async () => {
      await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
      await dbService.init();
      calls = [];
      rejectIds = new Set();
      sessionValue = { access_token: 'valid', user: { id: 'ACCOUNT-1' } };
      Object.defineProperty(globalThis, 'navigator', {
        value: { onLine: true },
        configurable: true,
        writable: true,
      });
      useSyncStore.setState({ isSyncing: false, pendingCount: 0, stuckCount: 0, cloudConnected: false });
    });

    it('pushes rows that are still sitting out a backoff', async () => {
      // What the button is actually for. After any hiccup the queue is parked behind a
      // timer of up to half an hour; the ordinary worker would skip these entirely, so
      // pressing sync appeared to do nothing while the count trickled down on its own.
      const item = queued({ tableName: 'tickets', payload: { id: 'T1', amount: 100 } });
      await db.outbox.add({
        ...item,
        retryCount: 5,
        nextAttemptAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      });

      await useSyncStore.getState().checkOutbox();
      await useSyncStore.getState().triggerSyncWorker();
      expect(calls).toHaveLength(0); // not due yet — the ordinary worker leaves it alone

      await useSyncStore.getState().forceSyncNow();

      expect(calls).toHaveLength(1);
      expect(useSyncStore.getState().pendingCount).toBe(0);
    });
  });
});
