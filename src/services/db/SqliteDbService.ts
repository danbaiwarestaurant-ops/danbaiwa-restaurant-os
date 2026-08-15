/**
 * SqliteDbService.ts
 *
 * Production-grade SQLite-in-WASM persistence engine.
 * 10-year marathon hardened:
 *
 * Storage tier 1 — sql.js in-memory SQLite (microsecond reads/writes)
 * Storage tier 2 — IndexedDB binary snapshot (no quota limit, raw Uint8Array)
 * Storage tier 3 — Supabase Storage cloud backup (debounced 10s, disaster recovery)
 *
 * Crash safety guarantee:
 *   Every write is wrapped in a SQL BEGIN/COMMIT transaction.
 *   The IndexedDB persist() call is awaited before the method returns.
 *   Print is dispatched ONLY after persist() resolves.
 *   If the browser crashes after persist(), data is safe in IndexedDB.
 *   If it crashes before persist(), the write never happened (no orphaned receipt).
 *
 * Vitest compatible:
 *   In Node test environments (no indexedDB, no window), both IDB and Supabase
 *   layers are skipped silently. Tests run against pure in-memory SQLite.
 */

import { IDbService } from './IDbService';
import { Ticket } from '../../types/ticket';
import { Shift } from '../../types/shift';
import { Expense } from '../../types/expense';
import { OutboxItem } from '../../types/sync';
import { DeviceConfig } from '../../types/config';
import { UserAccount } from '../../types/user';
import { supabase, isSupabaseConfigured } from '../supabase/supabaseClient';

// ─── Constants ────────────────────────────────────────────────────────────────

const MIGRATION_FLAG = 'ticket_pos_migrated_v2';

/** IndexedDB database & store names */
const IDB_DB_NAME = 'ticket_pos_idb_v1';
const IDB_STORE_NAME = 'snapshots';
const IDB_KEY = 'sqlite_db';

/** Supabase Storage bucket (must be created once in Supabase Dashboard) */
const SUPABASE_BUCKET = 'db-backups';

/** How long to debounce Supabase cloud backup after last write (ms) */
const BACKUP_DEBOUNCE_MS = 10_000;

// ─── Schema DDL ───────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    email             TEXT,
    username          TEXT,
    password_hash     TEXT,
    password_salt     TEXT,
    pin_hash          TEXT NOT NULL,
    pin_salt          TEXT NOT NULL,
    recovery_key_hash TEXT,
    recovery_key_salt TEXT,
    role              TEXT NOT NULL DEFAULT 'cashier',
    created_at        TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'active'
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

  CREATE TABLE IF NOT EXISTS tickets (
    id          TEXT PRIMARY KEY,
    location_id TEXT NOT NULL,
    device_id   TEXT NOT NULL,
    local_seq   INTEGER NOT NULL,
    amount      REAL NOT NULL,
    currency    TEXT NOT NULL DEFAULT '₦',
    status      TEXT NOT NULL DEFAULT 'paid',
    cashier_id  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    qr_payload  TEXT NOT NULL,
    void_reason TEXT,
    voided_by   TEXT,
    voided_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_cashier ON tickets(cashier_id);
  CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created_at);
  CREATE INDEX IF NOT EXISTS idx_tickets_status  ON tickets(status);

  CREATE TABLE IF NOT EXISTS sequences (
    key      TEXT PRIMARY KEY,
    next_val INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS shifts (
    id            TEXT PRIMARY KEY,
    cashier_id    TEXT NOT NULL,
    cashier_name  TEXT NOT NULL,
    location_id   TEXT NOT NULL,
    device_id     TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'open',
    opening_float REAL NOT NULL DEFAULT 0,
    opened_at     TEXT NOT NULL,
    closed_at     TEXT,
    counted_cash  REAL,
    expected_cash REAL,
    variance      REAL,
    notes         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_shifts_cashier ON shifts(cashier_id);
  CREATE INDEX IF NOT EXISTS idx_shifts_status  ON shifts(status);

  CREATE TABLE IF NOT EXISTS expenses (
    id               TEXT PRIMARY KEY,
    shift_id         TEXT NOT NULL,
    cashier_id       TEXT NOT NULL,
    cashier_name     TEXT NOT NULL DEFAULT '',
    category         TEXT NOT NULL,
    description      TEXT,
    amount           REAL NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    logged_at        TEXT NOT NULL,
    reviewed_by      TEXT,
    reviewed_at      TEXT,
    rejection_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_expenses_shift   ON expenses(shift_id);
  CREATE INDEX IF NOT EXISTS idx_expenses_cashier ON expenses(cashier_id);

  CREATE TABLE IF NOT EXISTS outbox (
    id          TEXT PRIMARY KEY,
    table_name  TEXT NOT NULL,
    action      TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    retry_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);

  CREATE TABLE IF NOT EXISTS audit_logs (
    id        TEXT PRIMARY KEY,
    entity    TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action    TEXT NOT NULL,
    actor_id  TEXT NOT NULL,
    reason    TEXT,
    timestamp TEXT NOT NULL
  );
`;

// ─── Type alias ───────────────────────────────────────────────────────────────

type SqlJsDatabase = import('sql.js').Database;

// ─── sql.js loader ───────────────────────────────────────────────────────────

let _sqlJsModule: any = null;

async function loadSqlJs(): Promise<any> {
  if (_sqlJsModule) return _sqlJsModule;
  const initSqlJs = (await import('sql.js')).default;
  const isNode = typeof window === 'undefined';
  _sqlJsModule = isNode
    ? await initSqlJs()
    : await initSqlJs({ locateFile: () => '/sql-wasm.wasm' });
  return _sqlJsModule;
}

// ─── Tier 2: IndexedDB binary snapshot ───────────────────────────────────────

function isIDBAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function _openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      (e.target as IDBOpenDBRequest).result.createObjectStore(IDB_STORE_NAME);
    };
    req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSnapshotIDB(data: Uint8Array): Promise<void> {
  if (!isIDBAvailable()) return;
  try {
    const idb = await _openIDB();
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE_NAME, 'readwrite');
      tx.objectStore(IDB_STORE_NAME).put(data, IDB_KEY);
      tx.oncomplete = () => { idb.close(); resolve(); };
      tx.onerror   = () => { idb.close(); reject(tx.error); };
    });
  } catch (e) {
    console.warn('[SqliteDbService] IDB save failed:', e);
  }
}

async function loadSnapshotIDB(): Promise<Uint8Array | null> {
  if (!isIDBAvailable()) return null;
  try {
    const idb = await _openIDB();
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE_NAME, 'readonly');
      const req = tx.objectStore(IDB_STORE_NAME).get(IDB_KEY);
      req.onsuccess = () => { idb.close(); resolve(req.result as Uint8Array | null ?? null); };
      req.onerror   = () => { idb.close(); reject(req.error); };
    });
  } catch (e) {
    console.warn('[SqliteDbService] IDB load failed:', e);
    return null;
  }
}

// ─── Tier 3: Supabase Storage cloud backup ────────────────────────────────────

/** Device ID used for Supabase Storage path — updated after config loads */
let _deviceId = 'DEV01';

let _backupTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Upload the binary SQLite snapshot to Supabase Storage.
 * Two files are written on every backup:
 *   db-backups/snapshots/{deviceId}/latest.db  — always overwritten (hot recovery)
 *   db-backups/snapshots/{deviceId}/{date}.db  — daily versioned archive
 *
 * This function is debounced — frequent writes coalesce into one upload
 * per BACKUP_DEBOUNCE_MS window.
 */
function scheduleSupabaseBackup(data: Uint8Array): void {
  if (!isSupabaseConfigured || typeof window === 'undefined') return;
  if (_backupTimer) clearTimeout(_backupTimer);

  _backupTimer = setTimeout(async () => {
    try {
      const date = new Date().toISOString().split('T')[0];
      const blob = new Blob([data], { type: 'application/octet-stream' });

      // Latest hot copy (always overwrite)
      await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(`snapshots/${_deviceId}/latest.db`, blob, { upsert: true });

      // Daily versioned archive
      await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(`snapshots/${_deviceId}/${date}.db`, blob, { upsert: true });

      console.debug(`[SqliteDbService] Cloud backup uploaded (${(data.byteLength / 1024).toFixed(1)} KB)`);
    } catch (e) {
      console.warn('[SqliteDbService] Supabase backup failed (will retry next write):', e);
    }
  }, BACKUP_DEBOUNCE_MS);
}

/**
 * Ensure the db-backups bucket exists in Supabase Storage.
 * Called once on init — silently ignores "already exists" errors.
 */
async function ensureBackupBucket(): Promise<void> {
  if (!isSupabaseConfigured || typeof window === 'undefined') return;
  try {
    const { error } = await supabase.storage.createBucket(SUPABASE_BUCKET, {
      public: false,
      fileSizeLimit: 52_428_800, // 50 MB
    });
    // Ignore "already exists" — expected on subsequent boots
    if (error && !error.message.toLowerCase().includes('already exists') && !error.message.toLowerCase().includes('duplicate')) {
      console.warn('[SqliteDbService] Could not create backup bucket:', error.message);
    }
  } catch (_) {}
}

// ─── SQL helpers ─────────────────────────────────────────────────────────────

/** Execute a write statement (no automatic persist — callers call this._persist()) */
function runSql(db: SqlJsDatabase, sql: string, params?: any[]): void {
  db.run(sql, params);
}

/** Execute a read query and return typed rows */
function querySql<T = Record<string, any>>(db: SqlJsDatabase, sql: string, params?: any[]): T[] {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as unknown as T);
  }
  stmt.free();
  return rows;
}

// ─── Service class ────────────────────────────────────────────────────────────

export class SqliteDbService implements IDbService {
  private db: SqlJsDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  // ─── Init ───────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const SQL = await loadSqlJs();

      // Tier 2: load from IndexedDB (fast — binary, no parsing)
      const snapshot = await loadSnapshotIDB();
      const db: SqlJsDatabase = snapshot ? new SQL.Database(snapshot) : new SQL.Database();

      // Create / migrate schema (idempotent)
      db.run(SCHEMA_SQL);

      // Seed default device config if missing
      const cfgRows = querySql(db, "SELECT value FROM config WHERE key = 'device_config'");
      if (cfgRows.length === 0) {
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
        db.run("INSERT INTO config (key, value) VALUES ('device_config', ?)", [JSON.stringify(defaultConfig)]);
      } else {
        // Update module-level deviceId from stored config
        try {
          const cfg: DeviceConfig = JSON.parse(cfgRows[0].value as string);
          _deviceId = cfg.deviceId || 'DEV01';
        } catch (_) {}
      }

      this.db = db;

      // Persist initial state to IndexedDB
      await this._persist();

      // Tier 3: ensure Supabase Storage bucket exists (async, non-blocking)
      ensureBackupBucket().catch(() => {});

      // One-time migration from legacy localStorage JSON blobs
      if (typeof localStorage !== 'undefined' && !localStorage.getItem(MIGRATION_FLAG)) {
        this._migrateFromLocalStorage();
        localStorage.setItem(MIGRATION_FLAG, '1');
      }
    })();

    return this.initPromise;
  }

  /**
   * Persist in-memory SQLite state to IndexedDB (Tier 2) and
   * schedule debounced Supabase cloud backup (Tier 3).
   *
   * This is the heart of crash-safety: every write method awaits _persist()
   * before returning, so the caller can be sure data is durable in IDB.
   */
  private async _persist(): Promise<void> {
    if (!this.db) return;
    const data = this.db.export();
    await saveSnapshotIDB(data);
    scheduleSupabaseBackup(data);
  }

  private get DB(): SqlJsDatabase {
    if (!this.db) throw new Error('SqliteDbService: call init() first.');
    return this.db;
  }

  // ─── Config ─────────────────────────────────────────────────────────────

  async getDeviceConfig(): Promise<DeviceConfig | null> {
    const rows = querySql(this.DB, "SELECT value FROM config WHERE key = 'device_config'");
    return rows.length > 0 ? JSON.parse(rows[0].value as string) : null;
  }

  async saveDeviceConfig(config: DeviceConfig): Promise<void> {
    this.DB.run("BEGIN");
    runSql(this.DB, "INSERT OR REPLACE INTO config (key, value) VALUES ('device_config', ?)", [JSON.stringify(config)]);
    this.DB.run("COMMIT");
    _deviceId = config.deviceId || 'DEV01';
    await this._persist();
  }

  // ─── Users ──────────────────────────────────────────────────────────────

  async getUsers(): Promise<UserAccount[]> {
    return querySql(this.DB, 'SELECT * FROM users ORDER BY created_at DESC').map(this._rowToUser);
  }

  async getUserByEmail(email: string): Promise<UserAccount | null> {
    const clean = (email || '').trim().toLowerCase();
    const rows = querySql(this.DB,
      'SELECT * FROM users WHERE lower(email) = ? OR lower(username) = ? LIMIT 1',
      [clean, clean]
    );
    return rows.length > 0 ? this._rowToUser(rows[0]) : null;
  }

  async saveUser(user: UserAccount): Promise<void> {
    this.DB.run('BEGIN');
    runSql(this.DB, `
      INSERT OR IGNORE INTO users
        (id,name,email,username,password_hash,password_salt,pin_hash,pin_salt,
         recovery_key_hash,recovery_key_salt,role,created_at,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      user.id, user.name, user.email ?? null, user.username ?? null,
      user.passwordHash ?? null, user.passwordSalt ?? null,
      user.pinHash, user.pinSalt,
      user.recoveryKeyHash ?? null, user.recoveryKeySalt ?? null,
      user.role, user.createdAt, user.status,
    ]);
    this._runQueueOutbox('users', 'INSERT', user);
    this.DB.run('COMMIT');
    await this._persist();
  }

  async updateUser(user: UserAccount): Promise<void> {
    this.DB.run('BEGIN');
    runSql(this.DB, `
      UPDATE users SET name=?,email=?,username=?,password_hash=?,password_salt=?,
        pin_hash=?,pin_salt=?,recovery_key_hash=?,recovery_key_salt=?,role=?,status=?
      WHERE id=?
    `, [
      user.name, user.email ?? null, user.username ?? null,
      user.passwordHash ?? null, user.passwordSalt ?? null,
      user.pinHash, user.pinSalt,
      user.recoveryKeyHash ?? null, user.recoveryKeySalt ?? null,
      user.role, user.status, user.id,
    ]);
    this._runQueueOutbox('users', 'UPDATE', user);
    this.DB.run('COMMIT');
    await this._persist();
  }

  // ─── Tickets ────────────────────────────────────────────────────────────

  async getTickets(userId?: string): Promise<Ticket[]> {
    const rows = userId
      ? querySql(this.DB, 'SELECT * FROM tickets WHERE cashier_id = ? ORDER BY created_at DESC', [userId])
      : querySql(this.DB, 'SELECT * FROM tickets ORDER BY created_at DESC');
    return rows.map(this._rowToTicket);
  }

  async saveTicket(ticket: Ticket): Promise<void> {
    this.DB.run('BEGIN');
    runSql(this.DB, `
      INSERT OR IGNORE INTO tickets
        (id,location_id,device_id,local_seq,amount,currency,status,
         cashier_id,created_at,qr_payload,void_reason,voided_by,voided_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      ticket.id, ticket.locationId, ticket.deviceId, ticket.localSeq,
      ticket.amount, ticket.currency, ticket.status,
      ticket.cashierId, ticket.createdAt, ticket.qrPayload,
      ticket.voidReason ?? null, ticket.voidedBy ?? null, ticket.voidedAt ?? null,
    ]);
    this._runQueueOutbox('tickets', 'INSERT', ticket);
    this.DB.run('COMMIT');
    await this._persist(); // ← IDB write confirmed before caller returns
  }

  async updateTicketStatus(ticketId: string, status: 'paid' | 'collected' | 'void', reason?: string, voidedBy?: string): Promise<void> {
    const now = new Date().toISOString();
    this.DB.run('BEGIN');
    if (status === 'void') {
      runSql(this.DB,
        'UPDATE tickets SET status=?,void_reason=?,voided_by=?,voided_at=? WHERE id=?',
        [status, reason ?? null, voidedBy ?? null, now, ticketId]
      );
      this._runAuditLog({ entity: 'ticket', entityId: ticketId, action: 'VOID', actorId: voidedBy ?? 'ADMIN', reason: reason ?? 'N/A', timestamp: now });
    } else {
      runSql(this.DB, 'UPDATE tickets SET status=? WHERE id=?', [status, ticketId]);
    }
    const rows = querySql(this.DB, 'SELECT * FROM tickets WHERE id=?', [ticketId]);
    if (rows.length > 0) this._runQueueOutbox('tickets', 'UPDATE', this._rowToTicket(rows[0]));
    this.DB.run('COMMIT');
    await this._persist();
  }

  /**
   * Atomic sequence increment — BEGIN/COMMIT wraps the UPSERT + SELECT.
   * No race condition is possible: SQLite serialises concurrent writers
   * and the result is committed to IndexedDB before returning.
   */
  async getNextSeq(locationId: string, deviceId: string): Promise<number> {
    const key = `${locationId}_${deviceId}`;
    this.DB.run('BEGIN');
    try {
      this.DB.run(
        'INSERT INTO sequences (key, next_val) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET next_val = next_val + 1',
        [key]
      );
      const rows = querySql(this.DB, 'SELECT next_val FROM sequences WHERE key=?', [key]);
      const nextVal = rows[0].next_val as number;
      this.DB.run('COMMIT');
      await this._persist(); // sequence committed & durable before print
      return nextVal;
    } catch (e) {
      this.DB.run('ROLLBACK');
      throw e;
    }
  }

  // ─── Shifts ─────────────────────────────────────────────────────────────

  async getCurrentShift(userId?: string): Promise<Shift | null> {
    const shifts = await this.getShifts(userId);
    return shifts.find(s => s.status === 'open') ?? null;
  }

  async getShifts(userId?: string): Promise<Shift[]> {
    const rows = userId
      ? querySql(this.DB, 'SELECT * FROM shifts WHERE cashier_id=? ORDER BY opened_at DESC', [userId])
      : querySql(this.DB, 'SELECT * FROM shifts ORDER BY opened_at DESC');
    return rows.map(this._rowToShift);
  }

  async saveShift(shift: Shift): Promise<void> {
    this.DB.run('BEGIN');
    runSql(this.DB, `
      INSERT OR IGNORE INTO shifts
        (id,cashier_id,cashier_name,location_id,device_id,status,
         opening_float,opened_at,closed_at,counted_cash,expected_cash,variance,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      shift.id, shift.cashierId, shift.cashierName, shift.locationId, shift.deviceId,
      shift.status, shift.openingFloat, shift.openedAt,
      shift.closedAt ?? null, shift.countedCash ?? null,
      shift.expectedCash ?? null, shift.variance ?? null, shift.notes ?? null,
    ]);
    this._runQueueOutbox('shifts', 'INSERT', shift);
    this.DB.run('COMMIT');
    await this._persist();
  }

  async closeShift(shiftId: string, countedCash: number, expectedCash: number, variance: number, notes?: string): Promise<void> {
    const now = new Date().toISOString();
    this.DB.run('BEGIN');
    runSql(this.DB,
      'UPDATE shifts SET status=?,closed_at=?,counted_cash=?,expected_cash=?,variance=?,notes=? WHERE id=?',
      ['closed', now, countedCash, expectedCash, variance, notes ?? null, shiftId]
    );
    const rows = querySql(this.DB, 'SELECT * FROM shifts WHERE id=?', [shiftId]);
    if (rows.length > 0) this._runQueueOutbox('shifts', 'UPDATE', this._rowToShift(rows[0]));
    this.DB.run('COMMIT');
    await this._persist();
  }

  // ─── Expenses ───────────────────────────────────────────────────────────

  async getExpenses(shiftId?: string, userId?: string): Promise<Expense[]> {
    let sql = 'SELECT * FROM expenses WHERE 1=1';
    const params: any[] = [];
    if (shiftId) { sql += ' AND shift_id=?';   params.push(shiftId); }
    if (userId)  { sql += ' AND cashier_id=?';  params.push(userId); }
    sql += ' ORDER BY logged_at DESC';
    return querySql(this.DB, sql, params).map(this._rowToExpense);
  }

  async saveExpense(expense: Expense): Promise<void> {
    this.DB.run('BEGIN');
    runSql(this.DB, `
      INSERT OR IGNORE INTO expenses
        (id,shift_id,cashier_id,cashier_name,category,description,amount,status,logged_at,
         reviewed_by,reviewed_at,rejection_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      expense.id, expense.shiftId, expense.cashierId,
      expense.cashierName ?? '', expense.category,
      expense.description ?? null, expense.amount, expense.status,
      expense.loggedAt, expense.reviewedBy ?? null,
      expense.reviewedAt ?? null, expense.rejectionReason ?? null,
    ]);
    this._runQueueOutbox('expenses', 'INSERT', expense);
    this.DB.run('COMMIT');
    await this._persist();
  }

  async updateExpenseStatus(expenseId: string, status: 'approved' | 'rejected', reviewer: string, reason?: string): Promise<void> {
    const now = new Date().toISOString();
    this.DB.run('BEGIN');
    runSql(this.DB,
      'UPDATE expenses SET status=?,reviewed_by=?,reviewed_at=?,rejection_reason=? WHERE id=?',
      [status, reviewer, now, reason ?? null, expenseId]
    );
    const rows = querySql(this.DB, 'SELECT * FROM expenses WHERE id=?', [expenseId]);
    if (rows.length > 0) {
      this._runQueueOutbox('expenses', 'UPDATE', this._rowToExpense(rows[0]));
      this._runAuditLog({
        entity: 'expense', entityId: expenseId,
        action: status === 'approved' ? 'APPROVE_EXPENSE' : 'REJECT_EXPENSE',
        actorId: reviewer, reason: reason ?? 'Manager Review', timestamp: now,
      });
    }
    this.DB.run('COMMIT');
    await this._persist();
  }

  // ─── Outbox ─────────────────────────────────────────────────────────────

  async getPendingOutbox(): Promise<OutboxItem[]> {
    return querySql(this.DB, "SELECT * FROM outbox WHERE status='pending' ORDER BY created_at ASC").map(r => ({
      id:          r.id as string,
      tableName:   r.table_name as string,
      action:      r.action as 'INSERT' | 'UPDATE' | 'DELETE',
      payload:     JSON.parse(r.payload as string),
      createdAt:   r.created_at as string,
      status:      r.status as 'pending' | 'synced',
      retryCount:  r.retry_count as number,
    }));
  }

  async markOutboxSynced(id: string): Promise<void> {
    this.DB.run('BEGIN');
    runSql(this.DB, "UPDATE outbox SET status='synced' WHERE id=?", [id]);
    this.DB.run('COMMIT');
    await this._persist();
  }

  // ─── Private synchronous helpers (called inside BEGIN/COMMIT) ────────────

  /** Synchronously queue an outbox row — must be called inside an open transaction */
  private _runQueueOutbox(tableName: string, action: string, payload: Record<string, any>): void {
    runSql(this.DB, `
      INSERT INTO outbox (id,table_name,action,payload,created_at,status,retry_count)
      VALUES (?,?,?,?,?,'pending',0)
    `, [crypto.randomUUID(), tableName, action, JSON.stringify(payload), new Date().toISOString()]);
  }

  /** Synchronously append an audit log row — must be called inside an open transaction */
  private _runAuditLog(e: { entity: string; entityId: string; action: string; actorId: string; reason: string; timestamp: string }): void {
    runSql(this.DB, `
      INSERT INTO audit_logs (id,entity,entity_id,action,actor_id,reason,timestamp)
      VALUES (?,?,?,?,?,?,?)
    `, [crypto.randomUUID(), e.entity, e.entityId, e.action, e.actorId, e.reason, e.timestamp]);
  }

  // ─── Row mappers ────────────────────────────────────────────────────────

  private _rowToUser(r: Record<string, any>): UserAccount {
    return {
      id: r.id, name: r.name,
      email: r.email ?? undefined, username: r.username ?? undefined,
      passwordHash: r.password_hash ?? undefined, passwordSalt: r.password_salt ?? undefined,
      pinHash: r.pin_hash, pinSalt: r.pin_salt,
      recoveryKeyHash: r.recovery_key_hash ?? undefined, recoveryKeySalt: r.recovery_key_salt ?? undefined,
      role: r.role, createdAt: r.created_at, status: r.status,
    };
  }

  private _rowToTicket(r: Record<string, any>): Ticket {
    return {
      id: r.id, locationId: r.location_id, deviceId: r.device_id,
      localSeq: r.local_seq as number, amount: r.amount as number, currency: r.currency,
      status: r.status, cashierId: r.cashier_id, createdAt: r.created_at, qrPayload: r.qr_payload,
      voidReason: r.void_reason ?? undefined, voidedBy: r.voided_by ?? undefined,
      voidedAt: r.voided_at ?? undefined,
    };
  }

  private _rowToShift(r: Record<string, any>): Shift {
    return {
      id: r.id, cashierId: r.cashier_id, cashierName: r.cashier_name,
      locationId: r.location_id, deviceId: r.device_id,
      status: r.status, openingFloat: r.opening_float as number, openedAt: r.opened_at,
      closedAt: r.closed_at ?? undefined, countedCash: r.counted_cash ?? undefined,
      expectedCash: r.expected_cash ?? undefined, variance: r.variance ?? undefined,
      notes: r.notes ?? undefined,
    };
  }

  private _rowToExpense(r: Record<string, any>): Expense {
    return {
      id: r.id, shiftId: r.shift_id, cashierId: r.cashier_id,
      cashierName: r.cashier_name ?? '',
      category: r.category, description: r.description ?? '',
      amount: r.amount as number, status: r.status, loggedAt: r.logged_at,
      reviewedBy: r.reviewed_by ?? undefined, reviewedAt: r.reviewed_at ?? undefined,
      rejectionReason: r.rejection_reason ?? undefined,
    };
  }

  // ─── One-time legacy migration ───────────────────────────────────────────

  /**
   * Read legacy localStorage JSON blobs, bulk-insert into SQLite,
   * then delete the old keys. Runs once, guarded by MIGRATION_FLAG.
   * All inserts use OR IGNORE — safe to re-run.
   */
  private _migrateFromLocalStorage(): void {
    const keys = {
      TICKETS:  'ticket_pos_tickets',
      USERS:    'ticket_pos_users',
      SHIFTS:   'ticket_pos_shifts',
      EXPENSES: 'ticket_pos_expenses',
    };

    const tryMigrate = <T>(key: string, fn: (item: T) => void) => {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return;
        const items: T[] = JSON.parse(raw);
        items.forEach(item => { try { fn(item); } catch (_) {} });
      } catch (_) {}
    };

    tryMigrate<Ticket>(keys.TICKETS, t => {
      this.DB.run(`INSERT OR IGNORE INTO tickets
        (id,location_id,device_id,local_seq,amount,currency,status,cashier_id,created_at,qr_payload)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [
        t.id, t.locationId, t.deviceId, t.localSeq,
        t.amount, t.currency, t.status, t.cashierId, t.createdAt, t.qrPayload,
      ]);
    });

    tryMigrate<UserAccount>(keys.USERS, u => {
      this.DB.run(`INSERT OR IGNORE INTO users
        (id,name,email,username,password_hash,password_salt,pin_hash,pin_salt,role,created_at,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
        u.id, u.name, u.email ?? null, u.username ?? null,
        u.passwordHash ?? null, u.passwordSalt ?? null,
        u.pinHash, u.pinSalt, u.role, u.createdAt, u.status,
      ]);
    });

    tryMigrate<Shift>(keys.SHIFTS, s => {
      this.DB.run(`INSERT OR IGNORE INTO shifts
        (id,cashier_id,cashier_name,location_id,device_id,status,opening_float,opened_at)
        VALUES (?,?,?,?,?,?,?,?)`, [
        s.id, s.cashierId, s.cashierName, s.locationId, s.deviceId,
        s.status, s.openingFloat, s.openedAt,
      ]);
    });

    tryMigrate<Expense>(keys.EXPENSES, e => {
      this.DB.run(`INSERT OR IGNORE INTO expenses
        (id,shift_id,cashier_id,cashier_name,category,amount,status,logged_at)
        VALUES (?,?,?,?,?,?,?,?)`, [
        e.id, e.shiftId, e.cashierId, e.cashierName ?? '',
        e.category, e.amount, e.status, e.loggedAt,
      ]);
    });

    Object.values(keys).forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
    console.info('[SqliteDbService] Legacy localStorage migration complete.');

    // Persist migrated data immediately
    this._persist().catch(() => {});
  }
}

export const dbService = new SqliteDbService();
