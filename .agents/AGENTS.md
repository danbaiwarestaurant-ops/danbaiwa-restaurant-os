# Project Rules & Guidelines — Ticket POS (Danbaiwa Restaurant OS)

## 1. MANDATORY UNIT TESTING (VITEST)
- **Vitest First Principle**: All core business logic (PIN hashing, RBAC role checks, user management, composite key generation, shift float reconciliation, cash variance math, and outbox idempotency formatting) MUST be covered by unit tests in `src/tests/` running via `npm run test`.
- **Zero Regression Policy**: Never break or bypass Vitest suite before declaring any feature or bug fix complete.

## 2. SECURITY & ZERO HARDCODED CREDENTIALS RULE
- **CRITICAL**: ABSOLUTELY NO hardcoded PINs, passwords, or fallback credentials anywhere in source code (e.g. no `DEFAULT_PINS = '9999'`).
- **Dynamic Account Management**: System initializes via a First-Launch Admin Setup screen on first boot where the venue owner creates the primary Admin account.
- **Salted Hashing**: All user PINs (Admin and Staff Cashiers) are hashed using `crypto.subtle.digest('SHA-256', salt + pin)` with a unique 16-byte cryptographically random salt generated via `crypto.getRandomValues()`.
- **Stored in IndexedDB Only**: Hashes and salts are stored strictly in the local IndexedDB `users` table (via Dexie — `id`, `name`, `username`, `role`, `pin_hash`, `pin_salt`, `created_at`, `status`).

## 3. SUPABASE CLOUD SYNC FOR ALL DATA (OUTBOX PATTERN)
- **Full Outbox Coverage**: ALL local database mutations across ALL tables (`users`, `tickets`, `shifts`, `expenses`, `audit_logs`) MUST be written to `sync_outbox` in the exact same database transaction.
- **Idempotency Keys**: All outbox payloads use client-generated UUID primary keys (`id`) to ensure 100% replay-safe idempotent upserts on Supabase Postgres backend.
- **Background Outbox Worker**: Polling worker (5s interval when online) drains `sync_outbox` to Supabase without blocking the main UI thread.

## 4. CODE ARCHITECTURE & STYLING
- **Component-Based Architecture**: Modular organization (`src/components/`, `src/store/`, `src/services/`, `src/hooks/`, `src/types/`, `src/utils/`, `src/tests/`).
- **Light Mode POS Aesthetics**: High-contrast light slate theme (`#f8fafc` background, `#ffffff` panels, `#e2e8f0` borders, `#0f172a` typography, `#f59e0b` amber accents, `#10b981` status badges).
- **Strict 90-Degree Zero Radius (`rounded-none`)**: NO rounded corners on any elements — crisp industrial POS edges across all cards, modals, buttons, and ticket stubs.

## 5. MANDATORY DEEP END-TO-END FUNCTIONAL TESTING RULE
- **Complete End-to-End Life-Cycle Verification**: When testing a feature or bug fix, verifying UI rendering or page navigation alone is NOT sufficient. You MUST verify the complete end-to-end functional lifecycle down to the final target outcome (e.g. for password/PIN resets: verify credential update in database, verify old password/PIN is rejected, and verify logging in with the new password/PIN authenticates the user and hydrates their session).

## 6. MANDATORY BUG DOCUMENTATION RULE
- **Log Every Bug You Fix**: Whenever a bug is found and fixed, add an entry to `BUGFIXES.md` (project root) before considering the work done. This applies whether the bug was reported by the user or discovered while working on something else.
- **What to write**: what broke, what the user actually saw, the root cause, the fix, and the file(s) touched. Written so someone with no memory of this conversation can understand it later.
- **Why this rule exists**: so the same bug never gets silently reintroduced or re-debugged from scratch months later.

---

# Load-Bearing Invariants

Things that are easy to break by accident because nothing in the type system stops
you. Each one has already cost a real bug. Read this section before touching auth,
reporting, shifts, sync, or printing.

## 7. THE CLOUD PASSWORD IS ALWAYS DERIVED FROM THE PIN
`deriveSupabasePassword(pin)` in `src/services/supabase/supabaseClient.ts` is the
**only** thing that turns a local PIN into a Supabase Auth password. Every path that
changes an admin's PIN — first registration, PIN change in settings, recovery-key
reset, email-link password reset — **must** also call
`updateSupabaseUserPassword(deriveSupabasePassword(newPin))` in the same flow.

If it doesn't, the local PIN and the cloud password drift apart, the till can no
longer re-authenticate on the next login, and the app silently degrades to
"Not Signed In to Cloud" — local writes keep queueing in the outbox and nothing ever
reaches Supabase. This failure is invisible until someone checks the sync badge.

**Device enrolment is not the staff session.** Ordinary "Log Out" at the till ends the
staff session only — it must **not** call `supabase.auth.signOut()`. The Supabase
credential is derived from the admin PIN, so signing out strands the till on "Not
Signed In to Cloud" with a queue nobody at the counter can clear until an admin comes
and types that PIN. Only the console's explicit **System Logout**
(`logoutUser({ unenrolDevice: true })`) disconnects the device, for handing a till on
or decommissioning it. The retained session grants nothing the machine did not
already have: the whole local database is already on it, and the session's reach is
exactly that same account.

**Known limitation, deliberately accepted:** a recovery key used while **offline**
restores access to the till but *cannot* realign the cloud password (there is no
session to change it through). `recoverAdminPinWithKey` returns `cloudRealigned` so
the UI can say so, and the dialog does say so. The emailed reset restores both.

## 8. NO ALL-TIME NUMBERS ANYWHERE IN THE CONSOLE
Every figure in the manager console belongs to an explicit, navigable reporting
window. There is no "all-time" total, summary, or record list, by design — the owner
asked for this specifically and it should not creep back in.

- `src/utils/period.ts` — the model. `PeriodUnit = 'day' | 'week' | 'month' | 'year'`,
  a `Period { unit, start, end, label }`, and pure helpers (`periodFor`,
  `shiftPeriod`, `withUnit`, `periodContains`, `filterByPeriod`, `periodBuckets`,
  `bucketNoun`). Weeks are **Monday-based**. All boundaries are **local time**, never
  UTC — a UTC day boundary misfiles the evening's takings in Lagos.
- `src/store/useConsolePeriodStore.ts` — one period shared by every console view.
  It persists **only the unit**, never the anchor. Persisting the anchor means
  reopening the console in October silently lands you on an empty August.
- `src/components/manager/PeriodPicker.tsx` — `DAY | WEEK | MONTH | YEAR`, `◀ label ▶`,
  and a reset to the present. "Next" is disabled at the present period.
- **`withUnit` must preserve the present.** It is
  `periodFor(unit, isCurrentPeriod(p, now) ? now : p.start)`. Naively anchoring on
  `p.start` means Month → Year → Month lands on *January*, silently blanking the
  console. There is a round-trip test for this; keep it.
- Anything actionable that falls **outside** the window must still be surfaced as a
  `+N older` hint (see Overview's Needs Attention) — the window narrows reporting, it
  must not hide work.

## 9. THE MANAGER CONSOLE IS ALWAYS ACCOUNT-WIDE
The console is the account's books. It loads the whole account regardless of which
cashier happens to be signed in at the till (`App.tsx`, the `isManagerView` branch of
the data-loading effect). A console scoped to the signed-in cashier would report the
month's revenue as whatever that one person took.

Entering the console requires the admin PIN, and that unlock grants
`hasAdminAuthority` in `useAuthStore`. Admin-only actions inside the console check
**that flag**, not `activeUser.role` — the owner is legitimately standing at a till
that a cashier is signed into. `assertAdminRole()` passes on either.

## 10. PIN ENTRY AND THE TWO PIN SCOPES
`openPinModal(purpose, onVerify, scope)` where `scope` is:

- `'admin'` (default) — only an admin PIN matches. Manager mode, voids, staff
  changes, recovery-key issue.
- `'session'` — the **signed-in user's own** PIN also matches (admin PINs still work,
  so a manager can take over a locked till). Used by Lock Till and the 5-minute idle
  auto-lock. Before this existed, the idle timer locked a lone cashier out of their
  own till until the owner walked over.

`PinModal` **auto-submits**: a PIN is attempted ~420ms after the last digit, silently,
with a settle delay before showing an error, and PINs are 4–8 digits so the dot
display is `Math.min(8, Math.max(4, pin.length))`. There is no requirement to tap
ENTER. When re-opening the modal with a new PIN programmatically, **clear `error`
first** — stale error state blocks auto-submit and strands the user on a keypad that
does nothing.

In `'session'` scope the modal is a **screen lock**: titled "Till Locked", it names
who is signed in, has no ESC button, and Escape does not dismiss it. A lock you can
walk past is not a lock.

## 11. SHIFT RECONCILIATION SCOPES TICKETS TO THE SHIFT
Expected cash for a shift is **not** the sum of every ticket in the store. Use
`shiftTickets(tickets, shift)` / `shiftExpenses(...)` from `src/utils/analytics.ts`,
which filter by `cashierId` **and** the `openedAt … closedAt` window. Both
`useShiftStore.closeShift` and `CloseShiftModal`'s live preview must use them, or
every shift is reconciled against lifetime revenue.

`reconcileShift` on a **closed** shift returns what the close-out *recorded*, never a
recomputation. Re-deriving it later would quietly rewrite history when a backdated
ticket syncs in.

Also: `closeShift` must reload with the shift's own cashier
(`loadShift(shift.cashierId)`), not an unscoped `loadShift()`.

## 12. DELETES MUST REACH THE CLOUD, AND STAFF DELETION IS REFUSED, NOT WARNED
- `useSyncStore` has an explicit **DELETE branch** (`.delete().eq('id',…).eq('account_id',…)`).
  Every queued row used to be upserted regardless of action, so deletions came back on
  the next pull. Any new destructive mutation must queue `action: 'DELETE'` and be
  handled there.
- Staff deletion is only permitted when the person owns **no** tickets, shifts,
  expenses or audit entries (`countRecordsForUser`). Nothing cascades, so deleting a
  cashier with history would orphan the books. The dialog counts first and either
  refuses — listing what they own and offering **Deactivate Instead** — or requires
  typing the person's name. Deactivated staff stay in `users` (`loadUsers` no longer
  filters to active); `switchCashierSession` rejects non-active accounts.

## 13. RECOVERY KEYS
`src/utils/recoveryKey.ts` — format `DANB-XXXX-XXXX-XXXX`, Crockford base32
(`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, no I/L/O/U). `normaliseRecoveryKey` maps
I/L→1 and O→0 and strips punctuation, so a key read off paper still works.

- Issued at registration and shown **once** by `RecoveryKeyNotice`, gated behind an
  "I have written this key down" checkbox. Re-issue lives in Settings →
  `RecoveryKeySettings`, behind the admin PIN.
- Keys are **single-use**: consuming one sets `recoveryKeyHash` to **`null`**, never
  `undefined`. `JSON.stringify` drops `undefined`, so an undefined never reaches
  Supabase, the column keeps the old hash, and the next pull *resurrects the spent
  key*. `User.recoveryKeyHash` is typed `string | null` for exactly this reason —
  the same trap applies to any other nullable column synced this way.
- Accounts created before keys existed have none. Existing owners must issue one.

## 14. RECEIPT PRINTING IS CUT TO CONTENT
`print-server.cjs` measures the rendered receipt and emits a PDF exactly that tall.
It used to emit a full A4 page (297mm) per ticket, wasting ~222mm of roll each time.

- `PRINT_WIDTH_MM` (default **58**), `PRINT_FEED_MM` (default **0**, raise only if the
  cutter needs slack). `PX_PER_MM = 96 / 25.4`.
- The measured element needs `overflow: hidden` so it forms a BFC and child margins
  don't collapse out of the measurement.
- `page.pdf({ width, height, margin: all 0mm })`, then `printer.print(…, { scale: 'noscale' })`.
  Any scaling reintroduces margins.
- `src/index.css`'s `@media print` block must stay in step (58mm, `padding: 0 1mm`,
  `html, body { margin: 0; padding: 0 }`).
- `renderReceiptPdf` is exported and `app.listen` is guarded by
  `require.main === module` so the renderer can be tested without a live server.

## 15. LOGIN ACCEPTS STAFF IDS, NOT JUST EMAILS
The identity field on `AuthPage` is `type="text"` with `inputMode="email"`. It was
`type="email"`, which made browser validation reject every non-email staff ID — so
cashiers could not sign in at all, and the failure looked like a form that ignored the
button. Do not "tidy" it back to `type="email"`.

## 16. CONSOLE NAVIGATION AND PLACEHOLDERS
`src/components/manager/consoleNav.ts` is the single source for tab ids, labels,
groups, titles and `periodScoped`. The sidebar, breadcrumb and topbar all read it, so
they cannot drift.

- **Live Tickets was removed** (the till already shows them; it was redundant in the
  back office). `ManagerConsole` reads a last-viewed id from `localStorage`
  (`ticket_pos_console_view`) — a saved id that no longer exists **must** fall back to
  Overview rather than rendering nothing.
- **Menu Management** and **Inventory** are deliberate "not set up yet" placeholders.
  A `Ticket` is a flat amount: there are no line items, product names or cost prices
  anywhere in the data model. Best-sellers, stock levels and profit margins cannot be
  built without a schema project first. Do not fabricate them.
- No router. View switching is `useState` + `localStorage`; adding a router is not
  justified by this.

## 17. THE SYNC WORKER SENDS BATCHES — ORDER AND ISOLATION ARE THE PRICE
`triggerSyncWorker` pushes **runs of rows per request**, not one row per request (which
made a 300-row backlog take 300 sequential round trips — the visible "pending count
trickling down" complaint). Three properties must survive any change to it:

- **Runs are contiguous** (`batchOutbox`). Group by table alone and a record's later
  DELETE can be sent before its earlier UPDATE, and the update recreates the row that
  was just removed. The queue's `createdAt` order carries meaning.
- **Repeat writes to one record are collapsed** (`dedupeBatch`, last wins). Postgres
  rejects an `ON CONFLICT` upsert whose payload touches the same row twice ("cannot
  affect row a second time"), which would fail a whole batch over a non-error. A
  superseded row is only acknowledged once its successor actually lands.
- **A rejected batch is retried row-by-row.** One bad record must be isolated and
  charged alone; the rest of the run must still reach the cloud on that pass rather
  than inheriting a backoff it did not earn. The existing rules still hold: a lost
  session aborts the pass and charges nobody, and no row is ever written off.

`forceSyncNow` (what the badge's click runs) additionally calls `revivePendingOutbox`
to clear backoff timers first. Without that the button does nothing on precisely the
occasions it gets pressed — after a hiccup, when most of the queue is parked behind a
timer of up to half an hour.

## 18. A TILL HAS ITS OWN CLOUD IDENTITY — THE TENANT KEY IS NOT `session.user.id`
A till enrols as its own Supabase auth user (`src/services/supabase/deviceIdentity.ts`)
and reaches the account's data through the `account_devices` membership row, so it can
restore its own session with nobody present. Consequences that are easy to break:

- **Never read the tenant key as `session.user.id`.** Go through `getAccountId()` /
  `resolveAccountId(session)`. A till's own auth id owns no rows in any table, so
  stamping data with it files that data under nothing — it would sync "successfully"
  into invisibility, hidden from the owner and every other device. Resolution is
  local-first (stored identity, then the `account_id` claim in the till's JWT) because
  rows are stamped as they are written, which happens offline constantly.
- **Only an owner session may enrol a device.** The membership row is inserted under
  the caller's own `auth.uid()`, so a till can neither enrol itself nor move itself to
  another account. `ensureDeviceEnrolled` returns null on a till session, by design.
- **Pre-flight before `signUp`.** Creating an auth user is not reversible from the
  client, so enrolment probes `account_devices` first. Without that, a project whose
  migration has not been run yet collects an orphan, unusable till user on every
  sign-in.
- **A till must never hold an owner credential.** Its password is random, not derived
  from any PIN. This is the property that makes a stolen till less dangerous than it
  used to be — previously an unlocked till carried a live owner session that could
  change the owner's own password.
- **`updateSupabaseUserPassword` refuses to run on a till session** (checks
  `user_metadata.kind === 'pos-till'`). Otherwise a PIN change would silently rewrite
  the *device's* credential, locking the till out of the cloud for good while the
  owner's account went unchanged.
- **Devices get no UPDATE policy on their own row.** Last-seen goes through the
  `touch_device_last_seen()` SECURITY DEFINER function; a self-updatable row would let
  a compromised till un-revoke itself or repoint its `account_id`.
- **Revocation is a server-side switch, not a client one.** `current_account_id()`
  stops matching, so a revoked till reads and writes nothing, immediately, with
  nothing to roll out to the device.
- **`current_account_id()` falls through to `auth.uid()`** for a session with no device
  row, which is what makes the whole migration behaviourally identical for an owner and
  safe to apply to a live account.

## 19. VERIFICATION PRACTICE (what has actually caught bugs here)
Rule 5 requires end-to-end verification; these are the specific traps in this app.

- Drive the real app with **Playwright** against a real signup, not fixtures.
- **Assert case-insensitively.** The POS aesthetic uses `text-transform: uppercase`,
  and `innerText` reflects it — `/Balanced/` and `indexOf('Cash Reconciliation')` both
  produce phantom failures.
- **Never `page.locator('svg').first()`** or bare `table tr`; the sidebar is full of
  lucide icons and there are several tables per view. Anchor on something specific
  (`svg[viewBox="0 0 700 190"]`, `table:has(th:has-text("Staff ID"))`).
- **`waitFor` the condition, never a fixed sleep.** PIN hashing is PBKDF2 and
  deliberately slow; fixed sleeps produce failures that are purely about timing.
- A Supabase test session mock needs `user.id`, or `getAccountId()` returns null and
  every row is stamped with an empty `account_id`.
- When a check fails, **prove which side is wrong** before changing product code —
  dump the Dexie row and the rendered DOM. Three "failures" in one session were the
  assertions, not the app.
