-- =============================================================================
-- Supabase Database Schema & Row Level Security (RLS) Setup Script
-- Project: Danbaiwa Restaurant OS (Ticket POS)
-- Run this script in your Supabase project (SQL Editor) to set up tables and RLS.
-- =============================================================================

-- Enable extension for UUID generation if not already active
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Table: users
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY,
  name              TEXT NOT NULL,
  email             TEXT,
  username          TEXT,
  password_hash     TEXT,
  password_salt     TEXT,
  pin_hash          TEXT NOT NULL,
  pin_salt          TEXT NOT NULL,
  recovery_key_hash TEXT,
  recovery_key_salt TEXT,
  role              TEXT NOT NULL DEFAULT 'cashier',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  status            TEXT NOT NULL DEFAULT 'active',
  location_id       TEXT -- Scopes RLS checks for Cashiers/Staff
);

-- Indexes for these tables are defined once, in the FOOTPRINT section near the end of this
-- file. They used to be created here and then dropped there, which on a million-row table
-- meant building an index on every re-run purely to delete it a moment later.

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Table: tickets
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tickets (
  id          TEXT PRIMARY KEY, -- Composite key format: LOC01-DEV01-000001
  location_id TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  local_seq   INTEGER NOT NULL,
  amount      NUMERIC(12, 2) NOT NULL,
  currency    TEXT NOT NULL DEFAULT '₦',
  status      TEXT NOT NULL DEFAULT 'paid',
  tender      TEXT NOT NULL DEFAULT 'cash', -- 'cash' | 'transfer' (card and bank transfer)
  cashier_id  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  qr_payload  TEXT NOT NULL,
  void_reason TEXT,
  voided_by   TEXT,
  voided_at   TIMESTAMPTZ
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Table: shifts
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shifts (
  id             UUID PRIMARY KEY,
  cashier_id     TEXT NOT NULL,
  cashier_name   TEXT NOT NULL,
  location_id    TEXT NOT NULL,
  device_id      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',
  opening_float  NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  opened_at      TIMESTAMPTZ NOT NULL,
  closed_at      TIMESTAMPTZ,
  counted_cash   NUMERIC(12, 2),
  expected_cash  NUMERIC(12, 2),
  variance       NUMERIC(12, 2),
  notes          TEXT
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Table: expenses
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id               UUID PRIMARY KEY,
  shift_id         UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  cashier_id       TEXT NOT NULL,
  cashier_name     TEXT NOT NULL,
  category         TEXT NOT NULL,
  description      TEXT,
  amount           NUMERIC(12, 2) NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  logged_at        TIMESTAMPTZ NOT NULL,
  reviewed_by      TEXT,
  reviewed_at      TIMESTAMPTZ,
  rejection_reason TEXT
);

-- =============================================================================
-- Row Level Security (RLS) Setup & Multi-Location Scoping
-- =============================================================================

-- Enable Row Level Security (RLS) on all POS Tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any to prevent collision on re-runs
DROP POLICY IF EXISTS "Scope users by location" ON users;
DROP POLICY IF EXISTS "Scope tickets by location" ON tickets;
DROP POLICY IF EXISTS "Scope shifts by location" ON shifts;
DROP POLICY IF EXISTS "Scope expenses by location" ON expenses;

-- 1. Users Scoping Policy: Users can query/update themselves,
-- and Admins can manage users scoped to their location.
CREATE POLICY "Scope users by location" ON users
FOR ALL TO authenticated
USING (
  id = auth.uid() OR
  location_id = (auth.jwt() -> 'user_metadata' ->> 'location_id')
)
WITH CHECK (
  id = auth.uid() OR
  location_id = (auth.jwt() -> 'user_metadata' ->> 'location_id')
);

-- 2. Tickets Scoping Policy: Restricts access to matching location_id metadata.
CREATE POLICY "Scope tickets by location" ON tickets
FOR ALL TO authenticated
USING (location_id = (auth.jwt() -> 'user_metadata' ->> 'location_id'))
WITH CHECK (location_id = (auth.jwt() -> 'user_metadata' ->> 'location_id'));

-- 3. Shifts Scoping Policy: Restricts access to matching location_id metadata.
CREATE POLICY "Scope shifts by location" ON shifts
FOR ALL TO authenticated
USING (location_id = (auth.jwt() -> 'user_metadata' ->> 'location_id'))
WITH CHECK (location_id = (auth.jwt() -> 'user_metadata' ->> 'location_id'));

-- 4. Expenses Scoping Policy: Scopes access to expenses related to location shifts.
CREATE POLICY "Scope expenses by location" ON expenses
FOR ALL TO authenticated
USING (
  shift_id IN (
    SELECT id FROM shifts 
    WHERE location_id = (auth.jwt() -> 'user_metadata' ->> 'location_id')
  )
)
WITH CHECK (
  shift_id IN (
    SELECT id FROM shifts 
    WHERE location_id = (auth.jwt() -> 'user_metadata' ->> 'location_id')
  )
);

-- =============================================================================
-- Storage Bucket Setup for SQL.js Binary Backups
-- =============================================================================

-- Snapshots live at snapshots/<account-uuid>/<LOCATION>/<DEVICE>/latest.json (plus dated
-- dailies). The account is the FIRST segment, so the bucket can be policed by folder;
-- the device id is only ever the LAST, because a replacement till knows the account it
-- signed in as but can never guess the device id of the machine it is replacing, so
-- restores list the location folder and take the newest snapshot in it.

-- Create the bucket up front. The app also tries this at startup, but createBucket()
-- normally needs a service role, so a client-side attempt quietly fails and the very
-- first backup upload 404s with no bucket to write into.
INSERT INTO storage.buckets (id, name, public)
VALUES ('db-backups', 'db-backups', false)
ON CONFLICT (id) DO NOTHING;

-- Snapshot bucket policies live at the END of this file, not here: they are written in
-- terms of current_account_id(), and Postgres resolves a policy's expression when the
-- policy is created — so they must come after the function does. See "SNAPSHOT BUCKET".


-- =============================================================================
-- Multi-Device Continuous Sync: updated_at columns, audit_logs table, Realtime
-- =============================================================================
--
-- Local storage on every till is now a continuously-reconciled cache of these
-- tables (see src/services/db/realtimeSync.ts), not each device's sole store of
-- record. Two things make that safe: a server-authoritative `updated_at` on every
-- row (so a stale pull can never win a last-write-wins merge over a newer one) and
-- these tables being added to the `supabase_realtime` publication (so changes
-- propagate to other signed-in devices live, not just on the next manual sync).

-- `updated_at`, stamped by Postgres itself (never trusted from the client) so
-- clock skew between tills can't corrupt the merge order.
-- Cash / transfer split. Every ticket written before this column existed was a drawer
-- sale, so the default backfills them correctly and no data migration is needed.
ALTER TABLE tickets  ADD COLUMN IF NOT EXISTS tender TEXT NOT NULL DEFAULT 'cash';

ALTER TABLE users    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now());
ALTER TABLE tickets  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now());
ALTER TABLE shifts   ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now());
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now());

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_tickets_updated_at ON tickets;
CREATE TRIGGER trg_tickets_updated_at BEFORE INSERT OR UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_shifts_updated_at ON shifts;
CREATE TRIGGER trg_shifts_updated_at BEFORE INSERT OR UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_expenses_updated_at ON expenses;
CREATE TRIGGER trg_expenses_updated_at BEFORE INSERT OR UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_logs table — previously local-only; closes a gap where void/approve/
-- reject actions were never synced, so a manager on a different till could never
-- see them.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  reason      TEXT,
  "timestamp" TIMESTAMPTZ NOT NULL,
  location_id TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

DROP TRIGGER IF EXISTS trg_audit_logs_updated_at ON audit_logs;
CREATE TRIGGER trg_audit_logs_updated_at BEFORE INSERT OR UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Deliberately no UPDATE/DELETE policy — with RLS enabled, no policy means those
-- operations are denied outright. This makes "immutable audit log" true at the
-- database level, not just by convention.
DROP POLICY IF EXISTS "Scope audit_logs read by location" ON audit_logs;
CREATE POLICY "Scope audit_logs read by location" ON audit_logs
FOR SELECT TO authenticated
USING (location_id = (auth.jwt() -> 'user_metadata' ->> 'location_id'));

DROP POLICY IF EXISTS "Scope audit_logs insert by location" ON audit_logs;
CREATE POLICY "Scope audit_logs insert by location" ON audit_logs
FOR INSERT TO authenticated
WITH CHECK (location_id = (auth.jwt() -> 'user_metadata' ->> 'location_id'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime publication — required for postgres_changes subscriptions. A plain
-- `ALTER PUBLICATION ... ADD TABLE` errors on re-run if the table is already a
-- member, unlike this file's other statements, hence the existence check.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'tickets', 'shifts', 'expenses', 'audit_logs'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', t);
    END IF;
  END LOOP;
END $$;

-- =============================================================================
-- ACCOUNT-SCOPED TENANCY  (supersedes the location_id scoping above)
-- =============================================================================
--
-- Why this replaces location scoping entirely:
--
-- The old policies compared `location_id` against
-- `auth.jwt() -> 'user_metadata' ->> 'location_id'`. That claim is only ever written
-- at signup, so every account created before it existed carries no claim at all — the
-- comparison runs against NULL, matches nothing, and the account can neither write
-- (42501) nor read (0 rows) anything, with no error visible in the app. Worse, every
-- install defaults location_id to the literal 'LOC01', so all accounts that DID carry
-- the claim shared a single data pool and could read each other's tickets.
--
-- `auth.uid()` reads the `sub` claim, which is native to every Supabase JWT and always
-- present. There is nothing to populate at signup, nothing to drift when settings
-- change, and nothing to backfill onto existing auth users. The tenant is the admin's
-- auth user id; cashiers hold no cloud identity of their own and simply carry their
-- admin's account_id.
--
-- location_id columns are KEPT as descriptive/reporting fields (the UI still shows
-- them) but are no longer security-relevant.

ALTER TABLE users      ADD COLUMN IF NOT EXISTS account_id UUID;
ALTER TABLE tickets    ADD COLUMN IF NOT EXISTS account_id UUID;
ALTER TABLE shifts     ADD COLUMN IF NOT EXISTS account_id UUID;
ALTER TABLE expenses   ADD COLUMN IF NOT EXISTS account_id UUID;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS account_id UUID;

-- The account_id indexes these tables need are created in the FOOTPRINT section, as
-- (account_id, updated_at) — a leading column answers everything a plain account_id index
-- did, and the pair also matches the incremental pull exactly.

-- audit_logs.location_id was NOT NULL under the old scoping. It is descriptive now, and
-- a till whose config carries no location must still be able to write an audit entry.
ALTER TABLE audit_logs ALTER COLUMN location_id DROP NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- NOTE: a one-time clean slate ran here on 2026-08-30, clearing rows that predated
-- account_id. Those rows were owned by nobody, so no policy below could match them —
-- and because an upsert of the same primary key would have to UPDATE a row the policy
-- cannot see, they would have permanently BLOCKED re-uploading those ids from a device.
-- Each till's history was restored from its own local copy by the backfill sweep
-- (src/services/db/cloudBackfill.ts) on the next sign-in.
--
-- The DELETE statements have been removed deliberately: real multi-device data now
-- lives in these tables and is NOT all recoverable from any single device, so this file
-- must stay safe to re-run. Do not reintroduce them.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- Account-scoped policies
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Scope users by location" ON users;
DROP POLICY IF EXISTS "Scope tickets by location" ON tickets;
DROP POLICY IF EXISTS "Scope shifts by location" ON shifts;
DROP POLICY IF EXISTS "Scope expenses by location" ON expenses;
DROP POLICY IF EXISTS "Scope audit_logs read by location" ON audit_logs;
DROP POLICY IF EXISTS "Scope audit_logs insert by location" ON audit_logs;

-- The `id = auth.uid()` disjunct is load-bearing: adoptAccountFromCloud() reads the
-- admin's own row on a device that has pulled nothing yet, before any account_id is
-- known locally. Without it, first-time device adoption cannot bootstrap.
DROP POLICY IF EXISTS "Scope users by account" ON users;
CREATE POLICY "Scope users by account" ON users
FOR ALL TO authenticated
USING      (id = auth.uid() OR account_id = auth.uid())
WITH CHECK (id = auth.uid() OR account_id = auth.uid());

DROP POLICY IF EXISTS "Scope tickets by account" ON tickets;
CREATE POLICY "Scope tickets by account" ON tickets
FOR ALL TO authenticated
USING (account_id = auth.uid()) WITH CHECK (account_id = auth.uid());

DROP POLICY IF EXISTS "Scope shifts by account" ON shifts;
CREATE POLICY "Scope shifts by account" ON shifts
FOR ALL TO authenticated
USING (account_id = auth.uid()) WITH CHECK (account_id = auth.uid());

-- Direct account check, replacing the old `shift_id IN (SELECT ... FROM shifts)`
-- subquery: an expense is no longer unsyncable merely because its shift has not
-- arrived in the cloud yet.
DROP POLICY IF EXISTS "Scope expenses by account" ON expenses;
CREATE POLICY "Scope expenses by account" ON expenses
FOR ALL TO authenticated
USING (account_id = auth.uid()) WITH CHECK (account_id = auth.uid());

-- Still deliberately no UPDATE/DELETE policy — immutability enforced by the database.
DROP POLICY IF EXISTS "Scope audit_logs read by account" ON audit_logs;
CREATE POLICY "Scope audit_logs read by account" ON audit_logs
FOR SELECT TO authenticated
USING (account_id = auth.uid());

DROP POLICY IF EXISTS "Scope audit_logs insert by account" ON audit_logs;
CREATE POLICY "Scope audit_logs insert by account" ON audit_logs
FOR INSERT TO authenticated
WITH CHECK (account_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- account_settings — business settings follow the account to every device.
-- Stored as a single JSONB blob because these are read and written as one unit
-- (the whole DeviceConfig), and adding a field must not require a migration.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS account_settings (
  account_id UUID PRIMARY KEY,
  settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

DROP TRIGGER IF EXISTS trg_account_settings_updated_at ON account_settings;
CREATE TRIGGER trg_account_settings_updated_at BEFORE INSERT OR UPDATE ON account_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE account_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Scope account_settings by account" ON account_settings;
CREATE POLICY "Scope account_settings by account" ON account_settings
FOR ALL TO authenticated
USING (account_id = auth.uid()) WITH CHECK (account_id = auth.uid());

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'account_settings'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE account_settings;
  END IF;
END $$;

-- =============================================================================
-- DEVICE IDENTITY — a till authenticates as itself, not as its owner
-- =============================================================================
--
-- Until now the only cloud identity was the owner's, and the only way to get one was
-- the admin PIN. Cashiers hold no cloud identity at all, so a till that lost its
-- session went silent until the owner physically came and typed their PIN — the exact
-- situation an owner running the business remotely cannot afford.
--
-- A till now enrols as its own auth user, and reaches the account's data through a
-- membership row rather than by borrowing the owner's login. Three things follow:
--
--   * the till can re-authenticate itself, so no human is needed to restore sync;
--   * a stolen till can write that account's tickets but CANNOT touch the owner's
--     account — it holds no credential of the owner's (previously, an unlocked till
--     held a live owner session that could change the owner's own password);
--   * access is revocable per device, remotely, without changing anyone's PIN.
--
-- Enrolment is deliberately something only an owner session can do: the membership row
-- is INSERTed under the owner's own auth.uid(), so a till cannot enrol itself or move
-- itself to another account.

CREATE TABLE IF NOT EXISTS account_devices (
  auth_user_id UUID PRIMARY KEY,               -- the till's own Supabase auth user
  account_id   UUID NOT NULL,                  -- the owner whose data it may reach
  device_id    TEXT,
  location_id  TEXT,
  label        TEXT,
  status       TEXT NOT NULL DEFAULT 'active', -- 'active' | 'revoked'
  enrolled_at  TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  last_seen_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_account_devices_account ON account_devices(account_id);

DROP TRIGGER IF EXISTS trg_account_devices_updated_at ON account_devices;
CREATE TRIGGER trg_account_devices_updated_at BEFORE INSERT OR UPDATE ON account_devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The tenant key for the caller, whoever they are.
--
-- An owner signing in directly has no device row, so this falls through to auth.uid()
-- and every policy behaves exactly as it did before — which is what makes this
-- migration safe to apply to a live account with tills already in the field.
--
-- SECURITY DEFINER because the lookup must not itself be filtered by the policies that
-- call it. search_path is pinned so the function body cannot be redirected by a
-- caller-controlled schema.
CREATE OR REPLACE FUNCTION current_account_id() RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT d.account_id
       FROM account_devices d
      WHERE d.auth_user_id = auth.uid()
        AND d.status = 'active'),
    auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION current_account_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_account_id() TO authenticated;

-- A till reports itself alive without being able to edit anything else about its own
-- enrolment. Written as a function precisely because the device has no UPDATE policy:
-- letting it write its own row would let a compromised till un-revoke itself or point
-- itself at another account.
CREATE OR REPLACE FUNCTION touch_device_last_seen() RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE account_devices
     SET last_seen_at = timezone('utc'::text, now())
   WHERE auth_user_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION touch_device_last_seen() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION touch_device_last_seen() TO authenticated;

ALTER TABLE account_devices ENABLE ROW LEVEL SECURITY;

-- The owner manages their own fleet: enrol, rename, revoke.
DROP POLICY IF EXISTS "Owners manage their devices" ON account_devices;
CREATE POLICY "Owners manage their devices" ON account_devices
FOR ALL TO authenticated
USING      (account_id = auth.uid())
WITH CHECK (account_id = auth.uid());

-- A till may read its own enrolment (to discover it has been revoked, and say so)
-- and nothing else. Deliberately SELECT-only: see touch_device_last_seen above.
DROP POLICY IF EXISTS "Devices read their own enrolment" ON account_devices;
CREATE POLICY "Devices read their own enrolment" ON account_devices
FOR SELECT TO authenticated
USING (auth_user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- Re-point every policy at current_account_id().
--
-- Identical behaviour for an owner session (the COALESCE falls through to auth.uid());
-- a till session now resolves to the account it is enrolled with. Revoking a device
-- makes the lookup miss, the COALESCE returns the till's own id, and it matches no row
-- in any table — so revocation takes effect immediately, everywhere, with nothing to
-- roll out to the device itself.
-- ─────────────────────────────────────────────────────────────────────────────

-- The `id = auth.uid()` disjunct stays for owner bootstrap: adoptAccountFromCloud()
-- reads the owner's own row on a device that has pulled nothing yet.
DROP POLICY IF EXISTS "Scope users by account" ON users;
CREATE POLICY "Scope users by account" ON users
FOR ALL TO authenticated
USING      (id = auth.uid() OR account_id = current_account_id())
WITH CHECK (id = auth.uid() OR account_id = current_account_id());

DROP POLICY IF EXISTS "Scope tickets by account" ON tickets;
CREATE POLICY "Scope tickets by account" ON tickets
FOR ALL TO authenticated
USING (account_id = current_account_id()) WITH CHECK (account_id = current_account_id());

DROP POLICY IF EXISTS "Scope shifts by account" ON shifts;
CREATE POLICY "Scope shifts by account" ON shifts
FOR ALL TO authenticated
USING (account_id = current_account_id()) WITH CHECK (account_id = current_account_id());

DROP POLICY IF EXISTS "Scope expenses by account" ON expenses;
CREATE POLICY "Scope expenses by account" ON expenses
FOR ALL TO authenticated
USING (account_id = current_account_id()) WITH CHECK (account_id = current_account_id());

-- Still deliberately no UPDATE/DELETE policy — immutability enforced by the database.
DROP POLICY IF EXISTS "Scope audit_logs read by account" ON audit_logs;
CREATE POLICY "Scope audit_logs read by account" ON audit_logs
FOR SELECT TO authenticated
USING (account_id = current_account_id());

DROP POLICY IF EXISTS "Scope audit_logs insert by account" ON audit_logs;
CREATE POLICY "Scope audit_logs insert by account" ON audit_logs
FOR INSERT TO authenticated
WITH CHECK (account_id = current_account_id());

DROP POLICY IF EXISTS "Scope account_settings by account" ON account_settings;
CREATE POLICY "Scope account_settings by account" ON account_settings
FOR ALL TO authenticated
USING (account_id = current_account_id()) WITH CHECK (account_id = current_account_id());

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'account_devices'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE account_devices;
  END IF;
END $$;

-- =============================================================================
-- SNAPSHOT BUCKET — one account's database snapshots are one account's business
-- =============================================================================

-- Snapshots are scoped to the account that wrote them, by folder:
--
--   snapshots/<account-uuid>/<LOCATION>/<DEVICE>/latest.json
--
-- These policies used to grant every authenticated user the whole bucket. Combined with
-- a path that named only the location, and every install defaulting to LOC01, that meant
-- one account's till could list and download another account's entire database — and it
-- did: a freshly installed till restored the wrong tenant's records, then spent its life
-- being refused as it tried to re-upload them under its own account. The folder check
-- below is what makes the client-side scoping in src/utils/backupPaths.ts enforceable
-- rather than merely intended.
--
-- current_account_id() (not auth.uid()) so an enrolled till reaches its OWNER's folder
-- and not one of its own. Index [2] is the segment after 'snapshots'; it is compared as
-- text, which is why the client writes that segment lowercase and unmangled.
--
-- NOTE: snapshots written before this migration live at snapshots/<LOCATION>/... and are
-- no longer readable by anyone. That is deliberate — none of them can be proven to belong
-- to the account restoring them. Every live till writes a fresh, correctly-scoped
-- snapshot within seconds of its next write.

DROP POLICY IF EXISTS "authenticated users can upload backups" ON storage.objects;
DROP POLICY IF EXISTS "authenticated users can read backups" ON storage.objects;
DROP POLICY IF EXISTS "authenticated users can overwrite backups" ON storage.objects;

DROP POLICY IF EXISTS "accounts write their own backups" ON storage.objects;
CREATE POLICY "accounts write their own backups"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'db-backups'
  AND (storage.foldername(name))[2] = current_account_id()::text
);

-- Required for restores. Without SELECT, listing and downloading snapshots is denied
-- by RLS, so a replacement machine can never find a backup no matter how it is keyed.
DROP POLICY IF EXISTS "accounts read their own backups" ON storage.objects;
CREATE POLICY "accounts read their own backups"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'db-backups'
  AND (storage.foldername(name))[2] = current_account_id()::text
);

-- Required for `upsert: true`. latest.json is overwritten on every snapshot; with only
-- an INSERT policy every write after the first one is rejected.
DROP POLICY IF EXISTS "accounts overwrite their own backups" ON storage.objects;
CREATE POLICY "accounts overwrite their own backups"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'db-backups'
  AND (storage.foldername(name))[2] = current_account_id()::text
)
WITH CHECK (
  bucket_id = 'db-backups'
  AND (storage.foldername(name))[2] = current_account_id()::text
);

-- =============================================================================
-- TICKET KEY — unique per restaurant, not per project
-- =============================================================================
--
-- tickets.id is a composite string minted on the till: LOC01-DEV01-K3F9QZ-000042
-- (location, device, installation, sequence). As a bare PRIMARY KEY it has to be unique
-- across the WHOLE project — every restaurant in it — which is a promise the till cannot
-- keep and should not have to. Location and device both default to LOC01/DEV01 on a
-- fresh install, and tickets minted before the installation segment existed carry only
-- three parts, so two unrelated restaurants can easily mint the same id.
--
-- The consequence is not a nice clean error. Whoever uploads that id first owns it; the
-- second restaurant's upsert then has to UPDATE a row its policy cannot see, and Postgres
-- refuses it with
--
--   new row violates row-level security policy (USING expression) for table "tickets"
--
-- forever. That record can never reach the cloud, and the reconciliation sweep re-queues
-- it on every pass because it cannot read it back either. One tenant silently and
-- permanently blocks an id for everyone else.
--
-- Scoping the key to the account removes the shared namespace entirely: an id now only
-- has to be unique within one restaurant, which is exactly the guarantee the till can
-- actually make. Two restaurants may hold the same ticket id and neither is aware of it.
--
-- Side benefit: the primary key is also the default REPLICA IDENTITY, so account_id now
-- travels in realtime DELETE payloads. The subscriptions in realtimeSync.ts filter on
-- account_id=eq.<account>, and a DELETE that carried only the id could never match that
-- filter — deletions were silently not propagating to other devices.
--
-- The other synced tables need none of this: their ids are UUIDs, which do not collide.
--
-- Safe to re-run: it checks the current key first and does nothing if already applied.
-- If any ticket has no account_id it declines to run rather than guessing an owner —
-- with more than one restaurant in the project, claiming an orphan row blindly would
-- hand one tenant another's takings. Fix those rows (see the REPAIR section) and re-run.

DO $$
DECLARE
  orphans BIGINT;
  pk_name TEXT;
  pk_cols TEXT;
BEGIN
  SELECT count(*) INTO orphans FROM tickets WHERE account_id IS NULL;

  IF orphans > 0 THEN
    RAISE NOTICE
      'Ticket key migration SKIPPED: % ticket(s) have no account_id. Give them an owner (see the REPAIR section at the end of this file), then re-run.',
      orphans;
    RETURN;
  END IF;

  SELECT c.conname,
         (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
            FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
    INTO pk_name, pk_cols
    FROM pg_constraint c
   WHERE c.conrelid = 'public.tickets'::regclass
     AND c.contype = 'p';

  IF pk_cols = 'account_id,id' THEN
    RETURN; -- already migrated
  END IF;

  ALTER TABLE tickets ALTER COLUMN account_id SET NOT NULL;

  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE tickets DROP CONSTRAINT %I', pk_name);
  END IF;

  ALTER TABLE tickets ADD CONSTRAINT tickets_pkey PRIMARY KEY (account_id, id);

  RAISE NOTICE 'tickets primary key is now (account_id, id)';
END $$;

-- An index on id alone used to be created here, for a lookup by ticket number against the
-- whole account. Nothing performs that lookup — a scanned ticket is checked on the till,
-- against its own copy — and "cheap to keep" stopped being true at a million rows a year.
-- See the FOOTPRINT section. One statement brings it back if the cloud ever needs it:
--
--   CREATE INDEX idx_tickets_id_sb ON tickets(id);

-- =============================================================================
-- FOOTPRINT — the cloud is a transport, not a filing cabinet
-- =============================================================================
--
-- A restaurant doing 3,000 tickets a day writes about 1.1 million ticket rows a year.
-- Against a 500 MB database that makes every byte per row a decision, and two of them
-- were being spent on nothing at all.
--
-- ── 1. Indexes nothing reads ────────────────────────────────────────────────
--
-- An index is not free: it is written on every insert and it occupies space per row, for
-- ever. These were created for queries this application does not make. It reads the cloud
-- exactly two ways —
--
--     select id            where account_id = ...                      (cloudBackfill)
--     select *             where account_id = ... and updated_at >= ... (realtimeSync)
--
-- — plus realtime's own account_id filter. Every report the business actually looks at
-- (by cashier, by day, by status, by location) is computed on the till against its local
-- copy, and never touches Postgres at all. So an index on cashier_id or created_at here
-- has never once been used to answer a question, while costing ~40 bytes on every row.
--
-- The (account_id, updated_at) indexes below replace the plain account_id ones: a leading
-- column serves the same lookups, so nothing is lost, and the incremental pull — the one
-- query that runs constantly — gets an index that matches it exactly. tickets needs none,
-- since its primary key already leads with account_id.
--
-- Reversible: an index is derived data, and any of these can be recreated in one statement
-- if a future feature queries the cloud a new way.

DROP INDEX IF EXISTS idx_tickets_cashier_sb;
DROP INDEX IF EXISTS idx_tickets_created_sb;
DROP INDEX IF EXISTS idx_tickets_status_sb;
DROP INDEX IF EXISTS idx_tickets_location_sb;
DROP INDEX IF EXISTS idx_tickets_id_sb;
DROP INDEX IF EXISTS idx_tickets_account_sb;
DROP INDEX IF EXISTS idx_shifts_cashier_sb;
DROP INDEX IF EXISTS idx_shifts_status_sb;
DROP INDEX IF EXISTS idx_shifts_location_sb;
DROP INDEX IF EXISTS idx_shifts_account_sb;
DROP INDEX IF EXISTS idx_expenses_shift_sb;
DROP INDEX IF EXISTS idx_expenses_cashier_sb;
DROP INDEX IF EXISTS idx_expenses_account_sb;
DROP INDEX IF EXISTS idx_users_email_sb;
DROP INDEX IF EXISTS idx_users_location_sb;
DROP INDEX IF EXISTS idx_users_account_sb;
DROP INDEX IF EXISTS idx_audit_logs_entity_sb;
DROP INDEX IF EXISTS idx_audit_logs_location_sb;
DROP INDEX IF EXISTS idx_audit_logs_account_sb;

CREATE INDEX IF NOT EXISTS idx_tickets_sync    ON tickets(account_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_shifts_sync     ON shifts(account_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_expenses_sync   ON expenses(account_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_users_sync      ON users(account_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_sync ON audit_logs(account_id, updated_at);

-- ── 2. qr_payload, which restates three columns it sits beside ──────────────
--
-- It is `TICKET|<id>|<amount>|<created_at>` — about 60 bytes per ticket saying nothing the
-- row does not already say, which is ~65 MB per restaurant per year. Tills no longer send
-- it and rebuild it from those three fields instead (ticketQrPayload in remoteMerge.ts),
-- reproducing the original exactly, so a reprint still scans identically to the paper.
--
-- ORDER MATTERS: run this BEFORE deploying the build that stops sending the column. A till
-- that omits a NOT NULL column with no default has every ticket refused (23502). The other
-- way round is harmless — an older till still sends the text and it is simply stored.
--
-- Existing values are deliberately left alone. They are correct, they are preferred over a
-- rebuilt payload wherever they exist, and the space they occupy is reclaimed by ordinary
-- autovacuum as those rows age out. Dropping the column outright is left for later, once
-- no till in the field is still sending it:
--
--   ALTER TABLE tickets DROP COLUMN qr_payload;

ALTER TABLE tickets ALTER COLUMN qr_payload DROP NOT NULL;

-- ── 3. Where the space is actually going ────────────────────────────────────
--
--   SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
--     FROM pg_catalog.pg_statio_user_tables
--    ORDER BY pg_total_relation_size(relid) DESC;

-- =============================================================================
-- REPAIR — records the cloud holds but a till is no longer allowed to touch
-- =============================================================================
--
-- The symptom, in the browser console of a till whose queue will not drain:
--
--   new row violates row-level security policy (USING expression) for table "tickets"
--
-- Read that message carefully — the "(USING expression)" half is the diagnosis. A plain
-- "violates row-level security policy" means the row being written was rejected. The
-- USING variant is raised only on the ON CONFLICT branch of an upsert: a row with that
-- primary key ALREADY EXISTS, and the policy will not let this session see or update it.
-- Retrying can never succeed, and the till cannot repair it from the client either,
-- because it cannot see the offending rows at all. Hence a repair that runs here, in the
-- SQL editor, where RLS does not apply.
--
-- How a device gets into that state: account_id on the stored row no longer equals
-- current_account_id() for the till writing it. Either the row was stamped with an id
-- that belongs to no account (a till's own auth id — the client no longer does this, see
-- resolveAccountId in src/services/supabase/deviceIdentity.ts), or the till's enrolment
-- was revoked or deleted, so current_account_id() falls back to the till's own auth id
-- and stops matching the account's data. The reconciliation sweep then reads back
-- nothing, concludes the cloud is missing the device's entire history, re-queues all of
-- it, and every row is refused this way: hundreds pending, nothing moving.
--
-- ── 1. Diagnose. Who owns the rows, and is that an account or a till? ────────
--
--   SELECT account_id, count(*) FROM tickets GROUP BY 1 ORDER BY 2 DESC;
--
--   -- Any account_id in that list which appears here is a TILL's id, not an account's:
--   SELECT auth_user_id, account_id, status, label, last_seen_at FROM account_devices;
--
--   -- And what the cloud resolves for the session you are worried about — run this
--   -- from the app's own console (it is what every policy compares against):
--   --   await supabase.rpc('current_account_id')
--
-- ── 2. Re-point rows stamped with a till's id back to that till's account ────
--
-- Safe and idempotent: it only touches rows whose account_id is a known device id, and
-- a device id is never an account id. Running it twice changes nothing the second time.

UPDATE users      t SET account_id = d.account_id FROM account_devices d WHERE t.account_id = d.auth_user_id;
UPDATE tickets    t SET account_id = d.account_id FROM account_devices d WHERE t.account_id = d.auth_user_id;
UPDATE shifts     t SET account_id = d.account_id FROM account_devices d WHERE t.account_id = d.auth_user_id;
UPDATE expenses   t SET account_id = d.account_id FROM account_devices d WHERE t.account_id = d.auth_user_id;
UPDATE audit_logs t SET account_id = d.account_id FROM account_devices d WHERE t.account_id = d.auth_user_id;

-- ── 2b. The owner's own profile row, left ownerless ──────────────────────────
--
-- A users row whose id is an auth user IS that account's own profile — users.id is the
-- owner's auth uid, and their account is themselves. So unlike the ownerless rows in step
-- 4 below, there is nothing to guess here and nothing that could be handed to the wrong
-- tenant: the row states its owner in its primary key.
--
-- Worth its own statement because of how it presents. The owner's device can still update
-- that row (the `id = auth.uid()` disjunct in the users policy sees it), so nothing looks
-- wrong there — but no enrolled till can, and the till's backfill sweep cannot read it
-- back either, so it re-queues it every pass and every push is refused with the USING
-- variant. That is the "1 record permanently queued" a till reports for ever while
-- everything else syncs.
--
-- Safe and idempotent.

UPDATE users u SET account_id = u.id
 WHERE u.account_id IS NULL
   AND EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.id);

-- Any users row still stuck after steps 2 and 2b is a genuine cross-account collision —
-- the cloud holds that id for somebody else. The till names the ids in its console
-- ("id(s) the cloud holds under another account"); look them up here, from the SQL
-- editor, where RLS does not apply:
--
--   SELECT id, account_id, role, name, email FROM users WHERE id = '<id from console>';
--
-- ── 3. Re-enable a till whose enrolment was revoked ──────────────────────────
--
-- Deliberately NOT run automatically: a revoked till may have been revoked on purpose
-- (lost, stolen, sold). Un-revoke only the ones you mean to, by id from step 1:
--
--   UPDATE account_devices SET status = 'active' WHERE auth_user_id = '<till-uuid>';
--
-- A till whose enrolment row was DELETED rather than revoked needs no SQL at all: an
-- admin signing in on it with their PIN enrols it again.
--
-- ── 4. Rows owned by nobody (account_id IS NULL) ─────────────────────────────
--
-- Left commented because only you can know whose they are. With a single account in the
-- project the answer is unambiguous; with more than one, claiming them blindly would
-- hand one tenant another's records. Check the count first, then claim deliberately:
--
--   SELECT count(*) FROM tickets WHERE account_id IS NULL;
--   UPDATE tickets SET account_id = '<your-account-uuid>' WHERE account_id IS NULL;
--
-- ── 5. Legacy snapshots in the backup bucket ─────────────────────────────────
--
-- Snapshots written before the bucket was partitioned by account sit at
-- snapshots/<LOCATION>/... and belong to nobody in particular. The policies above make
-- them unreadable, which is the point — a fresh till restoring one is how another
-- account's records arrive on a device that can never sync them. They are now dead
-- weight and can be deleted from the Storage browser in the dashboard. Live tills write
-- a fresh, correctly-scoped snapshot within seconds of their next write; nothing is lost
-- that the account's own tables do not already hold.
