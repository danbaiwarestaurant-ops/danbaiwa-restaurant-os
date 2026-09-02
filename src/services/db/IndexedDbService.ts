/**
 * IndexedDbService.ts
 *
 * IDbService implementation backed by Dexie (IndexedDB). Local storage is a
 * continuously-reconciled cache of Postgres, not each device's sole store of record —
 * see realtimeSync.ts for the realtime/reconciliation pull that keeps it that way, and
 * remoteMerge.ts for the last-write-wins merge rules incoming remote rows go through.
 *
 * Every mutating method wraps its writes — the row itself, plus the outbox entry and
 * (where applicable) the audit-log entry — in one Dexie `rw` transaction across all
 * affected tables, so the outbox is always written in the exact same transaction as
 * the mutation it describes (see .agents/AGENTS.md rule 3). IndexedDB commits that
 * transaction durably before the promise resolves.
 */

import { IDbService } from './IDbService';
import { Ticket } from '../../types/ticket';
import { Shift } from '../../types/shift';
import { Expense } from '../../types/expense';
import { OutboxItem } from '../../types/sync';
import { DeviceConfig } from '../../types/config';
import { UserAccount } from '../../types/user';
import { db, UserRow, AuditLogRow, computeLoginKeys, stripUserRow } from './dexieSchema';
import { isLocalDataEmpty, restoreFromCloud } from './cloudBackup';

const DEFAULT_CONFIG_KEY = 'device_config';
const INSTALLATION_ID_KEY = 'installation_id';

/** Short, readable, collision-resistant token identifying this browser install. */
function generateInstallationId(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — these get printed
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** Retry count past which a row is reported as "stuck" in the UI. It keeps retrying. */
const STUCK_AFTER_RETRIES = 8;
const BASE_BACKOFF_MS = 2_000;
/**
 * Only rows the cloud actually *rejected* are ever backed off — a dropped connection is
 * classified as transient in useSyncStore and charged to nobody. So the ceiling only has
 * to be long enough to stop a permanently-bad row from being retried in a tight loop,
 * not the half hour it used to be: at that cap a row whose blocker cleared (a referenced
 * shift finally arrives, a schema is fixed) sat out most of a service before anyone saw
 * it move.
 */
const MAX_BACKOFF_MS = 60_000;

function queueOutboxRow(tableName: string, action: 'INSERT' | 'UPDATE' | 'DELETE', payload: Record<string, any>): OutboxItem {
  return {
    id: crypto.randomUUID(),
    tableName,
    action,
    payload,
    createdAt: new Date().toISOString(),
    status: 'pending',
    retryCount: 0,
  };
}

function auditLogRow(e: { entity: string; entityId: string; action: string; actorId: string; reason: string; timestamp: string }): AuditLogRow {
  return { id: crypto.randomUUID(), ...e };
}

export class IndexedDbService implements IDbService {
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await db.open();

      const existing = await db.config.get(DEFAULT_CONFIG_KEY);
      if (!existing) {
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
        await db.config.put({ key: DEFAULT_CONFIG_KEY, value: defaultConfig });
      }

      // Per-browser identity for ticket numbering. Deliberately NOT part of
      // DeviceConfig: config follows the account to every device, so locationId and
      // deviceId are necessarily shared between tills and cannot make an id unique.
      // Generated once, never synced, never surfaced in settings.
      const install = await db.config.get(INSTALLATION_ID_KEY);
      if (!install?.value) {
        await db.config.put({ key: INSTALLATION_ID_KEY, value: generateInstallationId() });
      }
    })();

    return this.initPromise;
  }

  /** This browser's installation token, generated on first init(). */
  async getInstallationId(): Promise<string> {
    await this.init();
    const row = await db.config.get(INSTALLATION_ID_KEY);
    return (row?.value as string) || 'LOCAL';
  }

  /** True when this device holds no operational records yet (fresh/wiped install). */
  async isLocalDataEmpty(): Promise<boolean> {
    return isLocalDataEmpty();
  }

  /**
   * Retained for interface compatibility; no longer called from the app (see
   * realtimeSync.ts's runReconciliationPull, which replaced the "only if empty" cloud
   * restore with an always-safe merge). Left in place, unused, as a rollback path.
   */
  async restoreFromCloud(): Promise<{ restored: boolean; reason?: string; source?: string }> {
    await this.init();
    return restoreFromCloud();
  }

  // ─── Config ──────────────────────────────────────────────────────────────

  async getDeviceConfig(): Promise<DeviceConfig | null> {
    const row = await db.config.get(DEFAULT_CONFIG_KEY);
    return row ? row.value : null;
  }

  /**
   * Persists config and queues it for the account, so business settings follow the admin
   * to every device they sign in on.
   *
   * Only user-initiated saves come through here — init()'s first-boot default writes
   * straight to Dexie, so a fresh install doesn't push a default config over whatever
   * the account already has. Remote settings arriving from another device are applied by
   * applyRemoteSettings(), which likewise bypasses this to avoid a push/pull loop.
   */
  async saveDeviceConfig(config: DeviceConfig): Promise<void> {
    await db.transaction('rw', db.config, db.outbox, async () => {
      await db.config.put({ key: DEFAULT_CONFIG_KEY, value: config });
      await db.outbox.add(
        queueOutboxRow('account_settings', 'UPDATE', {
          settings: config,
          updatedAt: new Date().toISOString(),
        })
      );
    });
  }

  // ─── Users ───────────────────────────────────────────────────────────────

  async getUsers(): Promise<UserAccount[]> {
    const rows = await db.users.orderBy('createdAt').reverse().toArray();
    return rows.map(stripUserRow);
  }

  async findUsersByLoginKey(email: string): Promise<UserAccount[]> {
    const clean = (email || '').trim().toLowerCase();
    if (!clean) return [];
    const rows = await db.users.where('loginKeys').equals(clean).toArray();
    return rows.map(stripUserRow);
  }

  /**
   * Emails are unique across every account, so for an admin login this is unchanged.
   * Staff IDs are not: they only have to be unique inside one restaurant, so once a
   * second business's roster has synced into the same browser profile, "amina" names
   * two different people. `.first()` picked whichever Dexie happened to return, which
   * is how one shop's cashier could be handed another shop's till session.
   */
  async getUserByEmail(email: string, accountId?: string | null): Promise<UserAccount | null> {
    const matches = await this.findUsersByLoginKey(email);
    if (!matches.length) return null;
    if (matches.length === 1) return matches[0];

    if (accountId) {
      const own = matches.find((u) => u.accountId === accountId);
      if (own) return own;
    }
    // Rows predating account stamping belong to whoever is on this device; a row
    // owned by a *different* account never does, so it is never the fallback.
    return matches.find((u) => !u.accountId) ?? null;
  }

  async saveUserLocalOnly(user: UserAccount, rebuiltLocally = false): Promise<void> {
    // updatedAt is honoured when the caller supplies one. That is what lets a
    // reconstructed profile date itself to the account's creation instead of to now,
    // so the authoritative row always wins the last-write-wins merge when it arrives.
    const stamped = { ...user, updatedAt: user.updatedAt || new Date().toISOString() };
    await db.users.put({ ...stamped, loginKeys: computeLoginKeys(stamped), rebuiltLocally });
  }

  async saveUser(user: UserAccount): Promise<void> {
    const stamped = { ...user, updatedAt: new Date().toISOString() };
    await db.transaction('rw', db.users, db.outbox, async () => {
      const existing = await db.users.get(user.id);
      if (!existing) {
        const row: UserRow = { ...stamped, loginKeys: computeLoginKeys(stamped) };
        await db.users.add(row);
      }
      await db.outbox.add(queueOutboxRow('users', 'INSERT', stamped));
    });
  }

  async updateUser(user: UserAccount): Promise<void> {
    const stamped = { ...user, updatedAt: new Date().toISOString() };
    await db.transaction('rw', db.users, db.outbox, async () => {
      const row: UserRow = { ...stamped, loginKeys: computeLoginKeys(stamped) };
      await db.users.put(row);
      await db.outbox.add(queueOutboxRow('users', 'UPDATE', stamped));
    });
  }

  /**
   * Removes a staff account outright, queueing the removal for the cloud in the same
   * transaction.
   *
   * The queued DELETE is what makes this real rather than local: without it the next
   * reconciliation pull would find the row still in Supabase and put it straight back.
   * Callers must establish that the account owns no records first — see
   * countRecordsForUser — because nothing here cascades, and a ticket whose cashier no
   * longer exists loses its name for good.
   */
  async deleteUser(userId: string): Promise<void> {
    await db.transaction('rw', db.users, db.outbox, async () => {
      await db.users.delete(userId);
      await db.outbox.add(queueOutboxRow('users', 'DELETE', { id: userId }));
    });
  }

  /** How much history a staff account owns, per table. All zero means nothing is lost by deleting it. */
  async countRecordsForUser(userId: string): Promise<{ tickets: number; shifts: number; expenses: number; auditLogs: number }> {
    const [tickets, shifts, expenses, auditLogs] = await Promise.all([
      db.tickets.where('cashierId').equals(userId).count(),
      db.shifts.where('cashierId').equals(userId).count(),
      db.expenses.where('cashierId').equals(userId).count(),
      db.auditLogs.where('actorId').equals(userId).count(),
    ]);
    return { tickets, shifts, expenses, auditLogs };
  }

  // ─── Tickets ─────────────────────────────────────────────────────────────

  async getTickets(userId?: string): Promise<Ticket[]> {
    if (userId) {
      const rows = await db.tickets.where('cashierId').equals(userId).sortBy('createdAt');
      return rows.reverse();
    }
    return db.tickets.orderBy('createdAt').reverse().toArray();
  }

  async saveTicket(ticket: Ticket): Promise<void> {
    const stamped = { ...ticket, updatedAt: new Date().toISOString() };
    await db.transaction('rw', db.tickets, db.outbox, async () => {
      const existing = await db.tickets.get(ticket.id);
      if (!existing) await db.tickets.add(stamped);
      await db.outbox.add(queueOutboxRow('tickets', 'INSERT', stamped));
    });
  }

  async updateTicketStatus(
    ticketId: string,
    status: 'paid' | 'collected' | 'void',
    reason?: string,
    voidedBy?: string
  ): Promise<void> {
    const now = new Date().toISOString();
    await db.transaction('rw', db.tickets, db.outbox, db.auditLogs, async () => {
      if (status === 'void') {
        await db.tickets.update(ticketId, { status, voidReason: reason, voidedBy, voidedAt: now, updatedAt: now });
        const entry = auditLogRow({
          entity: 'ticket',
          entityId: ticketId,
          action: 'VOID',
          actorId: voidedBy ?? 'ADMIN',
          reason: reason ?? 'N/A',
          timestamp: now,
        });
        await db.auditLogs.add(entry);
        await db.outbox.add(queueOutboxRow('audit_logs', 'INSERT', entry));
      } else {
        await db.tickets.update(ticketId, { status, updatedAt: now });
      }
      const updated = await db.tickets.get(ticketId);
      if (updated) await db.outbox.add(queueOutboxRow('tickets', 'UPDATE', updated));
    });
  }

  /**
   * Atomically increment this installation's ticket counter.
   *
   * Keyed by installationId, not locationId/deviceId: those are account-level settings
   * that follow the admin to every device, so keying on them would have two tills
   * sharing one counter and minting duplicate ticket ids.
   */
  async getNextSeq(_locationId: string, _deviceId: string): Promise<number> {
    const key = `seq_${await this.getInstallationId()}`;
    return db.transaction('rw', db.sequences, async () => {
      const row = await db.sequences.get(key);
      const val = (row?.nextVal ?? 0) + 1;
      await db.sequences.put({ key, nextVal: val });
      return val;
    });
  }

  // ─── Shifts ──────────────────────────────────────────────────────────────

  async getCurrentShift(userId?: string): Promise<Shift | null> {
    const shifts = await this.getShifts(userId);
    return shifts.find((s) => s.status === 'open') ?? null;
  }

  async getShifts(userId?: string): Promise<Shift[]> {
    if (userId) {
      const rows = await db.shifts.where('cashierId').equals(userId).sortBy('openedAt');
      return rows.reverse();
    }
    return db.shifts.orderBy('openedAt').reverse().toArray();
  }

  async saveShift(shift: Shift): Promise<void> {
    const stamped = { ...shift, updatedAt: new Date().toISOString() };
    await db.transaction('rw', db.shifts, db.outbox, async () => {
      const existing = await db.shifts.get(shift.id);
      if (!existing) await db.shifts.add(stamped);
      await db.outbox.add(queueOutboxRow('shifts', 'INSERT', stamped));
    });
  }

  async closeShift(shiftId: string, countedCash: number, expectedCash: number, variance: number, notes?: string): Promise<void> {
    const now = new Date().toISOString();
    await db.transaction('rw', db.shifts, db.outbox, async () => {
      await db.shifts.update(shiftId, { status: 'closed', closedAt: now, countedCash, expectedCash, variance, notes, updatedAt: now });
      const updated = await db.shifts.get(shiftId);
      if (updated) await db.outbox.add(queueOutboxRow('shifts', 'UPDATE', updated));
    });
  }

  // ─── Expenses ────────────────────────────────────────────────────────────

  async getExpenses(shiftId?: string, userId?: string): Promise<Expense[]> {
    let rows: Expense[];
    if (shiftId && userId) {
      rows = await db.expenses.where('[shiftId+cashierId]').equals([shiftId, userId]).toArray();
    } else if (shiftId) {
      rows = await db.expenses.where('shiftId').equals(shiftId).toArray();
    } else if (userId) {
      rows = await db.expenses.where('cashierId').equals(userId).toArray();
    } else {
      rows = await db.expenses.toArray();
    }
    return rows.sort((a, b) => (a.loggedAt < b.loggedAt ? 1 : a.loggedAt > b.loggedAt ? -1 : 0));
  }

  async saveExpense(expense: Expense): Promise<void> {
    const stamped = { ...expense, updatedAt: new Date().toISOString() };
    await db.transaction('rw', db.expenses, db.outbox, async () => {
      const existing = await db.expenses.get(expense.id);
      if (!existing) await db.expenses.add(stamped);
      await db.outbox.add(queueOutboxRow('expenses', 'INSERT', stamped));
    });
  }

  async updateExpenseStatus(expenseId: string, status: 'approved' | 'rejected', reviewer: string, reason?: string): Promise<void> {
    const now = new Date().toISOString();
    await db.transaction('rw', db.expenses, db.outbox, db.auditLogs, async () => {
      await db.expenses.update(expenseId, { status, reviewedBy: reviewer, reviewedAt: now, rejectionReason: reason, updatedAt: now });
      const updated = await db.expenses.get(expenseId);
      if (updated) {
        await db.outbox.add(queueOutboxRow('expenses', 'UPDATE', updated));
        const entry = auditLogRow({
          entity: 'expense',
          entityId: expenseId,
          action: status === 'approved' ? 'APPROVE_EXPENSE' : 'REJECT_EXPENSE',
          actorId: reviewer,
          reason: reason ?? 'Manager Review',
          timestamp: now,
        });
        await db.auditLogs.add(entry);
        await db.outbox.add(queueOutboxRow('audit_logs', 'INSERT', entry));
      }
    });
  }

  // ─── Audit Logs ──────────────────────────────────────────────────────────

  async getAuditLogs(entityId?: string, actorId?: string): Promise<AuditLogRow[]> {
    let rows: AuditLogRow[];
    if (entityId) {
      rows = await db.auditLogs.where('entityId').equals(entityId).toArray();
    } else if (actorId) {
      rows = await db.auditLogs.where('actorId').equals(actorId).toArray();
    } else {
      rows = await db.auditLogs.toArray();
    }
    return rows.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  }

  // ─── Outbox Sync ─────────────────────────────────────────────────────────

  /** Queued rows that are eligible to be pushed right now (i.e. not waiting out a backoff). */
  async getPendingOutbox(): Promise<OutboxItem[]> {
    const now = Date.now();
    const rows = await db.outbox.where('status').equals('pending').sortBy('createdAt');
    return rows.filter((r) => !r.nextAttemptAt || Date.parse(r.nextAttemptAt) <= now);
  }

  /**
   * Everything still owed to the cloud, whether or not it is currently due for a retry.
   * This — not getPendingOutbox — is what the UI must report, so a row quietly sitting
   * out a 30-minute backoff can never be mistaken for "synced".
   */
  async countUnsyncedOutbox(): Promise<{
    total: number;
    stuck: number;
    topError?: { reason: string; count: number };
  }> {
    const rows = await db.outbox.where('status').anyOf('pending', 'failed').toArray();

    // Why the queue is not moving is recorded on every row that failed, and used to be
    // readable nowhere: the badge said "N pending" whether the cloud was busy or was
    // refusing every record for the same reason. Report the reason the most rows share.
    const tally = new Map<string, number>();
    for (const row of rows) {
      if (!row.lastError) continue;
      tally.set(row.lastError, (tally.get(row.lastError) ?? 0) + 1);
    }
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];

    return {
      total: rows.length,
      stuck: rows.filter((r) => r.retryCount >= STUCK_AFTER_RETRIES).length,
      topError: top ? { reason: top[0], count: top[1] } : undefined,
    };
  }

  async markOutboxSynced(id: string): Promise<void> {
    await db.outbox.update(id, { status: 'synced' });
  }

  async markOutboxSyncedMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await db.transaction('rw', db.outbox, async () => {
      for (const id of ids) {
        await db.outbox.update(id, { status: 'synced' });
      }
    });
  }

  /**
   * Records a failed sync attempt for one outbox item and backs it off exponentially.
   *
   * Deliberately never parks a row as permanently 'failed'. Doing so used to drop it
   * out of getPendingOutbox's filter with nothing anywhere that ever retried it, so a
   * till that spent a couple of minutes without a cloud session orphaned that data on
   * the device permanently — invisible to every other device, forever. A row that
   * cannot sync now may well sync later (the session comes back, a referenced shift
   * arrives, the schema is fixed), so it keeps its place in the queue and is surfaced
   * as "stuck" via countUnsyncedOutbox instead of being abandoned.
   */
  async markOutboxAttemptFailed(id: string, retryCount: number, lastError?: string): Promise<void> {
    const nextRetryCount = retryCount + 1;
    const delayMs = Math.min(
      BASE_BACKOFF_MS * 2 ** Math.min(nextRetryCount, 12),
      MAX_BACKOFF_MS
    );
    await db.outbox.update(id, {
      retryCount: nextRetryCount,
      status: 'pending',
      nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
      lastError,
    });
  }

  /**
   * Drops acknowledged outbox rows older than the retention window.
   *
   * Nothing ever deleted them, so the outbox grew for the life of the install: one row
   * per ticket, shift, expense, user edit and audit entry, forever. Every code path that
   * has to ask "is this record still owed?" pays for that history, and the whole table
   * goes into each cloud snapshot. A short window is kept rather than deleting on
   * acknowledgement so a recent push is still inspectable when something looks wrong.
   * Only rows already confirmed in the cloud are touched — nothing unsynced can be lost.
   */
  async pruneSyncedOutbox(olderThanMs: number = 24 * 60 * 60_000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    return db.outbox
      .where('status')
      .equals('synced')
      .filter((row) => row.createdAt < cutoff)
      .delete();
  }

  /**
   * Clears every backoff and resurrects rows parked as 'failed' by the previous build,
   * so a newly (re)established cloud session immediately retries everything this device
   * still owes the cloud rather than waiting out timers set while it was disconnected.
   * Returns how many rows were revived from the permanently-parked 'failed' state.
   */
  async revivePendingOutbox(): Promise<number> {
    let revived = 0;
    await db.transaction('rw', db.outbox, async () => {
      const rows = await db.outbox.where('status').anyOf('pending', 'failed').toArray();
      for (const row of rows) {
        if (row.status === 'failed') revived++;
        await db.outbox.update(row.id, {
          status: 'pending',
          retryCount: 0,
          nextAttemptAt: undefined,
        });
      }
    });
    return revived;
  }

  /**
   * Queues rows the cloud is missing (see cloudBackfill.ts). Skips any row that already
   * has an entry in flight, so repeated sweeps can't pile up duplicate pushes.
   */
  async enqueueBackfill(tableName: string, payloads: Record<string, any>[]): Promise<number> {
    if (!payloads.length) return 0;
    let queued = 0;
    await db.transaction('rw', db.outbox, async () => {
      const inFlight = await db.outbox.where('status').anyOf('pending', 'failed').toArray();
      const already = new Set(
        inFlight.filter((o) => o.tableName === tableName).map((o) => (o.payload as any)?.id)
      );
      for (const payload of payloads) {
        if (already.has(payload.id)) continue;
        await db.outbox.add(queueOutboxRow(tableName, 'INSERT', payload));
        queued++;
      }
    });
    return queued;
  }
}

export const dbService = new IndexedDbService();
