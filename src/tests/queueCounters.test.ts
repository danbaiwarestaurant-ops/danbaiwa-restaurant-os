import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../services/db/dexieSchema';
import { IndexedDbService } from '../services/db/IndexedDbService';
import { OutboxItem } from '../types/sync';

const row = (id: string, status: OutboxItem['status'] = 'pending', retryCount = 0): OutboxItem =>
  ({ id, tableName: 'tickets', action: 'INSERT', payload: { id }, createdAt: new Date().toISOString(), status, retryCount });
const svc = new IndexedDbService();
beforeEach(async () => { await db.outbox.clear(); });
describe('atomic constant-time outbox counters', () => {
  it('tracks add, overwrite, retry, acknowledgement and deletion accurately', async () => {
    await db.outbox.bulkAdd([row('a'), row('b', 'failed', 8), row('c', 'synced')]);
    expect(await svc.countUnsyncedOutbox(false)).toEqual({ total: 2, stuck: 1 });
    await db.outbox.bulkPut([row('a', 'pending', 9), row('b', 'synced'), row('a', 'synced')]);
    expect(await svc.countUnsyncedOutbox(false)).toEqual({ total: 0, stuck: 0 });
    await db.outbox.put(row('c', 'failed', 10));
    await db.outbox.bulkDelete(['c', 'missing']);
    expect(await svc.countUnsyncedOutbox(false)).toEqual({ total: 0, stuck: 0 });
  });
  it('rolls counters back with the business transaction and serializes parallel writes', async () => {
    await expect(db.transaction('rw', db.outbox, async () => {
      await Promise.all([db.outbox.add(row('a')), db.outbox.add(row('b'))]);
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await svc.countUnsyncedOutbox(false)).toEqual({ total: 0, stuck: 0 });
    await db.transaction('rw', db.outbox, () => Promise.all([db.outbox.add(row('a')), db.outbox.add(row('b'))]));
    expect(await svc.countUnsyncedOutbox(false)).toEqual({ total: 2, stuck: 0 });
  });
  it('handles partial bulk failures and clear without corrupting counts', async () => {
    await db.outbox.add(row('a'));
    await db.transaction('rw', db.outbox, async () => {
      await db.outbox.bulkAdd([row('a'), row('b')]).catch(() => {});
    });
    expect(await svc.countUnsyncedOutbox(false)).toEqual({ total: 2, stuck: 0 });
    await db.outbox.clear();
    expect(await svc.countUnsyncedOutbox(false)).toEqual({ total: 0, stuck: 0 });
  });
  it('never counts queue indexes to refresh the badge', async () => {
    await db.outbox.add(row('a'));
    const where = vi.spyOn(db.outbox, 'where');
    expect(await svc.countUnsyncedOutbox(false)).toEqual({ total: 1, stuck: 0 });
    expect(where).not.toHaveBeenCalled();
    where.mockRestore();
  });
  it('keeps before-images independent of mutable rows returned to callers', async () => {
    await db.outbox.add(row('a'));
    await db.transaction('rw', db.outbox, async () => {
      const rows = await db.outbox.toArray();
      rows[0].status = 'synced';
      await db.outbox.bulkPut(rows);
    });
    expect(await svc.countUnsyncedOutbox(false)).toEqual({ total: 0, stuck: 0 });
  });
  it('retains replay ordering proof without full acknowledged snapshots', async () => {
    const older = { ...row('old'), payload: { id: 'sale', accountId: 'account', status: 'paid' }, retryCount: 1,
      createdAt: '2026-10-01T12:00:00Z' };
    const latest = { ...row('new'), payload: { id: 'sale', accountId: 'account', status: 'void' },
      createdAt: '2026-10-01T12:01:00Z' };
    await db.outbox.bulkAdd([older, latest]);
    await svc.markOutboxSyncedMany([latest.id]);
    expect((await db.outbox.get(latest.id))?.payload).toEqual({ id: 'sale', accountId: 'account' });
    expect(await svc.prepareOutboxRetry(older, 'account')).toBe(false);
    expect(await svc.countUnsyncedOutbox(false)).toEqual({ total: 0, stuck: 0 });
  });
});
