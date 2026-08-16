# Bug Fix Log

Every bug we find and fix gets an entry here — what broke, what it looked like to a
user, why it happened, and how it was fixed. See rule 6 in `.agents/AGENTS.md`.

---

## 2026-08-16 — Backups couldn't be found from a replacement machine, and login gave one vague error for everything

**What the user saw:** Two separate problems, both in the "sign in on a different/new
till" path.

1. *Backups keyed so only the original device could find them.* Cloud snapshots were
   stored at `snapshots/<location>/<device>/latest.db`, but the restore only ever
   looked under the **locally configured** location. A brand-new or wiped till has
   never been configured, so its location was still the seeded default (`LOC01`) — if
   the real outlet used any other location id, the restore searched the wrong folder
   and reported "no cloud backup found", even though a perfectly good backup existed.
   The device id itself was fine (it was already the last path segment), but nothing
   made the machine look in the right *location* folder for the account it just
   signed in as.
2. *Every login failure showed the same sentence.* Wrong PIN, wrong password, an
   account that simply doesn't exist on this machine yet, being offline, a browser
   with crypto disabled (plain `http://`), a deactivated account — all of them
   collapsed to **"Invalid email address, password, or PIN."** On a till, a cashier
   couldn't tell "you fat-fingered the PIN" from "this machine has never seen your
   account and needs the internet to pull it down" — completely different fixes.

**Root cause:**
1. `restoreFromCloud()` derived its search root purely from `_locationId` (local
   device config) and only scanned for `latest.db`. It never consulted the signed-in
   cloud account's own location metadata, and never widened the search when the local
   guess came up empty.
2. `loginUser()` returned a bare `boolean`, and the only "account not found" branch
   just incremented the fail counter and returned `false` — there was no attempt to
   pull an unknown account down from the cloud, and no structured reason for the UI to
   render. Separately, the `db-backups` storage bucket only had an INSERT policy, so
   even a correctly-located restore would have been denied read access (and every
   overwrite of `latest.db` was silently rejected too).

**Fix:**
- `src/utils/backupPaths.ts` (new) — pure addressing module. Snapshot keys are
  location-first, device-last; segments are normalised (case-stable, no injected path
  separators) so the same place never splits into two folders; helpers pick the newest
  snapshot deterministically and list candidate location folders. Fully unit-tested.
- `src/services/db/SqliteDbService.ts` — restore now resolves the location from the
  **signed-in cloud account** first, then the local config, then falls back to
  scanning *every* location folder in the bucket. It considers any `*.db` (not just
  `latest.db`), so a till whose hot-snapshot upload failed is still recoverable from
  its last daily copy. Blocked listings now throw the real Supabase error instead of
  looking like "no backup".
- `src/services/auth/loginErrors.ts` (new) — one code per distinct failure with an
  exact message + actionable hint. Unit-tested to guarantee no two reasons collapse to
  the same sentence and the old generic message never reappears.
- `src/store/useAuthStore.ts` (`loginUser`) — now returns a structured `LoginResult`.
  An unknown account triggers a real cloud adoption path (authenticate → restore
  snapshot → fall back to the synced `users` row), rather than being reported as a bad
  password. Only genuinely-rejected credentials count toward the lockout; being
  offline or unconfigured does not. Deactivated accounts are named as such.
- `src/components/auth/AuthPage.tsx` — the error banner now shows the specific reason
  plus its hint, and a successful cross-machine restore shows a "restored from cloud"
  confirmation.
- `supabase_schema.sql` — added SELECT (needed for any restore) and UPDATE (needed for
  `upsert`-overwriting `latest.db`) storage policies on `db-backups`, and creates the
  bucket up front so the first backup has somewhere to land.

**Verified:** `src/tests/backupPaths.test.ts` (9) and `src/tests/loginErrors.test.ts`
(6) added; full suite now 34/34 green (was 19) and `tsc --noEmit` clean. App boots to
the till with no new console errors from these changes.

**Still to confirm on real hardware:** on a genuinely fresh machine (different
`deviceId`, cloud location different from `LOC01`), sign in with the admin email + PIN
and confirm the account + data restore from the cloud snapshot, and that a wrong PIN
now reads "That PIN does not match…" rather than the old three-in-one message.

---

## 2026-08-16 — Leftover demo/placeholder data visible in the real app

**What the user saw:** Opening a new shift pre-filled the cashier name as "Main
Cashier" and the starting cash as 5000 — real values, not just hint text, so it was
easy to accidentally start a real shift under a fake name with a made-up float. The
Manager Dashboard's location panel also permanently showed a second, entirely made
up outlet ("Danbaiwa Annex (Outlet #2)", ₦48,500 in sales) that doesn't exist.

**Root cause:** These were leftover values from early development/demo builds that
never got cleaned up before real usage.

**Fix:**
- `src/components/shift/OpenShiftModal.tsx` — the cashier name now defaults to
  whoever is actually logged in, and the starting cash field starts empty so it has
  to be entered on purpose.
- `src/components/manager/ManagerDashboard.tsx` — removed the fabricated second
  outlet; the location panel now only ever shows this till's real location.

**Also caught while checking this:** the cloud backup process was reporting
"backup complete" in the console even when the upload had actually failed (missing
folder, no permission, etc.) — it just wasn't checking whether Supabase actually
said yes. Fixed in `src/services/db/SqliteDbService.ts` so a failed backup is now
reported as a failure, not silently logged as a success. This is what made the
empty snapshots folder confusing to diagnose earlier — the logs were lying.

**Verified:** Logged in as a test admin, opened the shift dialog and confirmed both
fields now behave correctly, and confirmed the Manager Dashboard only shows the one
real location. Typecheck and full test suite (19/19) pass.

**Not yet resolved — flagged, not fixed:** the "All Cashiers / CASHIER-01 (Main
Till) / CASHIER-02 (Mobile Scanner)" filter dropdown on the Manager Dashboard is
also fake — picking an option doesn't actually filter anything. Left as-is pending
a decision on whether to wire it up for real or remove it.

---

## 2026-08-16 — Sync got permanently stuck after the first logout ("Sync pending" never clears, nothing backs up to the cloud)

**What the user saw:** The manual sync button did nothing. The "Sync (N pending)"
badge stayed stuck showing pending items even with a good internet connection for
several minutes. The Supabase storage folder stayed empty — no backups ever
appeared.

**Root cause:** Two things stacked on top of each other:

1. Logging out of the till calls Supabase's real sign-out, which destroys the
   till's connection to the cloud. The normal day-to-day login (typing your PIN)
   never reconnects it — only the one-time account-creation step ever did. So the
   very first time anyone hit "Log Out" on this till, cloud sync and cloud backups
   silently stopped working for good, with no error shown anywhere in the app.
2. On top of that, whenever any single queued item failed to sync for any reason,
   the sync worker gave up on the entire batch rather than skipping just that one
   item — so even after reconnecting, one bad record could jam every ticket, shift,
   and expense behind it in the queue, forever.

**Fix:**
- `src/store/useAuthStore.ts` (`loginUser`) — logging in with your PIN now quietly
  reconnects to the cloud in the background, the same way the original account
  setup did. Never blocks or slows down local login, even if offline.
- `src/store/useSyncStore.ts` (`triggerSyncWorker`) — a failing item is now retried
  a few times and then set aside instead of blocking everything queued behind it.
- `src/services/db/SqliteDbService.ts` / `IDbService.ts` / `LocalStorageDbService.ts`
  — added the bookkeeping (`markOutboxAttemptFailed`) needed to track and set aside
  those repeatedly-failing items.

**Verified:** Confirmed against the real Supabase project that logging out clears
the cloud connection, and that the same reconnect step the fix uses (Supabase
sign-in) successfully restores it. Full sign-in path double-checked as reachable
and correctly wired. Typecheck and full test suite (19/19) pass.

**Still to confirm:** please log out and log back in once on the real till, then
watch the "Sync (N pending)" badge clear and check that a `latest.db` file shows up
in the `db-backups` bucket in Supabase — that's the true end-to-end proof.

---

## 2026-08-16 — Anyone could create themselves an Admin account from the login screen

**What the user saw:** N/A — found during a pre-launch check, before it caused a
visible incident.

**Root cause:** The login screen's "Create Account" option was available at all
times, to anyone, with no restriction — and it included a dropdown letting the
person creating the account pick "Primary Admin / Manager" for themselves. There
was nothing stopping a customer or anyone else who reached the till from granting
themselves full admin access (voiding tickets, managing staff, etc.).

**Fix:** Account self-registration now only works during true first-time setup —
the very first account ever created on a given till. Once any account exists,
"Create Account" disappears from the login screen entirely, and the role picker is
gone too (first-time setup always creates the one primary Admin; all other staff
accounts must be added afterward by that logged-in Admin from the dashboard, which
already existed and was already properly locked down).
`src/store/useAuthStore.ts`, `src/components/auth/AuthPage.tsx`.

**Verified:** Confirmed "Create Account" shows on a brand-new till with zero
accounts, and confirmed it fully disappears — leaving only the login form — as soon
as one account exists.

---

## 2026-08-16 — New accounts could vanish after closing the app ("invalid details" on return)

**What the user saw:** Create an account, close/reload the app shortly after, come
back later, and login says the details are invalid — even though the account was
created successfully moments earlier.

**Root cause:** The local database keeps a durable "journal" of every pending write
in the browser's IndexedDB, as a safety net in case the app closes before its next
periodic full save. On the next app launch, that journal is supposed to be replayed
back into the database. The replay code wrapped the whole replay in one transaction,
but each journaled entry *already* contained its own transaction markers, so SQLite
rejected it with "cannot start a transaction within a transaction" — and the replay
failed **every single time** there was anything in the journal (which includes right
after any brand-new signup). Worse, the code cleared the journal and saved a new
snapshot even when the replay had just failed, permanently discarding whatever was
queued — including newly created accounts.

**Fix:** `src/services/db/SqliteDbService.ts` (`init()`, WAL replay block) — skip the
redundant per-entry transaction markers during replay instead of nesting them, and
only clear the journal / save a new snapshot when replay actually succeeded.

**Verified:** Created a user record, reloaded immediately (before the normal 5s
autosave would have run), and confirmed the account was still there and login-able
after reload — reproduced the original failure first, then confirmed the fix holds
across repeated reloads.

---

## 2026-08-16 — App stuck forever on "Initializing POS Till..." screen

**What the user saw:** Before the fix above, the app also regressed to never
finishing its startup — permanently stuck on the loading spinner, or (in an earlier
version of the app) skipping straight past login into the till with authentication
never having actually run.

**Root cause:** `vite.config.ts` excluded the `sql.js` database engine from Vite's
dependency pre-bundling step. That pre-bundling step is what normally converts
older-style JS modules into something the browser can `import` correctly. Without
it, importing `sql.js` in the browser silently resolved to an empty, broken module,
so the database could never start up — which meant the part of the app that checks
"is anyone logged in" never finished running either.

**Fix:** Removed the `optimizeDeps.exclude: ['sql.js']` line from `vite.config.ts`
so Vite processes the package normally.

**Verified:** Reloaded the app and confirmed the login screen now renders normally
with no console errors, full test suite (19/19) still passes, and typecheck is clean.

---

## 2026-08-16 — Password reset could be used to take over a different account

**What the user saw:** N/A — found during a code review before it caused a visible
incident.

**Root cause:** The "reset your password" screen had an email field that was meant
to just display whose account you were resetting, but it was actually editable and
the app trusted whatever was typed into it. Meanwhile, the part that actually
verifies who you are (via the email link you clicked) was handled separately and
never cross-checked against that field. So someone could request a legitimate
password reset for their *own* account, then simply retype a different person's
email into that field, and the app would overwrite that other person's saved
password and PIN — and log the attacker straight in as them.

**Fix:** `src/store/useAuthStore.ts` (`updatePasswordAfterRecovery`) — the account
being reset is now always taken from the verified, logged-in reset session, never
from the editable form field. `src/components/auth/AuthPage.tsx` — that field is
now read-only. Also removed a related issue where, if no matching account could be
found, the app would create a brand-new account and default it to Admin access
instead of refusing.
