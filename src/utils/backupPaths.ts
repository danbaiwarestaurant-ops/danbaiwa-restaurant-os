/**
 * backupPaths.ts
 *
 * Addressing rules for cloud (Supabase Storage) database snapshots.
 *
 * A backup is only worth taking if the machine that needs it can find it — and only
 * safe to take if no other tenant can. The device id is therefore only ever the LAST
 * segment, never something a restore has to know up front (a replacement till knows
 * which account it just signed in as, but can never guess the device id of the machine
 * that died), and the ACCOUNT is the first, so the bucket can be policed by folder.
 *
 * Layout:  snapshots/<account-uuid>/<LOCATION>/<DEVICE>/latest.json
 *          snapshots/<account-uuid>/<LOCATION>/<DEVICE>/<YYYY-MM-DD>.json
 *
 * The account segment is what was missing, and its absence was not theoretical: two
 * accounts both using the default location wrote into the same snapshots/LOC01 folder,
 * a restore widened its search across every location in the bucket, and a freshly
 * installed till pulled down another account's entire database — which it then tried to
 * re-upload as its own, and which the cloud refused row by row for the rest of its life.
 * Kept lowercase and unmangled, unlike the other segments, so a storage policy can
 * compare it directly against current_account_id()::text.
 */

export const SNAPSHOT_ROOT = 'snapshots';
export const LATEST_FILE = 'latest.json';

export const DEFAULT_LOCATION_ID = 'LOC01';
export const DEFAULT_DEVICE_ID = 'DEV01';

/**
 * Storage keys are path segments, so keep them boring and case-stable — otherwise a
 * location typed as "Main Branch" on one till and "main branch" on another writes
 * two unrelated folders that neither machine would recognise as the same place.
 */
export function normalizeSegment(raw: string | null | undefined, fallback: string): string {
  const cleaned = (raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (cleaned || fallback).toUpperCase();
}

/**
 * The account segment, or null when there is no account to write under.
 *
 * Null is a refusal, not a default: a snapshot that cannot name its owner has nowhere
 * safe to go, and guessing would put it in somebody's folder.
 */
export function accountSegment(accountId?: string | null): string | null {
  const clean = (accountId ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  return clean || null;
}

/** Root folder for one account's snapshots, or null when the account is unknown. */
export function accountDir(accountId?: string | null): string | null {
  const segment = accountSegment(accountId);
  return segment ? `${SNAPSHOT_ROOT}/${segment}` : null;
}

/** Folder holding every device's snapshots for one of an account's locations. */
export function locationDir(accountId: string | null | undefined, locationId?: string | null): string | null {
  const root = accountDir(accountId);
  return root ? `${root}/${normalizeSegment(locationId, DEFAULT_LOCATION_ID)}` : null;
}

/** Folder holding one device's snapshots. */
export function snapshotDir(
  accountId: string | null | undefined,
  locationId?: string | null,
  deviceId?: string | null
): string | null {
  const dir = locationDir(accountId, locationId);
  return dir ? `${dir}/${normalizeSegment(deviceId, DEFAULT_DEVICE_ID)}` : null;
}

export function snapshotPath(
  accountId: string | null | undefined,
  locationId: string | null | undefined,
  deviceId: string | null | undefined,
  fileName: string
): string | null {
  const dir = snapshotDir(accountId, locationId, deviceId);
  return dir ? `${dir}/${fileName}` : null;
}

/**
 * Ordered, de-duplicated list of location folders a restore should search, best guess
 * first — all of them inside the signed-in account. Empty/unknown ids are dropped rather
 * than defaulted, so an unknown cloud location never silently becomes "LOC01", and an
 * unknown account yields nothing at all rather than a bucket-wide hunt.
 */
export function candidateLocationDirs(
  accountId: string | null | undefined,
  ...locationIds: Array<string | null | undefined>
): string[] {
  if (!accountSegment(accountId)) return [];
  const dirs: string[] = [];
  for (const id of locationIds) {
    if (!id || !String(id).trim()) continue;
    const dir = locationDir(accountId, id);
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

export interface SnapshotCandidate {
  path: string;
  updatedAt: number;
}

/** Newest wins; identical timestamps break ties by path so the choice is deterministic. */
export function pickNewestSnapshot(candidates: SnapshotCandidate[]): SnapshotCandidate | null {
  let best: SnapshotCandidate | null = null;
  for (const candidate of candidates) {
    if (
      !best ||
      candidate.updatedAt > best.updatedAt ||
      (candidate.updatedAt === best.updatedAt && candidate.path < best.path)
    ) {
      best = candidate;
    }
  }
  return best;
}

export function isSnapshotFile(name: string | null | undefined): boolean {
  return /\.json$/i.test((name ?? '').trim());
}

/**
 * Age of a listed storage object. Falls back to the date encoded in a daily
 * snapshot's filename when Supabase returns no timestamps for the entry.
 */
export function snapshotTimestamp(entry: {
  name?: string;
  updated_at?: string | null;
  created_at?: string | null;
}): number {
  const raw = entry.updated_at || entry.created_at;
  if (raw) {
    const parsed = new Date(raw).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  const dated = /(\d{4}-\d{2}-\d{2})\.json$/i.exec(entry.name ?? '');
  if (dated) {
    const parsed = new Date(dated[1]).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}
