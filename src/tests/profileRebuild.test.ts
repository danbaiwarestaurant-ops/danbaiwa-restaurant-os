/**
 * profileRebuild.test.ts
 *
 * An account lives in two places: a Supabase Auth user (email + password, created the
 * instant you register) and a POS profile row (name, role, PIN hash) that starts life
 * only on the till that registered it and is uploaded later, through a cloud session.
 *
 * When the project requires email confirmation, that session never arrives — so the
 * profile is never uploaded, and the owner can sign in on exactly one machine for ever.
 * A verified cloud sign-in is the same proof registration itself stood on, so the profile
 * is now rebuilt from it rather than refused.
 *
 * The rebuild is only safe while it stays on the device. It shares a primary key with the
 * genuine profile the original till still owes the cloud, and it knows none of what makes
 * that profile whole — the real name, the password hash, the recovery key. Upload it and
 * the cloud's `id` is taken: the original till's backfill sees the id present, skips it,
 * and every device ends up with the thin copy. That containment is what these tests pin.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db, computeLoginKeys } from '../services/db/dexieSchema';
import { dbService } from '../services/db/IndexedDbService';
import { applyRemoteRow } from '../services/db/remoteMerge';
import { UserAccount } from '../types/user';

const ACCOUNT = 'owner-auth-uuid';

/** What adoptAccountFromCloud can reconstruct: id, email, and the PIN just typed. */
const rebuilt: UserAccount = {
  id: ACCOUNT,
  name: 'owner',
  email: 'owner@shop.com',
  username: 'owner@shop.com',
  pinHash: 'hash-of-typed-pin',
  pinSalt: 'salt',
  role: 'admin',
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'active',
  accountId: ACCOUNT,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('a profile rebuilt from a verified cloud sign-in', () => {
  beforeEach(async () => {
    await db.users.clear();
    await db.outbox.clear();
  });

  it('signs the owner in on a machine that was never given the profile', async () => {
    await dbService.saveUserLocalOnly(rebuilt, true);

    const found = await dbService.getUserByEmail('owner@shop.com', ACCOUNT);
    expect(found?.id).toBe(ACCOUNT);
    expect(found?.role).toBe('admin');
  });

  it('queues nothing for the cloud — saveUser would, this must not', async () => {
    await dbService.saveUserLocalOnly(rebuilt, true);
    expect(await db.outbox.count()).toBe(0);

    // Contrast: an authored write is meant to travel.
    await dbService.saveUser({ ...rebuilt, id: 'someone-else' });
    expect(await db.outbox.count()).toBe(1);
  });

  it('is skipped by the backfill sweep, which would otherwise claim the cloud row', async () => {
    await dbService.saveUserLocalOnly(rebuilt, true);
    const row = await db.users.get(ACCOUNT);
    expect(row?.rebuiltLocally).toBe(true);
  });

  it('carries no trace of the flag into anything cloud-facing', async () => {
    await dbService.saveUserLocalOnly(rebuilt, true);
    const users = await dbService.getUsers();
    expect(users[0]).not.toHaveProperty('rebuiltLocally');
    expect(users[0]).not.toHaveProperty('loginKeys');
  });

  it('gives way to the genuine profile the moment it arrives from the original till', async () => {
    await dbService.saveUserLocalOnly(rebuilt, true);

    // The real row: everything the reconstruction could not know, and — because it is
    // dated by Postgres at push time — newer than the reconstruction's backdated stamp.
    const applied = await applyRemoteRow(
      'users',
      {
        id: ACCOUNT,
        name: 'Adebayo Okonkwo',
        email: 'owner@shop.com',
        username: 'owner@shop.com',
        passwordHash: 'real-password-hash',
        passwordSalt: 'real-password-salt',
        pinHash: 'real-pin-hash',
        pinSalt: 'real-pin-salt',
        recoveryKeyHash: 'real-recovery-hash',
        recoveryKeySalt: 'real-recovery-salt',
        role: 'admin',
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'active',
        accountId: ACCOUNT,
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
      'UPDATE'
    );

    expect(applied).toBe(true);
    const merged = await db.users.get(ACCOUNT);
    expect(merged?.name).toBe('Adebayo Okonkwo');
    expect(merged?.recoveryKeyHash).toBe('real-recovery-hash');
    // The reconstruction is gone, flag and all — this row is now the authoritative one.
    expect(merged?.rebuiltLocally).toBeUndefined();
  });
});
