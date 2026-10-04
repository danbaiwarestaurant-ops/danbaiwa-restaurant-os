import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { periodFor, periodContains, periodBuckets, shiftPeriod, withUnit } from '../utils/period';
import { businessDayKey, isStaleShift } from '../utils/shiftDay';
import { staffFoodCounts } from '../utils/staffMeals';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';
import { dbService } from '../services/db/IndexedDbService';
import { useDeviceStore } from '../store/useDeviceStore';
import { useConsolePeriodStore } from '../store/useConsolePeriodStore';
import { useInventoryStore } from '../store/useInventoryStore';
import { useAuthStore } from '../store/useAuthStore';
import { Ticket } from '../types/ticket';
import { UserAccount } from '../types/user';

vi.mock('../services/supabase/supabaseClient', async importOriginal => ({ ...(await importOriginal<any>()), isSupabaseConfigured: false }));
const defaults = useDeviceStore.getState().config;
beforeEach(async () => {
  await Promise.all(TABLE_NAMES.map(name => (db as any)[name].clear()));
  useDeviceStore.setState({ config: { ...defaults }, isLoaded: true });
  useConsolePeriodStore.setState({ period: periodFor('day'), weekStartsOn: 1, businessDayStartHour: 0 });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); useDeviceStore.setState({ config: defaults }); });

describe('configured trading calendar', () => {
  it('uses the same exact boundary for meals, reports and stale shifts', () => {
    const before = new Date(2026, 9, 5, 7, 59, 59);
    const boundary = new Date(2026, 9, 5, 8);
    const period = periodFor('day', before, 1, 8);
    expect(businessDayKey(before, 8)).toBe('2026-10-04');
    expect(businessDayKey(boundary, 8)).toBe('2026-10-05');
    expect(period.start).toEqual(new Date(2026, 9, 4, 8));
    expect(periodContains(period, before)).toBe(true);
    expect(periodContains(period, boundary)).toBe(false);
    const shift = { status: 'open' as const, openedAt: new Date(2026, 9, 4, 18).toISOString() };
    expect(isStaleShift(shift, before, 8)).toBe(false);
    expect(isStaleShift(shift, boundary, 8)).toBe(true);
  });

  it('keeps early January service in the preceding month, year and week', () => {
    const early = new Date(2027, 0, 1, 7);
    expect(periodFor('month', early, 1, 8).label).toBe('December 2026');
    expect(periodFor('year', early, 1, 8).label).toBe('2026');
    const week = periodFor('week', new Date(2026, 9, 4, 7), 0, 8);
    expect(week.start).toEqual(new Date(2026, 8, 27, 8));
    expect(week.end).toEqual(new Date(2026, 9, 4, 8));
  });

  it('includes business-day labels correctly even when the boundary is after noon', () => {
    const period = periodFor('month', new Date(2026, 9, 15, 23), 1, 23);
    expect(periodContains(period, '2026-10-01')).toBe(true);
    expect(periodContains(period, '2026-10-31')).toBe(true);
    expect(periodContains(period, '2026-11-01')).toBe(false);
    expect(periodContains(period, new Date(2026, 10, 1, 22, 59))).toBe(true);
    expect(periodContains(period, new Date(2026, 10, 1, 23))).toBe(false);
  });

  it('charts every hour from the boundary through the next morning without gaps', () => {
    const period = periodFor('day', new Date(2026, 9, 5, 12), 1, 8);
    const buckets = periodBuckets(period);
    expect(buckets).toHaveLength(24);
    expect(buckets[0].label).toBe('08');
    expect(buckets[16].key).toBe('2026-10-06T00');
    expect(buckets[23].label).toBe('07');
    expect(buckets[0].start).toEqual(period.start);
    expect(buckets[23].end).toEqual(period.end);
    for (let i = 1; i < buckets.length; i++) expect(buckets[i].start).toEqual(buckets[i - 1].end);
    const year = periodBuckets(periodFor('year', new Date(2026, 9, 5, 12), 1, 8));
    expect(year.every(bucket => bucket.start.getHours() === 8 && bucket.end.getHours() === 8)).toBe(true);
  });

  it('preserves the boundary through date navigation and historical setting changes', () => {
    const period = periodFor('day', new Date(2026, 9, 5, 12), 0, 8);
    expect(shiftPeriod(period, -1).start).toEqual(new Date(2026, 9, 4, 8));
    expect(withUnit(period, 'month', new Date(2026, 9, 5, 12)).start).toEqual(new Date(2026, 9, 1, 8));
    useConsolePeriodStore.setState({ period: periodFor('day', new Date(2025, 9, 5, 10)), weekStartsOn: 1, businessDayStartHour: 0 });
    useConsolePeriodStore.getState().setCalendar(0, 18);
    expect(useConsolePeriodStore.getState().period.start).toEqual(new Date(2025, 9, 5, 18));
  });

  it('persists the shared setting and queues it for other devices', async () => {
    await useDeviceStore.getState().updateConfig({ businessDayStartHour: 8, weekStartsOn: 0 });
    useDeviceStore.setState({ config: defaults });
    await useDeviceStore.getState().loadConfig();
    expect(useDeviceStore.getState().config.businessDayStartHour).toBe(8);
    const queued = (await db.outbox.toArray()).find(row => row.tableName === 'account_settings');
    expect(queued?.payload.settings.businessDayStartHour).toBe(8);
    expect(queued?.payload.settings.weekStartsOn).toBe(0);
  });

  it('retains 06:00 for old settings and rejects invalid hours before writing', async () => {
    await db.config.put({ key: 'device_config', value: { ...defaults, businessDayStartHour: undefined } });
    await useDeviceStore.getState().loadConfig();
    expect(useDeviceStore.getState().config.businessDayStartHour).toBe(6);
    for (const hour of [-1, 24, 8.5, NaN]) await expect(useDeviceStore.getState().updateConfig({ businessDayStartHour: hour })).rejects.toThrow('Starting hour');
    expect(await db.outbox.count()).toBe(0);
  });

  it('restores the previous local calendar when saving fails', async () => {
    vi.spyOn(dbService, 'saveDeviceConfig').mockRejectedValueOnce(new Error('storage failure'));
    await expect(useDeviceStore.getState().updateConfig({ businessDayStartHour: 8 })).rejects.toThrow('storage failure');
    expect(useDeviceStore.getState().config.businessDayStartHour).toBe(6);
  });

  it('counts every employee across cashiers and resets at the configured hour', () => {
    const meal = (id: string, staffId: string, hour: number, status = 'paid') => ({ id, staffId, tender: 'staff', status, createdAt: new Date(2026, 9, 5, hour).toISOString() } as Ticket);
    const tickets = [meal('1', 'a', 7), meal('2', 'a', 8), meal('3', 'b', 9), meal('4', 'b', 10, 'void')];
    expect(staffFoodCounts(tickets, '2026-10-04', 8)).toEqual({ a: 1 });
    expect(staffFoodCounts(tickets, '2026-10-05', 8)).toEqual({ a: 1, b: 1 });
  });

  it('uses the persisted boundary for atomic meal charges and their wage-ledger day', async () => {
    await useDeviceStore.getState().updateConfig({ businessDayStartHour: 8 });
    const staff = { id: 'employee', name: 'Employee', username: 'employee', role: 'kitchen', status: 'active', createdAt: '', pinHash: 'fixture', pinSalt: 'fixture', dailyFoodCountLimit: 1 } as UserAccount;
    await dbService.saveUser(staff);
    const meal = (id: string, at: Date): Ticket => ({ id, staffId: staff.id, cashierId: 'cashier', locationId: 'LOC', deviceId: 'DEV', localSeq: 1, amount: 500, currency: 'N', tender: 'staff', status: 'paid', createdAt: at.toISOString(), qrPayload: '', mealOptions: [{ id: 'food', name: 'Food', isFree: true, wageCharge: 500 }] });
    await dbService.saveStaffMealTicket(meal('earlier', new Date(2026, 9, 4, 18)));
    const ticket = meal('charged', new Date(2026, 9, 5, 7));
    await dbService.saveStaffMealTicket(ticket, { id: 'deduction', staffId: staff.id, staffName: staff.name, businessDay: '2026-10-05', kind: 'manual_adjustment', amount: -500, note: 'meal', recordedBy: 'cashier', recordedAt: ticket.createdAt });
    expect((await db.tickets.get(ticket.id))?.staffMealWageDeduction).toBe(500);
    expect((await db.wageLedger.get('deduction'))?.businessDay).toBe('2026-10-04');
    const fresh = meal('new-day', new Date(2026, 9, 5, 8));
    await dbService.saveStaffMealTicket(fresh);
    expect((await db.tickets.get(fresh.id))?.staffMealWageDeduction).toBe(0);
  });

  it('stamps inventory before the boundary onto the preceding trading day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 5, 7));
    useDeviceStore.setState({ config: { ...defaults, businessDayStartHour: 8 } });
    useAuthStore.setState({ hasAdminAuthority: true });
    useInventoryStore.setState({ items: [], batches: [], movements: [] });
    const item = { id: 'rice', name: 'Rice', baseUnit: 'kg', purchaseUnit: 'bag', baseUnitsPerPurchaseUnit: 10, reorderLevel: 0, active: true, createdAt: '' };
    await useInventoryStore.getState().receive(item, 1, 1000);
    expect((await db.inventoryMovements.toArray())[0].businessDay).toBe('2026-10-04');
    useAuthStore.setState({ hasAdminAuthority: false });
  });
});
