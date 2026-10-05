import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { db, TABLE_NAMES, TicketPosDB } from '../services/db/dexieSchema';

describe('non-destructive till schema upgrade', () => {
  it('preserves old records, counts rejected work and restores interrupted syncing rows', async () => {
    const name = 'upgrade-test-' + crypto.randomUUID();
    const old = new Dexie(name);
    const stores = Object.fromEntries(TABLE_NAMES.map(name => {
      const schema = db.table(name).schema;
      const indexes = schema.indexes.filter(index => !['[cashierId+createdAt+id]', '[shiftId+createdAt+id]', '[status+readyAt+createdAt+id]', '[cashierId+status]'].includes(index.name));
      return [name, [schema.primKey.src, ...indexes.map(index => index.src)].join(',')];
    }));
    stores.outbox += ',createdAt,[status+createdAt+id]';
    old.version(4).stores(stores);
    await old.table('outbox').bulkAdd([
      { id: 'pending', status: 'pending', tableName: 'tickets', payload: { id: 'sale' }, createdAt: '2026-10-01T12:00:00Z', retryCount: 0 },
      { id: 'failed', status: 'failed', tableName: 'tickets', payload: { id: 'other' }, createdAt: '2026-10-01T12:00:00Z', retryCount: 8 },
      { id: 'interrupted', status: 'syncing', tableName: 'tickets', payload: { id: 'third' }, createdAt: '2026-10-01T12:00:00Z', retryCount: 0 },
    ]);
    await old.table('tickets').add({ id: 'sale', cashierId: 'cashier', amount: 500, createdAt: '2026-10-01T12:00:00Z' });
    old.close();
    const upgraded = new TicketPosDB(name), otherTab = new TicketPosDB(name);
    try {
      await upgraded.open();
      expect(await upgraded.tickets.get('sale')).toMatchObject({ amount: 500, cashierId: 'cashier' });
      expect(await upgraded.queueCounters.get('outbox')).toEqual({ key: 'outbox', pending: 2, failed: 1, stuck: 1 });
      expect(await upgraded.outbox.get('interrupted')).toMatchObject({ status: 'pending', readyAt: '' });
      await otherTab.open();
      await upgraded.outbox.update('failed', { status: 'synced' });
      expect(await otherTab.queueCounters.get('outbox')).toEqual({ key: 'outbox', pending: 2, failed: 0, stuck: 0 });
    } finally { upgraded.close(); otherTab.close(); await Dexie.delete(name); }
  });
});
