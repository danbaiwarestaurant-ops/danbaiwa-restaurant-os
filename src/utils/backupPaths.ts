/**
 * backupPaths.ts
 *
 * Addressing rules for cloud (Supabase Storage) database snapshots.
 *
 * A backup is only worth taking if the machine that needs it can find it. The device
 * id is therefore only ever the LAST segment of a snapshot key, never something a
 * restore has to know up front — a replacement till knows which account it just
 * signed in as, but it can never guess the device id of the machine that died.
 *
 * Layout:  snapshots/<LOCATION>/<DEVICE>/latest.db
 *          snapshots/<LOCATION>/<DEVICE>/<YYYY-MM-DD>.db
 *
 * A restore widens its search: the account's location first, then this machine's
 * configured location, then every location in the bucket.
 */

export const SNAPSHOT_ROOT = 'snapshots';
export const LATEST_FILE = 'latest.db';

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

/** Folder holding every device's snapshots for one location. */
export function locationDir(locationId?: string | null): string {
  return `${SNAPSHOT_ROOT}/${normalizeSegment(locationId, DEFAULT_LOCATION_ID)}`;
}

/** Folder holding one device's snapshots. */
export function snapshotDir(locationId?: string | null, deviceId?: string | null): string {
  return `${locationDir(locationId)}/${normalizeSegment(deviceId, DEFAULT_DEVICE_ID)}`;
}

export function snapshotPath(
  locationId: string | null | undefined,
  deviceId: string | null | undefined,
  fileName: string
): string {
  return `${snapshotDir(locationId, deviceId)}/${fileName}`;
}

/**
 * Ordered, de-duplicated list of location folders a restore should search first,
 * best guess first. Empty/unknown ids are dropped rather than defaulted, so an
 * unknown cloud location never silently becomes "LOC01".
 */
export function candidateLocationDirs(...locationIds: Array<string | null | undefined>): string[] {
  const dirs: string[] = [];
  for (const id of locationIds) {
    if (!id || !String(id).trim()) continue;
    const dir = locationDir(id);
    if (!dirs.includes(dir)) dirs.push(dir);
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
  return /\.db$/i.test((name ?? '').trim());
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
  const dated = /(\d{4}-\d{2}-\d{2})\.db$/i.exec(entry.name ?? '');
  if (dated) {
    const parsed = new Date(dated[1]).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}
