import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';
import { dbService } from '../services/db/IndexedDbService';
import { applyRemoteRow, applyRemoteRows } from '../services/db/remoteMerge';
import { useTicketStore } from '../store/useTicketStore';
import { useShiftStore } from '../store/useShiftStore';
import { useAuthStore } from '../store/useAuthStore';
import { readSessionIdentity, writeSessionIdentity } from '../services/sessionIdentity';
import { shiftTickets } from '../utils/analytics';
import { Ticket } from '../types/ticket';
import { Shift } from '../types/shift';

vi.mock('../services/supabase/supabaseClient', async original => ({ ...(await original<any>()), isSupabaseConfigured: false }));
vi.mock('../services/print/PrintAdapter', () => ({ PrintAdapter: { printTicket: vi.fn(async () => ({ success: true })) } }));
const ticket = (id: string): Ticket => ({ id, locationId: 'L', deviceId: 'D', localSeq: 1, cashierId: 'cashier', createdAt: new Date().toISOString(), amount: 500, currency: 'N', status: 'paid', qrPayload: 'q' });
const shift = (id: string): Shift => ({ id, locationId: 'L', deviceId: 'D', cashierId: 'cashier', cashierName: 'Cashier', openedAt: '2026-10-04T00:00:00Z', status: 'open', openingFloat: 0 });
function storage() {
  const rows = new Map<string, string>();
  return { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => rows.set(key, value), removeItem: (key: string) => rows.delete(key) };
}
beforeEach(async () => {
  await Promise.all(TABLE_NAMES.map(name => (db as any)[name].clear()));
  useAuthStore.setState({ activeUser: null, isLoaded: false, isAuthenticated: false });
  useTicketStore.setState({ tickets: [], scope: undefined, isLoading: false });
  useShiftStore.setState({ currentShift: null });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('operational record safety', () => {
  it('a roster refresh cannot undo a sign-in that finished while it was reading', async () => {
    const cashier = { id: 'cashier', name: 'Cashier', role: 'cashier', status: 'active' } as any;
    const admin = { ...cashier, id: 'admin', role: 'admin' };
    useAuthStore.setState({ activeUser: cashier, isLoaded: true, isAuthenticated: true });
    let resolve!: (users: any[]) => void;
    vi.spyOn(dbService, 'getUsers').mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const refresh = useAuthStore.getState().loadUsers();
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    useAuthStore.setState({ activeUser: admin });
    resolve([cashier]); await refresh;
    expect(useAuthStore.getState().activeUser?.id).toBe('admin');
  });

  it('clearing the shift for admin access invalidates a pending cashier shift read', async () => {
    let resolve!: (shift: Shift | null) => void;
    vi.spyOn(dbService, 'getCurrentShift').mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValueOnce(null);
    const cashierLoad = useShiftStore.getState().loadShift('cashier');
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    await useShiftStore.getState().loadShift();
    resolve(shift('cashier-live')); await cashierLoad;
    expect(useShiftStore.getState().currentShift).toBeNull();
    expect(useShiftStore.getState().isLoading).toBe(false);
  });

  it('keeps cashier and admin identities independent across tabs and reloads', () => {
    const shared = storage(), cashierTab = storage(), adminTab = storage();
    vi.stubGlobal('localStorage', shared); vi.stubGlobal('sessionStorage', cashierTab);
    shared.setItem('ticket_pos_session_user_id', 'cashier');
    expect(readSessionIdentity()).toBe('cashier');
    vi.stubGlobal('sessionStorage', adminTab);
    expect(readSessionIdentity()).toBeNull();
    writeSessionIdentity('admin');
    expect(readSessionIdentity()).toBe('admin');
    vi.stubGlobal('sessionStorage', cashierTab);
    expect(readSessionIdentity()).toBe('cashier');
    vi.stubGlobal('sessionStorage', adminTab); writeSessionIdentity(null);
    vi.stubGlobal('sessionStorage', cashierTab);
    expect(readSessionIdentity()).toBe('cashier');
  });

  it('never adopts a remote shift just because the same cashier is signed in', async () => {
    await db.shifts.put({ ...shift('remote'), installationId: 'another-phone' });
    expect(await dbService.getCurrentShift('cashier')).toBeNull();
    await dbService.saveShift(shift('local'));
    expect((await dbService.getCurrentShift('cashier'))?.id).toBe('local');
    expect(await dbService.getCurrentShift()).toBeNull();
  });

  it('resumes legacy local shifts without adopting legacy cloud-only shifts', async () => {
    await db.shifts.put(shift('cloud-only'));
    expect(await dbService.getCurrentShift('cashier')).toBeNull();
    await db.outbox.add({ id: 'local-proof', tableName: 'shifts', action: 'INSERT', payload: shift('cloud-only'), status: 'synced', retryCount: 0, createdAt: new Date().toISOString() });
    expect((await dbService.getCurrentShift('cashier'))?.id).toBe('cloud-only');
  });

  it('rejects number collisions without changing the original record or queue', async () => {
    const original = ticket('same-id');
    await dbService.saveTicket(original);
    await dbService.saveTicket(original); // exact replay is harmless
    await expect(dbService.saveTicket({ ...original, amount: 999 })).rejects.toThrow('collision');
    expect((await db.tickets.get(original.id))?.amount).toBe(500);
    expect(await db.outbox.count()).toBe(1);
  });

  it('ignores a stale dirty snapshot even if the remote timestamp is newer', async () => {
    const original = ticket('unsent');
    await dbService.saveTicket(original);
    expect(await applyRemoteRow('tickets', { ...original, amount: 1, updatedAt: '2099-01-01T00:00:00Z' }, 'UPDATE', new Set())).toBe(false);
    await applyRemoteRows('tickets', [{ ...original, amount: 2, updatedAt: '2099-01-01T00:00:00Z' }]);
    expect((await db.tickets.get(original.id))?.amount).toBe(500);
  });

  it('a slow reload cannot erase a ticket committed while that read was in flight', async () => {
    let resolve!: (tickets: Ticket[]) => void;
    vi.spyOn(dbService, 'getRecentTickets').mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const loading = useTicketStore.getState().loadTickets('cashier');
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    const issued = await useTicketStore.getState().createAndPrintTicket(500, 'cashier');
    resolve([]); await loading;
    expect(useTicketStore.getState().tickets.map(row => row.id)).toContain(issued.ticket?.id);
    expect(await db.tickets.count()).toBe(1);
  });

  it('an older scoped read cannot replace a later account-wide manager read', async () => {
    let resolve!: (tickets: Ticket[]) => void;
    vi.spyOn(dbService, 'getRecentTickets').mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    vi.spyOn(dbService, 'getTicketsInPeriod').mockResolvedValueOnce([ticket('account')]);
    const older = useTicketStore.getState().loadTickets('cashier');
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    await useTicketStore.getState().loadTickets();
    resolve([]); await older;
    expect(useTicketStore.getState().scope).toBeUndefined();
    expect(useTicketStore.getState().tickets.map(row => row.id)).toEqual(['account']);
  });

  it('explicit shift links keep simultaneous shifts separate for the same cashier', () => {
    const a = shift('A'), b = shift('B');
    const tickets = [{ ...ticket('first'), shiftId: a.id }, { ...ticket('second'), shiftId: b.id }];
    expect(shiftTickets(tickets, a).map(row => row.id)).toEqual(['first']);
    expect(shiftTickets(tickets, b).map(row => row.id)).toEqual(['second']);
  });

  it('reads a bounded page and leaves a healthy 2,000-record queue untouched during revive', async () => {
    const now = new Date().toISOString();
    await db.outbox.bulkAdd(Array.from({ length: 2000 }, (_, i) => ({ id: String(i).padStart(6, '0'), tableName: 'tickets', action: 'INSERT' as const, payload: ticket('T' + i), status: 'pending' as const, retryCount: 0, createdAt: now })));
    expect(await dbService.getPendingOutbox(200)).toHaveLength(200);
    expect((await dbService.countUnsyncedOutbox(false)).total).toBe(2000);
    const writes = vi.spyOn(db.outbox, 'bulkPut');
    await dbService.revivePendingOutbox();
    expect(writes.mock.calls.every(([rows]) => rows.length === 0)).toBe(true);
    expect(await db.outbox.count()).toBe(2000);
  }, 30000);

  it('bulk pagination passes a backed-off prefix without skipping equal-timestamp records', async () => {
    const stamp = new Date().toISOString();
    await db.outbox.bulkAdd(Array.from({ length: 600 }, (_, i) => ({ id: String(i).padStart(6, '0'), tableName: 'tickets', action: 'INSERT' as const, payload: ticket('T' + i), createdAt: stamp, status: 'pending' as const, retryCount: i < 400 ? 1 : 0, nextAttemptAt: i < 400 ? '2099-01-01T00:00:00Z' : undefined })));
    const due = await dbService.getPendingOutbox(20);
    expect(due.map(row => row.id)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 400).padStart(6, '0')));
    expect(await dbService.getPendingOutbox()).toHaveLength(200);
  });
});
