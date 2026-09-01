import { IDbService } from './IDbService';
import { Ticket } from '../../types/ticket';
import { Shift } from '../../types/shift';
import { Expense } from '../../types/expense';
import { OutboxItem } from '../../types/sync';
import { DeviceConfig } from '../../types/config';
import { UserAccount } from '../../types/user';

const STORAGE_KEYS = {
  CONFIG: 'ticket_pos_device_config',
  USERS: 'ticket_pos_users',
  TICKETS: 'ticket_pos_tickets',
  SHIFTS: 'ticket_pos_shifts',
  EXPENSES: 'ticket_pos_expenses',
  OUTBOX: 'ticket_pos_outbox',
  AUDIT: 'ticket_pos_audit_logs',
  SEQ: 'ticket_pos_sequences',
};

// In-memory fallback for headless Node.js unit test environments
const inMemoryStore: Record<string, string> = {};

function getItem(key: string): string | null {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem(key);
  }
  return inMemoryStore[key] || null;
}

function setItem(key: string, value: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(key, value);
  } else {
    inMemoryStore[key] = value;
  }
}

export class LocalStorageDbService implements IDbService {
  private isInitialized = false;

  async init(): Promise<void> {
    if (this.isInitialized) return;
    
    const existingConfig = getItem(STORAGE_KEYS.CONFIG);
    if (!existingConfig) {
      const defaultConfig: DeviceConfig = {
        locationId: 'LOC01',
        locationName: 'Danbaiwa Restraunt',
        deviceId: 'DEV01',
        deviceName: 'Till Alpha 1',
        businessName: 'Danbaiwa Restraunt',
        currencySymbol: '₦',
        presetAmounts: [200, 300, 400, 500, 1000],
        isConfigured: true,
      };
      setItem(STORAGE_KEYS.CONFIG, JSON.stringify(defaultConfig));
    }
    this.isInitialized = true;
  }

  async isLocalDataEmpty(): Promise<boolean> {
    return true;
  }

  async restoreFromCloud(): Promise<{ restored: boolean; reason?: string; source?: string }> {
    return { restored: false, reason: 'not supported in test double' };
  }

  async getDeviceConfig(): Promise<DeviceConfig | null> {
    const raw = getItem(STORAGE_KEYS.CONFIG);
    return raw ? JSON.parse(raw) : null;
  }

  async saveDeviceConfig(config: DeviceConfig): Promise<void> {
    setItem(STORAGE_KEYS.CONFIG, JSON.stringify(config));
  }

  // Users & Accounts
  async getUsers(): Promise<UserAccount[]> {
    const raw = getItem(STORAGE_KEYS.USERS);
    return raw ? JSON.parse(raw) : [];
  }

  async getUserByEmail(email: string): Promise<UserAccount | null> {
    const users = await this.getUsers();
    const cleanEmail = (email || '').trim().toLowerCase();
    return users.find(u => 
      (u && u.email && typeof u.email === 'string' && u.email.toLowerCase() === cleanEmail) || 
      (u && u.username && typeof u.username === 'string' && u.username.toLowerCase() === cleanEmail)
    ) || null;
  }

  async saveUser(user: UserAccount): Promise<void> {
    const users = await this.getUsers();
    users.unshift(user);
    setItem(STORAGE_KEYS.USERS, JSON.stringify(users));
    await this.queueOutbox('users', 'INSERT', user);
  }

  async updateUser(user: UserAccount): Promise<void> {
    const users = await this.getUsers();
    const index = users.findIndex(u => u.id === user.id);
    if (index !== -1) {
      users[index] = user;
      setItem(STORAGE_KEYS.USERS, JSON.stringify(users));
      await this.queueOutbox('users', 'UPDATE', user);
    }
  }

  // User-Scoped Tickets
  async getTickets(userId?: string): Promise<Ticket[]> {
    const raw = getItem(STORAGE_KEYS.TICKETS);
    const tickets: Ticket[] = raw ? JSON.parse(raw) : [];
    if (!userId) return tickets;
    return tickets.filter(t => t.cashierId === userId || (t.cashierId && t.cashierId.includes(userId)));
  }

  async saveTicket(ticket: Ticket): Promise<void> {
    const tickets = await this.getTickets();
    tickets.unshift(ticket);
    setItem(STORAGE_KEYS.TICKETS, JSON.stringify(tickets));
    await this.queueOutbox('tickets', 'INSERT', ticket);
  }

  async updateTicketStatus(
    ticketId: string,
    status: 'paid' | 'collected' | 'void',
    reason?: string,
    voidedBy?: string
  ): Promise<void> {
    const tickets = await this.getTickets();
    const index = tickets.findIndex(t => t.id === ticketId);
    if (index !== -1) {
      tickets[index].status = status;
      if (status === 'void') {
        tickets[index].voidReason = reason;
        tickets[index].voidedBy = voidedBy;
        tickets[index].voidedAt = new Date().toISOString();
        
        this.appendAuditLog({
          entity: 'ticket',
          entityId: ticketId,
          action: 'VOID',
          actorId: voidedBy || 'ADMIN',
          reason: reason || 'N/A',
          timestamp: new Date().toISOString(),
        });
      }
      setItem(STORAGE_KEYS.TICKETS, JSON.stringify(tickets));
      await this.queueOutbox('tickets', 'UPDATE', tickets[index]);
    }
  }

  async getNextSeq(locationId: string, deviceId: string): Promise<number> {
    const rawSeqMap = getItem(STORAGE_KEYS.SEQ);
    const seqMap: Record<string, number> = rawSeqMap ? JSON.parse(rawSeqMap) : {};
    const key = `${locationId}_${deviceId}`;
    const nextVal = (seqMap[key] || 0) + 1;
    seqMap[key] = nextVal;
    setItem(STORAGE_KEYS.SEQ, JSON.stringify(seqMap));
    return nextVal;
  }

  // User-Scoped Shifts
  async getCurrentShift(userId?: string): Promise<Shift | null> {
    const shifts = await this.getShifts(userId);
    return shifts.find(s => s.status === 'open') || null;
  }

  async getShifts(userId?: string): Promise<Shift[]> {
    const raw = getItem(STORAGE_KEYS.SHIFTS);
    const shifts: Shift[] = raw ? JSON.parse(raw) : [];
    if (!userId) return shifts;
    return shifts.filter(s => s.cashierId === userId);
  }

  async saveShift(shift: Shift): Promise<void> {
    const shifts = await this.getShifts();
    shifts.unshift(shift);
    setItem(STORAGE_KEYS.SHIFTS, JSON.stringify(shifts));
    await this.queueOutbox('shifts', 'INSERT', shift);
  }

  async closeShift(
    shiftId: string,
    countedCash: number,
    expectedCash: number,
    variance: number,
    notes?: string
  ): Promise<void> {
    const shifts = await this.getShifts();
    const index = shifts.findIndex(s => s.id === shiftId);
    if (index !== -1) {
      shifts[index].status = 'closed';
      shifts[index].closedAt = new Date().toISOString();
      shifts[index].countedCash = countedCash;
      shifts[index].expectedCash = expectedCash;
      shifts[index].variance = variance;
      shifts[index].notes = notes;
      setItem(STORAGE_KEYS.SHIFTS, JSON.stringify(shifts));
      await this.queueOutbox('shifts', 'UPDATE', shifts[index]);
    }
  }

  // User-Scoped Expenses
  async getExpenses(shiftId?: string, userId?: string): Promise<Expense[]> {
    const raw = getItem(STORAGE_KEYS.EXPENSES);
    let expenses: Expense[] = raw ? JSON.parse(raw) : [];
    if (shiftId) expenses = expenses.filter(e => e.shiftId === shiftId);
    if (userId) expenses = expenses.filter(e => e.cashierId === userId);
    return expenses;
  }

  async saveExpense(expense: Expense): Promise<void> {
    const expenses = await this.getExpenses();
    expenses.unshift(expense);
    setItem(STORAGE_KEYS.EXPENSES, JSON.stringify(expenses));
    await this.queueOutbox('expenses', 'INSERT', expense);
  }

  async updateExpenseStatus(
    expenseId: string,
    status: 'approved' | 'rejected',
    reviewer: string,
    reason?: string
  ): Promise<void> {
    const expenses = await this.getExpenses();
    const index = expenses.findIndex(e => e.id === expenseId);
    if (index !== -1) {
      expenses[index].status = status;
      expenses[index].reviewedBy = reviewer;
      expenses[index].reviewedAt = new Date().toISOString();
      if (reason) expenses[index].rejectionReason = reason;

      setItem(STORAGE_KEYS.EXPENSES, JSON.stringify(expenses));
      await this.queueOutbox('expenses', 'UPDATE', expenses[index]);

      this.appendAuditLog({
        entity: 'expense',
        entityId: expenseId,
        action: status === 'approved' ? 'APPROVE_EXPENSE' : 'REJECT_EXPENSE',
        actorId: reviewer,
        reason: reason || 'Manager Review',
        timestamp: new Date().toISOString(),
      });
    }
  }

  async getAuditLogs(entityId?: string, actorId?: string): Promise<any[]> {
    const raw = getItem(STORAGE_KEYS.AUDIT);
    let logs: any[] = raw ? JSON.parse(raw) : [];
    if (entityId) logs = logs.filter(l => l.entityId === entityId);
    if (actorId) logs = logs.filter(l => l.actorId === actorId);
    return logs;
  }

  async getPendingOutbox(): Promise<OutboxItem[]> {
    const raw = getItem(STORAGE_KEYS.OUTBOX);
    const outbox: OutboxItem[] = raw ? JSON.parse(raw) : [];
    const now = Date.now();
    return outbox.filter(
      o => o.status === 'pending' && (!o.nextAttemptAt || Date.parse(o.nextAttemptAt) <= now)
    );
  }

  async countUnsyncedOutbox(): Promise<{ total: number; stuck: number }> {
    const raw = getItem(STORAGE_KEYS.OUTBOX);
    const outbox: OutboxItem[] = raw ? JSON.parse(raw) : [];
    const unsynced = outbox.filter(o => o.status === 'pending' || o.status === 'failed');
    return { total: unsynced.length, stuck: unsynced.filter(o => o.retryCount >= 8).length };
  }

  async revivePendingOutbox(): Promise<number> {
    const raw = getItem(STORAGE_KEYS.OUTBOX);
    const outbox: OutboxItem[] = raw ? JSON.parse(raw) : [];
    let revived = 0;
    for (const o of outbox) {
      if (o.status !== 'pending' && o.status !== 'failed') continue;
      if (o.status === 'failed') revived++;
      o.status = 'pending';
      o.retryCount = 0;
      delete o.nextAttemptAt;
    }
    setItem(STORAGE_KEYS.OUTBOX, JSON.stringify(outbox));
    return revived;
  }

  async enqueueBackfill(tableName: string, payloads: Record<string, any>[]): Promise<number> {
    const raw = getItem(STORAGE_KEYS.OUTBOX);
    const outbox: OutboxItem[] = raw ? JSON.parse(raw) : [];
    const already = new Set(
      outbox
        .filter(o => o.tableName === tableName && (o.status === 'pending' || o.status === 'failed'))
        .map(o => (o.payload as any)?.id)
    );
    let queued = 0;
    for (const payload of payloads) {
      if (already.has(payload.id)) continue;
      outbox.push({
        id: crypto.randomUUID(),
        tableName,
        action: 'INSERT',
        payload,
        createdAt: new Date().toISOString(),
        status: 'pending',
        retryCount: 0,
      });
      queued++;
    }
    setItem(STORAGE_KEYS.OUTBOX, JSON.stringify(outbox));
    return queued;
  }

  async markOutboxSynced(id: string): Promise<void> {
    const raw = getItem(STORAGE_KEYS.OUTBOX);
    const outbox: OutboxItem[] = raw ? JSON.parse(raw) : [];
    const index = outbox.findIndex(o => o.id === id);
    if (index !== -1) {
      outbox[index].status = 'synced';
      setItem(STORAGE_KEYS.OUTBOX, JSON.stringify(outbox));
    }
  }

  async markOutboxSyncedMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const raw = getItem(STORAGE_KEYS.OUTBOX);
    const outbox: OutboxItem[] = raw ? JSON.parse(raw) : [];
    const wanted = new Set(ids);
    for (const o of outbox) {
      if (wanted.has(o.id)) o.status = 'synced';
    }
    setItem(STORAGE_KEYS.OUTBOX, JSON.stringify(outbox));
  }

  async markOutboxAttemptFailed(id: string, retryCount: number, lastError?: string): Promise<void> {
    const raw = getItem(STORAGE_KEYS.OUTBOX);
    const outbox: OutboxItem[] = raw ? JSON.parse(raw) : [];
    const index = outbox.findIndex(o => o.id === id);
    if (index !== -1) {
      const next = retryCount + 1;
      // Mirrors IndexedDbService: back off, never park. Unsynced data is never dropped.
      outbox[index].retryCount = next;
      outbox[index].status = 'pending';
      outbox[index].nextAttemptAt = new Date(
        Date.now() + Math.min(5_000 * 2 ** Math.min(next, 12), 30 * 60_000)
      ).toISOString();
      outbox[index].lastError = lastError;
      setItem(STORAGE_KEYS.OUTBOX, JSON.stringify(outbox));
    }
  }

  private async queueOutbox(tableName: string, action: 'INSERT' | 'UPDATE' | 'DELETE', payload: Record<string, any>): Promise<void> {
    const raw = getItem(STORAGE_KEYS.OUTBOX);
    const outbox: OutboxItem[] = raw ? JSON.parse(raw) : [];
    outbox.push({
      id: crypto.randomUUID(),
      tableName,
      action,
      payload,
      createdAt: new Date().toISOString(),
      status: 'pending',
      retryCount: 0,
    });
    setItem(STORAGE_KEYS.OUTBOX, JSON.stringify(outbox));
  }

  private appendAuditLog(entry: { entity: string; entityId: string; action: string; actorId: string; reason: string; timestamp: string }) {
    const raw = getItem(STORAGE_KEYS.AUDIT);
    const logs = raw ? JSON.parse(raw) : [];
    logs.unshift(entry);
    setItem(STORAGE_KEYS.AUDIT, JSON.stringify(logs));
  }
}

export const dbService = new LocalStorageDbService();
