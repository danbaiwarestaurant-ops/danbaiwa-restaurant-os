import Dexie from 'dexie';
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
import { staffFoodCount, staffMealWageDeduction } from '../../utils/staffMeals';
import { businessDayKey } from '../../utils/shiftDay';
import { Ticket, TicketTender } from '../../types/ticket';
import { Shift } from '../../types/shift';
import { Expense } from '../../types/expense';
import { ServerSalesEntry } from '../../types/serverSales';
import { OutboxItem } from '../../types/sync';
import { DeviceConfig } from '../../types/config';
import { UserAccount } from '../../types/user';
import { RolePayConfig, StaffAssessment, WageLedgerEntry } from '../../types/workforce';
import { InventoryBatch, InventoryItem, InventoryMovement } from '../../types/inventory';
import { db, UserRow, AuditLogRow, computeLoginKeys, stripUserRow } from './dexieSchema';
import { isLocalDataEmpty, restoreFromCloud } from './cloudBackup';
import { adjustShiftSummary, emptyShiftSummary, ShiftSummary } from './shiftSummaries';
import { Period, periodFor } from '../../utils/period';
import { archivedStaff, STAFF_DELETION_ENTITY } from './staffIdentity';

async function assertStaffNotDeleted(id: string): Promise<void> {
  const logs = await db.auditLogs.where('entityId').equals(id).toArray();
  if (logs.some(log => archivedStaff(log))) throw new Error('This staff profile was permanently deleted. Create a new staff account.');
}

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
          staffMealOptions: [
            { id: 'food', name: 'Food', wageCharge: 500, isFree: true },
            { id: 'meat', name: 'Meat', wageCharge: 500, isFree: false },
            { id: 'fish', name: 'Fish', wageCharge: 500, isFree: false },
            { id: 'egg', name: 'Egg', wageCharge: 200, isFree: false },
          ],
          penaltyRules: [
            { id: 'son-zuciya', label: 'Son zuciya', fixedFee: 0 },
            { id: 'punctuality', label: 'Punctuality', fixedFee: 0 },
            { id: 'cleanliness', label: 'Cleanliness', fixedFee: 0 },
            { id: 'customer-engagement', label: 'Customer Engagement', fixedFee: 0 },
          ],
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
    const archived = (await db.auditLogs.where('entity').equals(STAFF_DELETION_ENTITY).toArray())
      .map(archivedStaff).filter((u): u is UserAccount => !!u);
    const identities = [...new Map(archived.sort((a, b) => (a.deletedAt || '').localeCompare(b.deletedAt || '')).map(u => [u.id, u])).values()];
    const removed = new Set(identities.map(u => u.id));
    return [...rows.filter(u => !removed.has(u.id)).map(stripUserRow), ...identities];
  }

  async getUserById(id: string): Promise<UserAccount | null> {
    const row = await db.users.get(id);
    return row ? stripUserRow(row) : null;
  }

  async findUsersByLoginKey(email: string): Promise<UserAccount[]> {
    const clean = (email || '').trim().toLowerCase();
    if (!clean) return [];
    const rows = await db.users.where('loginKeys').equals(clean).toArray();
    const removed = new Set((await db.auditLogs.where('entity').equals(STAFF_DELETION_ENTITY).toArray())
      .filter(log => archivedStaff(log)).map(log => log.entityId));
    return rows.filter(row => !removed.has(row.id)).map(stripUserRow);
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
    await db.transaction('rw', db.users, db.auditLogs, async () => {
      await assertStaffNotDeleted(user.id);
      await db.users.put({ ...stamped, loginKeys: computeLoginKeys(stamped), rebuiltLocally });
    });
  }

  async saveUser(user: UserAccount): Promise<void> {
    const stamped = { ...user, updatedAt: new Date().toISOString() };
    await db.transaction('rw', db.users, db.outbox, db.auditLogs, async () => {
      await assertStaffNotDeleted(user.id);
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
    await db.transaction('rw', db.users, db.outbox, db.auditLogs, async () => {
      await assertStaffNotDeleted(user.id);
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
   * An immutable credential-free audit identity retains attribution. Historical
   * records remain intact, and a deletion tombstone rejects stale login profiles.
   */
  async deleteUser(userId: string): Promise<void> {
    await db.transaction('rw', db.users, db.outbox, db.auditLogs, async () => {
      const user = await db.users.get(userId);
      if (!user) return;
      if (user.role === 'admin') throw new Error('The business owner cannot be deleted as staff.');
      const now = new Date().toISOString();
      const identity: AuditLogRow = { id: crypto.randomUUID(), entity: STAFF_DELETION_ENTITY,
        entityId: userId, action: 'PERMANENT_DELETE', actorId: user.accountId || '', timestamp: now,
        accountId: user.accountId, updatedAt: now,
        reason: JSON.stringify({ id: user.id, name: user.name, role: user.role, createdAt: user.createdAt, accountId: user.accountId }) };
      // Archive first in queue order. No salary, ticket, expense or shift is deleted.
      await db.auditLogs.add(identity);
      await db.outbox.add({ ...queueOutboxRow('audit_logs', 'INSERT', identity), createdAt: now });
      // Credentials also lived in older queued/synced profile snapshots. Remove
      // them atomically. Unsent snapshots remain queued as non-login identities
      // until acknowledged; their deletion successor is never silently dropped.
      await db.outbox.where('[tableName+payload.id+status]').anyOf(
        ['pending', 'failed', 'synced', 'syncing'].map(status => ['users', userId, status])
      ).modify(row => {
        if (row.action === 'DELETE') return;
        row.payload = { id: userId, accountId: user.accountId, name: user.name, role: user.role,
          createdAt: user.createdAt, updatedAt: now, status: 'deactivated',
          email: null, username: null, pinHash: '', pinSalt: '', passwordHash: null, passwordSalt: null,
          recoveryKeyHash: null, recoveryKeySalt: null };
      });
      await db.users.delete(userId);
      await db.outbox.add({ ...queueOutboxRow('users', 'DELETE', { id: userId, accountId: user.accountId }), createdAt: new Date(Date.parse(now) + 1).toISOString() });
    });
  }

  /** How much history a staff account owns, per table. Deletion retains this history. */
  async countRecordsForUser(userId: string): Promise<{ tickets: number; shifts: number; expenses: number; assessments: number; wageLedger: number; auditLogs: number }> {
    const [tickets, shifts, expenses, assessments, wageLedger, auditLogs] = await Promise.all([
      db.tickets.filter((ticket) => ticket.cashierId === userId || ticket.staffId === userId).count(),
      db.shifts.where('cashierId').equals(userId).count(),
      db.expenses.where('cashierId').equals(userId).count(),
      db.staffAssessments.where('staffId').equals(userId).count(),
      db.wageLedger.where('staffId').equals(userId).count(),
      db.auditLogs.where('actorId').equals(userId).count(),
    ]);
    return { tickets, shifts, expenses, assessments, wageLedger, auditLogs };
  }

  // ─── Tickets ─────────────────────────────────────────────────────────────

  async getTickets(userId?: string): Promise<Ticket[]> {
    if (userId) {
      return db.tickets.where('[cashierId+createdAt]')
        .between([userId, Dexie.minKey], [userId, Dexie.maxKey]).reverse().toArray();
    }
    return db.tickets.orderBy('createdAt').reverse().toArray();
  }

  async getTicketsInPeriod(period: Period): Promise<Ticket[]> {
    // Let IndexedDB return a native bulk page. Reverse IDB queries otherwise
    // invoke a separate cursor callback per row on many deployed browsers.
    const rows = await db.tickets.where('createdAt').between(period.start.toISOString(), period.end.toISOString(), true, false).toArray();
    return rows.reverse();
  }

  async getStaffMealTickets(staffIds: string[], period: Period): Promise<Ticket[]> {
    const rows = await Promise.all(staffIds.map(id => db.tickets.where('[staffId+createdAt]').between(
      [id, period.start.toISOString()], [id, period.end.toISOString()], true, false).toArray()));
    return rows.flat();
  }

  /** Keyset pagination: reading page 100,000 costs the same as page 1. */
  async getRecentTickets(userId?: string, before?: { createdAt: string; id: string }, limit = 200): Promise<Ticket[]> {
    if (userId) return db.tickets.where('[cashierId+createdAt+id]').between(
      [userId, Dexie.minKey, Dexie.minKey],
      before ? [userId, before.createdAt, before.id] : [userId, Dexie.maxKey], true, !before
    ).reverse().limit(limit).toArray();
    // Admin's till uses the same personal cashier scope as other tills.
    return db.tickets.orderBy('createdAt').reverse().limit(limit).toArray();
  }

  async getShiftSummary(shift: Shift): Promise<ShiftSummary> {
    const ready = await db.shiftSummaries.get(shift.id);
    if (ready) return ready;
    return db.transaction('rw', db.tickets, db.shiftSummaries, async () => {
      const cached = await db.shiftSummaries.get(shift.id);
      if (cached) return cached;
      const summary = emptyShiftSummary(shift);
      // One-time legacy bootstrap for THIS shift, bounded native pages. Both modern
      // shift IDs and legacy cashier/window membership match reconciliation rules.
      for (const [index, lower, upper, legacy] of [
        ['[shiftId+createdAt+id]', [shift.id, Dexie.minKey, Dexie.minKey], [shift.id, Dexie.maxKey], false],
        ['[cashierId+createdAt+id]', [shift.cashierId, shift.openedAt, Dexie.minKey], (shift.closedAt ? [shift.cashierId, shift.closedAt, Dexie.maxKey] : [shift.cashierId, Dexie.maxKey]), true],
      ] as const) {
        let cursor: any = lower;
        let inclusive = true;
        while (true) {
          const rows = await db.tickets.where(index).between(cursor, upper, inclusive, true).limit(500).toArray();
          for (const row of rows) if (!legacy || !row.shiftId) adjustShiftSummary(summary, row, 1);
          if (rows.length < 500) break;
          const last = rows[rows.length - 1];
          cursor = [legacy ? shift.cashierId : shift.id, last.createdAt, last.id];
          inclusive = false;
        }
      }
      await db.shiftSummaries.put(summary);
      return summary;
    });
  }

  async saveTicket(ticket: Ticket): Promise<void> {
    const stamped = { ...ticket, updatedAt: new Date().toISOString() };
    await db.transaction('rw', db.tickets, db.outbox, async () => {
      const existing = await db.tickets.get(ticket.id);
      if (existing) {
        if (existing.cashierId !== ticket.cashierId || existing.createdAt !== ticket.createdAt || existing.amount !== ticket.amount) {
          throw new Error('Ticket number collision detected. Sale was not recorded; preserve this till and contact support.');
        }
        return; // replay of the same sale; do not queue a stale snapshot
      }
      await db.tickets.add(stamped);
      await db.outbox.add(queueOutboxRow('tickets', 'INSERT', stamped));
    });
  }

  async saveStaffMealTicket(ticket: Ticket, wageEntry?: WageLedgerEntry): Promise<void> {
    const now = new Date().toISOString();
    const stampedTicket = { ...ticket, updatedAt: now };
    await db.transaction('rw', [db.tickets, db.users, db.config, db.wageLedger, db.outbox, db.auditLogs], async () => {
      if (await db.tickets.get(ticket.id)) return;
      const staff = ticket.staffId ? await db.users.get(ticket.staffId) : undefined;
      if (staff && ticket.mealOptions?.length) {
        const config = (await db.config.get(DEFAULT_CONFIG_KEY))?.value as DeviceConfig | undefined;
        const day = businessDayKey(ticket.createdAt, config?.businessDayStartHour);
        const window = periodFor('day', new Date(ticket.createdAt), undefined, config?.businessDayStartHour);
        const meals = (await db.tickets.where('[staffId+createdAt]').between(
          [staff.id, window.start.toISOString()], [staff.id, window.end.toISOString()], true, false).toArray())
          .filter(t => !staff.accountId || !t.accountId || t.accountId === staff.accountId);
        const used = staffFoodCount(meals, staff.id, day, config?.businessDayStartHour);
        const deduction = staffMealWageDeduction(ticket.mealOptions, used, staff.dailyFoodCountLimit ?? 1);
        ticket.staffMealWageDeduction = deduction;
        stampedTicket.staffMealWageDeduction = deduction;
        if (wageEntry) wageEntry = deduction > 0 ? { ...wageEntry, amount: -deduction, businessDay: day } : undefined;
      }
      await db.tickets.add(stampedTicket);
      await db.outbox.add(queueOutboxRow('tickets', 'INSERT', stampedTicket));
      if (wageEntry && wageEntry.amount < 0) {
        const stampedEntry = { ...wageEntry, updatedAt: now };
        await db.wageLedger.add(stampedEntry);
        await db.outbox.add(queueOutboxRow('wage_ledger', 'INSERT', stampedEntry));
        const audit = auditLogRow({ entity: 'staff_meal', entityId: ticket.id, action: 'MEAL_WAGE_DEDUCTION', actorId: wageEntry.recordedBy, reason: `${wageEntry.staffName}: ${wageEntry.amount}. ${wageEntry.note}`, timestamp: now });
        await db.auditLogs.add(audit);
        await db.outbox.add(queueOutboxRow('audit_logs', 'INSERT', audit));
      }
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

  async updateTicketTender(ticketId: string, tender: TicketTender, actorId: string): Promise<void> {
    const now = new Date().toISOString();
    await db.transaction('rw', db.tickets, db.outbox, db.auditLogs, async () => {
      const before = await db.tickets.get(ticketId);
      if (!before) return;
      // Nothing changed, so nothing to log — retagging cash as cash should not fill the
      // audit trail with entries a manager has to read past.
      if ((before.tender ?? 'cash') === tender) return;

      await db.tickets.update(ticketId, { tender, updatedAt: now });
      const entry = auditLogRow({
        entity: 'ticket',
        entityId: ticketId,
        action: 'TENDER_CHANGE',
        actorId,
        reason: `${before.tender ?? 'cash'} → ${tender}`,
        timestamp: now,
      });
      await db.auditLogs.add(entry);
      await db.outbox.add(queueOutboxRow('audit_logs', 'INSERT', entry));

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
    if (!userId) return null;
    const installationId = await this.getInstallationId();
    const binding = await db.config.get('active_shift_' + userId);
    if (binding?.value) {
      const bound = await db.shifts.get(binding.value);
      if (bound?.status === 'open' && bound.cashierId === userId) return bound;
    }
    const shifts = await this.getShifts(userId);
    for (const shift of shifts.filter(row => row.status === 'open')) {
      if (shift.installationId === installationId) return shift;
      if (shift.installationId) continue;
      // Legacy rows have no installation field. Only resume a shift with evidence
      // that it was created here, never a remote cashier's open drawer on a phone.
      const localQueue = await db.outbox.where('[tableName+payload.id+status]')
        .anyOf(['pending', 'failed', 'synced'].map(status => ['shifts', shift.id, status])).count();
      const localTicket = await db.tickets.where('[cashierId+createdAt]')
        .between([userId, shift.openedAt], [userId, Dexie.maxKey], true, true)
        .filter(ticket => ticket.id.includes(installationId)).first();
      if (localQueue || localTicket) return shift;
    }
    return null;
  }

  async getShifts(userId?: string): Promise<Shift[]> {
    if (userId) {
      const rows = await db.shifts.where('cashierId').equals(userId).sortBy('openedAt');
      return rows.reverse();
    }
    return db.shifts.orderBy('openedAt').reverse().toArray();
  }

  async saveShift(shift: Shift): Promise<void> {
    const stamped = { ...shift, installationId: shift.installationId || await this.getInstallationId(), updatedAt: new Date().toISOString() };
    await db.transaction('rw', db.shifts, db.outbox, db.config, async () => {
      const existing = await db.shifts.get(shift.id);
      if (!existing) await db.shifts.add(stamped);
      if (shift.status === 'open') await db.config.put({ key: 'active_shift_' + shift.cashierId, value: shift.id });
      await db.outbox.add(queueOutboxRow('shifts', 'INSERT', stamped));
    });
  }

  async closeShift(shiftId: string, countedCash: number, expectedCash: number, variance: number, notes?: string, reconciliationPending = false): Promise<void> {
    const now = new Date().toISOString();
    await db.transaction('rw', db.shifts, db.outbox, async () => {
      await db.shifts.update(shiftId, { status: 'closed', closedAt: now, countedCash, expectedCash, variance, notes, reconciliationPending, updatedAt: now });
      const updated = await db.shifts.get(shiftId);
      if (updated) await db.outbox.add(queueOutboxRow('shifts', 'UPDATE', updated));
    });
  }

  async updateShiftReconciliation(shiftId: string, countedCash: number, expectedCash: number, variance: number, actorId: string): Promise<void> {
    const now = new Date().toISOString();
    await db.transaction('rw', db.shifts, db.outbox, db.auditLogs, async () => {
      await db.shifts.update(shiftId, { countedCash, expectedCash, variance, reconciliationPending: false, acknowledgedByManager: actorId, updatedAt: now });
      const updated = await db.shifts.get(shiftId);
      if (updated) await db.outbox.add(queueOutboxRow('shifts', 'UPDATE', updated));
      const audit = auditLogRow({ entity: 'shift', entityId: shiftId, action: 'RECONCILE_SHIFT', actorId, reason: `Counted ${countedCash}; variance ${variance}`, timestamp: now });
      await db.auditLogs.add(audit);
      await db.outbox.add(queueOutboxRow('audit_logs', 'INSERT', audit));
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

  // ─── Server ticket counts ────────────────────────────────────────────────

  async getServerSales(from?: string, to?: string): Promise<ServerSalesEntry[]> {
    // businessDay is a zero-padded YYYY-MM-DD, so a string range is a date range and the
    // index can answer it without reading rows outside the period.
    const rows =
      from && to
        ? await db.serverSales.where('businessDay').between(from, to, true, true).toArray()
        : await db.serverSales.toArray();
    // Newest day first, then by name, so a period reads as a diary rather than as
    // whatever order IndexedDB happened to return.
    return rows.sort(
      (a, b) =>
        (a.businessDay < b.businessDay ? 1 : a.businessDay > b.businessDay ? -1 : 0) ||
        a.serverName.localeCompare(b.serverName)
    );
  }

  async saveServerSales(entry: ServerSalesEntry): Promise<void> {
    const stamped = { ...entry, updatedAt: new Date().toISOString() };
    await db.transaction('rw', db.serverSales, db.outbox, async () => {
      // put, not add: the id is `<day>_<server>`, so a manager correcting a number is
      // writing the same row again and must overwrite it rather than fail on the key.
      await db.serverSales.put(stamped);
      await db.outbox.add(queueOutboxRow('server_sales', 'INSERT', stamped));
    });
  }

  async deleteServerSales(entryId: string): Promise<void> {
    await db.transaction('rw', db.serverSales, db.outbox, async () => {
      const existing = await db.serverSales.get(entryId);
      if (!existing) return;
      await db.serverSales.delete(entryId);
      // The cloud copy has to go too, or the next reconciliation pull puts it straight back.
      await db.outbox.add(queueOutboxRow('server_sales', 'DELETE', { id: entryId }));
    });
  }

  // Workforce performance and wage ledger
  async getRolePayConfigs(): Promise<RolePayConfig[]> {
    return db.rolePayConfigs.toArray();
  }

  async saveRolePayConfig(config: RolePayConfig, actorId: string): Promise<void> {
    const now = new Date().toISOString();
    const stamped = { ...config, updatedAt: now };
    await db.transaction('rw', db.rolePayConfigs, db.outbox, db.auditLogs, async () => {
      await db.rolePayConfigs.put(stamped);
      await db.outbox.add(queueOutboxRow('role_pay_configs', 'UPDATE', stamped));
      const audit = auditLogRow({ entity: 'pay_config', entityId: config.id, action: 'UPDATE_PAY_CONFIG', actorId, reason: `${config.metricLabel}: ${config.nairaPerUnit}/unit reward`, timestamp: now });
      await db.auditLogs.add(audit);
      await db.outbox.add(queueOutboxRow('audit_logs', 'INSERT', audit));
    });
  }

  async getStaffAssessments(from?: string, to?: string): Promise<StaffAssessment[]> {
    const rows = from && to
      ? await db.staffAssessments.where('businessDay').between(from, to, true, true).toArray()
      : await db.staffAssessments.toArray();
    return rows.sort((a, b) => b.businessDay.localeCompare(a.businessDay) || a.staffName.localeCompare(b.staffName));
  }

  async saveStaffAssessment(assessment: StaffAssessment, actorId: string, reason: string): Promise<void> {
    const now = new Date().toISOString();
    const stamped = { ...assessment, updatedAt: now };
    await db.transaction('rw', db.staffAssessments, db.outbox, db.auditLogs, async () => {
      const previous = await db.staffAssessments.get(assessment.id);
      await db.staffAssessments.put(stamped);
      await db.outbox.add(queueOutboxRow('staff_assessments', previous ? 'UPDATE' : 'INSERT', stamped));
      const action = assessment.status === 'finalized' && previous?.status !== 'finalized'
        ? 'FINALIZE_ASSESSMENT'
        : previous?.status === 'finalized' && assessment.status === 'draft'
          ? 'REOPEN_ASSESSMENT'
          : previous ? 'UPDATE_ASSESSMENT' : 'CREATE_ASSESSMENT';
      const audit = auditLogRow({ entity: 'staff_assessment', entityId: assessment.id, action, actorId, reason, timestamp: now });
      await db.auditLogs.add(audit);
      await db.outbox.add(queueOutboxRow('audit_logs', 'INSERT', audit));
    });
  }

  async getWageLedger(from?: string, to?: string): Promise<WageLedgerEntry[]> {
    const rows = from && to
      ? await db.wageLedger.where('businessDay').between(from, to, true, true).toArray()
      : await db.wageLedger.toArray();
    return rows.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  async saveWageLedgerEntry(entry: WageLedgerEntry, actorId: string): Promise<void> {
    const now = new Date().toISOString();
    const stamped = { ...entry, updatedAt: now };
    await db.transaction('rw', db.wageLedger, db.outbox, db.auditLogs, async () => {
      await db.wageLedger.add(stamped);
      await db.outbox.add(queueOutboxRow('wage_ledger', 'INSERT', stamped));
      const audit = auditLogRow({ entity: 'wage_ledger', entityId: entry.id, action: entry.kind.toUpperCase(), actorId, reason: `${entry.staffName}: ${entry.amount}. ${entry.note}`, timestamp: now });
      await db.auditLogs.add(audit);
      await db.outbox.add(queueOutboxRow('audit_logs', 'INSERT', audit));
    });
  }

  // FIFO ingredient inventory
  async getInventoryItems(): Promise<InventoryItem[]> {
    return (await db.inventoryItems.toArray()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveInventoryItem(item: InventoryItem, actorId: string): Promise<void> {
    const now = new Date().toISOString();
    const stamped = { ...item, updatedAt: now };
    await db.transaction('rw', db.inventoryItems, db.outbox, db.auditLogs, async () => {
      const previous = await db.inventoryItems.get(item.id);
      await db.inventoryItems.put(stamped);
      await db.outbox.add(queueOutboxRow('inventory_items', previous ? 'UPDATE' : 'INSERT', stamped));
      const audit = auditLogRow({ entity: 'inventory_item', entityId: item.id, action: previous ? 'UPDATE_ITEM' : 'CREATE_ITEM', actorId, reason: `${item.name}; reorder at ${item.reorderLevel} ${item.baseUnit}`, timestamp: now });
      await db.auditLogs.add(audit);
      await db.outbox.add(queueOutboxRow('audit_logs', 'INSERT', audit));
    });
  }

  async getInventoryBatches(itemId?: string): Promise<InventoryBatch[]> {
    const rows = itemId ? await db.inventoryBatches.where('itemId').equals(itemId).toArray() : await db.inventoryBatches.toArray();
    return rows.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  async getInventoryMovements(from?: string, to?: string): Promise<InventoryMovement[]> {
    const rows = from && to
      ? await db.inventoryMovements.where('businessDay').between(from, to, true, true).toArray()
      : await db.inventoryMovements.toArray();
    return rows.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  async receiveInventory(batch: InventoryBatch, movement: InventoryMovement, actorId: string): Promise<void> {
    const now = new Date().toISOString();
    const stampedBatch = { ...batch, updatedAt: now };
    const stampedMovement = { ...movement, updatedAt: now };
    await db.transaction('rw', db.inventoryBatches, db.inventoryMovements, db.outbox, db.auditLogs, async () => {
      await db.inventoryBatches.add(stampedBatch);
      await db.inventoryMovements.add(stampedMovement);
      await db.outbox.add(queueOutboxRow('inventory_batches', 'INSERT', stampedBatch));
      await db.outbox.add(queueOutboxRow('inventory_movements', 'INSERT', stampedMovement));
      const audit = auditLogRow({ entity: 'inventory', entityId: movement.id, action: movement.type === 'count_adjustment' ? 'COUNT_ADJUSTMENT' : 'RECEIVE_STOCK', actorId, reason: `${movement.itemName}: +${movement.quantityBase}`, timestamp: now });
      await db.auditLogs.add(audit);
      await db.outbox.add(queueOutboxRow('audit_logs', 'INSERT', audit));
    });
  }

  async issueInventory(movement: InventoryMovement, updatedBatches: InventoryBatch[], actorId: string): Promise<void> {
    const now = new Date().toISOString();
    const stampedMovement = { ...movement, updatedAt: now };
    await db.transaction('rw', db.inventoryBatches, db.inventoryMovements, db.outbox, db.auditLogs, async () => {
      for (const batch of updatedBatches) {
        const stamped = { ...batch, updatedAt: now };
        await db.inventoryBatches.put(stamped);
        await db.outbox.add(queueOutboxRow('inventory_batches', 'UPDATE', stamped));
      }
      await db.inventoryMovements.add(stampedMovement);
      await db.outbox.add(queueOutboxRow('inventory_movements', 'INSERT', stampedMovement));
      const audit = auditLogRow({ entity: 'inventory', entityId: movement.id, action: movement.type.toUpperCase(), actorId, reason: `${movement.itemName}: ${movement.quantityBase}. ${movement.note || ''}`, timestamp: now });
      await db.auditLogs.add(audit);
      await db.outbox.add(queueOutboxRow('audit_logs', 'INSERT', audit));
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
  async getPendingOutbox(limit = Number.POSITIVE_INFINITY): Promise<OutboxItem[]> {
    if (limit <= 0) return [];
    // A native due-time index skips any size of backed-off prefix in one read.
    // Healthy rows all have readyAt='', retaining their createdAt/id order.
    // Retries follow them and prepareOutboxRetry guards newer record versions.
    const rows = await db.outbox.where('[status+readyAt+createdAt+id]').between(
      ['pending', ''], ['pending', new Date().toISOString(), Dexie.maxKey], true, true
    ).limit(limit).toArray();
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /** A backed-off older snapshot must never overwrite a newer acknowledged edit. */
  async prepareOutboxRetry(item: OutboxItem, accountId: string): Promise<boolean> {
    if (item.retryCount === 0) return true;
    return db.transaction('rw', db.outbox, async () => {
      const query = item.payload.id
        ? db.outbox.where('[tableName+payload.id+status]').anyOf(
          ['pending', 'failed', 'synced'].map(status => [item.tableName, item.payload.id, status]))
        : db.outbox.where('[tableName+status]').anyOf(
          ['pending', 'failed', 'synced'].map(status => [item.tableName, status]));
      const versions = (await query.toArray()).filter(row => !row.payload.accountId || row.payload.accountId === accountId);
      const newer = versions.filter(row => row.createdAt > item.createdAt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!newer) return true;
      if (newer.status === 'synced') await db.outbox.update(item.id, { status: 'synced' });
      else await db.outbox.update(item.id, { nextAttemptAt: new Date(Date.now() + BASE_BACKOFF_MS).toISOString() });
      return false;
    });
  }

  /**
   * Everything still owed to the cloud, whether or not it is currently due for a retry.
   * This — not getPendingOutbox — is what the UI must report, so a row quietly sitting
   * out a 30-minute backoff can never be mistaken for "synced".
   */
  async countUnsyncedOutbox(includeDiagnostics = true): Promise<{
    total: number;
    stuck: number;
    topError?: { reason: string; count: number; sampled?: boolean };
  }> {
    const counts = await db.queueCounters.get('outbox');
    const total = (counts?.pending || 0) + (counts?.failed || 0);
    const stuck = counts?.stuck || 0;
    if (!includeDiagnostics || total === 0) return { total, stuck };
    // Diagnostics are a bounded sample; the queue totals remain exact.
    const rows = await db.outbox.where('[status+retryCount]').between(
      ['pending', 1], ['pending', Dexie.maxKey], true, true).limit(100).toArray();
    rows.push(...await db.outbox.where('status').equals('failed').limit(100).toArray());

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
      total,
      stuck,
      topError: top ? { reason: top[0], count: top[1], ...(rows.length >= 100 ? { sampled: true } : {}) } : undefined,
    };
  }

  async markOutboxSynced(id: string): Promise<void> {
    await db.outbox.update(id, { status: 'synced' });
  }

  async markOutboxSyncedMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await db.transaction('rw', db.outbox, async () => {
      // Exact keys avoid scanning other due records when batches span different
      // ready times. The transaction cache shares these before-images with counters.
      const rows = await db.outbox.bulkGet(ids);
      await db.outbox.bulkPut(rows.filter((row): row is OutboxItem => !!row)
        .map(row => ({ ...row, status: 'synced' as const,
          // Keep replay-order proof without retaining a second copy of the sale,
          // settings or login credentials after the cloud has acknowledged it.
          payload: { id: row.payload.id, accountId: row.payload.accountId } })));
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

  async markOutboxAttemptsFailedMany(items: OutboxItem[], reason: string): Promise<void> {
    await db.transaction('rw', db.outbox, async () => {
      const current = await db.outbox.bulkGet(items.map(item => item.id));
      const rows = current.filter((row): row is OutboxItem => !!row && row.status !== 'synced')
        .map(row => {
          const retryCount = row.retryCount + 1;
          const delay = Math.min(BASE_BACKOFF_MS * 2 ** Math.min(retryCount, 12), MAX_BACKOFF_MS);
          return { ...row, status: 'pending' as const, retryCount, lastError: reason,
            nextAttemptAt: new Date(Date.now() + delay).toISOString() };
        });
      await db.outbox.bulkPut(rows);
    });
  }

  /** A missing cloud column must not earn an ever-growing row retry delay. */
  async markOutboxSchemaBlockedMany(items: OutboxItem[], reason: string): Promise<void> {
    await db.transaction('rw', db.outbox, async () => {
      const current = await db.outbox.bulkGet(items.map(item => item.id));
      const nextAttemptAt = new Date(Date.now() + 30_000).toISOString();
      await db.outbox.bulkPut(current.filter((row): row is OutboxItem => !!row && row.status !== 'synced')
        .map(row => ({ ...row, status: 'pending' as const, retryCount: Math.max(1, row.retryCount),
          lastError: reason, nextAttemptAt })));
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
    // Keep newer acknowledged snapshots while older retries may still need them
    // as proof that their state has already been superseded.
    if ((await this.countUnsyncedOutbox(false)).total > 0) return 0;
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    let removed = 0;
    while (true) {
      const count = await db.transaction('rw', db.outbox, db.queueCounters, async () => {
        const counters = await db.queueCounters.get('outbox');
        if (counters && counters.pending + counters.failed > 0) return 0;
        const keys = await db.outbox.where('[status+createdAt]')
          .between(['synced', Dexie.minKey], ['synced', cutoff], true, false)
          .limit(200).primaryKeys();
        await db.outbox.bulkDelete(keys);
        return keys.length;
      });
      removed += count;
      if (count < 200) return removed;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  /**
   * Clears every backoff and resurrects rows parked as 'failed' by the previous build,
   * so a newly (re)established cloud session immediately retries everything this device
   * still owes the cloud rather than waiting out timers set while it was disconnected.
   * Returns how many rows were revived from the permanently-parked 'failed' state.
   */
  async revivePendingOutbox(): Promise<number> {
    let revived = 0;
    // Short transactions allow new ticket writes between maintenance chunks.
    for (const status of ['failed', 'pending'] as const) {
      while (true) {
        const changed = await db.transaction('rw', db.outbox, async () => {
          const query = status === 'failed'
            ? db.outbox.where('status').equals('failed')
            : db.outbox.where('[status+retryCount]').between(
                ['pending', 1], ['pending', Dexie.maxKey], true, true);
          const rows = await query.limit(200).toArray();
          await db.outbox.bulkPut(rows.map(row => ({ ...row, status: 'pending' as const,
            retryCount: 0, nextAttemptAt: undefined, lastError: undefined })));
          return rows.length;
        });
        if (status === 'failed') revived += changed;
        if (changed < 200) break;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    return revived;
  }

  /**
   * Queues rows the cloud is missing (see cloudBackfill.ts). Skips any row that already
   * has an entry in flight, so repeated sweeps can't pile up duplicate pushes.
   */
  async enqueueBackfill(tableName: string, payloads: Record<string, any>[]): Promise<number> {
    if (!payloads.length) return 0;
    let queued = 0;
    for (let offset = 0; offset < payloads.length; offset += 200) {
      const chunk = payloads.slice(offset, offset + 200);
      queued += await db.transaction('rw', db.outbox, async () => {
        const rows = await Promise.all(chunk.map(async payload => {
          const exists = await db.outbox.where('[tableName+payload.id+status]')
            .anyOf([[tableName, payload.id, 'pending'], [tableName, payload.id, 'failed']]).count();
          return exists ? null : queueOutboxRow(tableName, 'INSERT', payload);
        }));
        const additions = rows.filter((row): row is OutboxItem => row !== null);
        const unique = [...new Map(additions.map(row => [row.payload.id, row])).values()];
        await db.outbox.bulkAdd(unique);
        return unique.length;
      });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return queued;
  }
}

export const dbService = new IndexedDbService();
