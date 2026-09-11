/**
 * serverSales.test.ts
 *
 * The one table whose contents nobody observed.
 *
 * Every other figure in the system is a consequence of something that happened — a sale
 * was rung up, so a ticket exists. A server's ticket count is typed in by a manager from
 * a tally sheet, which means the usual protections do not apply: nothing upstream
 * guarantees the number is whole, non-negative, or entered only once. These pin the rules
 * that stand in for that, and the one that matters most is the identity rule — a count
 * entered twice for the same server on the same day must be one number, not two.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { serverSalesId } from '../types/serverSales';
import { db } from '../services/db/dexieSchema';
import { dbService } from '../services/db/IndexedDbService';
import { useServerSalesStore } from '../store/useServerSalesStore';
import { useAuthStore } from '../store/useAuthStore';

// The store pokes the sync worker after every write; there is no cloud in a test run.
vi.mock('../store/useSyncStore', () => ({
  useSyncStore: {
    getState: () => ({
      checkOutbox: () => Promise.resolve(),
      triggerSyncWorker: () => Promise.resolve(),
    }),
  },
}));

const MANAGER = { id: 'u-ada', name: 'Ada' } as any;

beforeEach(async () => {
  await dbService.init();
  await db.serverSales.clear();
  await db.outbox.clear();
  useServerSalesStore.setState({ entries: [], isLoading: false, scope: {} });
  useAuthStore.setState({ activeUser: MANAGER } as any);
});

describe('the identity of a count', () => {
  it('is one row per server per trading day', () => {
    expect(serverSalesId('2026-09-10', 'u-bola')).toBe('2026-09-10_u-bola');
    expect(serverSalesId('2026-09-10', 'u-bola')).toBe(serverSalesId('2026-09-10', 'u-bola'));
    expect(serverSalesId('2026-09-11', 'u-bola')).not.toBe(serverSalesId('2026-09-10', 'u-bola'));
  });

  it('overwrites rather than doubles when a number is corrected', async () => {
    // The failure this exists to prevent: a manager enters 40 on the till, notices the
    // tally was wrong and re-enters 34 on the office laptop. With a random id per entry
    // both rows survive the merge and the day reads 74 — a number nobody typed, and one
    // that looks entirely plausible in a monthly total.
    const store = useServerSalesStore.getState();
    await store.recordCount({
      serverId: 'u-bola',
      serverName: 'Bola',
      businessDay: '2026-09-10',
      ticketCount: 40,
    });
    await store.recordCount({
      serverId: 'u-bola',
      serverName: 'Bola',
      businessDay: '2026-09-10',
      ticketCount: 34,
    });

    const rows = await dbService.getServerSales();
    expect(rows).toHaveLength(1);
    expect(rows[0].ticketCount).toBe(34);
    expect(useServerSalesStore.getState().entries).toHaveLength(1);
  });

  it('keeps two servers on the same day apart', async () => {
    const store = useServerSalesStore.getState();
    await store.recordCount({ serverId: 'u-bola', serverName: 'Bola', businessDay: '2026-09-10', ticketCount: 40 });
    await store.recordCount({ serverId: 'u-chidi', serverName: 'Chidi', businessDay: '2026-09-10', ticketCount: 12 });

    expect(await dbService.getServerSales()).toHaveLength(2);
  });
});

describe('what a typed-in number is allowed to be', () => {
  it('is a whole, non-negative count', async () => {
    // Nothing upstream of a text input guarantees either, and both would reach the cloud
    // and every total computed off it.
    const store = useServerSalesStore.getState();
    const rounded = await store.recordCount({
      serverId: 'u-bola',
      serverName: 'Bola',
      businessDay: '2026-09-10',
      ticketCount: 12.6,
    });
    expect(rounded.ticketCount).toBe(13);

    const floored = await store.recordCount({
      serverId: 'u-chidi',
      serverName: 'Chidi',
      businessDay: '2026-09-10',
      ticketCount: -5,
    });
    expect(floored.ticketCount).toBe(0);
  });

  it('records zero as a real answer', async () => {
    // "Worked and sold nothing" is a fact worth keeping — it is the entry form's blank
    // box, not its zero, that means "not counted".
    const entry = await useServerSalesStore.getState().recordCount({
      serverId: 'u-bola',
      serverName: 'Bola',
      businessDay: '2026-09-10',
      ticketCount: 0,
    });
    expect(entry.ticketCount).toBe(0);
    expect(await dbService.getServerSales()).toHaveLength(1);
  });

  it('drops an empty note rather than storing whitespace', async () => {
    const entry = await useServerSalesStore.getState().recordCount({
      serverId: 'u-bola',
      serverName: 'Bola',
      businessDay: '2026-09-10',
      ticketCount: 5,
      note: '   ',
    });
    expect(entry.note).toBeUndefined();
  });
});

describe('who entered it', () => {
  it('is recorded on every row', async () => {
    // This figure is asserted, not observed — it is the only number in the system with
    // nothing behind it but somebody's word, so the word has a name against it.
    const entry = await useServerSalesStore.getState().recordCount({
      serverId: 'u-bola',
      serverName: 'Bola',
      businessDay: '2026-09-10',
      ticketCount: 20,
    });
    expect(entry.recordedBy).toBe('u-ada');
    expect(entry.recordedByName).toBe('Ada');
    expect(entry.recordedAt).toBeTruthy();
  });

  it('carries the server name onto the row', async () => {
    // Denormalised so a season's figures still name people after they leave and their
    // user row is gone — the same reason a shift carries cashierName.
    const entry = await useServerSalesStore.getState().recordCount({
      serverId: 'u-gone',
      serverName: 'Chidi',
      businessDay: '2026-09-10',
      ticketCount: 8,
    });
    expect(entry.serverName).toBe('Chidi');
  });
});

describe('reading them back', () => {
  beforeEach(async () => {
    const store = useServerSalesStore.getState();
    await store.recordCount({ serverId: 'u-bola', serverName: 'Bola', businessDay: '2026-09-01', ticketCount: 10 });
    await store.recordCount({ serverId: 'u-bola', serverName: 'Bola', businessDay: '2026-09-15', ticketCount: 20 });
    await store.recordCount({ serverId: 'u-bola', serverName: 'Bola', businessDay: '2026-10-01', ticketCount: 30 });
  });

  it('reads a trading-day range inclusively at both ends', async () => {
    // The console asks for a month, and a month's first and last days are exactly the
    // ones an off-by-one drops.
    const rows = await dbService.getServerSales('2026-09-01', '2026-09-30');
    expect(rows.map((r) => r.ticketCount).sort((a, b) => a - b)).toEqual([10, 20]);
  });

  it('returns the newest trading day first', async () => {
    const rows = await dbService.getServerSales();
    expect(rows[0].businessDay).toBe('2026-10-01');
  });

  it('groups a day by server for the entry form', async () => {
    await useServerSalesStore.getState().loadServerSales();
    const day = useServerSalesStore.getState().countsForDay('2026-09-15');
    expect(day['u-bola'].ticketCount).toBe(20);
    expect(day['u-chidi']).toBeUndefined();
  });
});

describe('removing a count entered by mistake', () => {
  it('takes it out of the cloud too, not just this device', async () => {
    // Without the DELETE the next reconciliation pull simply puts the row back, and the
    // manager watches a number they deleted reappear.
    const entry = await useServerSalesStore.getState().recordCount({
      serverId: 'u-bola',
      serverName: 'Bola',
      businessDay: '2026-09-10',
      ticketCount: 400,
    });
    await useServerSalesStore.getState().removeCount(entry.id);

    expect(await dbService.getServerSales()).toHaveLength(0);
    const queued = await db.outbox.toArray();
    expect(queued.some((o) => o.tableName === 'server_sales' && o.action === 'DELETE')).toBe(true);
  });

  it('does nothing at all for an id that is not there', async () => {
    await useServerSalesStore.getState().removeCount('2026-09-10_nobody');
    const queued = await db.outbox.toArray();
    expect(queued.some((o) => o.action === 'DELETE')).toBe(false);
  });
});

describe('the outbox', () => {
  it('queues every count for the cloud under its own table', async () => {
    await useServerSalesStore.getState().recordCount({
      serverId: 'u-bola',
      serverName: 'Bola',
      businessDay: '2026-09-10',
      ticketCount: 15,
    });
    const queued = await db.outbox.toArray();
    expect(queued).toHaveLength(1);
    expect(queued[0].tableName).toBe('server_sales');
    expect(queued[0].payload.id).toBe('2026-09-10_u-bola');
  });
});
