/**
 * sqliteDb.test.ts
 *
 * End-to-end Vitest test for SqliteDbService.
 * Verifies:
 * 1. DB initialises without errors (in-memory Node environment)
 * 2. getNextSeq() returns gapless sequential numbers under rapid sequential calls
 * 3. Tickets committed to SQLite persist and are retrieved correctly
 * 4. Multi-tenant isolation: User A cannot see User B tickets
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteDbService } from '../services/db/SqliteDbService';
import { Ticket } from '../types/ticket';

describe('SqliteDbService — Atomic Sequence & Persistence', () => {
  let db: SqliteDbService;

  beforeEach(async () => {
    db = new SqliteDbService();
    await db.init();
  });

  it('should initialise with default device config', async () => {
    const config = await db.getDeviceConfig();
    expect(config).not.toBeNull();
    expect(config?.locationId).toBe('LOC01');
    expect(config?.deviceId).toBe('DEV01');
    expect(config?.currencySymbol).toBe('₦');
  });

  it('should return gapless sequential numbers (1,2,3,4,5) under rapid calls', async () => {
    const seqs = await Promise.all([
      db.getNextSeq('LOC01', 'DEV01'),
      db.getNextSeq('LOC01', 'DEV01'),
      db.getNextSeq('LOC01', 'DEV01'),
      db.getNextSeq('LOC01', 'DEV01'),
      db.getNextSeq('LOC01', 'DEV01'),
    ]);

    // All values must be unique and form a contiguous range
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
      cashierId: 'user_sqlite_test',
      createdAt: new Date().toISOString(),
      qrPayload: 'TICKET|LOC01-DEV01-SEQ001|500',
    };

    await db.saveTicket(ticket);

    const retrieved = await db.getTickets('user_sqlite_test');
    expect(retrieved.length).toBeGreaterThan(0);
    expect(retrieved[0].id).toBe('LOC01-DEV01-SEQ001');
    expect(retrieved[0].amount).toBe(500);
    expect(retrieved[0].cashierId).toBe('user_sqlite_test');
  });

  it('should isolate tickets per user (multi-tenant enforcement)', async () => {
    const userATicket: Ticket = {
      id: 'LOC01-DEV01-USERA001',
      locationId: 'LOC01', deviceId: 'DEV01', localSeq: 100,
      amount: 200, currency: '₦', status: 'paid',
      cashierId: 'user_a_sqlite', createdAt: new Date().toISOString(),
      qrPayload: 'test-a',
    };
    const userBTicket: Ticket = {
      id: 'LOC01-DEV01-USERB001',
      locationId: 'LOC01', deviceId: 'DEV01', localSeq: 101,
      amount: 1000, currency: '₦', status: 'paid',
      cashierId: 'user_b_sqlite', createdAt: new Date().toISOString(),
      qrPayload: 'test-b',
    };

    await db.saveTicket(userATicket);
    await db.saveTicket(userBTicket);

    const aTickets = await db.getTickets('user_a_sqlite');
    const bTickets = await db.getTickets('user_b_sqlite');

    expect(aTickets.some(t => t.id === 'LOC01-DEV01-USERA001')).toBe(true);
    expect(aTickets.some(t => t.id === 'LOC01-DEV01-USERB001')).toBe(false);

    expect(bTickets.some(t => t.id === 'LOC01-DEV01-USERB001')).toBe(true);
    expect(bTickets.some(t => t.id === 'LOC01-DEV01-USERA001')).toBe(false);
  });

  it('should update ticket status to void with audit trail', async () => {
    const ticket: Ticket = {
      id: 'LOC01-DEV01-VOID001',
      locationId: 'LOC01', deviceId: 'DEV01', localSeq: 99,
      amount: 300, currency: '₦', status: 'paid',
      cashierId: 'user_void_test', createdAt: new Date().toISOString(),
      qrPayload: 'TICKET|VOID001|300',
    };
    await db.saveTicket(ticket);
    await db.updateTicketStatus('LOC01-DEV01-VOID001', 'void', 'Wrong amount', 'MANAGER-1');

    const tickets = await db.getTickets('user_void_test');
    const voided = tickets.find(t => t.id === 'LOC01-DEV01-VOID001');
    expect(voided).toBeDefined();
    expect(voided!.status).toBe('void');
    expect(voided!.voidReason).toBe('Wrong amount');
    expect(voided!.voidedBy).toBe('MANAGER-1');
  });
});
