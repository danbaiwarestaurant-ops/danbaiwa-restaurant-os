import { beforeEach, describe, expect, it } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';
import { IndexedDbService } from '../services/db/IndexedDbService';
import { applyRemoteRow, applyRemoteRows } from '../services/db/remoteMerge';
import { UserAccount } from '../types/user';
const svc = new IndexedDbService();
const user: UserAccount = { id: 'staff', name: 'Amina', username: 'amina', email: 'amina@example.test', pinHash: 'hash', pinSalt: 'salt', passwordHash: 'secret', passwordSalt: 'salt', role: 'cashier', status: 'active', accountId: 'account', createdAt: '2026-10-01T12:00:00.000Z' };
beforeEach(async () => { await Promise.all(TABLE_NAMES.map(name => db[name].clear())); });
describe('permanent staff removal keeps the books and cannot revive credentials', () => {
  it('deletes credentials with historical contributions and preserves attribution', async () => {
    await svc.saveUser(user);
    await db.tickets.put({ id: 'sale', cashierId: user.id, amount: 500 } as any);
    await db.shifts.put({ id: 'shift', cashierId: user.id } as any);
    await db.staffAssessments.put({ id: 'wage', staffId: user.id, netPay: 1000 } as any);
    await svc.deleteUser(user.id);
    expect(await db.users.get(user.id)).toBeUndefined();
    expect(await svc.findUsersByLoginKey('amina')).toEqual([]);
    expect(await svc.getUsers()).toContainEqual(expect.objectContaining({ id: user.id, name: user.name, deletedAt: expect.any(String), pinHash: '', pinSalt: '', email: '', username: '', status: 'deactivated' }));
    const archive = await db.auditLogs.where('entity').equals('staff_identity').first();
    expect(archive?.reason).not.toContain('secret');
    expect(archive?.reason).not.toContain('hash');
    const snapshots = (await db.outbox.toArray()).filter(row => row.tableName === 'users' && row.action !== 'DELETE');
    expect(snapshots.every(row => row.payload.pinHash === '' && row.payload.passwordHash === null && row.payload.status === 'deactivated')).toBe(true);
    expect(await db.tickets.get('sale')).toBeDefined();
    expect(await db.shifts.get('shift')).toBeDefined();
    expect(await db.staffAssessments.get('wage')).toBeDefined();
    await expect(svc.updateUser(user)).rejects.toThrow('permanently deleted');
    await expect(svc.saveUser(user)).rejects.toThrow('permanently deleted');
  });
  it('ignores stale remote profiles, propagates deletion to other devices and guards old backup logins', async () => {
    await svc.saveUser(user); await svc.deleteUser(user.id); await db.outbox.clear();
    const archive = (await db.auditLogs.toArray())[0];
    expect(await applyRemoteRow('users', { ...user, updatedAt: '2099-01-01T00:00:00Z' }, 'INSERT')).toBe(false);
    await applyRemoteRows('users', [{ ...user, updatedAt: '2099-01-01T00:00:00Z' }]);
    expect(await db.users.get(user.id)).toBeUndefined();
    await db.auditLogs.clear();
    await db.users.put({ ...user, loginKeys: ['amina'] });
    await applyRemoteRows('audit_logs', [archive]);
    expect(await db.users.get(user.id)).toBeUndefined();
    // A stale snapshot may still contain the old user row. Authentication refuses it.
    await db.users.put({ ...user, loginKeys: ['amina'] });
    expect(await svc.findUsersByLoginKey('amina')).toEqual([]);
  });
});
