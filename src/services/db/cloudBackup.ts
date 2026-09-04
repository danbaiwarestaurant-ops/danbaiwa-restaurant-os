/**
 * cloudBackup.ts
 *
 * Tier-3 disaster recovery: a debounced whole-database backup to Supabase Storage,
 * so a wiped or replaced till can pull its data back down after signing in again.
 *
 * Ported from SqliteDbService's Tier 3, with one format change: the backup is now a
 * JSON snapshot of every Dexie table instead of a sql.js binary export, since Dexie
 * has no single-file export equivalent to sql.js's db.export().
 */

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
import { db, TABLE_NAMES, TableName } from './dexieSchema';
import { getAccountId } from './accountScope';
import { clearWatermarks } from './syncWatermarks';

const SUPABASE_BUCKET = 'db-backups';
const BACKUP_DEBOUNCE_MS = 10_000;

interface BackupSnapshot {
  version: 1;
  exportedAt: string;
  /**
   * The account this snapshot belongs to. Absent in snapshots written before the bucket
   * was scoped by account — and those are exactly the ones that cannot be trusted, since
   * the folder they sit in says nothing about who owns them.
   */
  accountId?: string;
  tables: Partial<Record<TableName, any[]>>;
}

let _locationId = 'LOC01';
let _deviceId = 'DEV01';
let _backupTimer: ReturnType<typeof setTimeout> | null = null;

/** IndexedDbService calls this once the device config has loaded, so backups get
 *  written to (and restores search) the right location/device folder. */
export function setBackupLocationContext(locationId: string, deviceId: string): void {
  _locationId = locationId || 'LOC01';
  _deviceId = deviceId || 'DEV01';
}



async function exportAllTables(accountId: string): Promise<BackupSnapshot> {
  const tables: Partial<Record<TableName, any[]>> = {};
  await Promise.all(
    TABLE_NAMES.map(async (name) => {
      tables[name] = await (db as any)[name].toArray();
    })
  );
  return { version: 1, exportedAt: new Date().toISOString(), accountId, tables };
}

/** Debounces a full JSON export + upload, mirroring the old _persist()-triggered
 *  Tier-3 timing. Call this at the end of every mutating IndexedDbService method. */
export function scheduleCloudBackup(): void {
  if (!isSupabaseConfigured || typeof window === 'undefined') return;
  if (_backupTimer) clearTimeout(_backupTimer);

  _backupTimer = setTimeout(async () => {
    try {
      // No account, no backup. A snapshot that cannot name its owner has nowhere safe to
      // be written and nothing that could later prove it is safe to restore.
      const accountId = await getAccountId();
      const prefix = snapshotDir(accountId, _locationId, _deviceId);
      if (!accountId || !prefix) {
        console.debug('[cloudBackup] skipped: no account to write this snapshot under');
        return;
      }

      const snapshot = await exportAllTables(accountId);
      const json = JSON.stringify(snapshot);
      const blob = new Blob([json], { type: 'application/json' });
      const date = new Date().toISOString().split('T')[0];

      const latestResult = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(`${prefix}/${LATEST_FILE}`, blob, { upsert: true });

      const dailyResult = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(`${prefix}/${date}.json`, blob, { upsert: true });

      // supabase-js resolves (rather than throws) on a rejected upload, so this must
      // be checked explicitly — otherwise a silently-blocked backup (missing bucket,
      // RLS policy, no session) gets logged as a false-positive success.
      if (latestResult.error || dailyResult.error) {
        throw new Error(latestResult.error?.message || dailyResult.error?.message);
      }

      console.info(`[cloudBackup] Cloud backup sync complete (${(json.length / 1024).toFixed(1)} KB)`);
    } catch (e) {
      console.warn('[cloudBackup] Cloud backup failed (will retry on next snapshot):', e);
    }
  }, BACKUP_DEBOUNCE_MS);
}

export async function ensureBackupBucket(): Promise<void> {
  if (!isSupabaseConfigured || typeof window === 'undefined') return;
  try {
    const { error } = await supabase.storage.createBucket(SUPABASE_BUCKET, {
      public: false,
      fileSizeLimit: 52_428_800, // 50MB
    });
    if (
      error &&
      !error.message.toLowerCase().includes('already exists') &&
      !error.message.toLowerCase().includes('duplicate')
    ) {
      console.warn('[cloudBackup] Backup bucket creation notice:', error.message);
    }
  } catch (_) {}
}

// ─── Cloud snapshot discovery ──────────────────────────────────────────────

/**
 * The location a snapshot belongs to is a property of the ACCOUNT, not of the machine
 * holding it. A freshly installed till has never been configured, so its local device
 * config still reads the seeded default — asking the signed-in cloud session which
 * location this account belongs to is the only way that machine can find snapshots
 * written by the till it is replacing.
 */
async function resolveCloudLocationId(): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data } = await supabase.auth.getUser();
    const meta = (data?.user?.user_metadata ?? {}) as Record<string, unknown>;
    const loc = typeof meta.location_id === 'string' ? meta.location_id.trim() : '';
    return loc || null;
  } catch (_) {
    return null;
  }
}

async function listStorageDir(prefix: string): Promise<Array<Record<string, any>>> {
  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .list(prefix, { limit: 1000, sortBy: { column: 'updated_at', order: 'desc' } });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Newest snapshot beneath a location folder, across every device that ever backed up
 * there. Any snapshot file counts — not just latest.json — so a till whose hot
 * snapshot upload failed can still be recovered from its last daily copy.
 */
async function newestSnapshotUnder(locationPrefix: string): Promise<SnapshotCandidate | null> {
  const entries = await listStorageDir(locationPrefix);
  const found: SnapshotCandidate[] = [];

  for (const entry of entries) {
    const name: string = entry.name;
    if (!name) continue;

    if (isSnapshotFile(name)) {
      found.push({ path: `${locationPrefix}/${name}`, updatedAt: snapshotTimestamp(entry) });
      continue;
    }

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
 * Finds the snapshot a restoring machine should pull: the signed-in account's location
 * first, then this machine's configured location — both inside the account's own folder,
 * and no further.
 *
 * The search used to widen one step beyond that, scanning every location in the bucket
 * for anything at all. Combined with a bucket that was not partitioned by account, and
 * two accounts both on the default LOC01, that step is how a freshly installed till
 * restored a different account's entire database, re-queued all of it as its own, and
 * spent the rest of its life being refused row by row. Finding nothing is a far better
 * outcome than finding somebody else's data: the till simply starts empty and syncs.
 */
async function findNewestCloudSnapshot(
  accountId: string
): Promise<{ candidate: SnapshotCandidate | null; reason?: string }> {
  const cloudLocation = await resolveCloudLocationId();
  const preferred = candidateLocationDirs(accountId, cloudLocation, _locationId);

  try {
    for (const dir of preferred) {
      const hit = await newestSnapshotUnder(dir);
      if (hit) return { candidate: hit };
    }
    return { candidate: null, reason: 'no cloud backup found for this account' };
  } catch (e: any) {
    return { candidate: null, reason: `cloud backup lookup failed: ${e?.message || e}` };
  }
}

/** True when this device holds no operational records yet (fresh/wiped install). */
export async function isLocalDataEmpty(): Promise<boolean> {
  const [tickets, shifts] = await Promise.all([db.tickets.count(), db.shifts.count()]);
  return tickets === 0 && shifts === 0;
}

/**
 * Pulls the newest cloud snapshot for this location and replaces the local database
 * with it. Intended for a fresh or wiped device signing in again.
 *
 * Refuses to run when local records already exist, since this overwrites the whole
 * database — reconciling two diverged copies is a merge, not a restore, and would
 * silently destroy unsynced local tickets.
 */
export async function restoreFromCloud(): Promise<{ restored: boolean; reason?: string; source?: string }> {
  if (!isSupabaseConfigured) return { restored: false, reason: 'cloud not configured' };

  if (!(await isLocalDataEmpty())) {
    return { restored: false, reason: 'local data present — refusing to overwrite' };
  }

  const accountId = await getAccountId();
  if (!accountId) return { restored: false, reason: 'no account signed in to restore for' };

  const { candidate, reason } = await findNewestCloudSnapshot(accountId);
  if (!candidate) return { restored: false, reason: reason || 'no cloud backup found' };

  const { data: blob, error: dlError } = await supabase.storage.from(SUPABASE_BUCKET).download(candidate.path);
  if (dlError || !blob) return { restored: false, reason: dlError?.message || 'download failed' };

  const text = await blob.text();
  const parsed: BackupSnapshot = JSON.parse(text);

  // The folder said this belongs to us; the snapshot has to say so too. A snapshot with
  // no owner recorded predates account-scoped backups, and there is nothing about it that
  // can be checked — restoring it is how another account's records ended up on a till
  // that could never sync them. Refused, and said out loud rather than swallowed.
  if (parsed.accountId !== accountId) {
    console.warn(
      `[cloudBackup] refusing snapshot ${candidate.path}: it belongs to ${parsed.accountId ?? 'an unrecorded account'}, not to the account signed in here`
    );
    return {
      restored: false,
      reason: parsed.accountId
        ? 'the newest snapshot belongs to a different account'
        : 'the newest snapshot predates account-scoped backups and cannot be proven to belong to this account',
    };
  }

  await db.transaction('rw', TABLE_NAMES.map((name) => (db as any)[name]), async () => {
    for (const name of TABLE_NAMES) {
      const rows = parsed.tables[name] ?? [];
      if (rows.length) await (db as any)[name].bulkPut(rows);
    }
  });

  // A snapshot carries the config table too, including the position the *snapshotting*
  // device had reached in the cloud's history. Inheriting that would tell this machine it
  // had already read rows it has never seen, and the incremental pull would start after
  // them. Drop it, so the first pull here is a full one.
  await clearWatermarks();

  console.info(`[cloudBackup] Restored cloud backup from ${candidate.path}`);
  return { restored: true, source: candidate.path };
}
