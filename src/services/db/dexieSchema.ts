/**
 * dexieSchema.ts
 *
 * IndexedDB schema (via Dexie) — the single source of truth for local storage shape.
 * Mirrors the table set that used to live in SqliteDbService's SCHEMA_SQL, minus the
 * WAL/snapshot durability layer that only existed to protect an in-memory SQLite
 * database: IndexedDB writes are already durable once a `rw` transaction resolves.
 */

import Dexie, { Table } from 'dexie';
import { UserAccount } from '../../types/user';
import { Ticket } from '../../types/ticket';
import { Shift } from '../../types/shift';
import { Expense } from '../../types/expense';
import { OutboxItem } from '../../types/sync';

/** Storage-only row shape: UserAccount plus a derived, indexable lookup array that
 *  powers getUserByEmail's case-insensitive match across both the email and
 *  username columns (Dexie has no case-insensitive/OR-column index otherwise). */
export interface UserRow extends UserAccount {
  loginKeys: string[];
}

export interface SequenceRow {
  key: string;
  nextVal: number;
}

export interface ConfigRow {
  key: string;
  value: any;
}

export interface AuditLogRow {
  id: string;
  entity: string;
  entityId: string;
  action: string;
  actorId: string;
  reason: string;
  timestamp: string;
  /** Not set by the local writer — filled in at outbox-push time (see useSyncStore.ts),
   *  same reason `UserAccount` has no locationId field of its own. */
  locationId?: string;
  updatedAt?: string;
}

export class TicketPosDB extends Dexie {
  config!: Table<ConfigRow, string>;
  users!: Table<UserRow, string>;
  tickets!: Table<Ticket, string>;
  sequences!: Table<SequenceRow, string>;
  shifts!: Table<Shift, string>;
  expenses!: Table<Expense, string>;
  outbox!: Table<OutboxItem, string>;
  auditLogs!: Table<AuditLogRow, string>;

  constructor() {
    super('ticket_pos_dexie_v1');
    this.version(1).stores({
      config: 'key',
      users: 'id, createdAt, status, *loginKeys',
      tickets: 'id, cashierId, createdAt, status',
      sequences: 'key',
      shifts: 'id, cashierId, status, openedAt',
      expenses: 'id, shiftId, cashierId, loggedAt, [shiftId+cashierId]',
      outbox: 'id, status, createdAt',
      auditLogs: 'id, entity, entityId, actorId, timestamp',
    });
  }
}

/** Every table name, used by cloudBackup.ts to export/restore the whole database
 *  without repeating this list in two places. */
export const TABLE_NAMES = [
  'config',
  'users',
  'tickets',
  'sequences',
  'shifts',
  'expenses',
  'outbox',
  'auditLogs',
] as const;

export type TableName = (typeof TABLE_NAMES)[number];

export const db = new TicketPosDB();

/** Derives the case-insensitive lookup keys stored on every user row. */
export function computeLoginKeys(user: { email?: string; username?: string }): string[] {
  const keys = [user.email, user.username]
    .filter((v): v is string => Boolean(v && v.trim()))
    .map((v) => v.trim().toLowerCase());
  return Array.from(new Set(keys));
}

export function stripUserRow(row: UserRow): UserAccount {
  const { loginKeys, ...user } = row;
  return user;
}
