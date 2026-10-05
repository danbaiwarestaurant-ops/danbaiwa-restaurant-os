import { beforeEach, describe, expect, it } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';
import { IndexedDbService } from '../services/db/IndexedDbService';
import { Shift } from '../types/shift';
import { Ticket } from '../types/ticket';
import { applyRemoteRow } from '../services/db/remoteMerge';
const svc = new IndexedDbService();
const shift: Shift = { id: 'shift', cashierId: 'cashier', cashierName: 'Cashier', openedAt: '2026-10-05T08:00:00.000Z', status: 'open', openingFloat: 0, locationId: 'L', deviceId: 'D' };
const ticket = (id: string, extra: Partial<Ticket> = {}): Ticket => ({ id, cashierId: 'cashier', createdAt: '2026-10-05T09:00:00.000Z', amount: 500, tender: 'cash', status: 'paid', currency: 'N', localSeq: 1, locationId: 'L', deviceId: 'D', qrPayload: 'q', ...extra });
beforeEach(async () => { await Promise.all(TABLE_NAMES.map(name => db[name].clear())); await db.shifts.put(shift); });
describe('bounded till history with complete shift totals', () => {
  it('bootstraps legacy pages and explicit shift IDs without counting other shifts', async () => {
    await db.tickets.bulkAdd(Array.from({ length: 550 }, (_, i) => ticket(String(i).padStart(4, '0'))));
    await db.tickets.bulkAdd([ticket('explicit', { shiftId: 'shift', createdAt: '2026-10-04T09:00:00.000Z' }), ticket('other', { shiftId: 'other' }), ticket('old', { createdAt: '2026-10-04T09:00:00.000Z' })]);
    const summary = await svc.getShiftSummary(shift);
    expect(summary.ticketCount).toBe(551);
    expect(summary.cash).toBe(275500);
    const recent = await svc.getRecentTickets('cashier');
    expect(recent).toHaveLength(200);
    const older = await svc.getRecentTickets('cashier', recent[199]);
    expect(older).toHaveLength(200);
    expect(older.some(row => recent.some(t => t.id === row.id))).toBe(false);
  });
  it('atomically maintains totals through sales, voids, tender changes, remote updates and rollback', async () => {
    await svc.getShiftSummary(shift);
    await svc.saveTicket(ticket('a', { shiftId: 'shift' }));
    await svc.updateTicketTender('a', 'transfer', 'owner');
    expect(await svc.getShiftSummary(shift)).toMatchObject({ ticketCount: 1, revenue: 500, cash: 0, transfer: 500 });
    await svc.updateTicketStatus('a', 'void', 'Mistake', 'owner');
    expect(await svc.getShiftSummary(shift)).toMatchObject({ ticketCount: 0, voidCount: 1, revenue: 0 });
    await db.outbox.clear();
    await applyRemoteRow('tickets', ticket('a', { status: 'paid', amount: 700, updatedAt: '2099-01-01T00:00:00Z' }), 'UPDATE');
    expect(await svc.getShiftSummary(shift)).toMatchObject({ ticketCount: 1, voidCount: 0, cash: 700 });
    await expect(db.transaction('rw', db.tickets, async () => { await db.tickets.add(ticket('rollback')); throw new Error('abort'); })).rejects.toThrow('abort');
    expect((await svc.getShiftSummary(shift)).cash).toBe(700);
  });
});
