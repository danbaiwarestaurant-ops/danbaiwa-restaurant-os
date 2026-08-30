/**
 * indexedDbService.test.ts
 *
 * End-to-end Vitest test for IndexedDbService, mirroring the old sqliteDb.test.ts
 * coverage against the Dexie-backed implementation, plus an outbox-coverage check
 * for .agents/AGENTS.md rule 3 ("every mutation must queue an outbox row in the
 * same transaction").
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IndexedDbService } from '../services/db/IndexedDbService';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';
import { Ticket } from '../types/ticket';

describe('IndexedDbService — Atomic Sequence & Persistence', () => {
  let svc: IndexedDbService;

  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    svc = new IndexedDbService();
    await svc.init();
  });

  it('should initialise with default device config', async () => {
    const config = await svc.getDeviceConfig();
    expect(config).not.toBeNull();
    expect(config?.locationId).toBe('LOC01');
    expect(config?.deviceId).toBe('DEV01');
    expect(config?.currencySymbol).toBe('₦');
  });

  it('should return gapless sequential numbers (1,2,3,4,5) under rapid calls', async () => {
    const seqs = await Promise.all([
      svc.getNextSeq('LOC01', 'DEV01'),
      svc.getNextSeq('LOC01', 'DEV01'),
      svc.getNextSeq('LOC01', 'DEV01'),
      svc.getNextSeq('LOC01', 'DEV01'),
      svc.getNextSeq('LOC01', 'DEV01'),
    ]);

    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted[0]).toBeGreaterThan(0);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBe(sorted[i - 1] + 1);
    }
  });

  it('should persist a ticket and retrieve it by cashierId', async () => {
    const ticket: Ticket = {
      id: 'LOC01-DEV01-SEQ001',
      locationId: 'LOC01',
      deviceId: 'DEV01',
      localSeq: 1,
      amount: 500,
      currency: '₦',
      status: 'paid',
      cashierId: 'user_idb_test',
      createdAt: new Date().toISOString(),
      qrPayload: 'TICKET|LOC01-DEV01-SEQ001|500',
    };

    await svc.saveTicket(ticket);

    const retrieved = await svc.getTickets('user_idb_test');
    expect(retrieved.length).toBeGreaterThan(0);
    expect(retrieved[0].id).toBe('LOC01-DEV01-SEQ001');
    expect(retrieved[0].amount).toBe(500);
    expect(retrieved[0].cashierId).toBe('user_idb_test');
  });

  it('should isolate tickets per user (multi-tenant enforcement)', async () => {
    const userATicket: Ticket = {
      id: 'LOC01-DEV01-USERA001',
      locationId: 'LOC01', deviceId: 'DEV01', localSeq: 100,
      amount: 200, currency: '₦', status: 'paid',
      cashierId: 'user_a_idb', createdAt: new Date().toISOString(),
      qrPayload: 'test-a',
    };
    const userBTicket: Ticket = {
      id: 'LOC01-DEV01-USERB001',
      locationId: 'LOC01', deviceId: 'DEV01', localSeq: 101,
      amount: 1000, currency: '₦', status: 'paid',
      cashierId: 'user_b_idb', createdAt: new Date().toISOString(),
      qrPayload: 'test-b',
    };

    await svc.saveTicket(userATicket);
    await svc.saveTicket(userBTicket);

    const aTickets = await svc.getTickets('user_a_idb');
    const bTickets = await svc.getTickets('user_b_idb');

    expect(aTickets.some((t) => t.id === 'LOC01-DEV01-USERA001')).toBe(true);
    expect(aTickets.some((t) => t.id === 'LOC01-DEV01-USERB001')).toBe(false);

    expect(bTickets.some((t) => t.id === 'LOC01-DEV01-USERB001')).toBe(true);
    expect(bTickets.some((t) => t.id === 'LOC01-DEV01-USERA001')).toBe(false);
  });

  it('should update ticket status to void with audit trail', async () => {
    const ticket: Ticket = {
      id: 'LOC01-DEV01-VOID001',
      locationId: 'LOC01', deviceId: 'DEV01', localSeq: 99,
      amount: 300, currency: '₦', status: 'paid',
      cashierId: 'user_void_test', createdAt: new Date().toISOString(),
      qrPayload: 'TICKET|VOID001|300',
    };
    await svc.saveTicket(ticket);
    await svc.updateTicketStatus('LOC01-DEV01-VOID001', 'void', 'Wrong amount', 'MANAGER-1');

    const tickets = await svc.getTickets('user_void_test');
    const voided = tickets.find((t) => t.id === 'LOC01-DEV01-VOID001');
    expect(voided).toBeDefined();
    expect(voided!.status).toBe('void');
    expect(voided!.voidReason).toBe('Wrong amount');
    expect(voided!.voidedBy).toBe('MANAGER-1');

    const logs = await db.auditLogs.where('entityId').equals('LOC01-DEV01-VOID001').toArray();
    expect(logs.some((l) => l.action === 'VOID')).toBe(true);
  });

  it('queues an audit_logs outbox row when a ticket is voided (AGENTS.md rule 3 coverage)', async () => {
    const ticket: Ticket = {
      id: 'LOC01-DEV01-AUDITOUTBOX001',
      locationId: 'LOC01', deviceId: 'DEV01', localSeq: 55,
      amount: 400, currency: '₦', status: 'paid',
      cashierId: 'user_audit_outbox_test', createdAt: new Date().toISOString(),
      qrPayload: 'TICKET|AUDITOUTBOX001|400',
    };
    await svc.saveTicket(ticket);
    await svc.updateTicketStatus('LOC01-DEV01-AUDITOUTBOX001', 'void', 'Test void', 'MANAGER-2');

    const pending = await svc.getPendingOutbox();
    const auditRow = pending.find((o) => o.tableName === 'audit_logs' && o.action === 'INSERT');
    expect(auditRow).toBeDefined();
    expect(auditRow!.payload.entityId).toBe('LOC01-DEV01-AUDITOUTBOX001');
    expect(auditRow!.payload.action).toBe('VOID');
  });

  it('queues an audit_logs outbox row when an expense is approved or rejected', async () => {
    const expense = {
      id: 'expense-audit-outbox-1',
      shiftId: 'shift-1',
      cashierId: 'user_expense_audit_test',
      cashierName: 'Test Cashier',
      amount: 200,
      category: 'Supplies',
      description: 'Test expense',
      status: 'pending' as const,
      loggedAt: new Date().toISOString(),
    };
    await svc.saveExpense(expense);
    await svc.updateExpenseStatus('expense-audit-outbox-1', 'approved', 'Manager Test');

    const pending = await svc.getPendingOutbox();
    const auditRow = pending.find((o) => o.tableName === 'audit_logs' && o.payload.entityId === 'expense-audit-outbox-1');
    expect(auditRow).toBeDefined();
    expect(auditRow!.payload.action).toBe('APPROVE_EXPENSE');
  });

  it('round-trips audit logs through getAuditLogs, filterable by entityId and actorId', async () => {
    const ticket: Ticket = {
      id: 'LOC01-DEV01-AUDITREAD001',
      locationId: 'LOC01', deviceId: 'DEV01', localSeq: 56,
      amount: 300, currency: '₦', status: 'paid',
      cashierId: 'user_audit_read_test', createdAt: new Date().toISOString(),
      qrPayload: 'TICKET|AUDITREAD001|300',
    };
    await svc.saveTicket(ticket);
    await svc.updateTicketStatus('LOC01-DEV01-AUDITREAD001', 'void', 'reason', 'MANAGER-3');

    const byEntity = await svc.getAuditLogs('LOC01-DEV01-AUDITREAD001');
    expect(byEntity.length).toBeGreaterThan(0);
    expect(byEntity[0].action).toBe('VOID');

    const byActor = await svc.getAuditLogs(undefined, 'MANAGER-3');
    expect(byActor.some((l) => l.entityId === 'LOC01-DEV01-AUDITREAD001')).toBe(true);
  });

  it('should queue exactly one outbox row per mutating call (full outbox coverage)', async () => {
    const ticket: Ticket = {
      id: 'LOC01-DEV01-OUTBOX001',
      locationId: 'LOC01', deviceId: 'DEV01', localSeq: 42,
      amount: 750, currency: '₦', status: 'paid',
      cashierId: 'user_outbox_test', createdAt: new Date().toISOString(),
      qrPayload: 'TICKET|OUTBOX001|750',
    };

    await svc.saveTicket(ticket);
    let pending = await svc.getPendingOutbox();
    expect(pending.filter((o) => o.tableName === 'tickets' && o.action === 'INSERT').length).toBe(1);

    await svc.updateTicketStatus('LOC01-DEV01-OUTBOX001', 'collected');
    pending = await svc.getPendingOutbox();
    expect(pending.filter((o) => o.tableName === 'tickets' && o.action === 'UPDATE').length).toBe(1);
  });
});
