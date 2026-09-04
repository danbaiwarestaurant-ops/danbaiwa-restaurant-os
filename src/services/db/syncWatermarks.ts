/**
 * syncWatermarks.ts
 *
 * How far through the cloud's history this device has already read, per table.
 *
 * The reconciliation pull used to ask for the account's ENTIRE history every 60 seconds
 * and merge all of it, row by row, to discover that nearly none of it had changed. At a
 * few hundred tickets that is merely wasteful. At a restaurant ringing up 3,000 tickets a
 * day it is fatal: a month in, each till downloads ~100 MB a minute — more than Supabase's
 * whole monthly transfer allowance every hour, from every till, to learn nothing.
 *
 * Every synced row already carries a server-stamped `updated_at` (see the triggers in
 * supabase_schema.sql), so the pull can simply ask for what changed since last time. A
 * quiet minute then costs one small empty response per table instead of the account's
 * entire history.
 *
 * Two things this deliberately does NOT try to be:
 *
 *   * a substitute for the first pull. With no watermark stored, the pull is a full one —
 *     which is what a new or restored device needs, and what makes losing this marker
 *     harmless rather than dangerous.
 *   * a record of deletions. An incremental pull cannot see a row that is gone, but
 *     neither could the full pull: both are merge-only and never delete a local row for
 *     being absent (see applyRemoteRow). Deletes travel by realtime.
 *
 * Scoped to the account, because a different admin signing in on the same till must not
 * inherit the previous account's position and skip its own first full pull.
 */

import { db } from './dexieSchema';
import { SyncablePgTable } from './remoteMerge';

const WATERMARK_KEY = 'sync_watermarks';

/**
 * How far back before the stored position each pull actually asks from.
 *
 * `updated_at` is stamped when a statement runs, not when it commits, so a slow
 * transaction can commit *after* a faster one that carries a later stamp — and a strict
 * "newer than the newest I've seen" would step straight over it. Re-reading a couple of
 * minutes of overlap costs a handful of rows and closes that window; applying a row twice
 * is a no-op, so overlap is always safe.
 */
const OVERLAP_MS = 2 * 60_000;

interface WatermarkRecord {
  accountId: string;
  tables: Partial<Record<SyncablePgTable, string>>;
}

async function load(): Promise<WatermarkRecord | null> {
  try {
    const row = await db.config.get(WATERMARK_KEY);
    const value = row?.value as WatermarkRecord | undefined;
    return value?.accountId ? value : null;
  } catch (_) {
    return null;
  }
}

/**
 * Where to resume this table from, or null to read all of it.
 *
 * Returns the stored position less the overlap above, ready to be handed to the query.
 */
export async function watermarkFor(
  accountId: string,
  pgTable: SyncablePgTable
): Promise<string | null> {
  const record = await load();
  if (!record || record.accountId !== accountId) return null;

  const mark = record.tables[pgTable];
  if (!mark) return null;

  const at = Date.parse(mark);
  if (Number.isNaN(at)) return null;
  return new Date(at - OVERLAP_MS).toISOString();
}

/**
 * Records that everything up to `updatedAt` has been read and applied.
 *
 * Only ever moves forward, and only on a value the *server* stamped — the local clock is
 * never consulted. A till whose clock is days fast would otherwise write a position no
 * cloud row will ever reach and stop pulling anything at all.
 */
export async function advanceWatermark(
  accountId: string,
  pgTable: SyncablePgTable,
  updatedAt: string
): Promise<void> {
  const at = Date.parse(updatedAt);
  if (Number.isNaN(at)) return;

  const existing = await load();
  const record: WatermarkRecord =
    existing && existing.accountId === accountId ? existing : { accountId, tables: {} };

  const current = record.tables[pgTable];
  if (current && Date.parse(current) >= at) return;

  record.tables[pgTable] = updatedAt;
  await db.config.put({ key: WATERMARK_KEY, value: record });
}

/**
 * Forget every position, so the next pull is a full one.
 *
 * Used when this device's local copy has been rebuilt from outside the sync path — a
 * snapshot restore — where the local tables no longer correspond to anything the stored
 * positions describe.
 */
export async function clearWatermarks(): Promise<void> {
  try {
    await db.config.delete(WATERMARK_KEY);
  } catch (_) {
    /* a lost marker only ever costs one extra full pull */
  }
}
