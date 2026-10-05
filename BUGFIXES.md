# Bug Fix Log

Every bug we find and fix gets an entry here — what broke, what it looked like to a
user, why it happened, and how it was fixed. See rule 6 in `.agents/AGENTS.md`.

---

## 2026-09-23 — PIN-only login was still blocked by the hidden legacy identity rule

**What staff would have seen:** the screen said “Staff PIN,” but pressing Login did
nothing unless the old email/staff-ID field was also populated.

**Root cause:** the submit handler switched to PIN-only authentication, but the legacy
identity input remained in the form as a required browser-validation field.

**Fix:** once a local roster exists, the identity control is removed from the form and
the PIN is the only required login input. Account restoration still uses identity plus
secret on a device with no local roster.

**Files:** `src/components/auth/AuthPage.tsx`.

---

## 2026-09-23 — Existing device settings hid new meal and penalty defaults

**What the manager would have seen:** upgraded tills showed no default meal choices or
penalty infractions even though a fresh in-memory configuration included them.

**Root cause:** loading a saved device configuration replaced the whole default object.
Older saved objects legitimately had none of the newly introduced fields.

**Fix:** configuration loading now merges saved values over current defaults and fills
only missing meal/penalty collections; first-boot IndexedDB defaults include them too.

**Files:** `src/store/useDeviceStore.ts`, `src/services/db/IndexedDbService.ts`.

---

## 2026-09-23 — A free staff meal did not protect its employee from deletion

**What the manager would have seen:** an employee with a free staff-meal ticket but no
sales, shifts, assessments, or charged meals could still be permanently deleted. The meal
record remained but lost the roster identity it belonged to.

**Root cause:** the deletion guard counted tickets only where the employee was the
cashier. Staff-meal tickets identify the person eating through `staffId` instead.

**Fix:** ticket history now counts either relationship before permanent deletion is
allowed.

**Files:** `src/services/db/IndexedDbService.ts`.

---

## 2026-09-22 — Late auth refresh could report an unhandled storage error

**What the user would have seen:** nothing in a normal browser, but automated regression
runs could finish every assertion and still exit as failed when a delayed reconciliation
refresh completed after the test storage shim had been removed.

**Root cause:** the resumed-session lookup assumed `localStorage` was always present,
including in non-browser runtimes and during test teardown.

**Fix:** the lookup now treats an unavailable storage API as an empty resumed session.

**Files:** `src/store/useAuthStore.ts`.

---

## 2026-09-22 — Saving a role wage rule could leave the old rule active locally

**What the manager would have seen:** after changing a role's monetary reward, the save
confirmation appeared but a later assessment could still use the earlier value until the
page or another device refreshed.

**Root cause:** cloud-safe wage-rule ids are `<account-id>_<role>`, but the Zustand update
removed an existing row by comparing that composite id with the bare role name. The old
and new versions could therefore coexist, and `configFor(role)` returned whichever came
first.

**Fix:** local replacement now removes by the stable `role` property before inserting the
new configuration. The redesigned wage screen also refuses a zero monetary reward and
the assessment path refuses to create unpaid performance accidentally.

**Files:** `src/store/useWorkforceStore.ts`,
`src/components/manager/StaffPayroll.tsx`.

---

## 2026-09-20 — Staff with wage history could still be permanently deleted

**What the user would have seen:** after the performance-pay system was introduced, a
manager could permanently delete a staff member who had assessments or wage-ledger
entries but no tickets, shifts, expenses, or audit entries. The financial rows survived,
but the roster identity they referred to disappeared.

**Root cause:** the existing deletion guard counted only the record types that existed
before payroll. The new `staff_assessments` and `wage_ledger` tables were not included in
`countRecordsForUser`, its UI breakdown, or the aggregate deletion decision.

**Fix:** staff-record counting now includes both payroll tables; the deletion dialog shows
their counts; and deletion is refused whenever either contains history for that person.
The regression test for an empty account was extended to pin the complete count shape.

**Files:** `src/services/db/IndexedDbService.ts`, `src/store/useAuthStore.ts`,
`src/components/manager/StaffManagement.tsx`, `src/tests/staffRoster.test.ts`.

---

## 2026-09-04 — Every ticket was buying its cut feed twice, and its blank lines once

**What the user saw:** noticeably more blank paper above and below each ticket than the
ticket itself seemed to need. At a thousand tickets a day the roll cost was the complaint,
not the appearance.

**Root causes — three, of which two were ours:**

1. **The cut feed, paid twice.** `cutAndFeed(2)` sent `ESC d 2` and then `GS V 66 0`. But
   `GS V 66` *means* "feed to the cutting position, then partial cut" — the printer already
   advances the head-to-blade distance itself. Our feed was 6mm of blank roll on every
   ticket, on top of a feed that was going to happen anyway.
2. **Line spacing left at the power-on default.** ESC/POS starts at 30 dots per line for a
   font that is 24 dots tall, so each plain line carried 0.75mm of nothing. `ESC 3 24` now
   pins the feed to the character height.
3. **Not a bug: the gap at the top.** The cutter sits ~10–15mm past the print head, so the
   paper between them is blank after each cut and becomes the top of the next ticket. No
   command removes it; only a printer whose own utility offers reverse feed / "paper
   saving" can claw it back. Worth checking per venue, but there is nothing to fix here.

**Also cut, deliberately:** the amount from 6x to 4x height (−6mm), the business name from
3x to 2x (−3mm), and the separator rule above the amount (−3mm). An amount printed four
times taller than everything around it already separates itself.

**Result:** ~42mm of printed roll per ticket to ~24mm, before the printer's own cut feed.
At 1,000 tickets a day that is ~18 metres saved daily — roughly 80 rolls a year on an 80m
roll.

**Guarded by tests:** `escpos.test.ts` now pins the per-ticket height as a *budget*
(≤24mm), asserts no `ESC d` precedes the cut, and asserts `ESC 3 24` is sent. Raising a
magnification in `composeTicket` will fail the budget test rather than quietly costing a
roll a week. `cutAndFeed(n)` still takes a feed for printers with no cutter, which ignore
`GS V` entirely and need the feed to tear against.

**Files:** `src/services/print/escpos.ts`, `src/tests/escpos.test.ts`.

---


## 2026-09-04 — The till's counters and ticket list ran across shifts

**What the user saw:** on a till worked by two people in a day, the header's ticket count
and takings total included the previous cashier's service. The person standing at the till
was shown a figure they were not answerable for, right next to the drawer they were.

The sidebar had the same fault a page at a time: paging was fixed at eight tickets, so the
newest page routinely ended with the tail of the previous shift's tickets.

**Root cause:** both were scoped to *the day*, not to *the shift*. The header counters were
computed in `useTicketStore` over everything created since local midnight, and the sidebar
used the plain `usePagination` hook, which knows only how many items fit on a page.

**Fix:**

* The header now reads **Tickets This Shift** and **Shift Total**, derived in `Header.tsx`
  from the open shift's own tickets (`shiftTickets` + `summariseTickets`, so voids are out
  of both). With no shift open it shows a dash — there is nothing for the figures to belong
  to. The day-scoped fields are gone from the ticket store entirely.
* The sidebar pages through `paginateByShift`, which forces a page break at every shift
  boundary. The shift in progress starts on page one and never shares a page with the one
  before it; long shifts still break every eight tickets. Nothing is hidden — only where
  the breaks fall has changed.

`openShift` now refreshes the shift history, and the till loads it: the pager needs the
shift boundaries, and a shift the history did not know about yet would have had its first
tickets filed under the previous one.

**Files:** `src/components/common/Header.tsx`,
`src/components/ticket/RecentTicketsSidebar.tsx`, `src/utils/analytics.ts`,
`src/store/useTicketStore.ts`, `src/store/useShiftStore.ts`, `src/App.tsx`,
`src/tests/shiftSession.test.ts`.

---

## 2026-09-03 — A shift is now the cashier's session, and Switch Cashier is gone

**What was wrong:** opening and closing a shift was a separate act from signing in and
out, so the two could drift apart in both directions. A cashier could sign in and start
serving without opening a shift — the till refuses to print without one, so this showed up
as "the buttons don't work" — or sign out and walk away leaving a shift open with nobody
accountable for the drawer.

"Switch Cashier Session" made it worse: it swapped who was signed in *without touching the
shift*, so the incoming cashier carried on inside the outgoing cashier's open shift. Every
ticket they sold, and the drawer count that followed, settled against the wrong person.

**Fix:** the shift is the session.

* Signing in as a cashier opens a shift automatically, once per sign-in. Admins are
  excluded — an owner signing in to read the books should not accrue an empty shift they
  then have to count a drawer to close. They keep the header's manual shift button.
* Logging out closes it. With a shift open, "Log Out" routes through close-out first — the
  drawer count still has to be taken — and the session ends only once the shift is closed.
  The modal says "Close Shift & Log Out" so nobody discovers the session ended afterwards.
  Cancelling the count cancels the log out: better signed in than a shift left open.
* Switching cashiers is now: log out, log in. `switchCashierSession` is deleted, along with
  its menu entry and dialog.

The manager console's account menu logs out through the same door, so an owner cannot
leave a cashier's shift open by signing out from the back office.

**Guarded against:** the auto-open fires once per sign-in and not per render, so a cashier
who deliberately closes their shift and stays signed in does not get a new one opened
underneath them. The header button reopens one if they want it.

**Files:** `src/App.tsx`, `src/store/useAuthStore.ts`, `src/components/common/UserMenu.tsx`,
`src/components/common/Header.tsx`, `src/components/shift/CloseShiftModal.tsx`,
`src/components/manager/ManagerConsole.tsx`, `src/tests/shiftSession.test.ts`.

---

## 2026-09-03 — Unreviewed payouts showed up as cash shortages against the cashier

**What the user saw:** a cashier paid for gas or supplies out of the drawer, logged it,
and the till still expected that money to be there. Expected cash only came down once a
manager signed in and approved the entry — which on a busy night is hours later, or the
next day — so every unreviewed payout read as a shortage against the cashier at close-out.

**Root cause:** expenses were written with `status: 'pending'`, and `sumApprovedExpenses`
counts only approved ones. The approval step was modelled as though it happened *before*
the money left the drawer. It never does: by the time anyone types the entry in, the
vendor has been paid.

**Fix:** payouts are now recorded as **approved on entry**, and the cashier confirms with
their own PIN — their signature on money taken out of their own till. The till therefore
agrees with the drawer from the moment the payout is entered.

The manager's control moves to the other end: from the console they can **reject** any
payout, which puts the amount straight back into expected cash, and **restore** one they
rejected. Rejecting is still manager-PIN gated, exactly as approving was.

**New PIN scope:** `openPinModal(..., 'cashier')` accepts the signed-in cashier's own PIN
(an admin PIN passes, as it does everywhere). It is not the `'session'` scope — that one
renders the "Till Locked" screen, with no way out, which is not what a payout confirmation
should look like.

**Also fixed while here:** the PIN modal sat at `z-50`, the same layer as every other
modal, and was rendered before them in `App.tsx`. Any PIN challenge raised *from* a modal
therefore appeared behind it, and the cashier was left looking at a form that had stopped
responding. It is now `z-[60]`. This never bit before because no PIN challenge had ever
been raised from inside another modal.

**Files:** `src/store/useExpenseStore.ts`, `src/store/useAuthStore.ts`,
`src/components/expense/ExpenseLoggerModal.tsx`,
`src/components/expense/ExpenseApprovalQueue.tsx`,
`src/components/common/PinModal.tsx`, `src/components/manager/views/ExpensesView.tsx`,
`src/tests/expenseApproval.test.ts`.

**Note on old data:** expenses already sitting at `pending` are untouched and still need a
manager's approval — they are listed first in the console's review panel. Nothing
backfills them, because approving a payout nobody has verified is the manager's call.

---

## 2026-09-03 — The till's "Tickets Today" counter rolled over at the wrong hour

**What the user saw:** nothing obvious, which is why it survived. A restaurant still
serving after midnight would see the header counter reset an hour late, and tickets sold
in the first hour of the night counted towards the previous day.

**Root cause:** the counter compared `createdAt` against `new Date().toISOString()`'s date
prefix — a **UTC** day. Lagos is UTC+1, so the local day and the UTC day disagree between
00:00 and 01:00 local. `AGENTS.md` rule 8 already requires every reported window in this
app to be local time; the manager console obeys it through `period.ts`, but this counter
in `useTicketStore` predates that and was never brought in line.

**Fix:** both header figures now go through `summariseToday()`, which uses `dayKey()` —
the same local-day helper the console's analytics use.

**Why it was worth fixing now:** a ticket *count* being off by an hour's worth of tickets
is easy to miss. The header now also shows the day's **total takings** beside it, and a
cashier will check that against the drawer, so a wrong day boundary would have turned into
a phantom shortage on the busiest nights.

**Files:** `src/store/useTicketStore.ts`, `src/components/common/Header.tsx`,
`src/tests/tenderSplit.test.ts`.

**Superseded 2026-09-04:** those two header figures are no longer day-scoped at all — they
now count the **open shift** only, derived in `Header.tsx` from the shift's own tickets, and
`useTicketStore` keeps no day totals. The reason is the same one written up here, taken
further: a till worked by two people in a day showed each of them the other's takings. The
local-vs-UTC lesson still stands for anything day-scoped — see AGENTS.md rule 8.

---

## 2026-09-03 — Card and transfer sales were counted as cash in the drawer

**What the user saw:** shifts that took any card or bank-transfer payment could never
balance at close-out. The cashier counted the drawer, the app said they were short by
roughly the value of the day's transfers, and the shift landed in the manager console
flagged with a variance nobody could explain or make up.

**Root cause:** the till had no concept of how a customer paid. `Ticket` carried no
tender field, so close-out summed *every* ticket in the shift into `totalCashTickets`
and fed that into `expected cash = float + sales − approved expenses`. A transfer sale is
real revenue but it never enters the drawer, so every naira taken by transfer became a
naira of phantom shortage. This was in both close-out paths — the live figure the
cashier sees in `CloseShiftModal`, and the figure `closeShift` writes permanently onto
the shift record.

**Fix:** tickets now record a `tender` of `'cash'` or `'transfer'` (card and bank
transfer are one bucket — to a cashier counting cash they are the same thing). New
`splitByTender()` in `analytics.ts` divides a shift's non-void revenue into drawer cash
and transfer/POS, and every reconciliation path now expects **cash only** in the drawer.
Approved expenses are still charged against cash, since that is where the money was
taken from.

The field is optional and an absent tender reads as cash, because every ticket written
before this existed was a drawer sale — that default is what keeps historic shifts
balancing, and narrowing `tender` to a required field later would reintroduce this bug
backwards through the whole history.

**Close-out now shows** total sales, the cash and transfer/POS split beneath it, then
expenses, then expected cash in the drawer — plus a line saying transfers are excluded,
so the gap between the sales figure and the drawer target does not read as a loss.

**Files:** `src/types/ticket.ts`, `src/utils/analytics.ts`, `src/store/useShiftStore.ts`,
`src/store/useTicketStore.ts`, `src/components/shift/CloseShiftModal.tsx`,
`supabase_schema.sql`, `src/tests/tenderSplit.test.ts`.

**Deployment note:** `supabase_schema.sql` adds `tickets.tender` (`ALTER TABLE ... ADD
COLUMN IF NOT EXISTS`, defaulting to `'cash'`). Run it **before** deploying the app —
the sync layer maps ticket fields to columns generically, so tills would otherwise push a
`tender` column Postgres does not have and every ticket would pile up in the outbox.

---

## 2026-09-03 — Two seconds still sat between the button and the paper

**What the user saw:** silent printing worked and was no longer five seconds, but a
receipt still took about two seconds to appear. The point of the whole exercise was a
cashier not waiting, so "faster" was not the bar.

**Root cause:** two separate ones, and only the first belonged to this code.

The agent launched a fresh .NET process for every receipt and opened the printer inside
it. Measured on this machine that is **129ms per receipt**, and a till is slower than
this machine. Removing the per-receipt compile in the previous round had left the
per-receipt *process* untouched — the same mistake one layer down.

The rest is the Windows print spooler, which is not ours to remove. By default a printer
spools each job to disk and schedules it, and the delay between EndDoc and the paper
moving is the spooler service, not the app. The Advanced tab of the printer has a
"Print directly to the printer" setting that skips it entirely.

**Fix:** the helper is now started ONCE, with `--serve`, and stays alive holding an open
printer handle. Receipts go down its stdin as a length header and that many bytes; it
answers OK or ERR per receipt. Measured on the same machine that is **1.1ms**, against
129ms before. A helper that answers ERR is believed rather than retried through the old
path, because a receipt that may already be on paper must not be printed twice.

The helper is named after the agent version (`danbaiwa-rawprint-v3.exe`) so an older
build can never be silently reused — the previous name would have been found on disk and
kept forever.

**And the part that is not code:** the printer setup tab now times the test print and
says what the number means. Under ~300ms and the app has already handed the receipt over
— any remaining wait is the spooler, and the page names the checkbox that removes it.
Both previous rounds of this were settled by measuring, so the agent now reports its own
milliseconds on every job rather than leaving the next round to guesswork.

**Files:** `print-server.cjs`, `install-print-agent.bat`,
`src/components/manager/views/PrinterSetupView.tsx`, `PRINTING.md`.

---

## 2026-09-03 — The print agent had to be started by hand after every reboot

**What the user saw:** step 4 of `install-print-agent.bat` reported that it could not
register the startup task and that someone would have to run `start-hidden.vbs` after
every reboot. They were doing exactly that — keeping a shortcut on the desktop and
clicking it each morning — on a till that is meant to be unattended.

**Root cause:** the installer treated `schtasks /create` returning non-zero as the end of
the road. It is not: `schtasks` is refused often enough in the field (Group Policy
restricting Task Scheduler, a non-admin account, security software) and it is only one of
at least three ways Windows starts a program at logon. The Startup folder and the
per-user `Run` key both need no Administrator rights and no scheduler service at all. The
warning was accurate about the consequence and wrong about the cause — automating it was
always possible.

**Fix:** `install-print-agent.bat` now tries three mechanisms in order and reports which
one took: Task Scheduler, then a script in the Startup folder, then the current user's
`Run` key. All three are cleared first, so re-running the installer can never leave two
entries racing to bind port 9100. The warning survives only for the case where all three
are blocked, and now says that this points at a policy or security product rather than at
the till.

The Startup-folder entry is generated rather than copied: `start-hidden.vbs` locates
`run-agent.cmd` relative to itself, which from the Startup folder resolves to the wrong
place, so the generated one carries the absolute path.

**Files:** `install-print-agent.bat`, `PRINTING.md`.

---

## 2026-09-03 — Silent printing took five seconds a ticket, and the whole till felt slow with it

**What the user saw:** after installing the print agent, receipts did print silently — but
more than five seconds after the button was pressed. Pressing several presets in a row
produced nothing for a while and then all of them together. The delay was not confined to
the paper: the toast confirming the sale and the entry appearing in the sidebar, both of
which used to be instant, now lagged too. Silent printing exists to save time at the
counter, so this defeated the point of having it.

**Root cause:** two independent faults, one in the agent and one in the app.

1. **The agent compiled a C# program on every single receipt.** `sendRaw` spawned
   `powershell.exe` per job, and that script used `Add-Type -TypeDefinition` to compile the
   winspool P/Invoke wrapper from source at runtime. Measured on a fast machine:
   **358–1029ms for the compile alone, plus ~500ms of PowerShell startup, per ticket.** On
   a slower till that is the whole five seconds. Concurrent presses each spawned their own
   PowerShell, so a burst contended and then emerged together.
2. **The till waited for the printer before reporting the sale.** `createAndPrintTicket`
   awaited `PrintAdapter.printTicket` and returned its message, so the toast — and the
   caller — sat behind a spooler round trip. The sale itself was already committed and on
   screen; only the confirmation of it was blocked.

**Fix:**
- `print-server.cjs` — the P/Invoke wrapper is compiled **once** to
  `danbaiwa-rawprint.exe` and invoked directly with `execFile`. Measured end to end:
  ~180ms per job against ~850–1750ms before. The build runs at agent startup so the first
  ticket of the day does not pay for it either, and falls back with a clear message if the
  .NET Framework compiler is somehow unavailable. Jobs are also queued strictly serially,
  so receipts leave the roll in the order they were rung up rather than in whatever order
  four concurrent processes happened to finish.
- `src/store/useTicketStore.ts` — the print is dispatched and **not awaited**. The paper is
  a side effect of the sale, not part of it. Because a failure can no longer travel in the
  return value, a `printError` field carries it instead and `src/App.tsx` raises the error
  toast when it arrives — so an unplugged printer is noticed at the counter rather than
  discovered at the end of a shift, when nobody can say which tickets never came out.
- `src/services/print/directPrinter.ts` — `isDirectPrinterReady()` was doing a database
  read and a walk of the browser's granted-device list on every receipt. Now cached, and
  invalidated when the pairing changes or a print fails.

---

## 2026-09-03 — A till showed the update banner, the cashier pressed it, and nothing ever changed

**What the user saw:** every other device picked up new deployments from the live link.
One machine did not. It displayed the "a new version is ready" banner, the banner was
clicked, and the app carried on running the old build — through thousands of reloads.
Opening the same URL in Microsoft Edge on that same machine showed the current version
immediately.

**Root cause:** two separate faults in how a new build reaches a running till.

1. **A waiting service worker never activates on a kiosk.** A new build installs and then
   sits in the `waiting` state until every window running the old one has closed. A reload
   is itself such a window, so reloading can never release it. The till was checked for
   updates only at startup — and a kiosk never starts up — and the prompt was drawn at the
   **bottom** of the screen, the one edge kiosk mode makes easy to miss.
2. **`updateSW(true)` is a request, not a guarantee.** It asks the waiting worker to take
   over and waits for the browser to report the handover. On this machine the request went
   unanswered, so the button genuinely did nothing, and there was no path that did not
   depend on the worker's cooperation. Edge was unaffected because a service worker
   registration belongs to the browser, not to the machine.

**Fix:**
- `src/services/pwaUpdate.ts` (new) — checks for updates every 15 minutes, on
  `visibilitychange`, and on `online`. `applyUpdate` now watches for `controllerchange`
  after asking, and escalates to `forceReinstall` after five seconds of silence.
  `forceReinstall` unregisters every worker, deletes every cache, and navigates with a
  one-off `?fresh=` query string so the HTTP cache cannot answer either. IndexedDB is
  untouched, so records, settings and the outbox survive and the till comes back signed in.
- `src/components/common/UpdateBanner.tsx` (new) — the prompt moved to the top of the
  screen, rendered as a React component above the app rather than appended to `document.body`.
  Dismiss hides it for ten minutes rather than for good.
- `src/components/manager/AppVersionSettings.tsx` (new) — shows the running build, a
  **Check for updates** button, and **Reinstall the app on this till** for when a machine
  is stuck and no banner ever appears.
- `vite.config.ts` — stamps `__APP_BUILD__` (version + build time) into the bundle, so
  "is this till on the new version?" is answerable by looking. Also surfaced in the login
  screen's diagnostics panel.
- `src/main.tsx`, `src/App.tsx` — banner mounted above the auth guard, the till and the
  console.
- `Launch POS (Vercel).bat` — finds Chrome **or** Edge, and kills the matching process
  (killing `chrome.exe` does nothing when launching Edge, and `--kiosk-printing` is only
  honoured by a fresh process).

---

## 2026-09-02 — Silent printing needed Node on every till, and the receipt was mostly blank roll

**What the user saw:** printing silently from a client's device meant installing Node,
cloning the repository and downloading ~230MB of headless Chromium per machine. Tickets
took a second or two to appear and were far longer than the information on them.

**Root cause:** the receipt was built as HTML, rendered to a PDF through Playwright's
Chromium, and spooled through `pdf-to-printer`. That is an enormous amount of machinery to
produce a few hundred bytes of printer commands, it put a browser engine on every till, and
the resulting PDF was still at the mercy of whatever paper size the printer driver claimed.
The layout also devoted roughly 28mm — over a third of the ticket — to a QR code.

**Fix:**
- `src/services/print/escpos.ts` (new) — the receipt as ESC/POS bytes, built once and used
  by every route. `fitWidth` sizes magnified text to the roll instead of letting it wrap
  mid-number; `encodeText` transliterates (₦ → N) so nothing above `0x7f` reaches the
  printer; `EscPosBuilder` tracks its own height so ticket length is a tested property.
- `src/services/print/directPrinter.ts` (new) — Web Serial and WebUSB, so a till with a
  reachable printer needs **nothing installed at all** and works from the deployed PWA
  unchanged.
- `print-server.cjs` — Express, Playwright and `pdf-to-printer` all removed. It is now a
  single zero-dependency file that spools a RAW job through `winspool.drv`. Install is Node
  plus two files, with no `npm install`.
- `install-print-agent.bat` (new) — per-user install, **no Administrator required**, and
  deliberately not SYSTEM: a task running as SYSTEM cannot see a printer installed for one
  user only and silently prints nothing.
- Ticket layout: **76mm → 42mm**. The QR became a one-line tracking id, the amount doubled
  in size, the business name grew, and the subtitle, footer, one rule and two feed lines
  went.
- `DeviceConfig.paperWidthMm` (58 | 80) rides in `account_settings`, so an account that
  moves to 80mm printers sets it once from anywhere.
- `src/components/manager/views/PrinterSetupView.tsx` (new) — a guided tab that states in
  one line whether receipts print silently, and serves the agent and installer as download
  links (`scripts/copy-print-agent.mjs` → `public/print-agent/`).

**Follow-up the same day:** pairing recorded a printer that could not be opened. Choosing a
port in the browser's chooser only grants permission; it says nothing about whether the
port opens. A USB printer whose Windows driver holds the port exclusively therefore paired
"successfully" and then failed on every ticket — and worse, a saved-but-dead pairing takes
priority over the print agent, so a machine that *was* printing correctly would stop.
`pairSerial` now opens and closes the port before saving anything, and
`explainOpenFailure` replaces the browser's identical-for-every-cause "Failed to open
serial port" with the actual diagnosis.

---

## 2026-09-02 — Password reset links opened the wrong site, and an account could only be used on the machine it was created on

**What the user saw:** three complaints.

1. Password reset emails led to a Vercel page that was not the till.
2. Signing in on a browser profile the account had never been used on was refused, whatever
   combination of credentials was tried.
3. "Create Account" accepted an email that already belonged to a live business, from a
   different browser profile.

**Root cause:**

1. Supabase honours `redirectTo` **only** when the exact URL is on the project's Redirect
   URLs allow-list, and silently substitutes the project's Site URL otherwise. Tills run on
   addresses that were not on that list.
2. Two faults. The cloud sign-in only ever tried the PIN-derived password, so typing the
   account password came back as "invalid credentials" — and once a local profile existed,
   the cloud was never consulted at all, so a stale or wrong local copy refused the correct
   current credentials for ever. Separately, an account whose email was never confirmed has
   no session on the machine that registered it, so its `users` row (PIN and password
   hashes included) is never uploaded and no other device can pull it down.
3. The duplicate check was `select('id').eq('email', …)` against the `users` table, run on
   the anon key with no session. Every RLS policy there is granted `TO authenticated`, so
   it **always** returned nothing. `authenticateAdminWithSupabase` then signed the caller
   in to the existing account and reported it as a fresh signup, and registration wrote new
   PIN, password and recovery-key hashes over a live business's and synced them up.

**Fix:**
- `src/services/supabase/supabaseClient.ts` — `authRedirectUrl()` (with a
  `VITE_AUTH_REDIRECT_URL` override), and `signUpNewAdminAccount()`, which refuses an
  existing email. It detects both duplicate shapes: the plain "User already registered"
  error, and the obfuscated response Supabase returns when email confirmations are on — a
  user object with an **empty `identities` array**, which the old code read as success.
- `src/store/useAuthStore.ts` — cloud adoption tries both the derived and the typed secret;
  a failed *local* check now asks the cloud before declaring the credentials wrong, and
  repairs the stale local hash on success; a verified cloud sign-in with no profile in the
  cloud rebuilds one locally. That rebuild is written **local-only** and backdated: it
  shares a primary key with the genuine profile the original till still owes, so uploading
  it would permanently replace the real record — including the recovery key — on every
  device. `cloudBackfill.ts` skips rows flagged `rebuiltLocally`.
- Registration now warns loudly when a sign-up returns no session, because that account
  cannot be used on any other device until its email is confirmed.
- `src/components/auth/TillDiagnostics.tsx` (new) — a "Why can't I sign in?" panel on the
  login screen. A kiosk has no address bar and no devtools, so the address, whether the
  origin is secure, whether PIN checks are even possible, and which accounts the machine
  holds were all unanswerable from the seat.
- `src/services/auth/loginErrors.ts` — cloud refusals now carry the provider's own words
  instead of dropping them.

---

## 2026-09-01 — Sync crawled through the queue one row at a time, and the sync button kept demanding the admin PIN

**What the user saw:** two complaints about the same badge.

1. *"Sync (X pending)" with X reducing slowly.* Pressing the badge, or just waiting,
   drained the queue at a visible trickle — a minute or more for a backlog that should
   have gone up at once.
2. *The sync button asking for the admin PIN.* On a till where a cashier was working,
   the badge sat on "Not Signed In to Cloud" and clicking it opened the admin-PIN
   reconnect dialog, so nothing could be sent until the owner came over.

**Root cause:**

1. The worker sent **one row per HTTP request, strictly sequentially** — a 300-row
   backlog meant 300 round trips, plus 300 separate local writes to mark them off. On
   top of that, any row that had ever failed was parked behind an exponential backoff of
   up to 30 minutes, and the manual sync button did nothing about it: it ran the same
   ordinary worker, which skips rows that are not yet due. So the button appeared inert
   while the count went down on its own schedule.
2. Logging out of the till called `supabase.auth.signOut()`, destroying the device's
   cloud credential. Since that credential is derived from the admin PIN, nothing short
   of the admin's PIN could restore it — and a cashier logging in never establishes one
   at all. Every ordinary logout therefore left the next person on a till that could not
   sync, with the PIN dialog as the only way out. The till's staff session and the
   device's enrolment with the account were being treated as the same thing.

**Fix:**
- `src/store/useSyncStore.ts` — the worker now sends **batches**. `batchOutbox` splits
  the queue into *contiguous* runs of the same table and action (contiguous, so a
  record's later DELETE can never be sent ahead of its earlier UPDATE and resurrect the
  row), and `dedupeBatch` collapses repeat writes to the same record — required, because
  Postgres rejects an `ON CONFLICT` upsert that touches one row twice. A rejected batch
  is re-sent row-by-row so a single bad record is isolated and charged alone instead of
  dragging its whole run into an undeserved backoff. All the existing guarantees hold: a
  lost session still aborts the pass without charging anyone, and no row is ever written
  off.
- `src/store/useSyncStore.ts` (`forceSyncNow`) — what the badge's click now runs. It
  clears every backoff first, so "sync now" means now.
- `src/services/db/IndexedDbService.ts` / `IDbService.ts` / `LocalStorageDbService.ts` —
  `markOutboxSyncedMany`, so acknowledging a batch is one transaction rather than N.
- `src/store/useAuthStore.ts` (`logoutUser`) — ends the staff session only; the device
  stays enrolled and keeps draining its queue. Disconnecting from the cloud is now an
  explicit act via `logoutUser({ unenrolDevice: true })`, reached only from the console's
  **System Logout** (`src/components/manager/AdminProfileSettings.tsx`, with wording that
  says what it costs). Keeping the session grants nothing the machine did not already
  have — the whole local database is already on it, and the session reaches exactly that
  same account.
- `src/components/common/SyncIndicator.tsx`, `src/components/common/UserMenu.tsx` —
  wired to `forceSyncNow`, and the logout copy no longer implies syncing stops.

**Verified:** new `src/tests/syncBatching.test.ts` (8 tests) pins the batching rules —
300 rows become 2 requests not 300, an UPDATE is never reordered ahead of the DELETE
that follows it, a duplicate write is collapsed with the later value winning, one bad
record is charged while its nine batch-mates still sync, removals are still sent as
removals, and `forceSyncNow` pushes rows the ordinary worker skips. Full suite 164/164,
`tsc --noEmit` and `npm run build` clean. Driven in a real browser against the live
Supabase project: 12 tickets queued offline went up in **1** request (was 12), and after
an ordinary till logout the device still held its cloud session, came back to "Cloud
Synced" on the next login, and clicking sync did not open the PIN dialog.

**Note:** two mocks needed updating because the wire shape changed —
`tenantIsolation.test.ts` now records one entry per row in a batch, and
`staffRoster.test.ts`'s delete chain learned `.in()`. Neither was a product regression;
both tests assert the same things as before.

---

## 2026-09-01 — Nine bugs found while building the reporting periods, recovery keys and staff management

Grouped into one entry because they were found and fixed in one stretch of work. Each
is independent. The invariants that keep them from coming back are written up in
sections 7–17 of `.agents/AGENTS.md`.

**1. Every shift was reconciled against lifetime revenue.**
*What the user saw:* cash variance on shift close was nonsense — the expected-cash
figure grew forever and every shift looked massively short.
*Root cause:* `closeShift` (and the live preview in `CloseShiftModal`) summed **every
ticket in the store** rather than the tickets belonging to that cashier inside that
shift's open→close window.
*Fix:* new `shiftTickets()` / `shiftExpenses()` in `src/utils/analytics.ts`, used by
`src/store/useShiftStore.ts` and `src/components/shift/CloseShiftModal.tsx`. Proved
with a discriminating test: two shifts closed against their own takings expect 900 and
500, not 1400 each. `closeShift` also reloaded with an unscoped `loadShift()`; it now
passes `shift.cashierId`.

**2. The manager console reported one cashier's numbers as the whole business.**
*What the user saw:* opening the console while a cashier was signed in at the till
showed only that cashier's tickets, so the month's revenue was whatever that one
person happened to take.
*Root cause:* the console reused the till's per-cashier data scope.
*Fix:* `src/App.tsx` loads the whole account whenever the console is open. Because the
signed-in user may still be a cashier, `useAuthStore` gained `hasAdminAuthority`
(granted by the admin PIN that opens the console) and admin-only actions check that
rather than `activeUser.role`.

**3. Deleting anything silently un-deleted it on the next sync.**
*What the user saw:* would have shown as deleted staff reappearing.
*Root cause:* `useSyncStore`'s worker upserted every queued outbox row regardless of
its `action`, so a `DELETE` was replayed to Supabase as an upsert.
*Fix:* explicit DELETE branch (`.delete().eq('id',…).eq('account_id',…)`) in
`src/store/useSyncStore.ts`; `deleteUser` + `countRecordsForUser` added to
`src/services/db/IndexedDbService.ts`.

**4. A used recovery key came back to life.**
*Root cause:* consuming a key set `recoveryKeyHash: undefined`. `JSON.stringify` drops
`undefined`, so the field never reached Supabase, the column kept the old hash, and
the next pull restored the spent key — leaving a single-use key permanently valid.
*Fix:* set it to explicit `null`, and re-typed `User.recoveryKeyHash` as
`string | null` (`src/types/user.ts`, `src/store/useAuthStore.ts`).

**5. After a PIN recovery, the keypad refused to accept the new PIN.**
*What the user saw:* recovery succeeds, you land back on the keypad — and it is still
showing "Invalid PIN" about your *old* PIN, with the new one pre-filled, doing
nothing.
*Root cause:* `PinModal`'s auto-submit is suppressed while `error` is set, and the
error from the failed pre-recovery attempt was never cleared.
*Fix:* `src/components/common/PinModal.tsx` clears `error` before pre-filling and on
entering recovery mode.

**6. Locking the till locked the cashier out of it.**
*What the user saw:* a cashier working alone tapped Lock Till (or just let the
5-minute idle timer fire) and could not get back in — the lock demanded the **admin**
PIN. Conversely, pressing Escape dismissed the lock entirely, so it wasn't a lock.
*Root cause:* the lock reused the manager-authorisation PIN prompt verbatim.
*Fix:* `openPinModal` gained a scope — `'session'` accepts the signed-in user's own
PIN (admin PINs still work so a manager can take over), and renders a real screen lock
that names who is signed in, has no ESC button and ignores Escape. Manager mode stays
`'admin'`-scoped; verified that a cashier PIN still cannot open the console.
`src/store/useAuthStore.ts`, `src/components/common/PinModal.tsx`, `src/App.tsx`.

**7. Cashiers could not log in at all.**
*What the user saw:* typing a staff ID and PIN on the login screen did nothing — the
button appeared to be ignored.
*Root cause:* the identity field was `type="email"`, so browser validation silently
rejected every non-email staff ID before submit.
*Fix:* `src/components/auth/AuthPage.tsx` — `type="text"` with `inputMode="email"`,
relabelled "Email Address / Staff ID".

**8. Every ticket printed on a full A4 page.**
*What the user saw:* a huge blank area above and below each receipt; the roll advanced
far past the ticket.
*Root cause:* `print-server.cjs` emitted a fixed `297mm` page with 2mm margins,
regardless of how short the receipt was.
*Fix:* the receipt is measured after render and the PDF is emitted at exactly that
height, zero margins, printed `scale: 'noscale'`; width is configurable via
`PRINT_WIDTH_MM` (default 58) and slack via `PRINT_FEED_MM` (default 0). The measured
element gets `overflow: hidden` so child margins can't collapse out of the
measurement. `src/index.css`'s print block was brought in step (was 80mm/4mm).
~222mm of roll saved per ticket.

**9. The admin recovery key was a dead feature, and the email reset broke cloud sync.**
*What the user saw:* no way to recover an admin PIN; and after using the emailed
password reset, the till would quietly stop syncing ("Not Signed In to Cloud").
*Root cause:* `registerUser` never generated a recovery key, so nothing was ever
issued. Separately, `updatePasswordAfterRecovery` changed the local PIN without
changing the derived Supabase password, so the till could no longer re-authenticate —
very likely the original cause of the earlier "Not Signed In to Cloud" report.
*Fix:* keys are now generated at registration and shown once
(`src/utils/recoveryKey.ts`, `src/components/auth/RecoveryKeyNotice.tsx`,
`src/components/manager/RecoveryKeySettings.tsx`); every PIN-changing path now calls
`updateSupabaseUserPassword(deriveSupabasePassword(newPin))`.
*Known limitation, stated in the dialog:* a recovery key used **offline** restores the
till but not cloud sync — there is no session through which to realign the password.
The emailed reset restores both.

**Verified:** full suite 156/156 across 19 files (new: `period.test.ts`,
`recoveryKey.test.ts`, `staffRoster.test.ts`; rewritten sections of
`analytics.test.ts`), `tsc --noEmit` clean, `npm run build` clean, plus Playwright
runs against a real signup covering the console tabs, staff edit/delete, the lock
screen, cashier login and the recovery flow.

**Still to confirm on the real till:** sign in with the admin PIN on the owner's own
device and watch for `[accountScope] stamped N local row(s)` then
`[cloudBackfill] queued N …`, confirm the badge reaches "Cloud Synced", then confirm
the data appears in a second browser. The owner's existing admin account predates
recovery keys and still needs one issued under Settings → Admin Recovery Key.

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

---

## 2026-09-23 — Server collections used the wrong expected-value formula

**What the user saw:** Server performance added a separate “sales value” and profit,
so managers could not configure the actual preparation cost of each food item or
compare a waiter’s returned money with the amount that item mix should have produced.
Payroll also still exposed percentage penalties after the rule had changed to
fixed-naira deductions only.

**Root cause:** The server-sales calculator treated the legacy sales-value field as
the base of expected revenue and then added profit again. The daily record had no
money-gathered or variance fields, and the payroll draft model still constructed
percentage penalty rows.

**Fix:** Added per-sales-unit preparation cost and made expected collection equal
preparation cost plus configured profit. Daily server entries now persist itemized
quantities, money gathered, and surplus/shortage; weekly and monthly rollups retain
each item column. Removed percentage penalties from payroll entry, types, and wage
calculation. Updated the cloud schema and compatibility fallbacks for older item rows.

**Files:** `src/components/manager/views/InventoryView.tsx`,
`src/components/manager/views/ServerSalesView.tsx`,
`src/components/manager/StaffPayroll.tsx`, `src/utils/serverPerformance.ts`,
`src/utils/workforce.ts`, `src/store/useServerSalesStore.ts`, related types/tests,
and `supabase_schema.sql`.

**Verified:** All 354 Vitest checks pass, the production build succeeds, and the
browser lifecycle confirms item setup, daily quantity and cash entry, a ₦5,000
surplus, fixed-penalty wage finalization, FIFO stock, and persisted reports.

---

## 2026-09-23 — Server wage assessment was disconnected from item sales

**What the user saw:** Daily Performance & Pay still gave a server one generic
performance-number field. The manager had to enter food quantities and collected
cash on a separate screen, so the wage assessment did not itself explain the
server's expected collection, shortage/surplus, or real profit/loss contribution.

**Root cause:** Itemized server sales and staff wage assessment were persisted by
separate forms even though both represent the same server's daily performance.

**Fix:** Server rows in Daily Performance & Pay now list every inventory item that
has Server sales enabled, accept quantity per item and money collected, calculate
expected collection, actual profit/loss, and surplus/shortage live, and save the
itemized server record together with the wage draft. Server wage output is derived
from total units and cannot be manually contradicted.

**Files:** `src/components/manager/StaffPayroll.tsx`,
`src/components/manager/views/ServerSalesView.tsx`,
`src/store/useServerSalesStore.ts`, `src/types/serverSales.ts`,
`src/utils/serverPerformance.ts`, `supabase_schema.sql`, and related tests.

**Verified:** All 355 Vitest checks pass, the production build succeeds, and the
browser lifecycle records seven rice units and ₦180,000 collected directly from
Daily Performance & Pay, persists ₦54,000 actual profit, ₦5,000 surplus, and the
derived ₦1,300 final wage after a ₦100 fixed penalty.

---

## 2026-09-24 — Staff performance and audit history could not be investigated properly

**What the user saw:** Audit history was a paginated list with no search or filters.
Staff performance could be entered daily but there was no consolidated daily, weekly,
monthly, or yearly view of each employee's output, rewards, penalties, wages, and
server collection metrics. Weekly reports were permanently Monday-based, and managers
could configure deductions but not reusable performance bonuses.

**Root cause:** AuditLogView only applied the shared date window. The workforce model
stored base earnings and penalties but had no reward items or reward totals. Weekly
date boundaries were hard-coded in the period utility, and staff reporting had no
rollup interface over assessments and itemized server sales.

**Fix:** Added full-text audit search plus action, entity, and actor filters. Added
account-synced fixed performance-reward rules beside fixed penalties, persisted the
selected rewards in each assessment, and included them in wage calculation. Added a
Performance reports staff tab that uses the console's Day/Week/Month/Year picker and
shows every staff member's output, base reward, reward/penalty breakdowns, final wage,
food quantities, preparation cost, expected and collected cash, actual profit/loss,
and surplus/shortage. Added an account-wide starting-day-of-week setting and made all
weekly periods honor it.

**Files:** `src/components/manager/views/AuditLogView.tsx`,
`src/components/manager/StaffPerformanceReport.tsx`,
`src/components/manager/StaffPayroll.tsx`,
`src/components/manager/views/StaffView.tsx`,
`src/components/manager/views/SettingsView.tsx`, `src/utils/period.ts`,
`src/store/useConsolePeriodStore.ts`, workforce/config types and stores,
`supabase_schema.sql`, and related tests.

**Verified:** All 357 Vitest checks pass, the production build succeeds, and the
browser lifecycle verifies reward configuration and payout, the staff period report,
audit search/entity filtering, persistence, and a Sunday-based weekly boundary.


## 2026-10-04 - Phone access, admin identity, kitchen units and meal allowances

- Phone screens: the fixed desktop sidebar consumed the viewport; dense reports, stock forms and payroll inputs overflowed or required horizontal scrolling. Added a collapsible navigation drawer, phone report cards with field labels, wrapping till controls, responsive forms, 44px touch controls, 16px form text and scrollable short-screen dialogs. Files: ManagerConsole, ConsoleUI, Header, StaffManagement, StaffPayroll, DeviceAccessSettings, AdminProfileSettings, StaffMealModal and index.css.
- Admin lockout: AuthPage hid identity sign-in whenever any users existed. A PIN shared with another person was ambiguous and eventually caused a lockout with no alternative route. Identity sign-in is now available on every device; duplicate PIN matches do not consume failed-password attempts. PIN-only sign-in still refuses to guess an identity. New owner PINs are validated and checked for duplicates. Files: AuthPage and useAuthStore.
- Management sessions: admin sign-in now opens the console without starting or forcing close-out of a sales shift. Console state and authority reset when the signed-in person changes, preventing a later cashier login from retaining the previous owner's console view. Owner profile saves update only that owner's row, preserving the current cashier's identity and shift. Files: App, useAuthStore and AdminProfileSettings.
- Profile updates: unhandled async errors made saves look unresponsive; the form now catches and displays the actual failure and disables duplicate submissions. Cloud security changes authenticate the owner in a temporary, non-persistent client when the main client holds the till identity. The till's cloud credential is never changed. Owner email changes go through cloud verification before changing local login keys; sign-in with the verified new email updates the POS profile. Files: AdminProfileSettings, useAuthStore and supabaseClient.
- Inventory: a cooking unit and its base-stock conversion, preparation cost and profit are now distinct from purchase and sales units. Server quantities use the cooking unit when configured; legacy preparation/profit costs scale using the base-unit ratio. Existing ingredients retain their old behavior until configured. Kitchen usage/waste can be entered in cooking units and is stored in base units. Validation rejects invalid conversions/costs. Files: InventoryView, inventory types/utilities/store, serverPerformance, ServerSalesView, StaffPayroll and SQL schema.
- Staff meals: the existing per-person free-food setting is now visible in the roster. The issuing form loads the complete local ticket history and shows the remaining daily allowance; it previously counted only the cashier's displayed tickets. The database recalculates the wage deduction inside the meal/ticket/outbox transaction, so concurrent same-device issuance cannot reuse the same free allowance. Voids do not count. Zero-value wage entries and duplicate replay deductions are skipped. Files: staffMeals, StaffMealModal, IndexedDbService and useTicketStore.

Validation: regression tests in adminMobileFlows.test.ts; the full Vitest suite; TypeScript/production build; browser lifecycle checks in scripts/verify-mobile.mjs using real local registration and isolated cloud-disabled data. Phone screenshots are generated into artifacts/mobile-qa. Cloud email delivery and real owner authentication require staging/live validation. Simultaneous disconnected devices cannot enforce a single shared meal allowance until their tickets sync; this release guarantees serialized accounting on each device.

Rollout: apply scripts/migrations/20261004_kitchen_units.sql in Supabase before deploying the new app. Accept the PWA update on each till when service is idle. Configure cooking units per ingredient and free meals per person under Staff > Team & access > Edit. Existing historical server entries retain their saved unit/cost snapshots.

- Cancelled console close-out: cancelling an attempted logout left a pending logout flag set. A later manual shift close could unexpectedly log out the cashier. Both console and till dialogs now clear that flag and correctly label a close-out that ends the session. File: App.tsx.

- Login lockout expiry: the login page computed the countdown only when rendered, so disabled controls could stay locked after the timeout. A timer now refreshes the countdown and a new failed attempt after expiry starts a fresh attempt window. Files: AuthPage and useAuthStore; covered by the credential tests and mobile browser lifecycle.

Final verification: 43 test files / 369 tests passed; production build passed; Playwright passed at 320, 390, 768 and 1280 pixel widths, including kitchen FIFO consumption, persisted server cooking-unit costs, staff meal issuance/counter, lockout expiry and admin profile changes preserving the cashier shift. Live cloud credential/email confirmation paths were checked with isolated client tests, not against production.


## 2026-10-04 - Reconnect throughput, refresh retention and shift ownership

Symptoms reported: tens of thousands of queued records uploaded slowly after reconnect; manager views showed older data; refreshed tills appeared to lose shift records; ticket printing stalled.

Confirmed code defects and fixes:
- Shared localStorage login identity let another tab's login replace the cashier on a roster reload or refresh. Sessions now persist per tab, with a one-time migration of the existing signed-in person. Roster reloads retain the active identity and no longer restart cloud restoration/backfill on every realtime user change.
- Active shifts were selected only by cashier, so the same login on another installation could adopt a working till's shift. New shifts carry installationId and a local drawer binding. New tickets carry shiftId; reconciliation prefers that explicit association and retains time-window matching for old tickets. Legacy shifts resume only with evidence that they originated locally. Admin bootstrap does not open, resume or stale-close a cashier shift.
- Asynchronous ticket/shift/expense/roster reloads could replace a newer view or identity. Request generations discard stale reads; a ticket committed during a reload is merged into the returned snapshot. Admin bootstrap invalidates pending cashier-shift reads. A new ticket number colliding with an existing sale now fails atomically instead of silently queuing a replacement cloud row.
- Queue status queries loaded all healthy payloads on every ticket, while realtime dirty checks scanned the queue for every incoming record. Added compound IndexedDB indexes, native bulk queue reads with timestamp/id pagination, bounded 1,000-row pages, targeted dirty checks and coalesced status refreshes. Queue counts use one consistent read transaction. Large browser tests also exposed quadratic recounting after every batch: progress now subtracts acknowledged batches, reconciles counts at page boundaries and suppresses background polling during an active push. Stale status queries cannot replace newer batch progress. The worker latches before its first await, uses a browser lock across tabs and drains successive pages without another caller/poll.
- Catch-up waited for full-history backfill before sending existing queued work, and repeated calls launched overlapping sweeps. Catch-up is single-flight and sends the queue first. Deep comparisons run at most every six hours. Backfill checks actual ids even when local/cloud counts match and excludes rows belonging to another account. Uploads recheck the current account per batch and retain foreign-account entries without relabelling them.
- Revive, stamping and backfill held large write transactions. They now process bounded chunks and yield between them. Queue acknowledgements/failures use bulk operations, and pruning only deletes acknowledged rows in short chunks when the queue is drained. Healthy queued rows are untouched by revive. A failed older snapshot could overwrite a newer acknowledged void/shift closure: retries now check newer same-record snapshots and defer until their replacement lands, then acknowledge the obsolete retry. Pruning preserves that acknowledgement evidence while unsent rows remain.
- Dirty-check/read/write operations on incoming rows were separate, and account stamping wrote stale full-row snapshots. Incoming merges/settings now check pending local mutations and write inside the same transaction; stamping modifies current rows. Reconciliation merges up to 200 rows per transaction. Remote data cannot overwrite a new unsent local edit using a stale dirty-id snapshot.
- Cloud restore copied installation identity, counters, printer pairing and cloud credentials from the source till. That could clone ticket numbering across devices. Restore now imports only account settings from config and preserves this device's counters/identity. It rechecks emptiness inside the restore transaction, cancelling if sales arrived during download.
- Rapid receipts could contend for a serial writer, and serial ports were closed/reopened for each receipt. Browser dispatch is serialised and keeps the serial connection open between receipts. Partial USB/serial dispatch errors do not fall back into a duplicate receipt. Agent v4 stops a timed-out/uncertain resident-helper dispatch instead of trying another 20-second printing route. Physical printer/spooler latency still requires validation on the affected till.

Verification: 46 Vitest files / 392 tests passed; production build passed. Checks cover multi-page push with bounded recounts, worker/browser-lock exclusivity, obsolete-retry ordering, dirty snapshot races, ticket number collisions, independent tab identities, installation-specific shifts, stale roster/shift reads, in-flight reload retention and snapshot restore races. The browser lifecycle at 320/390/768/1280 widths passed with real local signup, including admin PIN change, rejection of the old PIN and successful sign-in with the new PIN. A real IndexedDB fixture with 20,000 pending tickets completed queue page/count/revive checks in 257 ms and a new ticket commit plus mocked print dispatch in 118 ms; refresh retained all 20,002 tickets and the original cashier shift after an independent admin-tab login.

The separate offline-to-online transport stress test (scripts/verify-sync-load.mjs) uploaded all 20,001 records in 101 requests of at most 200 rows, started uploading in 553 ms and drained in 80,771 ms. A concurrent ticket saved in 61 ms and reached the cloud; no records remained queued or disappeared locally. Cloud responses were intercepted with 30 ms latency per request; production was never contacted. IndexedDB acknowledgements accounted for 50.6 seconds of this run. These are local QA measurements, not physical printer or production-network claims. Browser scripts explicitly await asynchronous predicates through page.evaluate polling; the previous waitForFunction promise-truthiness checks could advance before database assertions completed.

Rollout: apply scripts/migrations/20261004_shift_ownership.sql before releasing this app (and the kitchen-unit migration from the preceding entry). The IndexedDB v4 upgrade only adds indexes; it does not clear records. Update the local print agent to v4 using the generated download/installer. Accept the PWA update on tills while idle. The deployed app, cloud migration and affected-device record recovery have not been performed by these repository changes. Missing records must be checked against the affected browser's database/outbox and cloud backups before claiming recovery; preserve that device's storage.

## 2026-10-05 - Employee meal counters and a shared trading-day start hour

The meal selector showed only names and roles, making cashiers select each employee to check their allowance. Every employee option now shows meals issued / free allowance and the remaining count, including zero allowances and exceeded limits. Counts are calculated in one pass across the local meal history, exclude voids, and refresh after issuance. An open form also updates when the business day changes. Admins configure each person's allowance under Staff Management > Team & access > Edit > Free meals per business day; the field accepts zero or a non-negative whole number and explains the reset time.

The system mixed midnight reporting/inventory/payroll dates with a fixed 06:00 shift and meal boundary. Settings now places Starting hour of day beside Starting day of week. The hour is validated from 00:00 through 23:00, saved atomically with its account-settings outbox entry, and follows the account to other devices. Old configs default to 06:00. Failed settings writes show an error and roll back the local setting.

Reports and chart buckets, weekly/monthly/yearly boundaries, shift rollover/close-out labels, meal counters/deductions, inventory movement dates and daily performance/payroll defaults now use that configured local hour. Early-morning service belongs to the preceding trading day. Reports interpreting saved YYYY-MM-DD business-day labels include the first day and exclude the next day correctly even when the boundary is later than noon. Meal issuance reads the persisted hour and allowance inside its ticket/wage/outbox transaction and assigns charged meals to the matching wage-ledger day. Historical records already assigned an explicit businessDay keep that recorded label.

Files: config types/useDeviceStore, shiftDay/period/staffMeals utilities, useConsolePeriodStore, App, ManagerConsole/SettingsView, StaffMealModal/StaffManagement, IndexedDbService/useTicketStore, useInventoryStore, CloseShiftModal, StaffPayroll/StaffPerformanceReport and staff/server reporting views. Verification: 47 Vitest files / 403 tests and the production build passed. scripts/verify-meal-calendar.mjs passed a real local registration and phone workflow in Africa/Lagos time: allowances 2 and 0 persist, weekday/hour settings survive reload, 07:30 belongs to the previous trading day with an 08:00 start, all selector counters update, the third meal charges once to the correct wage day, and the open form resets at 08:00. Cloud transport and physical printing are isolated/mocked in this browser check. This setting lives in the existing account_settings JSON and needs no additional SQL migration; deploy the app update for these changes to reach tills.

## 2026-10-05 - Large backlogs, bounded till rendering, permanent staff removal and salary statements

Symptoms: a till with over 10,000 unsynced records became sluggish; sales and print dispatch slowed as history accumulated; permanent staff deletion was blocked by historical contributions; the sales cashier filter included unrelated roles; salary balances lacked their calculation breakdown.

Confirmed causes and changes:
- IndexedDB index counts still visit every matching key in Chromium. Recounting the queue on each sale/page made badge updates proportional to the backlog. A derived queueCounters row now maintains exact pending/failed/stuck totals in the same native transaction as every queue mutation, including partial bulk failures, overwrite, retry, delete, rollback and restore. Diagnostics sample at most 200 rejected entries; healthy payloads are never loaded to count them. A compound due-time index reads only a bounded due page instead of scanning backed-off rows. Acknowledgements refresh a bounded batch with one exact-key bulk read and share before-images only within the native transaction. After cloud acknowledgement, full duplicate payloads are replaced with compact replay-order evidence; original business records remain intact. Healthy work starts before revive/deep recovery maintenance.
- The till loaded every lifetime ticket and sorted/copied it after each sale, while shift reconciliation depended on that giant array. Till history now uses native keyset pagination and a maximum 200-ticket cache. Load older tickets remains available. Complete shift totals are persisted separately and maintained atomically through sales, voids, tender changes, remote merges and rollback. Legacy totals bootstrap once in bounded pages using the same explicit-shift-ID/cashier-window rules as reconciliation. Close-out reads complete totals, never the recent page. Open-shift lookup has a cashier/status index. Print dispatch follows the durable sale immediately; summary refresh happens afterwards. Console tickets remain account-wide inside the selected reporting period, with a reload on period navigation. A sale finishing after a session-scope change cannot contaminate another cashier's cache.
- Recovery downloaded whole cloud tables and built whole local payload arrays/ID sets before processing anything. Reconciliation now streams 500-row keyset pages, advances its watermark only after all pages succeed, and reloads a reporting store once per changed table. Backfill merges two ordered page streams; account stamping also uses bounded primary-key pages and short write transactions. These paths retain unsent writes and never delete business data merely because it is absent remotely.
- Staff deletion previously refused anyone with records. The owner's explicit requirement now takes precedence: permanent deletion atomically stores a credential-free name/role audit identity, scrubs credentials from queued/synced profile snapshots, removes the login row and queues the archival audit before the users DELETE. Historical sales, shifts, expenses, assessments and ledger entries stay intact. Deleted identities resolve historical names but cannot log in, be edited/reactivated or be revived by stale pulls/backups. The staff roster hides deleted profiles; historical cashier filters and salary statements retain attribution. Owner deletion remains prohibited, and the active till user must be switched before removing that login.
- Sales Record Book filters users by role === cashier, retaining historical disabled/deleted cashiers while excluding admin, server and kitchen roles.
- Balances & payments now expands a salary statement for the selected reporting window: opening balance, daily output and rate, base earnings, labelled bonuses, penalties/reasons, net wages, meal deductions, payments, adjustments/debt forgiveness and closing balance. Draft assessments are excluded. Individual ledger entries show their day, reason and recorder. Inactive/deleted staff with wage history remain payable and retain their statements.

Files: dexieSchema, queueCounters/transactionReadCache/shiftSummaries, IndexedDbService/IDbService, accountScope/cloudBackfill/realtimeSync/remoteMerge/pagedSelect, ticket/shift/auth/sync stores, App/ManagerConsole, RecentTicketsSidebar/CloseShiftModal/StaffMealModal, staff management/payroll, workforce utilities, sales/audit views, migration SQL and regression/browser tests.

Rollout: apply scripts/migrations/20261005_permanent_staff_delete.sql before releasing permanent staff deletion. It atomically removes cloud login credentials when the archival audit arrives and rejects stale attempts to recreate the deleted UUID. It does not cascade business records. Keep the previously required kitchen-unit and shift-ownership migrations. Local IndexedDB v5-v8 adds derived metadata and indexes without clearing tickets or queued work; its one-time migration/bootstrap necessarily reads existing history. Accept the PWA update while tills are idle. Production deployment, SQL execution, physical printer timing and recovery of previously missing affected-device records have not been performed by these source changes.

Verification: real local signup on a phone passed creation of cashier/server accounts, finalized wages/bonus/penalty breakdown, payment through the UI, cashier-only filter, permanent deletion despite sales/wages, preserved attribution after refresh and rejection of the deleted PIN. Cloud/print transport is isolated in QA; no production account was contacted. A reproducible scale harness defaults to one million rows, but a completed one-million-row benchmark is not claimed.

Final transport verification after replacing the slower acknowledgement experiment and removing redundant queue indexes: 20,001 records uploaded in 101 requests, started in 87 ms and drained in 59,648 ms; a concurrent sale saved in 74 ms. The previous committed version, rerun on the same machine with the same isolated 30 ms/request fake cloud, took 99,265 ms (460 ms to first upload). This run reduced drain time by 40%; exact queue status took 58 ms total across 25 checks, compared with 14,910 ms across 24 checks previously. All original local tickets remained; zero pending rows remained. These are local QA timings rather than guarantees about production internet, storage or a physical printer. All 52 Vitest files / 418 tests and the production build passed. The final trading-day/meal browser lifecycle also passed. A full unit run caught malformed QR-only legacy rows missing cashierId in the new compound shift lookup; such rows now skip shift-cache lookup instead of raising an IndexedDB DataError.

Final phone/till verification at 320, 390, 768 and 1280 pixels passed with real local registration, staff allowance editing, cooking-unit creation/consumption, staff meal counters and owner PIN/profile updates preserving the cashier session. With 12,000 queued tickets, queue page/count/revive operations took 47 ms, and a ticket commit plus mocked print dispatch took 208 ms. Refresh retained all 12,002 business records, the original cashier shift and complete totals while keeping only 200 tickets in the till cache. An independent admin tab neither inherited nor replaced that shift. The staff/salary browser lifecycle also verified that navigating to the previous month reloads that period's historical sales and returning to the current month restores current sales.
