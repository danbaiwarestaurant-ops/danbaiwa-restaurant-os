/**
 * accountScope.test.ts
 *
 * The stamping sweep is what rescues history created before account scoping existed:
 * those rows carry no accountId, so the cloud rejects every one of them and no other
 * device can ever see them. These tests pin down that it claims exactly the unowned
 * rows, never reassigns a row that already belongs to someone, and never enqueues a
 * push of its own.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';

vi.mock('../services/supabase/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: 't', user: { id: 'account-A' } } },
      }),
    },
  },
}));

import { getAccountId, stampLocalRowsWithAccount } from '../services/db/accountScope';
import { Ticket } from '../types/ticket';

const ticket: Ticket = {
  id: 'LOC01-DEV01-AAAAAA-000001',
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

describe('accountScope', () => {
  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
  });

  it('reads the tenant id from the live session', async () => {
    expect(await getAccountId()).toBe('account-A');
  });

  it('stamps rows that belong to nobody', async () => {
    await db.tickets.add({ ...ticket });
    await db.shifts.add({
      id: 'shift-1',
      cashierId: 'c1',
      cashierName: 'C',
      locationId: 'LOC01',
      deviceId: 'DEV01',
      status: 'open',
      openedAt: '2026-08-30T08:00:00.000Z',
      openingFloat: 5000,
    } as any);

    const stamped = await stampLocalRowsWithAccount('account-A');
    expect(stamped).toBe(2);
    expect((await db.tickets.get(ticket.id))?.accountId).toBe('account-A');
    expect((await db.shifts.get('shift-1'))?.accountId).toBe('account-A');
  });

  it('never reassigns a row that already belongs to another account', async () => {
    await db.tickets.add({ ...ticket, accountId: 'account-B' });

    const stamped = await stampLocalRowsWithAccount('account-A');
    expect(stamped).toBe(0);
    expect((await db.tickets.get(ticket.id))?.accountId).toBe('account-B');
  });

  it('never queues an outbox row itself — the backfill decides what to upload', async () => {
    await db.tickets.add({ ...ticket });
    const before = await db.outbox.count();

    await stampLocalRowsWithAccount('account-A');

    // Stamping every historical row through saveTicket() would enqueue a duplicate push
    // for each one; the backfill diffs against the cloud instead.
    expect(await db.outbox.count()).toBe(before);
  });

  it('is idempotent — a second sweep finds nothing left to claim', async () => {
    await db.tickets.add({ ...ticket });
    expect(await stampLocalRowsWithAccount('account-A')).toBe(1);
    expect(await stampLocalRowsWithAccount('account-A')).toBe(0);
  });
});
