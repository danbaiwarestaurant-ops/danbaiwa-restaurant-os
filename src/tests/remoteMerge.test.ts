import { describe, it, expect, beforeEach } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';
import { applyRemoteRow, isRowDirty, shouldApplyRemote } from '../services/db/remoteMerge';
import { Ticket } from '../types/ticket';

describe('remoteMerge', () => {
  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
  });

  describe('shouldApplyRemote (last-write-wins)', () => {
    it('applies when no local row exists', () => {
      expect(shouldApplyRemote(undefined, { updatedAt: '2026-08-29T12:00:00.000Z' })).toBe(true);
    });

    it('applies when remote updatedAt is strictly newer', () => {
      expect(
        shouldApplyRemote({ updatedAt: '2026-08-29T12:00:00.000Z' }, { updatedAt: '2026-08-29T12:00:01.000Z' })
      ).toBe(true);
    });

    it('ignores when remote updatedAt is older or equal', () => {
      expect(
        shouldApplyRemote({ updatedAt: '2026-08-29T12:00:01.000Z' }, { updatedAt: '2026-08-29T12:00:00.000Z' })
      ).toBe(false);
      expect(
        shouldApplyRemote({ updatedAt: '2026-08-29T12:00:00.000Z' }, { updatedAt: '2026-08-29T12:00:00.000Z' })
      ).toBe(false);
    });
  });

  describe('applyRemoteRow', () => {
    const ticket: Ticket = {
      id: 'LOC01-DEV01-SEQ001',
      locationId: 'LOC01',
      deviceId: 'DEV01',
      localSeq: 1,
      amount: 500,
      currency: '₦',
      status: 'paid',
      cashierId: 'cashier-1',
      createdAt: '2026-08-29T12:00:00.000Z',
      qrPayload: 'TICKET|1|500',
      updatedAt: '2026-08-29T12:00:00.000Z',
    };

    it('applies a remote row when no local row exists', async () => {
      const changed = await applyRemoteRow('tickets', ticket, 'INSERT');
      expect(changed).toBe(true);
      const stored = await db.tickets.get(ticket.id);
      expect(stored?.amount).toBe(500);
    });

    it('applies a remote row when its updatedAt is newer than the local one', async () => {
      await db.tickets.add({ ...ticket, status: 'paid', updatedAt: '2026-08-29T12:00:00.000Z' });
      const newer = { ...ticket, status: 'void', updatedAt: '2026-08-29T12:05:00.000Z' };
      const changed = await applyRemoteRow('tickets', newer, 'UPDATE');
      expect(changed).toBe(true);
      const stored = await db.tickets.get(ticket.id);
      expect(stored?.status).toBe('void');
    });

    it('ignores a remote row when its updatedAt is older or equal (LWW)', async () => {
      await db.tickets.add({ ...ticket, status: 'void', updatedAt: '2026-08-29T12:05:00.000Z' });
      const stale = { ...ticket, status: 'paid', updatedAt: '2026-08-29T12:00:00.000Z' };
      const changed = await applyRemoteRow('tickets', stale, 'UPDATE');
      expect(changed).toBe(false);
      const stored = await db.tickets.get(ticket.id);
      expect(stored?.status).toBe('void'); // untouched
    });

    it('ignores a remote row entirely when a pending outbox entry exists for that id, regardless of timestamp', async () => {
      // Local unsynced edit: newer local write, still queued in the outbox.
      await db.tickets.add({ ...ticket, status: 'void', updatedAt: '2026-08-29T12:10:00.000Z' });
      await db.outbox.add({
        id: 'outbox-1',
        tableName: 'tickets',
        action: 'UPDATE',
        payload: { id: ticket.id },
        createdAt: '2026-08-29T12:10:00.000Z',
        status: 'pending',
        retryCount: 0,
      });

      expect(await isRowDirty('tickets', ticket.id)).toBe(true);

      // A remote value that is, on paper, even newer — must still be rejected, since
      // this device's own unsynced edit hasn't reached the server yet.
      const evenNewerRemote = { ...ticket, status: 'paid', updatedAt: '2026-08-29T12:20:00.000Z' };
      const changed = await applyRemoteRow('tickets', evenNewerRemote, 'UPDATE');
      expect(changed).toBe(false);
      const stored = await db.tickets.get(ticket.id);
      expect(stored?.status).toBe('void');
    });

    it('also treats a failed outbox entry as dirty (not just pending)', async () => {
      await db.outbox.add({
        id: 'outbox-2',
        tableName: 'tickets',
        action: 'UPDATE',
        payload: { id: ticket.id },
        createdAt: '2026-08-29T12:00:00.000Z',
        status: 'failed',
        retryCount: 8,
      });
      expect(await isRowDirty('tickets', ticket.id)).toBe(true);
    });

    it('never writes an outbox entry itself — applying a remote row must not re-queue a push', async () => {
      const before = await db.outbox.count();
      await applyRemoteRow('tickets', ticket, 'INSERT');
      const after = await db.outbox.count();
      expect(after).toBe(before);
    });

    it('computes loginKeys when applying a remote users row, so getUserByEmail can find it', async () => {
      const user = {
        id: 'user-1',
        name: 'Remote Admin',
        email: 'remote@example.com',
        username: 'remote@example.com',
        pinHash: 'h',
        pinSalt: 's',
        role: 'admin',
        createdAt: '2026-08-29T12:00:00.000Z',
        status: 'active',
        updatedAt: '2026-08-29T12:00:00.000Z',
      };
      await applyRemoteRow('users', user, 'INSERT');
      const found = await db.users.where('loginKeys').equals('remote@example.com').first();
      expect(found?.id).toBe('user-1');
    });

    it('removes a local row on a DELETE event when not dirty', async () => {
      await db.tickets.add(ticket);
      const changed = await applyRemoteRow('tickets', { id: ticket.id }, 'DELETE');
      expect(changed).toBe(true);
      expect(await db.tickets.get(ticket.id)).toBeUndefined();
    });

    it('skips a DELETE event when the row has unsynced local changes', async () => {
      await db.tickets.add(ticket);
      await db.outbox.add({
        id: 'outbox-3',
        tableName: 'tickets',
        action: 'UPDATE',
        payload: { id: ticket.id },
        createdAt: '2026-08-29T12:00:00.000Z',
        status: 'pending',
        retryCount: 0,
      });
      const changed = await applyRemoteRow('tickets', { id: ticket.id }, 'DELETE');
      expect(changed).toBe(false);
      expect(await db.tickets.get(ticket.id)).toBeDefined();
    });
  });
});
