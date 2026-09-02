/**
 * ticketConflictKey.test.ts
 *
 * tickets.id is minted on the till — LOC01-DEV01-K3F9QZ-000042 — and as a bare PRIMARY
 * KEY it had to be unique across every restaurant sharing the project. It cannot be:
 * location and device both default to LOC01/DEV01, and tickets predating the installation
 * segment carry only three parts. Whoever uploaded an id first owned it, and the next
 * restaurant's upsert was refused permanently, because its ON CONFLICT branch had to
 * update a row RLS would not show it.
 *
 * The key is now (account_id, id). An upsert must name the matching unique constraint, so
 * the client has to send the right conflict target — and cannot know which is right,
 * since a till is an offline PWA that may be running a build from either side of the
 * migration for as long as its service worker holds. So it corrects itself, once.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';

const ACCOUNT = '6894e791-18b1-4f53-83c7-0f644312eed5';

let sessionValue: any = { access_token: 'valid', user: { id: ACCOUNT } };
/** Conflict targets the fake cloud will accept; anything else is a 42P10. */
let acceptedTargets = new Set<string>(['account_id,id']);
let upsertCalls: { table: string; onConflict?: string; rows: any[] }[] = [];

vi.mock('../services/supabase/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: sessionValue } })),
      getUser: vi.fn(async () => ({ data: { user: { id: ACCOUNT, user_metadata: {} } } })),
    },
    rpc: vi.fn(async () => ({ data: ACCOUNT, error: null })),
    from: vi.fn((table: string) => ({
      upsert: vi.fn(async (rows: any, opts?: { onConflict?: string }) => {
        const list = Array.isArray(rows) ? rows : [rows];
        upsertCalls.push({ table, onConflict: opts?.onConflict, rows: list });
        if (opts?.onConflict && !acceptedTargets.has(opts.onConflict)) {
          return {
            error: {
              code: '42P10',
              message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification',
            },
          };
        }
        return { error: null };
      }),
    })),
  },
}));

import { useSyncStore } from '../store/useSyncStore';
import { IndexedDbService } from '../services/db/IndexedDbService';
import { Ticket } from '../types/ticket';

const ticket: Ticket = {
  id: 'LOC01-DEV01-K3F9QZ-000042',
  locationId: 'LOC01',
  deviceId: 'DEV01',
  localSeq: 42,
  amount: 500,
  currency: '₦',
  status: 'paid',
  cashierId: 'cashier-1',
  createdAt: '2026-09-02T09:00:00.000Z',
  qrPayload: 'TICKET|42|500',
};

describe('ticket conflict target', () => {
  let svc: IndexedDbService;

  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    svc = new IndexedDbService();
    await svc.init();
    upsertCalls = [];
    acceptedTargets = new Set(['account_id,id']);
    sessionValue = { access_token: 'valid', user: { id: ACCOUNT } };
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true },
      configurable: true,
      writable: true,
    });
    useSyncStore.setState({ isSyncing: false, pendingCount: 0, stuckCount: 0, cloudConnected: false });
  });

  it('upserts tickets against the account-scoped key', async () => {
    await svc.saveTicket(ticket);
    await useSyncStore.getState().checkOutbox();

    await useSyncStore.getState().triggerSyncWorker();

    expect(upsertCalls[0].onConflict).toBe('account_id,id');
    expect(useSyncStore.getState().pendingCount).toBe(0);
  });

  it('still keys the other tables by their own uuid', async () => {
    // Only tickets carry a till-minted id, so only tickets need the account in the key.
    await svc.saveShift({
      id: crypto.randomUUID(),
      locationId: 'LOC01',
      deviceId: 'DEV01',
      cashierId: 'cashier-1',
      cashierName: 'Khalid',
      status: 'open',
      openedAt: new Date().toISOString(),
      openingFloat: 0,
    } as any);
    acceptedTargets.add('id');
    await useSyncStore.getState().checkOutbox();

    await useSyncStore.getState().triggerSyncWorker();

    expect(upsertCalls.find((c) => c.table === 'shifts')?.onConflict).toBe('id');
  });

  it('falls back to the old key against a database that has not been migrated', async () => {
    // The till cannot know which side of the migration the project is on, and a PWA may
    // be running either build. One rejected statement teaches it, at no cost to the rows.
    acceptedTargets = new Set(['id']);
    await svc.saveTicket(ticket);
    await useSyncStore.getState().checkOutbox();

    await useSyncStore.getState().triggerSyncWorker();

    expect(upsertCalls.map((c) => c.onConflict)).toEqual(['account_id,id', 'id']);
    expect(useSyncStore.getState().pendingCount).toBe(0); // and the row still lands

    const [row] = await db.outbox.toArray();
    expect(row.status).toBe('synced');
    expect(row.retryCount).toBe(0); // a malformed statement is never the row's fault
  });

  it('remembers the correction instead of relearning it every pass', async () => {
    acceptedTargets = new Set(['id']);
    await svc.saveTicket(ticket);
    await useSyncStore.getState().checkOutbox();
    await useSyncStore.getState().triggerSyncWorker();

    upsertCalls = [];
    await svc.saveTicket({ ...ticket, id: 'LOC01-DEV01-K3F9QZ-000043', localSeq: 43 });
    await useSyncStore.getState().checkOutbox();
    await useSyncStore.getState().triggerSyncWorker();

    expect(upsertCalls.map((c) => c.onConflict)).toEqual(['id']); // no second probe
  });
});
