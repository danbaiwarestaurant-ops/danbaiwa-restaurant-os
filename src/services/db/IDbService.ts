import { Ticket } from '../../types/ticket';
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
  getUserByEmail(email: string): Promise<UserAccount | null>;
  saveUser(user: UserAccount): Promise<void>;
  updateUser(user: UserAccount): Promise<void>;

  // User-Scoped Tickets
  getTickets(userId?: string): Promise<Ticket[]>;
  saveTicket(ticket: Ticket): Promise<void>;
  updateTicketStatus(ticketId: string, status: 'paid' | 'collected' | 'void', reason?: string, voidedBy?: string): Promise<void>;
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
  /** Everything still owed to the cloud, including rows waiting out a retry backoff. */
  countUnsyncedOutbox(): Promise<{ total: number; stuck: number }>;
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
  /** Queues rows the cloud is missing; skips ids already in flight. */
  enqueueBackfill(tableName: string, payloads: Record<string, any>[]): Promise<number>;
}
