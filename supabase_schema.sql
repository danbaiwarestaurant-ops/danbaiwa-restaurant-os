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

CREATE INDEX IF NOT EXISTS idx_users_email_sb ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_location_sb ON users(location_id);

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
  cashier_id  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  qr_payload  TEXT NOT NULL,
  void_reason TEXT,
  voided_by   TEXT,
  voided_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tickets_cashier_sb ON tickets(cashier_id);
CREATE INDEX IF NOT EXISTS idx_tickets_created_sb ON tickets(created_at);
CREATE INDEX IF NOT EXISTS idx_tickets_status_sb  ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_location_sb ON tickets(location_id);

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

CREATE INDEX IF NOT EXISTS idx_shifts_cashier_sb ON shifts(cashier_id);
CREATE INDEX IF NOT EXISTS idx_shifts_status_sb  ON shifts(status);
CREATE INDEX IF NOT EXISTS idx_shifts_location_sb ON shifts(location_id);

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

CREATE INDEX IF NOT EXISTS idx_expenses_shift_sb   ON expenses(shift_id);
CREATE INDEX IF NOT EXISTS idx_expenses_cashier_sb ON expenses(cashier_id);

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

-- Snapshots live at snapshots/<LOCATION>/<DEVICE>/latest.db (plus dated dailies).
-- The device id is only ever the LAST segment: a replacement till knows the account
-- it signed in as, but can never guess the device id of the machine it is replacing,
-- so restores list the location folder and take the newest snapshot in it.

-- Create the bucket up front. The app also tries this at startup, but createBucket()
-- normally needs a service role, so a client-side attempt quietly fails and the very
-- first backup upload 404s with no bucket to write into.
INSERT INTO storage.buckets (id, name, public)
VALUES ('db-backups', 'db-backups', false)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to perform snapshot DB backup writes
DROP POLICY IF EXISTS "authenticated users can upload backups" ON storage.objects;
CREATE POLICY "authenticated users can upload backups"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'db-backups');

-- Required for restores. Without SELECT, listing and downloading snapshots is denied
-- by RLS, so a replacement machine can never find a backup no matter how it is keyed.
DROP POLICY IF EXISTS "authenticated users can read backups" ON storage.objects;
CREATE POLICY "authenticated users can read backups"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'db-backups');

-- Required for `upsert: true`. latest.db is overwritten on every snapshot; with only
-- an INSERT policy every write after the first one is rejected.
DROP POLICY IF EXISTS "authenticated users can overwrite backups" ON storage.objects;
CREATE POLICY "authenticated users can overwrite backups"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'db-backups')
WITH CHECK (bucket_id = 'db-backups');

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

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_sb   ON audit_logs(entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_location_sb ON audit_logs(location_id);

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

CREATE INDEX IF NOT EXISTS idx_users_account_sb      ON users(account_id);
CREATE INDEX IF NOT EXISTS idx_tickets_account_sb    ON tickets(account_id);
CREATE INDEX IF NOT EXISTS idx_shifts_account_sb     ON shifts(account_id);
CREATE INDEX IF NOT EXISTS idx_expenses_account_sb   ON expenses(account_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_account_sb ON audit_logs(account_id);

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
