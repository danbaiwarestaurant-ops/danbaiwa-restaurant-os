# Danbaiwa Restaurant OS — Deployment & Operation Guide

The app is a PWA deployed to Vercel. Tills open the live URL in Chrome or Edge, and work
offline from that point on. Records sync through Supabase.

Printing has its own guide: **[PRINTING.md](PRINTING.md)**.

---

## 1. Deploying the app

```bash
npm install
npm run build      # also refreshes public/print-agent/ (see PRINTING.md)
```

Vercel builds from the repository. Nothing else is needed for the app itself.

### Environment variables — set these in Vercel, not in a file

`.env.local` is **not** deployed. The Supabase credentials must be set in the Vercel
project's Environment Variables, or the deployed app runs with no cloud at all:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Without them `isSupabaseConfigured` is false, and the symptoms are misleading rather than
obvious: every browser profile becomes an island, accounts cannot be restored onto a new
machine, and the duplicate-email check on registration has nothing to ask. If a till is
behaving as though the cloud does not exist, check this first — the login screen's
**"Why can't I sign in?"** panel reports whether the build has credentials at all.

Optionally, `VITE_AUTH_REDIRECT_URL` pins where Supabase email links land, for installs
reached at an address other than the one that should receive them.

---

## 2. Supabase setup

### 2a. Schema

1. Open the Supabase project's SQL Editor.
2. Paste and run `supabase_schema.sql` (project root).

Safe to re-run: it creates nothing twice and deletes nothing. **Re-run it after updating
the app** — it is also how schema changes reach a live project.

### 2b. Auth URL configuration — the reset-link trap

**Authentication → URL Configuration.**

- **Site URL** — the address tills actually use, e.g.
  `https://danbaiwa-restaurant-os.vercel.app`
- **Redirect URLs** — the same address with `/**`, plus `http://localhost:5173/**` for
  local work.

Supabase honours a `redirectTo` **only** when the exact URL is on the Redirect URLs list.
Anything else is silently replaced with the Site URL — no error, no warning. If the Site
URL points at a deployment-specific Vercel address, those are protected by Vercel
Authentication, so every password reset link lands on a Vercel login page instead of the
till. That is the whole of that bug.

The forgot-password form prints the URL it is about to use, so it can be copied straight
into the allow-list.

### 2c. Email confirmation

**Authentication → Users** shows a **Confirmed at** date per account.

If the project requires email confirmation, a new sign-up returns **no session**. The till
that registered the account therefore never uploads that account's profile row, and every
other device is refused with "Email not confirmed". The account works perfectly on one
machine and nowhere else, for ever. Registration now says so plainly, but if an owner
reports being locked out everywhere except one till, check this column first.

### 2d. Till enrolment

The `DEVICE IDENTITY` section at the end of `supabase_schema.sql` lets each till sign in to
the cloud **as itself** instead of borrowing the owner's login. Until that section has been
run the app works exactly as before — it detects the missing table, stands down, and keeps
using the owner's session — so deploying the app first and the SQL later is safe.

Once run, the next admin sign-in on a till enrols it. From then on:

- the till restores its own cloud session after a logout, a reload, or a spell offline,
  with **no admin PIN and nobody present**;
- a lost or stolen till can be **revoked individually** from *Manager Console → Settings →
  Tills Connected to This Account*, without changing anyone's PIN or disturbing the other
  tills. Revocation takes effect server-side immediately;
- a till holds **no credential of the owner's**, so picking up a machine no longer exposes
  the owner's account.

Changing the admin PIN still requires an owner signed in on that till: a PIN change is a
change to the owner's cloud password, and a till session deliberately cannot make it.

---

## 3. Setting up a till

1. **Open the live URL** in Chrome or Edge, with internet, and let it finish loading. The
   service worker pre-caches the app for offline use.
2. **Install it** (address-bar install icon) if you want a standalone window, or use
   `Launch POS (Vercel).bat` for full-screen kiosk mode. That launcher finds Chrome or
   Edge automatically; set `BROWSER` at the top of the file to force one.
3. **Sign in** with the admin email and admin PIN. On a machine that has never held the
   account, the PIN is what pulls it down — the account password is only ever checked
   against a local copy, which does not exist there yet.
4. **Set up the printer**: *Manager Console → Printer Setup*. See
   [PRINTING.md](PRINTING.md).

> The address must be `https://` or `localhost`. On a plain `http://` LAN address browsers
> withhold `crypto.subtle`, every PIN check throws, and **no correct credential can ever
> work**. The login screen's diagnostics panel says so outright when it happens.

---

## 4. Updating a live till

Deploying does not, by itself, move a till onto the new build. A service worker installs
the new version and then **waits** until every window running the old one has closed — and
a reload is one of those windows, so refreshing never releases it.

The app handles this on its own now: it checks every 15 minutes and on regaining focus,
shows a prompt at the top of the screen that returns if dismissed, and **Update Now**
escalates to a full reinstall if the worker does not hand over within five seconds.

**To check or force it:** *Manager Console → Settings → App Version* shows the running
build, with **Check for updates** and **Reinstall the app on this till**. The reinstall
clears the cached app files only — tickets, shifts, staff, settings and the outbox are in
IndexedDB and are untouched.

**If a till is stuck on an old build and predates this machinery:**
F12 → **Application** → **Service workers** → **Unregister**, then `Ctrl+Shift+R`.

A wedged registration belongs to the **browser**, not the machine — the other browser on
the same PC will be perfectly current. Switching that till to Edge is a legitimate fix, not
a workaround: it is Chromium, so silent printing, Web Serial, WebUSB, PWA install and
offline caching all behave identically.

---

## 5. Operational checklists

### Cashier — shift start
- [ ] Open the POS at the till.
- [ ] Click **Shift Closed (Click to Open)** in the header.
- [ ] Declare the physical opening cash float (e.g. ₦5,000).
- [ ] Tap preset cards or use the home-row hotkeys (`A` `S` `D` `F` `G` `H` `J` `K` `L`).

### Cashier — mid-shift expense
- [ ] Click **Expense**; enter the payout amount, category and notes.
- [ ] It enters the manager approval queue automatically.

### Manager — shift close & reconciliation
- [ ] Click **Shift Open**, enter the physical cash count from the drawer.
- [ ] Review expected cash against the physical count.
- [ ] Confirm the variance and finalise the close.

### Manager — weekly
- [ ] Check the sync badge on each till reads connected with nothing pending.
- [ ] Check *Settings → App Version* matches across tills.
- [ ] Check *Settings → Tills Connected to This Account* lists only machines you recognise.
