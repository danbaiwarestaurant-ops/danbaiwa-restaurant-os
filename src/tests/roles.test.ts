/**
 * roles.test.ts
 *
 * Who may sign in, and whose tickets count as sales.
 *
 * Both questions used to be answered by comparing against the single role that existed,
 * which is how a kitchen hand ended up with a till login and a line in the sales figures.
 * They are now one module, and these pin the two answers that have consequences: a role
 * wrongly granted till access is a security hole, and a role wrongly counted as sales
 * puts people who never touch money into the revenue report.
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_ROLES,
  STAFF_ROLES,
  canSignIn,
  countedManually,
  isSalesRole,
  roleLabel,
  roleDescription,
  takesSales,
} from '../utils/roles';

describe('the roster', () => {
  it('offers every role except admin', () => {
    // An admin is created by signing up — it is the account's cloud identity, and one
    // minted from the staff form would have authority over the books with nothing
    // behind it.
    expect(STAFF_ROLES).not.toContain('admin');
    expect(ALL_ROLES).toContain('admin');
    expect(ALL_ROLES).toHaveLength(STAFF_ROLES.length + 1);
  });

  it('gives every role a label and a description', () => {
    for (const role of ALL_ROLES) {
      expect(roleLabel(role).length).toBeGreaterThan(0);
      expect(roleDescription(role).length).toBeGreaterThan(0);
      // The label is what the roster shows; the raw slug leaking through means a role
      // was added to the union without being described.
      expect(roleLabel(role)).not.toBe(role);
    }
  });
});

describe('till access', () => {
  it('lets the cashier and the owner in', () => {
    expect(canSignIn('admin')).toBe(true);
    expect(canSignIn('cashier')).toBe(true);
  });

  it('keeps everyone who does not handle money out', () => {
    // They still hold an account — it is what a staff meal is issued against — but a
    // login nobody uses is a PIN nobody protects, and the till is where the money is.
    // Servers are in this list: they take orders on the floor and the cashier handles
    // every naira, so a server has no reason to reach a till at all.
    expect(canSignIn('server')).toBe(false);
    expect(canSignIn('kitchen')).toBe(false);
    expect(canSignIn('storekeeper')).toBe(false);
    expect(canSignIn('other')).toBe(false);
  });

  it('never grants the till to a role it does not recognise', () => {
    // A till running an older build pulls down staff rows carrying roles it has never
    // heard of. Failing closed is the only safe direction.
    expect(canSignIn('regional-director')).toBe(false);
    expect(canSignIn(undefined)).toBe(false);
    expect(takesSales('regional-director')).toBe(false);
  });
});

describe('who counts as sales', () => {
  it('counts the cashier, who is the only one who rings anything up', () => {
    expect(takesSales('cashier')).toBe(true);
  });

  it('does not open a shift for a server', () => {
    // A server never touches the till, so there is no drawer to open and none to count.
    // Their selling is real, but it reaches the system through the manager's entry
    // screen, not through tickets — see countedManually.
    expect(takesSales('server')).toBe(false);
  });

  it('does not count the owner', () => {
    // An owner signing in to read the books should not accrue an empty shift they then
    // have to count a drawer to close.
    expect(takesSales('admin')).toBe(false);
  });

  it('does not count back-of-house', () => {
    expect(takesSales('kitchen')).toBe(false);
    expect(takesSales('storekeeper')).toBe(false);
    expect(takesSales('other')).toBe(false);
  });

  it('reports the whole sales floor, however it is counted', () => {
    // isSalesRole is the question the reports ask — "is this person worth a line in the
    // sales figures?" — and the answer is yes for both halves of the floor even though
    // only one of them produces tickets.
    expect(isSalesRole('cashier')).toBe(true);
    expect(isSalesRole('server')).toBe(true);
    expect(isSalesRole('kitchen')).toBe(false);
    expect(isSalesRole('admin')).toBe(false);
  });

  it('never counts someone who cannot even reach a till', () => {
    // Taking sales without being able to sign in is not a state that can exist. If one
    // is ever introduced, the roster would credit takings to somebody who was never there.
    for (const role of ALL_ROLES) {
      if (takesSales(role)) expect(canSignIn(role)).toBe(true);
    }
  });
});

describe('counts typed in by a manager', () => {
  it('is the server, and only the server', () => {
    expect(countedManually('server')).toBe(true);
    for (const role of ALL_ROLES) {
      if (role !== 'server') expect(countedManually(role)).toBe(false);
    }
  });

  it('never applies to somebody the till already counts', () => {
    // The two are alternatives, not shades of the same thing. A role that was both would
    // have its selling counted twice: once from its tickets and once from the entry form.
    for (const role of ALL_ROLES) {
      expect(takesSales(role) && countedManually(role)).toBe(false);
    }
  });

  it('does not grant a login', () => {
    // The whole reason this exists is that these people are not at a till.
    for (const role of ALL_ROLES) {
      if (countedManually(role)) expect(canSignIn(role)).toBe(false);
    }
  });

  it('fails closed on a role it does not recognise', () => {
    expect(countedManually('regional-director')).toBe(false);
    expect(countedManually(undefined)).toBe(false);
  });
});
