/**
 * tenantMismatch.test.ts
 *
 * The failure a till reports as "hundreds queued, barely moving":
 *
 *   new row violates row-level security policy (USING expression) for table "tickets"
 *
 * The "(USING expression)" half is the whole diagnosis. Plain "violates row-level
 * security policy" means the row being written was rejected; the USING variant is raised
 * only on the ON CONFLICT branch of an upsert, and means a row with that primary key
 * already exists and the policy will not let this session see or update it. No number of
 * retries can change that, and the till cannot even read the offending rows to find out
 * why — so the one useful thing the app can do is say which of the two situations it is
 * in, precisely, instead of guessing at a location that stopped being security-relevant
 * when account scoping landed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';

const STAMPED_ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';

let sessionValue: any = { access_token: 'valid', user: { id: STAMPED_ACCOUNT } };
let upsertError: { code?: string; message: string } | null = null;
/** What the database's own current_account_id() answers for this session. */
let serverAccountId: string | null = STAMPED_ACCOUNT;

vi.mock('../services/supabase/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: sessionValue } })),
      getUser: vi.fn(async () => ({ data: { user: { id: STAMPED_ACCOUNT, user_metadata: {} } } })),
    },
    rpc: vi.fn(async (fn: string) =>
      fn === 'current_account_id' ? { data: serverAccountId, error: null } : { data: null, error: null }
    ),
    from: vi.fn(() => ({
      upsert: vi.fn(async () => ({ error: upsertError })),
    })),
  },
}));

import { useSyncStore } from '../store/useSyncStore';
import { IndexedDbService } from '../services/db/IndexedDbService';
import { Ticket } from '../types/ticket';

const ticket: Ticket = {
  id: 'LOC01-DEV01-000001',
  locationId: 'LOC01',
  deviceId: 'DEV01',
  localSeq: 1,
  amount: 500,
  currency: '₦',
  status: 'paid',
  cashierId: 'cashier-1',
  createdAt: '2026-09-01T12:00:00.000Z',
  qrPayload: 'TICKET|1|500',
};

const conflictWithInvisibleRow = {
  code: '42501',
  message: 'new row violates row-level security policy (USING expression) for table "tickets"',
};

describe('tenant mismatch diagnosis', () => {
  let svc: IndexedDbService;

  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    svc = new IndexedDbService();
    await svc.init();
    sessionValue = { access_token: 'valid', user: { id: STAMPED_ACCOUNT } };
    serverAccountId = STAMPED_ACCOUNT;
    upsertError = null;
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true },
      configurable: true,
      writable: true,
    });
    useSyncStore.setState({ isSyncing: false, pendingCount: 0, stuckCount: 0, cloudConnected: false });
  });

  it('names the account disagreement when the cloud resolves this till differently', async () => {
    // A revoked or deleted enrolment: the till authenticates perfectly, stamps its rows
    // for the account it was enrolled to, and the server resolves it to something else —
    // so it can neither write nor read that account's data, with nothing in the app
    // previously able to say so.
    serverAccountId = OTHER_ACCOUNT;
    await svc.saveTicket(ticket);
    await useSyncStore.getState().checkOutbox();

    upsertError = conflictWithInvisibleRow;
    await useSyncStore.getState().triggerSyncWorker();

    const error = useSyncStore.getState().cloudError ?? '';
    expect(error).toContain(STAMPED_ACCOUNT.slice(0, 8)); // what this till stamps
    expect(error).toContain(OTHER_ACCOUNT.slice(0, 8)); // what the cloud thinks it is
    expect(error).toMatch(/PIN/i); // and the way out
  });

  it('says the records already exist elsewhere when the accounts do agree', async () => {
    // Same refusal, but the session's account is exactly what the rows are stamped with:
    // the rows in the cloud are the ones owned by somebody else, so this needs a repair
    // in Supabase rather than anything the till can do.
    serverAccountId = STAMPED_ACCOUNT;
    await svc.saveTicket(ticket);
    await useSyncStore.getState().checkOutbox();

    upsertError = conflictWithInvisibleRow;
    await useSyncStore.getState().triggerSyncWorker();

    const error = useSyncStore.getState().cloudError ?? '';
    expect(error).toMatch(/already holds these tickets records under a different account/i);
    expect(error).toMatch(/supabase_schema\.sql/);
  });

  it('keeps the row queued and the session healthy through all of it', async () => {
    serverAccountId = OTHER_ACCOUNT;
    await svc.saveTicket(ticket);
    await useSyncStore.getState().checkOutbox();

    upsertError = conflictWithInvisibleRow;
    await useSyncStore.getState().triggerSyncWorker();

    // Never dropped, and never mistaken for a dead session — the credentials are fine.
    const [row] = await db.outbox.toArray();
    expect(row.status).toBe('pending');
    expect(useSyncStore.getState().cloudConnected).toBe(true);
    expect(useSyncStore.getState().pendingCount).toBe(1);
  });
});
