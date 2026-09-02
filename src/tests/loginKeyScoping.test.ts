/**
 * loginKeyScoping.test.ts
 *
 * Staff IDs are only unique inside one restaurant — an admin types "amina" into their
 * own roster and nothing anywhere checks it against another business, nor should it.
 * But a browser profile can end up holding two businesses' rosters (a repurposed till, a
 * back-office machine two owners used), and the lookup behind every sign-in was
 * `where('loginKeys').equals(id).first()`: whichever row Dexie happened to return.
 *
 * That is one shop's cashier being handed a session on another shop's takings, decided
 * by insertion order. These tests pin the tie-break, and pin that a tie which cannot be
 * broken is refused rather than guessed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../services/db/dexieSchema';
import { computeLoginKeys } from '../services/db/dexieSchema';
import { dbService } from '../services/db/IndexedDbService';
import { UserAccount } from '../types/user';

const SHOP_A = 'account-a-uuid';
const SHOP_B = 'account-b-uuid';

function cashier(id: string, name: string, accountId?: string): UserAccount {
  return {
    id,
    name,
    email: 'amina',
    username: 'amina',
    pinHash: `hash-${id}`,
    pinSalt: `salt-${id}`,
    role: 'cashier',
    createdAt: new Date().toISOString(),
    status: 'active',
    accountId,
  } as UserAccount;
}

async function seed(...users: UserAccount[]) {
  for (const u of users) {
    await db.users.add({ ...u, loginKeys: computeLoginKeys(u) } as any);
  }
}

describe('login key lookup across accounts in one browser profile', () => {
  beforeEach(async () => {
    await db.users.clear();
  });

  it('returns the only match when the staff ID is unique here', async () => {
    await seed(cashier('a1', 'Amina from Shop A', SHOP_A));

    const found = await dbService.getUserByEmail('amina', SHOP_A);
    expect(found?.id).toBe('a1');
  });

  it('picks the cashier belonging to the account this till is working for', async () => {
    // Shop B's row is inserted FIRST, so an order-dependent lookup returns the wrong one.
    await seed(cashier('b1', 'Amina from Shop B', SHOP_B), cashier('a1', 'Amina from Shop A', SHOP_A));

    expect((await dbService.getUserByEmail('amina', SHOP_A))?.id).toBe('a1');
    expect((await dbService.getUserByEmail('amina', SHOP_B))?.id).toBe('b1');
  });

  it('refuses to guess when no account settles it', async () => {
    await seed(cashier('a1', 'Amina from Shop A', SHOP_A), cashier('b1', 'Amina from Shop B', SHOP_B));

    // No session, so no account to scope by. Handing over either row would be handing a
    // cashier somebody else's till.
    expect(await dbService.getUserByEmail('amina', null)).toBeNull();
    // A third account signing in here matches neither, and must not inherit one.
    expect(await dbService.getUserByEmail('amina', 'account-c-uuid')).toBeNull();
  });

  it('still finds a row that predates account stamping', async () => {
    // Legacy rows belong to whoever is on this device — that is the whole premise of the
    // backfill sweep — so they stay reachable when the scoped row does not exist.
    await seed(cashier('legacy', 'Amina, unstamped'), cashier('b1', 'Amina from Shop B', SHOP_B));

    expect((await dbService.getUserByEmail('amina', SHOP_A))?.id).toBe('legacy');
  });

  it('reports every match, so a caller can tell an ambiguity from a miss', async () => {
    await seed(cashier('a1', 'Amina from Shop A', SHOP_A), cashier('b1', 'Amina from Shop B', SHOP_B));

    expect((await dbService.findUsersByLoginKey('amina')).map((u) => u.id).sort()).toEqual(['a1', 'b1']);
    expect(await dbService.findUsersByLoginKey('nobody')).toEqual([]);
  });
});
