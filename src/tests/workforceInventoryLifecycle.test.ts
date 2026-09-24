import { beforeEach, describe, expect, it } from 'vitest';
import './setup/fakeIndexedDb';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';
import { IndexedDbService } from '../services/db/IndexedDbService';
import { calculateAssessment } from '../utils/workforce';
import { fifoAllocate, stockSummary } from '../utils/inventory';

describe('workforce and inventory persistence lifecycle', () => {
  let service: IndexedDbService;
  beforeEach(async () => {
    await db.open();
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    service = new IndexedDbService();
    await service.init();
  });

  it('saves, finalizes and reopens an assessment with synced audit history', async () => {
    const totals = calculateAssessment({
      output: 12, nairaPerUnit: 200,
      penalties: [{ id: 'late', label: 'Late', kind: 'fixed', value: 500 }],
    });
    const base: any = {
      id: '2026-09-18_staff-1', businessDay: '2026-09-18', staffId: 'staff-1', staffName: 'Amina',
      role: 'server', metricLabel: 'Tickets collected', output: 12, target: 10, nairaPerUnit: 200,
      penalties: [], ...totals, note: 'Lunch shift', status: 'draft', recordedBy: 'admin-1', recordedAt: new Date().toISOString(),
    };
    await service.saveStaffAssessment(base, 'admin-1', 'entered');
    await service.saveStaffAssessment({ ...base, status: 'finalized', finalizedAt: new Date().toISOString() }, 'admin-1', 'day closed');
    await service.saveStaffAssessment({ ...base, status: 'draft', reopenReason: 'Correct paper tally' }, 'admin-1', 'Correct paper tally');

    const [saved] = await service.getStaffAssessments();
    expect(saved.status).toBe('draft');
    expect(saved.netPay).toBe(1900);
    const audit = await service.getAuditLogs(base.id);
    expect(audit.map((a) => a.action)).toEqual(['REOPEN_ASSESSMENT', 'FINALIZE_ASSESSMENT', 'CREATE_ASSESSMENT']);
    const pending = await db.outbox.where('status').equals('pending').toArray();
    expect(pending.filter((o) => o.tableName === 'staff_assessments')).toHaveLength(3);
    expect(pending.filter((o) => o.tableName === 'audit_logs')).toHaveLength(3);
  });

  it('receives two batches and persists FIFO usage down to remaining stock and value', async () => {
    const oldBatch: any = { id: crypto.randomUUID(), itemId: crypto.randomUUID(), receivedAt: '2026-09-17T08:00:00Z', originalQuantityBase: 5, remainingQuantityBase: 5, unitCostBase: 200 };
    const newBatch: any = { id: crypto.randomUUID(), itemId: oldBatch.itemId, receivedAt: '2026-09-18T08:00:00Z', originalQuantityBase: 10, remainingQuantityBase: 10, unitCostBase: 300 };
    const receipt = (batch: any): any => ({ id: crypto.randomUUID(), itemId: batch.itemId, itemName: 'Rice', businessDay: batch.receivedAt.slice(0, 10), type: 'receipt', quantityBase: batch.originalQuantityBase, value: batch.originalQuantityBase * batch.unitCostBase, allocations: [], recordedBy: 'admin-1', recordedAt: batch.receivedAt });
    await service.receiveInventory(oldBatch, receipt(oldBatch), 'admin-1');
    await service.receiveInventory(newBatch, receipt(newBatch), 'admin-1');
    const fifo = fifoAllocate(await service.getInventoryBatches(oldBatch.itemId), 8);
    const quantities = new Map(fifo.allocations.map((a) => [a.batchId, a.quantity]));
    const updated = (await service.getInventoryBatches(oldBatch.itemId)).filter((b) => quantities.has(b.id)).map((b) => ({ ...b, remainingQuantityBase: b.remainingQuantityBase - (quantities.get(b.id) || 0) }));
    await service.issueInventory({ id: crypto.randomUUID(), itemId: oldBatch.itemId, itemName: 'Rice', businessDay: '2026-09-18', type: 'usage', quantityBase: -8, value: -fifo.value, allocations: fifo.allocations, note: 'Dinner service', recordedBy: 'admin-1', recordedAt: new Date().toISOString() }, updated, 'admin-1');

    const remaining = stockSummary(oldBatch.itemId, await service.getInventoryBatches(oldBatch.itemId));
    expect(remaining).toEqual({ quantity: 7, value: 2100 });
    expect(fifo.value).toBe(1900);
    const movements = await service.getInventoryMovements();
    expect(movements).toHaveLength(3);
    expect(movements.some((m) => m.type === 'usage' && m.quantityBase === -8)).toBe(true);
    const pending = await db.outbox.where('status').equals('pending').toArray();
    expect(pending.some((o) => o.tableName === 'inventory_batches' && o.action === 'UPDATE')).toBe(true);
    expect((await service.getAuditLogs()).filter((a) => a.entity === 'inventory')).toHaveLength(3);
  });

  it('commits a charged staff meal and its wage deduction with both outbox rows', async () => {
    const ticket: any = { id: 'LOC-DEV-1', locationId: 'LOC', deviceId: 'DEV', localSeq: 1, amount: 1200, currency: '₦', status: 'paid', tender: 'staff', createdAt: '2026-09-22T12:00:00Z', cashierId: 'cashier-1', qrPayload: 'meal', staffId: 'staff-1', staffName: 'Amina', staffMealWageDeduction: 700 };
    const wage: any = { id: crypto.randomUUID(), staffId: 'staff-1', staffName: 'Amina', businessDay: '2026-09-22', kind: 'manual_adjustment', amount: -700, note: 'Staff meal deduction: Meat', recordedBy: 'cashier-1', recordedAt: '2026-09-22T12:00:00Z' };
    await service.saveStaffMealTicket(ticket, wage);
    expect(await db.tickets.get(ticket.id)).toBeTruthy();
    expect((await service.getWageLedger())[0].amount).toBe(-700);
    const pending = await db.outbox.where('status').equals('pending').toArray();
    expect(pending.some((row) => row.tableName === 'tickets' && row.payload.id === ticket.id)).toBe(true);
    expect(pending.some((row) => row.tableName === 'wage_ledger' && row.payload.id === wage.id)).toBe(true);
  });
});
