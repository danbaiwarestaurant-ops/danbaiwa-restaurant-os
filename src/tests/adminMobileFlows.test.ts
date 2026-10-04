import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';
import { dbService } from '../services/db/IndexedDbService';
import { useAuthStore } from '../store/useAuthStore';
import { generateSalt, hashSecretWithSalt, verifySecret } from '../services/auth/pinAuth';
import { UserAccount } from '../types/user';
import { calculateServerItemSales } from '../utils/serverPerformance';
import { validateInventoryUnits } from '../utils/inventory';
import { staffFoodCount } from '../utils/staffMeals';
import { businessDayKey } from '../utils/shiftDay';
import { Ticket } from '../types/ticket';

vi.mock('../services/supabase/supabaseClient', async importOriginal => ({ ...(await importOriginal<any>()), isSupabaseConfigured: false }));
const storage = new Map<string, string>();
async function person(id: string, role: UserAccount['role'], pin: string): Promise<UserAccount> {
  const pinSalt = generateSalt();
  return { id, name: id, username: id + '@example.com', email: id + '@example.com', role, status: 'active', createdAt: new Date().toISOString(), pinSalt, pinHash: await hashSecretWithSalt(pin, pinSalt) };
}
beforeEach(async () => {
  await Promise.all(TABLE_NAMES.map(name => (db as any)[name].clear()));
  storage.clear();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  useAuthStore.setState({ users: [], activeUser: null, isAuthenticated: false, hasAdminAuthority: false, failedAttempts: 0, lockoutUntil: null });
});
afterEach(() => vi.unstubAllGlobals());

describe('admin access and profile lifecycle', () => {
  it('starts a fresh failed-attempt window after a lockout expires', async () => {
    const admin = await person('owner', 'admin', '2468');
    useAuthStore.setState({ users: [admin], failedAttempts: 3, lockoutUntil: Date.now() - 1 });
    const result = await useAuthStore.getState().loginWithPin('0000');
    expect(result.ok).toBe(false);
    expect(useAuthStore.getState().failedAttempts).toBe(1);
    expect(useAuthStore.getState().lockoutUntil).toBeNull();
  });
  it('allows identity sign-in for duplicate PINs without locking out the owner', async () => {
    const admin = await person('owner', 'admin', '2468'); const cashier = await person('cashier', 'cashier', '2468');
    await dbService.saveUser(admin); await dbService.saveUser(cashier);
    useAuthStore.setState({ users: [admin, cashier] });
    for (let i = 0; i < 4; i++) expect((await useAuthStore.getState().loginWithPin('2468')).ok).toBe(false);
    expect(useAuthStore.getState().lockoutUntil).toBeNull();
    expect((await useAuthStore.getState().loginUser(admin.email!, '2468')).ok).toBe(true);
    expect(useAuthStore.getState().activeUser?.id).toBe(admin.id);
  });
  it('updates an owner from the cashier session, preserves that session, and verifies old/new credentials', async () => {
    const admin = await person('owner', 'admin', '1234'); const cashier = await person('cashier', 'cashier', '2468');
    await dbService.saveUser(admin); await dbService.saveUser(cashier);
    storage.set('ticket_pos_session_user_id', cashier.id);
    useAuthStore.setState({ users: [admin, cashier], activeUser: cashier, isAuthenticated: true, hasAdminAuthority: true });
    await useAuthStore.getState().updateAdminProfile(admin.id, 'Owner updated', admin.email!, '6789');
    expect(useAuthStore.getState().activeUser?.id).toBe(cashier.id);
    const saved = (await dbService.getUserByEmail(admin.email!))!;
    expect(saved.name).toBe('Owner updated');
    expect(await verifySecret('1234', saved.pinHash, saved.pinSalt)).toBe(false);
    expect(await verifySecret('6789', saved.pinHash, saved.pinSalt)).toBe(true);
    expect((await useAuthStore.getState().loginUser(admin.email!, '1234')).ok).toBe(false);
    expect((await useAuthStore.getState().loginUser(admin.email!, '6789')).ok).toBe(true);
    expect(useAuthStore.getState().activeUser?.id).toBe(admin.id);
  });
  it('refuses a new admin PIN that is already assigned to staff', async () => {
    const admin = await person('owner', 'admin', '1234'); const cashier = await person('cashier', 'cashier', '2468');
    useAuthStore.setState({ users: [admin, cashier], activeUser: admin });
    await expect(useAuthStore.getState().updateAdminProfile(admin.id, admin.name, admin.email!, '2468')).rejects.toThrow('already used');
  });
});

describe('kitchen unit costs', () => {
  const item = { id: 'rice', name: 'Rice', baseUnit: 'kg', purchaseUnit: 'bag', baseUnitsPerPurchaseUnit: 50, reorderLevel: 5, salesUnit: 'cooler', baseUnitsPerSalesUnit: 5, cookingUnit: 'pot', baseUnitsPerCookingUnit: 10, standardPurchaseCost: 50000, active: true, createdAt: '' };
  it('calculates kitchen cost from raw stock and snapshots cooking quantities', () => {
    const sale = calculateServerItemSales({ ...item, profitPerCookingUnit: 2000 }, 2);
    expect(sale.salesUnit).toBe('pot'); expect(sale.cost).toBe(20000); expect(sale.sales).toBe(24000);
  });
  it('scales legacy sales-unit preparation costs when cooking units are introduced', () => {
    const sale = calculateServerItemSales({ ...item, preparationCostPerSalesUnit: 6000, profitPerSalesUnit: 1000 }, 2);
    expect(sale.cost).toBe(24000); expect(sale.profit).toBe(4000);
  });
  it('rejects invalid conversions before any stock is saved', () => {
    expect(() => validateInventoryUnits({ ...item, baseUnitsPerCookingUnit: 0 })).toThrow('Cooking conversion');
    expect(() => validateInventoryUnits({ ...item, baseUnitsPerPurchaseUnit: NaN })).toThrow('Purchase conversion');
  });
});

describe('staff meal allowance transaction', () => {
  it('counts different cashiers, ignores voids, and charges concurrent extra food exactly once', async () => {
    const staff = { ...await person('staff', 'kitchen', '1234'), dailyFoodCountLimit: 1 };
    await dbService.saveUser(staff);
    const food = [{ id: 'food', name: 'Food', isFree: true, wageCharge: 500 }];
    const meal = (id: string, cashierId: string): Ticket => ({ id, locationId: 'LOC', deviceId: 'DEV', localSeq: 1, amount: 500, currency: 'N', tender: 'staff', status: 'paid', createdAt: new Date().toISOString(), cashierId, qrPayload: '', staffId: staff.id, mealOptions: food, staffMealWageDeduction: 0 });
    const one = meal('one', 'cashier-a'); const two = meal('two', 'cashier-b');
    await Promise.all([one, two].map(ticket => dbService.saveStaffMealTicket(ticket, { id: 'wage-' + ticket.id, staffId: staff.id, staffName: staff.name, businessDay: businessDayKey(ticket.createdAt), kind: 'manual_adjustment', amount: 0, note: 'meal', recordedBy: ticket.cashierId, recordedAt: ticket.createdAt })));
    const saved = await dbService.getTickets();
    expect(staffFoodCount(saved, staff.id, businessDayKey(one.createdAt))).toBe(2);
    expect(saved.reduce((sum, ticket) => sum + (ticket.staffMealWageDeduction || 0), 0)).toBe(500);
    expect((await db.wageLedger.toArray()).map(entry => entry.amount)).toEqual([-500]);
    expect(staffFoodCount(saved.map(t => ({ ...t, status: 'void' })), staff.id, businessDayKey(one.createdAt))).toBe(0);
  });
});
