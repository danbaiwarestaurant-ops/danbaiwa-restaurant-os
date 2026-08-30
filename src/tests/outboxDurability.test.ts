/**
 * outboxDurability.test.ts
 *
 * Guards the single most important property of the sync layer: unsynced local data is
 * NEVER abandoned.
 *
 * The original implementation parked a row as status:'failed' after 8 attempts, and
 * getPendingOutbox() only ever returned 'pending' — so nothing in the entire system
 * would retry it again. A till that spent ~2 minutes online-but-unauthenticated
 * (a password login, or any cashier login) permanently orphaned every ticket created in
 * that window: invisible to every other device, forever, while the UI showed a green
 * "Online • Synced". These tests encode the rules that make that impossible.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IndexedDbService } from '../services/db/IndexedDbService';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';
import { Ticket } from '../types/ticket';

const ticket: Ticket = {
  id: 'LOC01-DEV01-DURABLE001',
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

describe('outbox durability', () => {
  let svc: IndexedDbService;

  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    svc = new IndexedDbService();
    await svc.init();
  });

  it('never parks a row as permanently failed, no matter how many attempts it takes', async () => {
    await svc.saveTicket(ticket);
    const [row] = await svc.getPendingOutbox();

    // Far past the old MAX_OUTBOX_RETRIES cliff of 8.
    for (let attempt = 0; attempt < 25; attempt++) {
      const current = (await db.outbox.get(row.id))!;
      await svc.markOutboxAttemptFailed(current.id, current.retryCount, 'simulated failure');
    }

    const after = (await db.outbox.get(row.id))!;
    expect(after.status).toBe('pending');
    expect(after.retryCount).toBe(25);

    // Still counted as owed to the cloud — never silently dropped from the tally.
    const { total } = await svc.countUnsyncedOutbox();
    expect(total).toBeGreaterThan(0);
  });

  it('reports a backed-off row as still unsynced even while it is not due for retry', async () => {
    await svc.saveTicket(ticket);
    const [row] = await svc.getPendingOutbox();
    await svc.markOutboxAttemptFailed(row.id, 5, 'simulated failure');

    // Not eligible right now (it is waiting out its backoff)...
    const due = await svc.getPendingOutbox();
    expect(due.find((o) => o.id === row.id)).toBeUndefined();

    // ...but it must still be reported as data the cloud does not have. This is the
    // exact gap that let the UI show a confident green badge over stranded data.
    const { total } = await svc.countUnsyncedOutbox();
    expect(total).toBe(1);
  });

  it('flags a repeatedly-rejected row as stuck without dropping it', async () => {
    await svc.saveTicket(ticket);
    const [row] = await svc.getPendingOutbox();
    await svc.markOutboxAttemptFailed(row.id, 8, 'schema mismatch');

    const { total, stuck } = await svc.countUnsyncedOutbox();
    expect(total).toBe(1);
    expect(stuck).toBe(1);
  });

  it('revives rows an older build parked as failed, and clears every backoff', async () => {
    await svc.saveTicket(ticket);
    const [row] = await svc.getPendingOutbox();

    // Simulate the legacy permanently-parked state left behind on real devices.
    await db.outbox.update(row.id, { status: 'failed', retryCount: 8 });
    expect(await svc.getPendingOutbox()).toHaveLength(0);

    const revived = await svc.revivePendingOutbox();
    expect(revived).toBe(1);

    const due = await svc.getPendingOutbox();
    expect(due).toHaveLength(1);
    expect(due[0].retryCount).toBe(0);
    expect(due[0].nextAttemptAt).toBeUndefined();
  });

  it('enqueueBackfill queues missing rows but never duplicates one already in flight', async () => {
    await svc.saveTicket(ticket); // already has a pending outbox entry

    const queued = await svc.enqueueBackfill('tickets', [
      { ...ticket },                            // already in flight — must be skipped
      { ...ticket, id: 'LOC01-DEV01-DURABLE002' }, // genuinely missing — must be queued
    ]);

    expect(queued).toBe(1);
    const rows = (await db.outbox.toArray()).filter((r) => r.tableName === 'tickets');
    const ids = rows.map((r) => (r.payload as any).id).sort();
    expect(ids).toEqual(['LOC01-DEV01-DURABLE001', 'LOC01-DEV01-DURABLE002']);
  });

  it('enqueueBackfill re-queues a row whose only outbox entry was already marked synced', async () => {
    // This is the stranded-history case: the push was recorded as done, but the row
    // never actually reached Postgres (rejected while unauthenticated, then written
    // off). Backfill compares against what the cloud really holds, so it must queue.
    await svc.saveTicket(ticket);
    const [row] = await svc.getPendingOutbox();
    await svc.markOutboxSynced(row.id);

    const queued = await svc.enqueueBackfill('tickets', [{ ...ticket }]);
    expect(queued).toBe(1);
  });
});
