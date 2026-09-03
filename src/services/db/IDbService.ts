import { Ticket, TicketTender } from '../../types/ticket';
import { Shift } from '../../types/shift';
import { Expense } from '../../types/expense';
import { OutboxItem } from '../../types/sync';
import { DeviceConfig } from '../../types/config';
import { UserAccount } from '../../types/user';
import { AuditLogRow } from './dexieSchema';

export interface IDbService {
  init(): Promise<void>;

  /** True when this device holds no operational records yet (fresh/wiped install). */
  isLocalDataEmpty(): Promise<boolean>;
  /** Pulls the newest cloud disaster-recovery backup down onto a fresh/wiped device. */
  restoreFromCloud(): Promise<{ restored: boolean; reason?: string; source?: string }>;

  // Config
  getDeviceConfig(): Promise<DeviceConfig | null>;
  saveDeviceConfig(config: DeviceConfig): Promise<void>;

  // Users & Auth
  getUsers(): Promise<UserAccount[]>;
  /**
   * A single account's user by email or staff ID.
   *
   * `accountId` breaks the tie when one browser profile holds more than one
   * business's data: emails are unique everywhere, but staff IDs are only unique
   * inside one restaurant, so "amina" can legitimately name two different people.
   */
  getUserByEmail(email: string, accountId?: string | null): Promise<UserAccount | null>;
  /** Every local user answering to that email or staff ID, across all accounts. */
  findUsersByLoginKey(email: string): Promise<UserAccount[]>;
  saveUser(user: UserAccount): Promise<void>;
  /**
   * Writes a user to this device and queues nothing for the cloud.
   *
   * For profiles this device reconstructed rather than authored — see
   * adoptAccountFromCloud. Uploading a reconstruction would overwrite the genuine row
   * it shares a primary key with, so it must never enter the outbox.
   */
  saveUserLocalOnly(user: UserAccount, rebuiltLocally?: boolean): Promise<void>;
  updateUser(user: UserAccount): Promise<void>;

  // User-Scoped Tickets
  getTickets(userId?: string): Promise<Ticket[]>;
  saveTicket(ticket: Ticket): Promise<void>;
  updateTicketStatus(ticketId: string, status: 'paid' | 'collected' | 'void', reason?: string, voidedBy?: string): Promise<void>;
  /**
   * Corrects how a ticket was paid.
   *
   * Mis-tags are inevitable — the alternative fix is voiding and reprinting a ticket the
   * customer is already holding, which costs paper and pollutes the void count with
   * clerical noise. Always audit-logged: this moves money between the drawer figure and
   * the transfer figure, so it must never be a silent edit.
   */
  updateTicketTender(ticketId: string, tender: TicketTender, actorId: string): Promise<void>;
  getNextSeq(locationId: string, deviceId: string): Promise<number>;

  // User-Scoped Shifts
  getCurrentShift(userId?: string): Promise<Shift | null>;
  getShifts(userId?: string): Promise<Shift[]>;
  saveShift(shift: Shift): Promise<void>;
  closeShift(shiftId: string, countedCash: number, expectedCash: number, variance: number, notes?: string): Promise<void>;

  // User-Scoped Expenses
  getExpenses(shiftId?: string, userId?: string): Promise<Expense[]>;
  saveExpense(expense: Expense): Promise<void>;
  updateExpenseStatus(expenseId: string, status: 'approved' | 'rejected', reviewer: string, reason?: string): Promise<void>;

  // Audit Logs (data-layer only — no UI reads this yet)
  getAuditLogs(entityId?: string, actorId?: string): Promise<AuditLogRow[]>;

  // Outbox Sync
  getPendingOutbox(): Promise<OutboxItem[]>;
  /**
   * Everything still owed to the cloud, including rows waiting out a retry backoff.
   * `topError` is the rejection reason the most queued rows share, so a queue that is
   * stalled for one systemic reason can say so instead of just counting.
   */
  countUnsyncedOutbox(): Promise<{
    total: number;
    stuck: number;
    topError?: { reason: string; count: number };
  }>;
  markOutboxSynced(id: string): Promise<void>;
  /**
   * Mark a whole batch synced in one transaction. The worker pushes rows to the cloud in
   * batches, so acknowledging them one-at-a-time would put the local write back on the
   * critical path it was just taken off.
   */
  markOutboxSyncedMany(ids: string[]): Promise<void>;
  markOutboxAttemptFailed(id: string, retryCount: number, lastError?: string): Promise<void>;
  /** Clears backoffs and resurrects rows parked as 'failed' by an older build. */
  revivePendingOutbox(): Promise<number>;
  /** Drops acknowledged outbox rows older than the window, so the table stays bounded. */
  pruneSyncedOutbox(olderThanMs?: number): Promise<number>;
  /** Queues rows the cloud is missing; skips ids already in flight. */
  enqueueBackfill(tableName: string, payloads: Record<string, any>[]): Promise<number>;
}
