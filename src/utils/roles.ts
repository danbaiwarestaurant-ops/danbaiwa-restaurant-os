/**
 * roles.ts
 *
 * What each kind of staff member is, and what the till lets them do.
 *
 * The system used to know two roles — admin and cashier — and every person added to the
 * roster became a cashier. A restaurant is not staffed that way: servers take orders,
 * the kitchen cooks, a storekeeper holds the stock, and only the cashier ever stands at
 * a till. Calling all of them cashiers made the roster unreadable, put people who never
 * touch money into the sales figures, and gave a login to staff who have no use for one.
 *
 * Three separate questions come out of that, and they do not collapse into one another:
 * who may sign in, whose sales the till records by itself, and whose selling has to be
 * typed in because it happens away from the till. A server answers no, no and yes.
 *
 * Capabilities live here as named questions rather than as `role === 'cashier'` scattered
 * through the app. That is what makes a new role a one-line change here instead of a hunt
 * through every component — and it is why the questions are phrased by what someone does
 * ("does this person work a till?") rather than by who they are.
 *
 * A note on the stored data: tickets and shifts carry a `cashierId`, and that column name
 * is not going to change — it is a Postgres column, a Dexie index and a sync payload key
 * on every record ever written. Read it as "the staff member who issued this", which is
 * what it has always meant. The UI says so; the schema keeps its history.
 */

import { UserRole } from '../types/user';

/** Every role, in the order they are offered when adding someone. */
export const STAFF_ROLES: UserRole[] = ['cashier', 'server', 'kitchen', 'storekeeper', 'other'];

/** Every role including the account owner's, which is never assignable from the roster. */
export const ALL_ROLES: UserRole[] = ['admin', ...STAFF_ROLES];

interface RoleSpec {
  label: string;
  /** One line, shown beside the role when choosing it. */
  description: string;
  /**
   * Can sign in at the till.
   *
   * Kitchen and store staff deliberately cannot. They still hold an account — it is what
   * a staff meal is issued against, and what a future rota or stock record hangs off —
   * but a login nobody uses is a PIN nobody protects, and the till is where the money is.
   */
  signsIn: boolean;
  /**
   * Rings up sales at the till, so a shift opens for them when they sign in and their
   * tickets are counted as their own takings.
   *
   * Only the cashier. Servers take orders on the floor and never touch the till — the
   * cashier handles all money — so a server has no shift, no drawer and no tickets of
   * their own in this system. Their selling is recorded a different way; see
   * `countedManually`. An admin is not counted either: an owner signing in to read the
   * books should not accrue a shift they then have to count a drawer to close.
   */
  takesSales: boolean;
  /**
   * Sells, but not through the till — so the count is typed in by a manager rather than
   * accumulated from tickets.
   *
   * This is the server. They are measured on how many tickets they turned over, and that
   * number exists only on paper until someone enters it, which is why it is a separate
   * question from `takesSales` rather than a shade of it. The two are mutually exclusive
   * by construction: a role whose sales the till already records has nothing to type in.
   */
  countedManually: boolean;
}

const SPEC: Record<UserRole, RoleSpec> = {
  admin: {
    label: 'Admin / Owner',
    description: 'Full access to the books, staff and settings.',
    signsIn: true,
    takesSales: false,
    countedManually: false,
  },
  cashier: {
    label: 'Cashier',
    description: 'Works the till, takes payment, counts the drawer at close-out.',
    signsIn: true,
    takesSales: true,
    countedManually: false,
  },
  server: {
    label: 'Server / Waiter',
    description: 'Takes orders on the floor. Does not use the till — their ticket count is entered by a manager.',
    signsIn: false,
    takesSales: false,
    countedManually: true,
  },
  kitchen: {
    label: 'Kitchen Staff',
    description: 'Cooks and prepares orders. No till access.',
    signsIn: false,
    takesSales: false,
    countedManually: false,
  },
  storekeeper: {
    label: 'Storekeeper',
    description: 'Holds and issues stock. No till access.',
    signsIn: false,
    takesSales: false,
    countedManually: false,
  },
  other: {
    label: 'Other Staff',
    description: 'Anyone else on the payroll — cleaners, security, drivers.',
    signsIn: false,
    takesSales: false,
    countedManually: false,
  },
};

/**
 * The spec for a role, falling back to 'other' for anything unrecognised.
 *
 * The fallback is not defensive padding: a till running an older build than the one that
 * added a role will pull down staff rows carrying it, and the right answer there is to
 * show the person on the roster with no till access — never to crash the roster, and
 * never to silently grant them the till.
 */
function specFor(role: UserRole | string | undefined): RoleSpec {
  return SPEC[role as UserRole] ?? SPEC.other;
}

/** Human label for a role, e.g. 'Server / Waiter'. */
export function roleLabel(role: UserRole | string | undefined): string {
  return specFor(role).label;
}

/** One line explaining what the role is for, shown when choosing it. */
export function roleDescription(role: UserRole | string | undefined): string {
  return specFor(role).description;
}

/** Whether this role can sign in at the till at all. */
export function canSignIn(role: UserRole | string | undefined): boolean {
  return specFor(role).signsIn;
}

/**
 * Whether signing in opens a shift for this person, and whether their tickets count as
 * their own sales. The one question the till asks about a role, in both places it matters.
 */
export function takesSales(role: UserRole | string | undefined): boolean {
  return specFor(role).takesSales;
}

/**
 * Whether this person's selling is counted by a manager typing it in, because they sell
 * without ever touching a till. The servers, and only the servers.
 */
export function countedManually(role: UserRole | string | undefined): boolean {
  return specFor(role).countedManually;
}

/**
 * Roles whose selling is worth reporting per person, however it gets counted — the whole
 * sales floor, tills and tables alike.
 */
export function isSalesRole(role: UserRole | string | undefined): boolean {
  const spec = specFor(role);
  return spec.takesSales || spec.countedManually;
}
