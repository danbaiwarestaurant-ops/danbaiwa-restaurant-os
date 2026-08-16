import { Ticket } from '../../types/ticket';
import { Shift } from '../../types/shift';
import { Expense } from '../../types/expense';
import { OutboxItem } from '../../types/sync';
import { DeviceConfig } from '../../types/config';
import { UserAccount } from '../../types/user';

export interface IDbService {
  init(): Promise<void>;
  
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

  // Outbox Sync
  getPendingOutbox(): Promise<OutboxItem[]>;
  markOutboxSynced(id: string): Promise<void>;
  markOutboxAttemptFailed(id: string, retryCount: number): Promise<void>;
}
