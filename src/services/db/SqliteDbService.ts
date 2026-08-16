/**
 * SqliteDbService.ts
 *
 * Production-grade SQLite-in-WASM database service.
 * Hardened for a 10-year marathon:
 *
 * 1. Tier 1 (In-Memory execution): sql.js (microseconds reads/writes)
 * 2. Tier 2 (Durability / WAL Journal): Writes only transaction queries to IndexedDB 'journal' store
 *    (O(1) write latency, crash-safe, awaited before print)
 * 3. Tier 2 (Baseline Snapshot): Debounced full db.export() to IndexedDB 'snapshots' store
 *    (every 10s on mutation, cleans up journal)
 * 4. Tier 3 (Cloud Disaster Recovery): Debounced db.export() upload to Supabase Storage
 *    (latest.db + daily snapshots)
 *
 * Crash-safe guarantee:
 * - Mutating statements are executed on in-memory SQLite and pushed to a pending transaction buffer.
 * - Calling await _persist() appends the transaction statements as a single journal entry to IndexedDB.
 * - Re-loading DB reads the last baseline snapshot and replays any pending journal entries in order.
 * - Vitest fallback: Node test environments bypass IndexedDB/Storage and run pure in-memory SQLite.
 */

import { IDbService } from './IDbService';
import { Ticket } from '../../types/ticket';
import { Shift } from '../../types/shift';
import { Expense } from '../../types/expense';
import { OutboxItem } from '../../types/sync';
import { DeviceConfig } from '../../types/config';
import { UserAccount } from '../../types/user';
import { supabase, isSupabaseConfigured } from '../supabase/supabaseClient';
import {
  SNAPSHOT_ROOT,
  LATEST_FILE,
  SnapshotCandidate,
  candidateLocationDirs,
  isSnapshotFile,
  pickNewestSnapshot,
  snapshotDir,
  snapshotTimestamp,
} from '../../utils/backupPaths';

const MIGRATION_FLAG = 'ticket_pos_migrated_v3';

/** IndexedDB DB & Store Configuration */
const IDB_DB_NAME = 'ticket_pos_idb_v2';
const IDB_SNAPSHOT_STORE = 'snapshots';
const IDB_JOURNAL_STORE = 'journal';
const IDB_KEY = 'sqlite_db';

/** Supabase Storage Configuration */
const SUPABASE_BUCKET = 'db-backups';
const BACKUP_DEBOUNCE_MS = 10_000;

// DDL — Schema definitions for SQLite tables
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

type SqlJsDatabase = import('sql.js').Database;

let _sqlJsModule: any = null;

async function loadSqlJs(): Promise<any> {
  if (_sqlJsModule) return _sqlJsModule;
  const sqlModule = await import('sql.js');
  
  // Resolve wrapper differences across Vite bundles vs Node environment
  const initSqlJs = (typeof sqlModule === 'function' ? sqlModule : null) ||
                    (sqlModule as any).default ||
                    (sqlModule as any).initSqlJs ||
                    sqlModule;

  if (typeof initSqlJs !== 'function') {
    throw new Error('SqliteDbService: initSqlJs is not a function. Resolved module contents: ' + Object.keys(sqlModule).join(', '));
  }

  const isNode = typeof window === 'undefined';
  _sqlJsModule = isNode
    ? await initSqlJs()
    : await initSqlJs({ locateFile: () => '/sql-wasm.wasm' });
  return _sqlJsModule;
}

// ─── Tier 2: IndexedDB WAL and Snapshot helper ──────────────────────────────

function isIDBAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function _openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(IDB_SNAPSHOT_STORE)) {
        db.createObjectStore(IDB_SNAPSHOT_STORE);
      }
      if (!db.objectStoreNames.contains(IDB_JOURNAL_STORE)) {
        db.createObjectStore(IDB_JOURNAL_STORE, { autoIncrement: true });
      }
    };
    req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror = () => reject(req.error);
  });
}

/** Load the baseline binary snapshot from IndexedDB */
async function loadSnapshotIDB(): Promise<Uint8Array | null> {
  if (!isIDBAvailable()) return null;
  try {
    const idb = await _openIDB();
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = idb.transaction(IDB_SNAPSHOT_STORE, 'readonly');
      const req = tx.objectStore(IDB_SNAPSHOT_STORE).get(IDB_KEY);
      req.onsuccess = () => { idb.close(); resolve(req.result as Uint8Array | null ?? null); };
      req.onerror   = () => { idb.close(); reject(tx.error || req.error); };
    });
  } catch (e) {
    console.warn('[SqliteDbService] IDB baseline snapshot load failed:', e);
    return null;
  }
}

/** Appends a transaction containing pending statements to the WAL journal */
async function appendJournalIDB(statements: Array<{ sql: string; params?: any[] }>): Promise<number> {
  if (!isIDBAvailable() || statements.length === 0) return 0;
  const idb = await _openIDB();
  return await new Promise<number>((resolve, reject) => {
    const tx = idb.transaction(IDB_JOURNAL_STORE, 'readwrite');
    const store = tx.objectStore(IDB_JOURNAL_STORE);
    const req = store.add(statements); // Appends the array as a single atomic entry
    req.onsuccess = () => { idb.close(); resolve(req.result as number); };
    req.onerror   = () => { idb.close(); reject(tx.error || req.error); };
  });
}

/** Reads all pending journal entries from the WAL */
async function loadJournalIDB(): Promise<Array<{ id: number; statements: Array<{ sql: string; params?: any[] }> }>> {
  if (!isIDBAvailable()) return [];
  const idb = await _openIDB();
  return await new Promise<any>((resolve, reject) => {
    const tx = idb.transaction(IDB_JOURNAL_STORE, 'readonly');
    const store = tx.objectStore(IDB_JOURNAL_STORE);
    const entries: any[] = [];
    store.openCursor().onsuccess = (event: any) => {
      const cursor = event.target.result;
      if (cursor) {
        entries.push({ id: cursor.key, statements: cursor.value });
        cursor.continue();
      } else {
        idb.close();
        resolve(entries);
      }
    };
    tx.onerror = () => { idb.close(); reject(tx.error); };
  });
}

/** Deletes journal entries up to a specific auto-increment key id */
async function deleteJournalIDBUpTo(maxId: number): Promise<void> {
  if (!isIDBAvailable() || maxId <= 0) return;
  const idb = await _openIDB();
  return await new Promise<void>((resolve, reject) => {
    const tx = idb.transaction(IDB_JOURNAL_STORE, 'readwrite');
    const store = tx.objectStore(IDB_JOURNAL_STORE);
    
    // Iterate keys and delete all that are <= maxId
    store.openKeyCursor().onsuccess = (event: any) => {
      const cursor = event.target.result;
      if (cursor) {
        const key = cursor.key as number;
        if (key <= maxId) {
          store.delete(key);
          cursor.continue();
        } else {
          idb.close();
          resolve();
        }
      } else {
        idb.close();
        resolve();
      }
    };
    tx.onerror = () => { idb.close(); reject(tx.error); };
  });
}

/** Clear all journal entries from the WAL store */
async function clearJournalIDB(): Promise<void> {
  if (!isIDBAvailable()) return;
  const idb = await _openIDB();
  return await new Promise<void>((resolve, reject) => {
    const tx = idb.transaction(IDB_JOURNAL_STORE, 'readwrite');
    tx.objectStore(IDB_JOURNAL_STORE).clear();
    tx.oncomplete = () => { idb.close(); resolve(); };
    tx.onerror    = () => { idb.close(); reject(tx.error); };
  });
}

// ─── Tier 3: Supabase Storage Backup configuration ─────────────────────────

let _deviceId = 'DEV01';
let _locationId = 'LOC01';
let _backupTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The location a snapshot belongs to is a property of the ACCOUNT, not of the machine
 * holding it. A freshly installed till has never been configured, so its local device
 * config still reads the seeded default — asking the signed-in cloud session which
 * location this account belongs to is the only way that machine can find snapshots
 * written by the till it is replacing.
 *
 * Deliberately uncached: it is only read during a restore attempt, and caching it
 * would pin the first account of the session onto every later sign-in.
 */
async function resolveCloudLocationId(): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data } = await supabase.auth.getUser();
    const meta = (data?.user?.user_metadata ?? {}) as Record<string, unknown>;
    const loc = typeof meta.location_id === 'string' ? meta.location_id.trim() : '';
    return loc || null;
  } catch (_) {
    // Offline or no session — fall back to the locally configured location.
    return null;
  }
}

/**
 * Where THIS machine writes its snapshots. Writes stay keyed to the locally configured
 * location (that is the operational truth of which outlet this till serves); discovery
 * is what widens — see findNewestCloudSnapshot().
 */
function backupPrefix(): string {
  return snapshotDir(_locationId, _deviceId);
}

function scheduleSupabaseBackup(data: Uint8Array): void {
  if (!isSupabaseConfigured || typeof window === 'undefined') return;
  if (_backupTimer) clearTimeout(_backupTimer);

  _backupTimer = setTimeout(async () => {
    try {
      const date = new Date().toISOString().split('T')[0];
      const blob = new Blob([data], { type: 'application/octet-stream' });

      // Overwrite latest hot snapshot
      const latestResult = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(`${backupPrefix()}/${LATEST_FILE}`, blob, { upsert: true });

      // Daily versioned snapshot
      const dailyResult = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(`${backupPrefix()}/${date}.db`, blob, { upsert: true });

      // supabase-js resolves (rather than throws) on a rejected upload, so this must
      // be checked explicitly — otherwise a silently-blocked backup (missing bucket,
      // RLS policy, no session) gets logged as a false-positive success.
      if (latestResult.error || dailyResult.error) {
        throw new Error(latestResult.error?.message || dailyResult.error?.message);
      }

      console.info(`[SqliteDbService] Cloud backup sync complete (${(data.byteLength / 1024).toFixed(1)} KB)`);
    } catch (e) {
      console.warn('[SqliteDbService] Cloud backup failed (will retry on next snapshot):', e);
    }
  }, BACKUP_DEBOUNCE_MS);
}

async function ensureBackupBucket(): Promise<void> {
  if (!isSupabaseConfigured || typeof window === 'undefined') return;
  try {
    const { error } = await supabase.storage.createBucket(SUPABASE_BUCKET, {
      public: false,
      fileSizeLimit: 52_428_800, // 50MB
    });
    if (error && !error.message.toLowerCase().includes('already exists') && !error.message.toLowerCase().includes('duplicate')) {
      console.warn('[SqliteDbService] Backup bucket creation notice:', error.message);
    }
  } catch (_) {}
}

// ─── Cloud snapshot discovery ──────────────────────────────────────────────

/** Lists one storage folder. Throws with the real Supabase message so a blocked
 *  listing (missing bucket, RLS) is never mistaken for "no backup exists". */
async function listStorageDir(prefix: string): Promise<Array<Record<string, any>>> {
  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .list(prefix, { limit: 1000, sortBy: { column: 'updated_at', order: 'desc' } });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Newest snapshot beneath a location folder, across every device that ever backed up
 * there. Any *.db file counts — not just latest.db — so a till whose hot snapshot
 * upload failed can still be recovered from its last daily copy.
 */
async function newestSnapshotUnder(locationPrefix: string): Promise<SnapshotCandidate | null> {
  const entries = await listStorageDir(locationPrefix);
  const found: SnapshotCandidate[] = [];

  for (const entry of entries) {
    const name: string = entry.name;
    if (!name) continue;

    if (isSnapshotFile(name)) {
      // A snapshot written straight into the location folder (no device segment).
      found.push({ path: `${locationPrefix}/${name}`, updatedAt: snapshotTimestamp(entry) });
      continue;
    }

    // Otherwise it is a device folder — descend one level.
    const files = await listStorageDir(`${locationPrefix}/${name}`);
    for (const file of files) {
      if (!isSnapshotFile(file.name)) continue;
      found.push({
        path: `${locationPrefix}/${name}/${file.name}`,
        updatedAt: snapshotTimestamp(file),
      });
    }
  }

  return pickNewestSnapshot(found);
}

/**
 * Finds the snapshot a restoring machine should pull, widening the search until
 * something turns up:
 *   1. the location on the signed-in cloud account,
 *   2. the location configured on this machine,
 *   3. every location in the bucket.
 *
 * Step 3 is what makes a brand-new machine work at all: it has never been configured,
 * so its local location is still the seeded default and would otherwise only ever look
 * in the wrong folder.
 */
async function findNewestCloudSnapshot(): Promise<{ candidate: SnapshotCandidate | null; reason?: string }> {
  const cloudLocation = await resolveCloudLocationId();
  const preferred = candidateLocationDirs(cloudLocation, _locationId);

  try {
    for (const dir of preferred) {
      const hit = await newestSnapshotUnder(dir);
      if (hit) return { candidate: hit };
    }

    // Widen to every location this account can see.
    const locations = await listStorageDir(SNAPSHOT_ROOT);
    const scanned: SnapshotCandidate[] = [];
    for (const entry of locations) {
      const prefix = `${SNAPSHOT_ROOT}/${entry.name}`;
      if (!entry.name || preferred.includes(prefix)) continue;
      const hit = await newestSnapshotUnder(prefix);
      if (hit) scanned.push(hit);
    }

    const widest = pickNewestSnapshot(scanned);
    return widest ? { candidate: widest } : { candidate: null, reason: 'no cloud backup found' };
  } catch (e: any) {
    return { candidate: null, reason: `cloud backup lookup failed: ${e?.message || e}` };
  }
}

// ─── SQL execute helpers ───────────────────────────────────────────────────

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

// ─── Service Class ──────────────────────────────────────────────────────────

export class SqliteDbService implements IDbService {
  private db: SqlJsDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  /** Accumulates mutating SQL queries ran in the current transaction */
  private pendingStatements: Array<{ sql: string; params?: any[] }> = [];

  /** Exporter debouncing state */
  private snapshotTimeout: ReturnType<typeof setTimeout> | null = null;

  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const SQL = await loadSqlJs();
      const snapshot = await loadSnapshotIDB();

      // Use a local variable to satisfy TypeScript strict null narrowing
      const db: SqlJsDatabase = snapshot ? new SQL.Database(snapshot) : new SQL.Database();
      db.run(SCHEMA_SQL);

      // Replay any pending journal entries from the WAL store (crash recovery)
      const journalEntries = await loadJournalIDB();
      if (journalEntries.length > 0) {
        console.info(`[SqliteDbService] Replaying ${journalEntries.length} WAL journal transactions...`);
        db.run('BEGIN TRANSACTION');
        let replaySucceeded = true;
        try {
          for (const entry of journalEntries) {
            for (const stmt of entry.statements) {
              // Each entry already carries its own BEGIN TRANSACTION/COMMIT pair from
              // when it was journaled (runWrite buffers those calls too). Skip them here
              // since the whole replay batch is already wrapped in one outer transaction —
              // running them verbatim would nest a transaction inside a transaction.
              const normalized = stmt.sql.trim().toUpperCase();
              if (normalized === 'BEGIN TRANSACTION' || normalized === 'COMMIT' || normalized === 'ROLLBACK') continue;
              db.run(stmt.sql, stmt.params);
            }
          }
          db.run('COMMIT');
        } catch (e) {
          db.run('ROLLBACK');
          replaySucceeded = false;
          console.error('[SqliteDbService] WAL replay failed, database may be inconsistent:', e);
        }

        // Only fold the journal into a new baseline snapshot if replay actually succeeded —
        // otherwise the queued mutations would be silently discarded with no way to retry.
        if (replaySucceeded) {
          const updatedData = db.export();
          if (isIDBAvailable()) {
            const idb = await _openIDB();
            await new Promise<void>((resolve, reject) => {
              const tx = idb.transaction([IDB_SNAPSHOT_STORE, IDB_JOURNAL_STORE], 'readwrite');
              tx.objectStore(IDB_SNAPSHOT_STORE).put(updatedData, IDB_KEY);
              tx.objectStore(IDB_JOURNAL_STORE).clear();
              tx.oncomplete = () => { idb.close(); resolve(); };
              tx.onerror    = () => { idb.close(); reject(tx.error); };
            });
          }
          console.info('[SqliteDbService] WAL journal cleared and baseline snapshot updated.');
        }
      }

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
        try {
          const cfg: DeviceConfig = JSON.parse(cfgRows[0].value as string);
          _deviceId = cfg.deviceId || 'DEV01';
          _locationId = cfg.locationId || 'LOC01';
        } catch (_) {}
      }

      this.db = db;

      // Ensure Supabase Storage bucket is ready
      ensureBackupBucket().catch(() => {});

      // One-time legacy migration from localStorage JSON blobs
      if (typeof localStorage !== 'undefined' && !localStorage.getItem(MIGRATION_FLAG)) {
        this._migrateFromLocalStorage();
        localStorage.setItem(MIGRATION_FLAG, '1');
      }
    })();

    return this.initPromise;
  }

  /** Gets the active Database connection */
  private get DB(): SqlJsDatabase {
    if (!this.db) throw new Error('SqliteDbService: call init() first.');
    return this.db;
  }

  /** True when this device holds no operational records yet (fresh/wiped install). */
  async isLocalDataEmpty(): Promise<boolean> {
    const [tickets] = querySql<{ n: number }>(this.DB, 'SELECT COUNT(*) AS n FROM tickets');
    const [shifts] = querySql<{ n: number }>(this.DB, 'SELECT COUNT(*) AS n FROM shifts');
    return (tickets?.n ?? 0) === 0 && (shifts?.n ?? 0) === 0;
  }

  /**
   * Pulls the newest cloud snapshot for this location and replaces the in-memory
   * database with it. Intended for a fresh or wiped device signing in again.
   *
   * Refuses to run when local records already exist, since this overwrites the whole
   * database — reconciling two diverged copies is a merge, not a restore, and would
   * silently destroy unsynced local tickets.
   */
  async restoreFromCloud(): Promise<{ restored: boolean; reason?: string; source?: string }> {
    if (!isSupabaseConfigured) return { restored: false, reason: 'cloud not configured' };
    await this.init();

    if (!(await this.isLocalDataEmpty())) {
      return { restored: false, reason: 'local data present — refusing to overwrite' };
    }

    const { candidate, reason } = await findNewestCloudSnapshot();
    if (!candidate) return { restored: false, reason: reason || 'no cloud backup found' };
    const newestPath = candidate.path;

    const { data: blob, error: dlError } = await supabase.storage.from(SUPABASE_BUCKET).download(newestPath);
    if (dlError || !blob) return { restored: false, reason: dlError?.message || 'download failed' };

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const SQL = await loadSqlJs();
    const restoredDb: SqlJsDatabase = new SQL.Database(bytes);
    restoredDb.run(SCHEMA_SQL); // tolerate snapshots taken before a newer table existed

    this.db?.close();
    this.db = restoredDb;
    this.pendingStatements = [];

    // Persist immediately so the restore survives a reload even if nothing else writes.
    if (isIDBAvailable()) {
      const idb = await _openIDB();
      await new Promise<void>((resolve, reject) => {
        const tx = idb.transaction([IDB_SNAPSHOT_STORE, IDB_JOURNAL_STORE], 'readwrite');
        tx.objectStore(IDB_SNAPSHOT_STORE).put(restoredDb.export(), IDB_KEY);
        tx.objectStore(IDB_JOURNAL_STORE).clear();
        tx.oncomplete = () => { idb.close(); resolve(); };
        tx.onerror    = () => { idb.close(); reject(tx.error); };
      });
    }

    console.info(`[SqliteDbService] Restored cloud backup from ${newestPath}`);
    return { restored: true, source: newestPath };
  }

  /** Run a write query (in-memory SQLite + buffer statement for journal) */
  private runWrite(sql: string, params?: any[]): void {
    this.DB.run(sql, params);
    this.pendingStatements.push({ sql, params });
  }

  /**
   * Durability step: Appends the transaction statements to the IndexedDB WAL journal.
   * This is O(1) and awaited in service methods to ensure crash-safety before returning.
   * Also schedules a debounced background export of the full snapshot database.
   */
  private async _persist(): Promise<void> {
    if (this.pendingStatements.length === 0) return;
    
    // Append the statements as a single atomic journal transaction entry in IDB WAL
    const journalId = await appendJournalIDB(this.pendingStatements);
    this.pendingStatements = [];

    // Schedule debounced full snapshot baseline update
    this.scheduleSnapshotExport(journalId);
  }

  /**
   * Debounces full database binary exports. Runs baseline update in background
   * to keep the UI responsive and thread unblocked.
   */
  private scheduleSnapshotExport(latestJournalId: number): void {
    if (this.snapshotTimeout) clearTimeout(this.snapshotTimeout);
    
    this.snapshotTimeout = setTimeout(async () => {
      if (!this.db) return;
      try {
        const data = this.db.export();
        
        // Tier 2: Update baseline snapshot in IndexedDB
        if (isIDBAvailable()) {
          const idb = await _openIDB();
          await new Promise<void>((resolve, reject) => {
            const tx = idb.transaction(IDB_SNAPSHOT_STORE, 'readwrite');
            tx.objectStore(IDB_SNAPSHOT_STORE).put(data, IDB_KEY);
            tx.oncomplete = () => { idb.close(); resolve(); };
            tx.onerror    = () => { idb.close(); reject(tx.error); };
          });

          // Delete journal entries that are now folded into this baseline snapshot
          await deleteJournalIDBUpTo(latestJournalId);
        }

        // Tier 3: Sync to cloud storage
        scheduleSupabaseBackup(data);
      } catch (e) {
        console.warn('[SqliteDbService] Snapshot background export failed:', e);
      }
    }, 5000); // 5 seconds debounce
  }

  // ─── Config ──────────────────────────────────────────────────────────────

  async getDeviceConfig(): Promise<DeviceConfig | null> {
    const rows = querySql(this.DB, "SELECT value FROM config WHERE key = 'device_config'");
    return rows.length > 0 ? JSON.parse(rows[0].value as string) : null;
  }

  async saveDeviceConfig(config: DeviceConfig): Promise<void> {
    this.runWrite("BEGIN TRANSACTION");
    this.runWrite("INSERT OR REPLACE INTO config (key, value) VALUES ('device_config', ?)", [JSON.stringify(config)]);
    this.runWrite("COMMIT");
    _locationId = config.locationId || 'LOC01';
    _deviceId = config.deviceId || 'DEV01';
    await this._persist();
  }

  // ─── Users ───────────────────────────────────────────────────────────────

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
    this.runWrite('BEGIN TRANSACTION');
    this.runWrite(`
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
    this.runWrite('COMMIT');
    await this._persist();
  }

  async updateUser(user: UserAccount): Promise<void> {
    this.runWrite('BEGIN TRANSACTION');
    this.runWrite(`
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
    this.runWrite('COMMIT');
    await this._persist();
  }

  // ─── Tickets ─────────────────────────────────────────────────────────────

  async getTickets(userId?: string): Promise<Ticket[]> {
    const rows = userId
      ? querySql(this.DB, 'SELECT * FROM tickets WHERE cashier_id = ? ORDER BY created_at DESC', [userId])
      : querySql(this.DB, 'SELECT * FROM tickets ORDER BY created_at DESC');
    return rows.map(this._rowToTicket);
  }

  async saveTicket(ticket: Ticket): Promise<void> {
    this.runWrite('BEGIN TRANSACTION');
    this.runWrite(`
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
    this.runWrite('COMMIT');
    await this._persist();
  }

  async updateTicketStatus(ticketId: string, status: 'paid' | 'collected' | 'void', reason?: string, voidedBy?: string): Promise<void> {
    const now = new Date().toISOString();
    this.runWrite('BEGIN TRANSACTION');
    if (status === 'void') {
      this.runWrite(
        'UPDATE tickets SET status=?,void_reason=?,voided_by=?,voided_at=? WHERE id=?',
        [status, reason ?? null, voidedBy ?? null, now, ticketId]
      );
      this._runAuditLog({ entity: 'ticket', entityId: ticketId, action: 'VOID', actorId: voidedBy ?? 'ADMIN', reason: reason ?? 'N/A', timestamp: now });
    } else {
      this.runWrite('UPDATE tickets SET status=? WHERE id=?', [status, ticketId]);
    }
    const rows = querySql(this.DB, 'SELECT * FROM tickets WHERE id=?', [ticketId]);
    if (rows.length > 0) this._runQueueOutbox('tickets', 'UPDATE', this._rowToTicket(rows[0]));
    this.runWrite('COMMIT');
    await this._persist();
  }

  /** Atomically increment sequence counter */
  async getNextSeq(locationId: string, deviceId: string): Promise<number> {
    const key = `${locationId}_${deviceId}`;
    this.runWrite('BEGIN TRANSACTION');
    try {
      this.runWrite(
        'INSERT INTO sequences (key, next_val) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET next_val = next_val + 1',
        [key]
      );
      const rows = querySql(this.DB, 'SELECT next_val FROM sequences WHERE key=?', [key]);
      const nextVal = rows[0].next_val as number;
      this.runWrite('COMMIT');
      await this._persist();
      return nextVal;
    } catch (e) {
      this.runWrite('ROLLBACK');
      throw e;
    }
  }

  // ─── Shifts ──────────────────────────────────────────────────────────────

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
    this.runWrite('BEGIN TRANSACTION');
    this.runWrite(`
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
    this.runWrite('COMMIT');
    await this._persist();
  }

  async closeShift(shiftId: string, countedCash: number, expectedCash: number, variance: number, notes?: string): Promise<void> {
    const now = new Date().toISOString();
    this.runWrite('BEGIN TRANSACTION');
    this.runWrite(
      'UPDATE shifts SET status=?,closed_at=?,counted_cash=?,expected_cash=?,variance=?,notes=? WHERE id=?',
      ['closed', now, countedCash, expectedCash, variance, notes ?? null, shiftId]
    );
    const rows = querySql(this.DB, 'SELECT * FROM shifts WHERE id=?', [shiftId]);
    if (rows.length > 0) this._runQueueOutbox('shifts', 'UPDATE', this._rowToShift(rows[0]));
    this.runWrite('COMMIT');
    await this._persist();
  }

  // ─── Expenses ────────────────────────────────────────────────────────────

  async getExpenses(shiftId?: string, userId?: string): Promise<Expense[]> {
    let sql = 'SELECT * FROM expenses WHERE 1=1';
    const params: any[] = [];
    if (shiftId) { sql += ' AND shift_id=?'; params.push(shiftId); }
    if (userId)  { sql += ' AND cashier_id=?'; params.push(userId); }
    sql += ' ORDER BY logged_at DESC';
    return querySql(this.DB, sql, params).map(this._rowToExpense);
  }

  async saveExpense(expense: Expense): Promise<void> {
    this.runWrite('BEGIN TRANSACTION');
    this.runWrite(`
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
    this.runWrite('COMMIT');
    await this._persist();
  }

  async updateExpenseStatus(expenseId: string, status: 'approved' | 'rejected', reviewer: string, reason?: string): Promise<void> {
    const now = new Date().toISOString();
    this.runWrite('BEGIN TRANSACTION');
    this.runWrite(
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
    this.runWrite('COMMIT');
    await this._persist();
  }

  // ─── Outbox Sync ─────────────────────────────────────────────────────────

  async getPendingOutbox(): Promise<OutboxItem[]> {
    return querySql(this.DB, "SELECT * FROM outbox WHERE status='pending' ORDER BY created_at ASC").map(r => ({
      id: r.id as string,
      tableName: r.table_name as string,
      action: r.action as 'INSERT' | 'UPDATE' | 'DELETE',
      payload: JSON.parse(r.payload as string),
      createdAt: r.created_at as string,
      status: r.status as 'pending' | 'synced',
      retryCount: r.retry_count as number,
    }));
  }

  async markOutboxSynced(id: string): Promise<void> {
    this.runWrite('BEGIN TRANSACTION');
    this.runWrite("UPDATE outbox SET status='synced' WHERE id=?", [id]);
    this.runWrite('COMMIT');
    await this._persist();
  }

  /**
   * Records a failed sync attempt for one outbox item. After MAX_OUTBOX_RETRIES
   * consecutive failures, the item is parked as 'failed' (dropped out of
   * getPendingOutbox's 'pending' filter) so a single bad/rejected record can't
   * block every other queued ticket/shift/expense behind it forever.
   */
  async markOutboxAttemptFailed(id: string, retryCount: number): Promise<void> {
    const MAX_OUTBOX_RETRIES = 8;
    const nextStatus = retryCount + 1 >= MAX_OUTBOX_RETRIES ? 'failed' : 'pending';
    this.runWrite('BEGIN TRANSACTION');
    this.runWrite("UPDATE outbox SET retry_count = retry_count + 1, status=? WHERE id=?", [nextStatus, id]);
    this.runWrite('COMMIT');
    await this._persist();
  }

  // ─── Private Sync outbox/audit helpers (inserts to transaction queue) ─────

  private _runQueueOutbox(tableName: string, action: string, payload: Record<string, any>): void {
    this.runWrite(`
      INSERT INTO outbox (id,table_name,action,payload,created_at,status,retry_count)
      VALUES (?,?,?,?,?,'pending',0)
    `, [crypto.randomUUID(), tableName, action, JSON.stringify(payload), new Date().toISOString()]);
  }

  private _runAuditLog(e: { entity: string; entityId: string; action: string; actorId: string; reason: string; timestamp: string }): void {
    this.runWrite(`
      INSERT INTO audit_logs (id,entity,entity_id,action,actor_id,reason,timestamp)
      VALUES (?,?,?,?,?,?,?)
    `, [crypto.randomUUID(), e.entity, e.entityId, e.action, e.actorId, e.reason, e.timestamp]);
  }

  // ─── Row Mappers ─────────────────────────────────────────────────────────

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
      voidReason: r.void_reason ?? undefined, voidedBy: r.voided_by ?? undefined, voidedAt: r.voided_at ?? undefined,
    };
  }

  private _rowToShift(r: Record<string, any>): Shift {
    return {
      id: r.id, cashierId: r.cashier_id, cashierName: r.cashier_name,
      locationId: r.location_id, deviceId: r.device_id,
      status: r.status, openingFloat: r.opening_float as number, openedAt: r.opened_at,
      closedAt: r.closed_at ?? undefined, countedCash: r.counted_cash ?? undefined,
      expectedCash: r.expected_cash ?? undefined, variance: r.variance ?? undefined, notes: r.notes ?? undefined,
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

  // ─── Legacy Migration ────────────────────────────────────────────────────

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

    this.runWrite('BEGIN TRANSACTION');

    tryMigrate<Ticket>(keys.TICKETS, t => {
      this.runWrite(`INSERT OR IGNORE INTO tickets
        (id,location_id,device_id,local_seq,amount,currency,status,cashier_id,created_at,qr_payload)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [
        t.id, t.locationId, t.deviceId, t.localSeq,
        t.amount, t.currency, t.status, t.cashierId, t.createdAt, t.qrPayload,
      ]);
    });

    tryMigrate<UserAccount>(keys.USERS, u => {
      this.runWrite(`INSERT OR IGNORE INTO users
        (id,name,email,username,password_hash,password_salt,pin_hash,pin_salt,role,created_at,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
        u.id, u.name, u.email ?? null, u.username ?? null,
        u.passwordHash ?? null, u.passwordSalt ?? null,
        u.pinHash, u.pinSalt, u.role, u.createdAt, u.status,
      ]);
    });

    tryMigrate<Shift>(keys.SHIFTS, s => {
      this.runWrite(`INSERT OR IGNORE INTO shifts
        (id,cashier_id,cashier_name,location_id,device_id,status,opening_float,opened_at)
        VALUES (?,?,?,?,?,?,?,?)`, [
        s.id, s.cashierId, s.cashierName, s.locationId, s.deviceId,
        s.status, s.openingFloat, s.openedAt,
      ]);
    });

    tryMigrate<Expense>(keys.EXPENSES, e => {
      this.runWrite(`INSERT OR IGNORE INTO expenses
        (id,shift_id,cashier_id,cashier_name,category,amount,status,logged_at)
        VALUES (?,?,?,?,?,?,?,?)`, [
        e.id, e.shiftId, e.cashierId, e.cashierName ?? '',
        e.category, e.amount, e.status, e.loggedAt,
      ]);
    });

    this.runWrite('COMMIT');

    Object.values(keys).forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
    console.info('[SqliteDbService] Legacy localStorage migration complete.');

    this._persist().catch(() => {});
  }
}

export const dbService = new SqliteDbService();
