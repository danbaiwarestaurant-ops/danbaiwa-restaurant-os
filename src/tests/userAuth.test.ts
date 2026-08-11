import { describe, it, expect } from 'vitest';
import { generateSalt, hashSecretWithSalt, verifySecret } from '../services/auth/pinAuth';
import { LocalStorageDbService } from '../services/db/LocalStorageDbService';
import { useAuthStore } from '../store/useAuthStore';
import { Ticket } from '../types/ticket';
import { UserAccount } from '../types/user';

describe('Enterprise Authentication & User Data Isolation', () => {
  it('should generate unique 16-byte cryptographically random hex salts', () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();

    expect(salt1).toBeDefined();
    expect(salt2).toBeDefined();
    expect(salt1.length).toBe(32);
    expect(salt2.length).toBe(32);
    expect(salt1).not.toBe(salt2);
  });

  it('should verify correct password or PIN against stored hash and salt', async () => {
    const secret = 'SecurePass123';
    const salt = generateSalt();
    const hash = await hashSecretWithSalt(secret, salt);

    const isValid = await verifySecret(secret, hash, salt);
    expect(isValid).toBe(true);
  });

  it('should fail verification for incorrect password or PIN', async () => {
    const correctSecret = 'SecurePass123';
    const wrongSecret = 'WrongPassword';
    const salt = generateSalt();
    const hash = await hashSecretWithSalt(correctSecret, salt);

    const isValid = await verifySecret(wrongSecret, hash, salt);
    expect(isValid).toBe(false);
  });

  it('should execute complete end-to-end password and PIN reset lifecycle', async () => {
    const db = new LocalStorageDbService();
    await db.init();

    const email = 'owner_test_reset@danbaiwa.com';
    const oldPassword = 'OldPassword123!';
    const oldPin = '1111';

    const newPassword = 'NewPassword456!';
    const newPin = '9999';

    // 1. Create original user record
    const pSalt = generateSalt();
    const pHash = await hashSecretWithSalt(oldPassword, pSalt);
    const pinSalt = generateSalt();
    const pinHash = await hashSecretWithSalt(oldPin, pinSalt);

    const originalUser: UserAccount = {
      id: 'user_reset_test_id',
      name: 'Owner Reset Test',
      email,
      username: email,
      passwordHash: pHash,
      passwordSalt: pSalt,
      pinHash,
      pinSalt,
      role: 'admin',
      createdAt: new Date().toISOString(),
      status: 'active',
    };

    await db.saveUser(originalUser);

    // Verify initial login with old password & PIN succeeds
    const initialFetched = await db.getUserByEmail(email);
    expect(initialFetched).not.toBeNull();
    const oldPassValid = await verifySecret(oldPassword, initialFetched!.passwordHash!, initialFetched!.passwordSalt!);
    expect(oldPassValid).toBe(true);

    // 2. Perform End-to-End Password & PIN Reset
    const newPSalt = generateSalt();
    const newPHash = await hashSecretWithSalt(newPassword, newPSalt);
    const newPinSalt = generateSalt();
    const newPinHash = await hashSecretWithSalt(newPin, newPinSalt);

    const updatedUser: UserAccount = {
      ...initialFetched!,
      passwordHash: newPHash,
      passwordSalt: newPSalt,
      pinHash: newPinHash,
      pinSalt: newPinSalt,
    };

    await db.updateUser(updatedUser);

    // 3. Verify Old Password & PIN are REJECTED
    const resetFetched = await db.getUserByEmail(email);
    const oldPassReCheck = await verifySecret(oldPassword, resetFetched!.passwordHash!, resetFetched!.passwordSalt!);
    const oldPinReCheck = await verifySecret(oldPin, resetFetched!.pinHash!, resetFetched!.pinSalt!);
    expect(oldPassReCheck).toBe(false);
    expect(oldPinReCheck).toBe(false);

    // 4. Verify NEW Password & PIN are ACCEPTED
    const newPassCheck = await verifySecret(newPassword, resetFetched!.passwordHash!, resetFetched!.passwordSalt!);
    const newPinCheck = await verifySecret(newPin, resetFetched!.pinHash!, resetFetched!.pinSalt!);
    expect(newPassCheck).toBe(true);
    expect(newPinCheck).toBe(true);
  });

  it('should strictly isolate data per user account (Multi-Tenant Data Isolation)', async () => {
    const db = new LocalStorageDbService();
    await db.init();

    const userATicket: Ticket = {
      id: 'LOC01-DEV01-000001',
      locationId: 'LOC01',
      deviceId: 'DEV01',
      localSeq: 1,
      amount: 500,
      currency: '₦',
      status: 'paid',
      cashierId: 'user_a_id',
      createdAt: new Date().toISOString(),
      qrPayload: 'test-qr-payload-a',
    };

    const userBTicket: Ticket = {
      id: 'LOC01-DEV01-000002',
      locationId: 'LOC01',
      deviceId: 'DEV01',
      localSeq: 2,
      amount: 1000,
      currency: '₦',
      status: 'paid',
      cashierId: 'user_b_id',
      createdAt: new Date().toISOString(),
      qrPayload: 'test-qr-payload-b',
    };

    await db.saveTicket(userATicket);
    await db.saveTicket(userBTicket);

    const userATickets = await db.getTickets('user_a_id');
    const userBTickets = await db.getTickets('user_b_id');

    // Verify User A sees ONLY User A's ticket
    expect(userATickets.some(t => t.id === 'LOC01-DEV01-000001')).toBe(true);
    expect(userATickets.some(t => t.id === 'LOC01-DEV01-000002')).toBe(false);

    // Verify User B sees ONLY User B's ticket
    expect(userBTickets.some(t => t.id === 'LOC01-DEV01-000002')).toBe(true);
    expect(userBTickets.some(t => t.id === 'LOC01-DEV01-000001')).toBe(false);
  });
});
