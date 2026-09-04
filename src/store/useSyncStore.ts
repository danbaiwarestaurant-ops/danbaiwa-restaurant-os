import { create, StoreApi } from 'zustand';
import { SyncState, OutboxItem, SyncAction } from '../types/sync';
import { dbService } from '../services/db/IndexedDbService';
import { supabase, isSupabaseConfigured } from '../services/supabase/supabaseClient';
import { useDeviceStore } from './useDeviceStore';
import { toSnakeCase } from '../utils/caseMapping';
import { getAccountId, getServerAccountId } from '../services/db/accountScope';
import { restoreDeviceSession, checkDeviceEnrolment } from '../services/supabase/deviceIdentity';

interface SyncStoreState extends SyncState {
  pendingItems: OutboxItem[];
  checkOutbox: () => Promise<void>;
  triggerSyncWorker: () => Promise<void>;
  /**
   * What the manual sync button does: clear every backoff timer and push right now.
   *
   * The background worker backs a *rejected* row off, so a row the cloud refused an
   * hour ago is still sitting out a timer — which is exactly what "sync now" is being
   * pressed to override. Someone standing at the till pressing the badge is new
   * information ("the connection is good, try again"), so honour it rather than making
   * them watch a timer they cannot see.
   */
  forceSyncNow: () => Promise<void>;
  startBackgroundLoop: () => void;
}

/**
 * Rows per cloud request. The worker used to send one row per HTTP round trip, strictly
 * sequentially: a 300-row backlog meant 300 round trips, so the pending counter visibly
 * ticked down one at a time for minutes on a normal connection. Postgres takes an array
 * just as happily as a single row, so the same backlog is now a couple of requests.
 */
const MAX_BATCH_ROWS = 200;

/**
 * How often the safety-net loop looks at the queue. Most ticks cost one cheap Dexie
 * count (see startBackgroundLoop), so this can be short: it is the longest a row that
 * failed on a dropped connection has to wait before being tried again. Every *normal*
 * write is pushed the instant it is queued and never waits for a tick at all.
 */
const POLL_INTERVAL_MS = 3_000;

/** Ticks between full status refreshes (cloud session + counts) for the sync badge. */
const FULL_REFRESH_EVERY = 5;

interface OutboxBatch {
  tableName: string;
  action: SyncAction;
  items: OutboxItem[];
}

/**
 * How a single push pass ended.
 *
 * `drained` is the only outcome worth immediately repeating for: it means the cloud was
 * reachable and answering, so anything queued while the pass was in flight can go now.
 */
type PassOutcome = 'drained' | 'skipped' | 'retry-soon' | 'session-lost';

/**
 * Set when a write is queued while a push is already in flight.
 *
 * The worker refuses to run concurrently with itself — two passes would send the same
 * rows twice — but it used to simply drop those triggers on the floor, so a ticket rung
 * up during a push waited for the next poll instead of going with the pass that was
 * about to finish. On a busy till, where a push is in flight most of the time, that is
 * the whole reason records appeared to trickle out rather than leave immediately.
 */
let resyncRequested = false;

/** Last outbox housekeeping sweep, and how often one is worth doing. */
let lastPrune = 0;
const PRUNE_EVERY_MS = 10 * 60_000;

/**
 * The conflict target the cloud accepts for tickets.
 *
 * tickets.id used to be the primary key on its own, which made a ticket number unique
 * across every restaurant in the project rather than within one — see the TICKET KEY
 * section of supabase_schema.sql. The key is now (account_id, id), and an upsert has to
 * name the matching unique constraint or Postgres rejects the statement outright (42P10).
 *
 * Which one is right therefore depends on whether that migration has been applied, and a
 * till cannot know: these are offline-capable PWAs, so a machine can be running a build
 * from before or after the migration for as long as its service worker holds. Rather than
 * demanding the database and every till be upgraded in the same instant, the first
 * mismatch flips this and the pass retries — once per session, then it sticks.
 */
let ticketConflictKey: 'account_id,id' | 'id' = 'account_id,id';

/** Postgres 42P10: the named conflict target has no matching unique constraint. */
function isConflictTargetMismatch(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    String(error.code ?? '') === '42P10' ||
    String(error.message ?? '')
      .toLowerCase()
      .includes('no unique or exclusion constraint matching the on conflict')
  );
}

/**
 * Split the due queue into runs that can be sent as one request each.
 *
 * Runs are **contiguous**, not merely grouped by table: the queue is ordered by createdAt
 * and that order carries meaning. Sorting all the UPDATEs together and all the DELETEs
 * together would let a record's later deletion be sent before its earlier update, and the
 * update would then recreate the row that was just removed.
 *
 * Exported for testing — the ordering guarantee is the whole correctness argument for
 * batching, so it is pinned down directly rather than inferred from the worker's output.
 */
export function batchOutbox(items: OutboxItem[], maxRows: number = MAX_BATCH_ROWS): OutboxBatch[] {
  const batches: OutboxBatch[] = [];

  for (const item of items) {
    const current = batches[batches.length - 1];
    const extendsRun =
      current &&
      current.tableName === item.tableName &&
      current.action === item.action &&
      current.items.length < maxRows;

    if (extendsRun) current.items.push(item);
    else batches.push({ tableName: item.tableName, action: item.action, items: [item] });
  }

  return batches;
}

/**
 * Collapse repeat writes to the same record within one batch.
 *
 * Two queued snapshots of the same row are two versions of the same full record, so the
 * later one wins and the earlier is already accounted for. This is not just an
 * optimisation: Postgres rejects an ON CONFLICT upsert whose payload touches the same row
 * twice ("cannot affect row a second time"), which would fail the entire batch over
 * something that is not an error at all.
 */
export function dedupeBatch(items: OutboxItem[]): { send: OutboxItem[]; superseded: OutboxItem[] } {
  // Index of the last queued write per record. A row that identifies no record at all
  // can't be deduped (or conflict-resolved by the cloud), so it is always sent as-is.
  const lastIndexFor = new Map<string, number>();
  items.forEach((item, i) => {
    const key = dedupeKey(item);
    if (key !== null) lastIndexFor.set(key, i);
  });

  const send: OutboxItem[] = [];
  const superseded: OutboxItem[] = [];

  items.forEach((item, i) => {
    const key = dedupeKey(item);
    if (key === null) send.push(item);
    else if (lastIndexFor.get(key) === i) send.push(item);
    else superseded.push(item);
  });

  return { send, superseded };
}

/**
 * What identifies the record a queued write is about.
 *
 * Usually the row id. account_settings is the exception that used to break this:
 * it is one row per account, keyed by account_id, and its queued payload carries no id
 * of its own — so every settings save looked like a distinct record, several went into
 * one upsert, and Postgres rejected the whole request ("ON CONFLICT DO UPDATE cannot
 * affect row a second time"). Every save after the first then failed, permanently,
 * while the batch beside it was dragged into per-row retries it did not need.
 */
function dedupeKey(item: OutboxItem): string | null {
  const rowId = item.payload?.id;
  if (rowId !== undefined && rowId !== null) return String(rowId);
  if (item.tableName === 'account_settings') return 'account_settings';
  return null;
}

/**
 * Errors that unambiguously mean "this browser is not authenticated" — no session or a
 * dead JWT. These must never count against a row's retry budget: the row is fine, the
 * till just isn't signed in, and charging it for that is exactly how a couple of
 * cloud-less minutes used to orphan a day of tickets permanently.
 */
function isSessionFailure(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = String(error.code ?? '');
  const msg = String(error.message ?? '').toLowerCase();
  return (
    code === 'PGRST301' || // JWT expired or invalid
    code === '401' ||
    msg.includes('jwt') ||
    msg.includes('not authenticated') ||
    msg.includes('unauthorized')
  );
}

/**
 * An RLS violation is ambiguous and must not be read as "the session died".
 *
 * Postgres returns the identical 42501 for two completely different situations: an
 * unauthenticated caller, and a perfectly authenticated caller pushing a row scoped to
 * a tenant its token doesn't cover (a shift stamped LOC01 against a token carrying a
 * different location_id, or none at all). Only checking the live session tells them
 * apart — treating every 42501 as a lost session made a successful reconnect flip
 * straight back to "Not Signed In to Cloud" on the first mis-scoped row.
 */
function isRlsViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    String(error.code ?? '') === '42501' ||
    String(error.message ?? '').toLowerCase().includes('row-level security')
  );
}

/**
 * A failure of the *connection*, not of the record — the cloud never judged the row at
 * all.
 *
 * These must not be charged against a row's retry budget. A five-second tunnel, a
 * hotspot switching cells, a laptop lid closing: every row in flight came back with one
 * of these, each earned an exponential backoff it had done nothing to deserve, and the
 * queue then dribbled out over the following half hour even though the connection had
 * returned almost immediately. That is the single biggest reason a backlog took so long
 * to clear. Transient failures now abort the pass and are retried within seconds,
 * leaving the rows exactly as they were.
 */
function isTransientFailure(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = String(error.code ?? '');
  const msg = String(error.message ?? '').toLowerCase();
  return (
    ['408', '429', '500', '502', '503', '504', 'PGRST002'].includes(code) ||
    msg.includes('failed to fetch') || // Chrome/Firefox, offline or DNS failure
    msg.includes('load failed') || // Safari's wording for the same thing
    msg.includes('networkerror') ||
    msg.includes('network error') ||
    msg.includes('fetch failed') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('connection')
  );
}

/**
 * The refusal that reads as an RLS problem but is really a *conflict* one.
 *
 * Postgres words these two failures differently, and the difference is the whole
 * diagnosis:
 *
 *   "new row violates row-level security policy for table X"
 *       → the row being written is not allowed. Fix the row (or the session).
 *   "new row violates row-level security policy (USING expression) for table X"
 *       → a row with this primary key ALREADY EXISTS in the cloud, and the policy will
 *         not let this session see or update it. The upsert's ON CONFLICT branch has to
 *         update that existing row, and cannot.
 *
 * The second is unfixable by retrying — the record is in the cloud, owned by an account
 * this till does not currently resolve to — and it is exactly what a till reports when
 * its enrolment has been revoked or deleted: it can no longer see the very rows it
 * uploaded, so the backfill sweep decides the cloud is missing everything, re-queues the
 * lot, and every one of them is refused this way. Hundreds pending, nothing moving.
 */
function isConflictWithInvisibleRow(error: { message?: string } | null): boolean {
  return String(error?.message ?? '').includes('USING expression');
}

/**
 * Postgres error codes that can only have been caused by the individual row carrying
 * them — a bad foreign key, a duplicate, a value the column will not take.
 *
 * Everything else (RLS refusals, a column missing from the cloud schema, an undefined
 * table) is a property of the *request*, and every row in the batch will fail it in
 * exactly the same way. Re-sending them one at a time to "isolate the cause" then costs
 * one HTTP round trip per queued row, every pass, forever, and isolates nothing: this is
 * why a few hundred rejected records turned into thousands of requests a minute while
 * the pending count sat still. Batch-level faults are now charged once, to the whole
 * run, and the pass moves on.
 */
const ROW_SPECIFIC_CODES = [
  '23503', // foreign key violation — e.g. an expense whose shift hasn't landed yet
  '23505', // unique violation
  '23502', // not-null violation
  '23514', // check constraint
  '22P02', // invalid text representation (a malformed uuid, say)
  '22003', // numeric out of range
  '21000', // ON CONFLICT touched the same row twice
];

function isRowSpecificFailure(error: { code?: string } | null): boolean {
  return ROW_SPECIFIC_CODES.includes(String(error?.code ?? ''));
}

/**
 * When this device last tried to sign *itself* back in.
 *
 * Each queued write asks hasCloudSession twice (checkOutbox, then the worker), and on a
 * till with no session each ask used to pay for a full restoreDeviceSession round trip —
 * so a burst of writes against a dead session became a burst of sign-in attempts, all
 * failing the same way. Only that attempt is rate-limited; the local session check
 * itself is cheap and always runs, so a session that has just been established is seen
 * immediately rather than being hidden behind a cached "no".
 */
let lastRestoreAttempt = 0;
const RESTORE_RETRY_MS = 5_000;

export function invalidateCloudSessionCache(): void {
  lastRestoreAttempt = 0;
}

/**
 * Whether this browser holds a real Supabase session — restoring the till's own one if
 * it does not.
 *
 * A till is enrolled with its account in its own right, so a lost session is something
 * the device can fix by itself. Doing it here means the fix happens on the path that
 * actually noticed the problem, rather than waiting for an owner to walk over with a PIN.
 */
async function hasCloudSession(): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  try {
    const { data } = await supabase.auth.getSession();
    if (data?.session) return true;
    if (Date.now() - lastRestoreAttempt < RESTORE_RETRY_MS) return false;
    lastRestoreAttempt = Date.now();
    return await restoreDeviceSession();
  } catch (_) {
    return false;
  }
}

/** Enough of an id to recognise, without printing a full uuid at a till. */
const shortId = (id: string | null): string => (id ? `${id.slice(0, 8)}…` : 'none');

/**
 * Says why the cloud refused a record, in terms of the thing that is actually wrong.
 *
 * This used to guess: "scoped to a different location than your account", which sent
 * whoever read it hunting through device settings for a problem that does not exist —
 * location has not been security-relevant since account scoping landed. The three real
 * causes are distinguishable, so distinguish them: ask the database which account it
 * resolves for this session (the exact expression its policies compare against), and
 * compare that with the account the rows are being stamped with.
 */
async function explainRefusal(
  error: { message?: string },
  tableName: string,
  stampedAccountId: string
): Promise<string> {
  const server = await getServerAccountId();
  const enrolment = await checkDeviceEnrolment();

  if (server.ok && server.accountId !== stampedAccountId) {
    const because =
      enrolment === 'revoked'
        ? "this till's access to the account was revoked"
        : enrolment === 'gone'
          ? "this till's enrolment has been removed from the account"
          : 'the cloud no longer resolves this till to that account';

    return (
      `This till stamps its records for account ${shortId(stampedAccountId)}, but the cloud ` +
      `treats it as ${shortId(server.accountId)} — ${because}. Nothing can be sent or seen ` +
      `until they agree, and everything stays queued safely here. An admin signing in on ` +
      `this till with their PIN will enrol it again and fix it.`
    );
  }

  if (isConflictWithInvisibleRow(error)) {
    return (
      `The cloud already holds these ${tableName} records under a different account, and ` +
      `will not let this till overwrite them. Retrying cannot fix it — the records have to ` +
      `be re-pointed at your account in Supabase (see the REPAIR section of ` +
      `supabase_schema.sql). Your copy is safe on this device meanwhile.`
    );
  }

  return (
    `Signed in, but the cloud refused this ${tableName} record (${error.message}). It stays ` +
    `queued and will be retried.`
  );
}

/** Zustand accessors, so the push pass can live outside the store definition. */
type SyncSet = StoreApi<SyncStoreState>['setState'];
type SyncGet = StoreApi<SyncStoreState>['getState'];

/**
 * One push of everything currently due.
 *
 * Lifted out of triggerSyncWorker so the trigger can run it again the moment it
 * finishes, without recursing through the store, and so the reason a pass ended is a
 * value the caller can act on rather than a bare `return`.
 */
async function runSyncPass(set: SyncSet, get: SyncGet): Promise<PassOutcome> {
  if (get().isSyncing || get().pendingCount === 0) return 'skipped';

  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  if (!isOnline || !isSupabaseConfigured) {
    console.debug('[Sync Store] Worker skipped: offline or Supabase not configured');
    return 'skipped';
  }

  // Being online is not the same as being authenticated. Without a Supabase session
  // every upsert below is rejected by RLS, and those rejections are not the queued
  // rows' fault — so skip entirely, exactly as if offline, rather than pushing every
  // row a step closer to being written off. hasCloudSession restores the till's own
  // session first, so reaching this branch means the device is not enrolled at all
  // (or cannot reach the cloud to prove it), which is the one case still needing a
  // person.
  if (!(await hasCloudSession())) {
    set({
      cloudConnected: false,
      cloudError:
        get().cloudError ??
        'This till has no cloud session and is not enrolled with your account, so nothing can reach your other devices. Your work is queued safely — an admin signing in here with their PIN will enrol it, once and for good.',
    });
    console.debug('[Sync Store] Worker skipped: no cloud session (data stays queued)');
    return 'skipped';
  }

  set({ isSyncing: true, cloudConnected: true, cloudError: null });

  try {
    const items = await dbService.getPendingOutbox();
    const locationId = useDeviceStore.getState().config.locationId || 'LOC01';
    // The tenant key every RLS policy checks. Resolved once per batch rather than per
    // row, and never cached across batches, so a different account signing in on this
    // device can't push under the previous one's id.
    const accountId = await getAccountId();

    // Without a tenant id every row goes up unowned, and every RLS policy in the schema
    // compares account_id against the caller — so the cloud refuses all of it, and the
    // old code charged each refusal to the row. A whole queue could burn itself down to
    // "stuck" over a resolution failure that has nothing to do with any record in it.
    // Treated exactly like a missing session: nothing sent, nothing charged, said plainly.
    if (!accountId) {
      set({
        isSyncing: false,
        cloudError:
          'Signed in, but this till could not work out which account its records belong to, so nothing can be sent. Your work is queued safely — reconnecting with the admin PIN will resolve it.',
      });
      console.warn('[Sync Store] Worker skipped: no account id resolved (data stays queued)');
      return 'skipped';
    }

    /** One row, prepared for the cloud's column names and tenant scoping. */
    const toCloudRow = (item: OutboxItem) => {
      const supabasePayload = toSnakeCase(item.payload);

      // Every synced row is owned by an account — this is what the RLS policies
      // compare against auth.uid(). Applied uniformly rather than per-table.
      if (accountId) supabasePayload.account_id = accountId;

      // location_id is descriptive now, not security-relevant, but audit_logs and
      // users have no locationId of their own to carry, so still supply it.
      if (item.tableName === 'users' || item.tableName === 'audit_logs') {
        supabasePayload.location_id = locationId;
      }

      // tickets.tender is NOT NULL with a 'cash' default, but a column default only
      // applies to a request that never mentions the column. A batch upsert names the
      // union of every row's keys, so a single ticket carrying a tender makes PostgREST
      // send tender=NULL for every ticket minted before the cash/transfer split existed —
      // and Postgres refuses the whole batch (23502), on every pass, for ever. That is a
      // till's entire ticket history stuck behind rows that are individually fine.
      //
      // An absent tender reads as cash everywhere else in the app (see isCashTicket), so
      // state it explicitly here rather than leaning on a default that is not in play.
      if (item.tableName === 'tickets' && supabasePayload.tender == null) {
        supabasePayload.tender = 'cash';
      }

      // qr_payload is `TICKET|<id>|<amount>|<created_at>` — three columns already on the
      // row, restated as ~60 bytes of text on every ticket. A restaurant doing 3,000 a day
      // spends tens of megabytes a year storing that repetition inside a 500 MB budget, so
      // it is not sent; a till that needs it rebuilds it (see ticketQrPayload).
      //
      // Deleted rather than nulled, which is the difference between the column being left
      // out of the INSERT entirely and being written as NULL. Note the ordering that
      // follows from it: the schema migration that makes qr_payload nullable has to be
      // applied BEFORE this build reaches a till, or every ticket is refused (23502). The
      // reverse pairing is harmless — an older till still sending the text writes it, and
      // a stored payload is always preferred over a rebuilt one.
      if (item.tableName === 'tickets') delete supabasePayload.qr_payload;

      return supabasePayload;
    };

    /**
     * Send one run of same-table, same-action rows as a single request.
     *
     * Removals have to be sent as removals. This branch used to be absent — every
     * queued row was upserted regardless of its action — so a DELETE would have
     * written the row straight back into the cloud instead of taking it out. Scoped by
     * account_id as well as id so a malformed queue entry can never reach beyond this
     * tenant.
     */
    const push = async (batch: OutboxBatch, rows: OutboxItem[]) => {
      if (batch.action === 'DELETE') {
        return supabase
          .from(batch.tableName)
          .delete()
          .in('id', rows.map((r) => r.payload.id))
          .eq('account_id', accountId ?? '');
      }
      // account_settings is keyed by account_id (one row per account); tickets by the
      // account plus the till-minted id, so a ticket number only has to be unique within
      // one restaurant; every other table by its client-generated uuid.
      const conflictKey =
        batch.tableName === 'account_settings'
          ? 'account_id'
          : batch.tableName === 'tickets'
            ? ticketConflictKey
            : 'id';

      // The audit log is immutable by design: the schema grants INSERT and SELECT and
      // deliberately no UPDATE, so RLS denies the UPDATE half of an ordinary upsert. Any
      // audit row the cloud already holds — one re-sent after a dropped connection, or
      // re-queued by the backfill sweep — was therefore refused with a 42501 that no
      // number of retries could ever satisfy, and it sat in the queue for good.
      // ignore-duplicates turns the write into ON CONFLICT DO NOTHING, which is the
      // correct semantics for an append-only log and needs no UPDATE right.
      const ignoreDuplicates = batch.tableName === 'audit_logs';

      return supabase
        .from(batch.tableName)
        .upsert(rows.map(toCloudRow), { onConflict: conflictKey, ignoreDuplicates });
    };

    /**
     * push(), plus the one-time correction for a project whose ticket key has not been
     * migrated yet (or a build that predates the migration). Nothing is charged to the
     * rows for it: the statement was malformed for this database, which is not their
     * fault, and the immediate retry is the same request with the right target.
     */
    const pushRows = async (batch: OutboxBatch, rows: OutboxItem[]) => {
      const result = await push(batch, rows);
      if (batch.tableName !== 'tickets' || !isConflictTargetMismatch(result.error)) return result;

      ticketConflictKey = ticketConflictKey === 'id' ? 'account_id,id' : 'id';
      console.info(
        `[Sync Store] Cloud does not accept that ticket conflict target; using "${ticketConflictKey}" from here on`
      );
      return push(batch, rows);
    };

    /**
     * Whether to abandon the whole pass. An RLS rejection only means "signed out" if
     * the session really is gone; otherwise it is the row's scope that is wrong, and
     * saying so is more useful than blaming the credentials.
     */
    const classify = async (error: { code?: string; message?: string }, tableName: string) => {
      if (isSessionFailure(error) || (isRlsViolation(error) && !(await hasCloudSession()))) {
        console.warn(
          '[Sync Store] Cloud authorisation lost mid-sync; queue left intact:',
          error.message
        );
        set({
          isSyncing: false,
          cloudConnected: false,
          cloudError: `The cloud rejected this till's credentials (${error.message}). Your work is queued safely — reconnect with the admin PIN to send it.`,
        });
        return 'session-lost' as const;
      }
      if (isRlsViolation(error)) {
        set({ cloudError: await explainRefusal(error, tableName, accountId) });
      }
      return 'row-fault' as const;
    };

    /**
     * The link went down mid-pass. Nothing here was judged on its merits, so the rows
     * are left exactly as they are — still due, no retry charged, no backoff — and the
     * pass stops rather than grinding through the rest of the queue against a
     * connection that has just proved it is gone. The background loop retries within
     * seconds, so a brief dropout costs seconds instead of parking the backlog behind
     * timers it never earned.
     */
    const abortTransient = async (error: { message?: string }): Promise<PassOutcome> => {
      console.warn(
        '[Sync Store] Connection lost mid-sync; queue left intact and retried shortly:',
        error.message
      );
      const { total, stuck, topError } = await dbService.countUnsyncedOutbox();
      set({ isSyncing: false, pendingCount: total, stuckCount: stuck, queueFault: topError ?? null });
      return 'retry-soon';
    };

    const fail = async (item: OutboxItem, error: { message?: string }, quiet = false) => {
      // One genuinely rejected record (schema mismatch, missing FK, etc.) must never
      // block every other queued ticket/shift/expense behind it. Back it off
      // exponentially and carry on — it keeps its place in the queue and is surfaced as
      // "stuck" rather than being dropped. Only real rejections reach here: a dropped
      // connection is caught by isTransientFailure above and charged to nobody.
      const reason = error?.message ?? String(error);
      // `quiet` is for a whole run refused for one reason: naming each of 400 rows
      // individually says nothing the one summary line above did not, and buries every
      // other message in the console under hundreds of identical lines.
      if (!quiet) {
        console.error(
          `[Sync Store] Sync failed for ${item.tableName} record ${item.id} (attempt ${item.retryCount + 1}):`,
          reason
        );
      }
      await dbService.markOutboxAttemptFailed(item.id, item.retryCount, reason);
    };

    for (const batch of batchOutbox(items)) {
      const { send, superseded } = dedupeBatch(batch.items);
      const { error } = await pushRows(batch, send);

      if (!error) {
        // Superseded rows are acknowledged too: the record they described was sent, in
        // its newer form, by this very request.
        await dbService.markOutboxSyncedMany([...send, ...superseded].map((i) => i.id));
        continue;
      }

      if (isTransientFailure(error)) return abortTransient(error);
      if ((await classify(error, batch.tableName)) === 'session-lost') return 'session-lost';

      // Nothing about this rejection points at a particular row, so every row in the run
      // would fail it identically. Charge the run once and move on: splitting it up
      // would mean one request per queued record, every pass, to learn nothing.
      if (!isRowSpecificFailure(error)) {
        console.warn(
          `[Sync Store] Whole ${batch.tableName} batch of ${send.length} refused (${error.code ?? 'no code'}: ${error.message}); not splitting — every row fails the same way`
        );
        // A conflict with a row this session cannot see is repaired in SQL, against
        // specific ids (see the REPAIR section of supabase_schema.sql). Naming them is
        // the difference between a repair someone can actually run and a hunt through
        // the whole table, and the till can never print them any other way — it cannot
        // read the offending rows back at all.
        if (isConflictWithInvisibleRow(error)) {
          const ids = send.slice(0, 20).map((i) => String(i.payload?.id));
          console.warn(
            `[Sync Store] ${batch.tableName} id(s) the cloud holds under another account: ` +
              `${ids.join(', ')}${send.length > ids.length ? `, +${send.length - ids.length} more` : ''}`
          );
        }
        for (const item of send) await fail(item, error, true);
        continue;
      }

      // The batch was rejected, but at most a few of its rows are actually at fault.
      // Re-send them individually so one bad record is isolated and charged, and every
      // other row in the run still reaches the cloud on this pass rather than
      // inheriting a backoff it did not earn.
      if (send.length === 1) {
        await fail(send[0], error);
        continue;
      }

      console.warn(
        `[Sync Store] Batch of ${send.length} ${batch.tableName} row(s) rejected (${error.message}); retrying individually to isolate the cause`
      );

      const deliveredRecords = new Set<string>();
      const acknowledge: string[] = [];

      for (const item of send) {
        const { error: rowError } = await pushRows(batch, [item]);
        if (!rowError) {
          acknowledge.push(item.id);
          deliveredRecords.add(String(item.payload?.id));
          continue;
        }
        if (isTransientFailure(rowError)) {
          // Acknowledge whatever did land before the link dropped, then stop.
          await dbService.markOutboxSyncedMany(acknowledge);
          return abortTransient(rowError);
        }
        if ((await classify(rowError, batch.tableName)) === 'session-lost') {
          await dbService.markOutboxSyncedMany(acknowledge);
          return 'session-lost';
        }
        await fail(item, rowError);
      }

      // A superseded row is only accounted for once its successor actually lands. If
      // that successor was the one the cloud rejected, the older snapshot has to stay
      // queued behind it rather than being quietly discarded.
      for (const item of superseded) {
        if (deliveredRecords.has(String(item.payload?.id))) acknowledge.push(item.id);
      }
      await dbService.markOutboxSyncedMany(acknowledge);
    }

    // Housekeeping, occasionally: acknowledged rows are never read again, but they were
    // kept forever and every "is this still owed?" lookup had to walk past them.
    if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
      lastPrune = Date.now();
      const dropped = await dbService.pruneSyncedOutbox();
      if (dropped) console.info(`[Sync Store] Pruned ${dropped} acknowledged outbox row(s)`);
    }

    // Re-fetch remaining outbox queue size
    const remaining = await dbService.getPendingOutbox();
    const { total, stuck, topError } = await dbService.countUnsyncedOutbox();
    if (topError && total) {
      console.warn(
        `[Sync Store] ${total} row(s) still queued; ${topError.count} of them share one reason: ${topError.reason}`
      );
    }
    set({
      pendingCount: total,
      stuckCount: stuck,
      queueFault: topError ?? null,
      pendingItems: remaining,
      isSyncing: false,
      lastSyncedAt: new Date().toISOString(),
    });
    return 'drained';
  } catch (e: any) {
    console.error('[Outbox Sync Worker Exception]:', e.message || e);
    set({ isSyncing: false });
    // A thrown fetch (rather than a returned error) is the other face of a dropped
    // connection, so it gets the same treatment: nothing charged, retried shortly.
    return isTransientFailure({ message: e?.message }) ? 'retry-soon' : 'skipped';
  }
}

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  cloudConnected: false,
  cloudError: null,
  pendingCount: 0,
  stuckCount: 0,
  queueFault: null,
  isSyncing: false,
  pendingItems: [],
  lastSyncedAt: undefined,

  checkOutbox: async () => {
    await dbService.init();
    const pending = await dbService.getPendingOutbox();
    // Report everything still owed to the cloud, not just what is due for a retry right
    // now, so a row waiting out a backoff can never be displayed as "synced".
    const { total, stuck, topError } = await dbService.countUnsyncedOutbox();
    set({
      pendingCount: total,
      stuckCount: stuck,
      queueFault: topError ?? null,
      pendingItems: pending,
      isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
      cloudConnected: await hasCloudSession(),
    });

    // Automatically trigger self-contained background polling loop
    get().startBackgroundLoop();
  },

  triggerSyncWorker: async () => {
    // A pass already running is not a reason to skip this one: note that more work
    // arrived and the running pass will pick it up as soon as it lands.
    if (get().isSyncing) {
      resyncRequested = true;
      return;
    }

    // Bounded so a pathological write rate cannot keep one caller pushing forever;
    // the background loop is still there to catch whatever the last pass missed.
    let passes = 0;
    do {
      resyncRequested = false;
      if (await runSyncPass(set, get) !== 'drained') return;
    } while (resyncRequested && get().pendingCount > 0 && ++passes < 10);
  },

  forceSyncNow: async () => {
    await dbService.init();
    // Someone pressing sync is asserting the connection is good now, so the cached
    // "no session" answer from a moment ago must not be what decides this attempt.
    invalidateCloudSessionCache();
    // Clear every backoff first. Without this the button is a lie on exactly the
    // occasions it matters most: after a spell offline, most of the queue is sitting out
    // a multi-minute timer, so pressing sync did nothing visible and the count kept
    // trickling down on its own schedule.
    const revived = await dbService.revivePendingOutbox();
    if (revived) {
      console.info(`[Sync Store] Manual sync revived ${revived} parked row(s)`);
    }
    await get().checkOutbox();
    await get().triggerSyncWorker();

    // And pull, not just push. Someone pressing sync means "make this till agree with the
    // others *now*", which is a two-way statement — but this button only ever sent, so
    // whatever the other tills had written was still waiting on the background timer.
    //
    // Started, not awaited: the queue count is what the person is watching and it is
    // already accurate, so holding the button's spinner open for a pull of somebody else's
    // records would only make a working sync look slow. Imported here rather than at the
    // top of the file because realtimeSync imports this store, and a static import back
    // would close the loop.
    void import('../services/db/realtimeSync')
      .then(({ runCloudCatchUp }) => runCloudCatchUp({ revive: true }))
      .catch((e) => console.warn('[Sync Store] Manual sync could not pull from the cloud:', e));
  },

  startBackgroundLoop: () => {
    // Avoid double initialization of the background interval timer
    if ((globalThis as any)._syncStoreInterval) return;
    // No window means no till — a test or SSR context, where a timer that outlives the
    // caller only causes surprises. Every push path works without the loop; it is a
    // safety net, not the mechanism.
    if (typeof window === 'undefined') return;

    // Waiting out a poll interval after the connection returns is the most visible delay
    // there is — the operator can see the wifi is back while the badge still shows a
    // queue — so react to the event itself. `online` clears backoffs too: the network
    // coming back is exactly the new information those timers were waiting on.
    window.addEventListener('online', () => {
      set({ isOnline: true });
      void get().forceSyncNow();
    });

    // Returning to the till (or waking the machine) is the other moment the queue should
    // already be moving before anyone looks at it. No revive here — nothing about focus
    // says a rejected row will now be accepted.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      invalidateCloudSessionCache();
      void get().checkOutbox().then(() => get().triggerSyncWorker());
    });

    let ticks = 0;

    (globalThis as any)._syncStoreInterval = setInterval(async () => {
      const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
      set({ isOnline: online });

      if (!online || !isSupabaseConfigured) return;

      ticks++;
      try {
        // The queue is empty almost all the time — every write pushes itself the moment
        // it is queued — and counting rows in Dexie is far cheaper than the full status
        // refresh (which also re-checks the cloud session). So tick often for the sake
        // of rows waiting on a retry, and only pay for the full refresh occasionally.
        const { total } = await dbService.countUnsyncedOutbox();
        if (total === 0 && ticks % FULL_REFRESH_EVERY !== 0) return;

        await get().checkOutbox();
        if (get().pendingCount > 0 && !get().isSyncing) {
          await get().triggerSyncWorker();
        }
      } catch (e) {
        console.debug('[Sync Store] Background tick skipped:', e);
      }
    }, POLL_INTERVAL_MS);
  },
}));
