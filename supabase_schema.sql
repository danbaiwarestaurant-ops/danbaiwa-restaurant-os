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
