-- =====================================================================
-- TICKET POS — SUPABASE POSTGRES SCHEMA (IDEMPOTENT RLS PROTECTED)
-- =====================================================================

-- 1. Device Configuration Table
CREATE TABLE IF NOT EXISTS public.device_configs (
    location_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    business_name TEXT NOT NULL,
    location_name TEXT NOT NULL,
    currency_symbol TEXT DEFAULT '₦',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (location_id, device_id)
);

-- 2. Tickets Table (Client-Generated Composite Key: location_id-device_id-local_seq)
CREATE TABLE IF NOT EXISTS public.tickets (
    id TEXT PRIMARY KEY, -- Composite key e.g. LOC01-DEV01-000001
    location_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    local_seq INT8 NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    currency TEXT DEFAULT '₦',
    status TEXT NOT NULL CHECK (status IN ('paid', 'collected', 'void')),
    cashier_id TEXT NOT NULL,
    void_reason TEXT,
    voided_by TEXT,
    voided_at TIMESTAMPTZ,
    qr_payload TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for multi-location reporting rollups
CREATE INDEX IF NOT EXISTS idx_tickets_location_date ON public.tickets (location_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON public.tickets (status);

-- 3. Shifts Table (Cash Reconciliation)
CREATE TABLE IF NOT EXISTS public.shifts (
    id UUID PRIMARY KEY, -- Client-generated UUID
    location_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    cashier_id TEXT NOT NULL,
    cashier_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    opened_at TIMESTAMPTZ NOT NULL,
    closed_at TIMESTAMPTZ,
    opening_float NUMERIC(12, 2) NOT NULL,
    expected_cash NUMERIC(12, 2),
    counted_cash NUMERIC(12, 2),
    variance NUMERIC(12, 2),
    notes TEXT,
    synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Expenses Table (Approval Queue)
CREATE TABLE IF NOT EXISTS public.expenses (
    id UUID PRIMARY KEY, -- Client-generated UUID
    shift_id TEXT NOT NULL,
    cashier_id TEXT NOT NULL,
    cashier_name TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    logged_at TIMESTAMPTZ NOT NULL,
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    rejection_reason TEXT,
    synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Immutable Audit Logs Table (Append Only)
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL
);

-- =====================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES — ANON KEY ACCESS ONLY
-- =====================================================================
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_configs ENABLE ROW LEVEL SECURITY;

-- Allow anon key to insert/upsert idempotent records
CREATE POLICY "Allow anon insert tickets" ON public.tickets FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update tickets" ON public.tickets FOR UPDATE USING (true);
CREATE POLICY "Allow anon read tickets" ON public.tickets FOR SELECT USING (true);

CREATE POLICY "Allow anon insert shifts" ON public.shifts FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update shifts" ON public.shifts FOR UPDATE USING (true);
CREATE POLICY "Allow anon read shifts" ON public.shifts FOR SELECT USING (true);

CREATE POLICY "Allow anon insert expenses" ON public.expenses FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update expenses" ON public.expenses FOR UPDATE USING (true);
CREATE POLICY "Allow anon read expenses" ON public.expenses FOR SELECT USING (true);

CREATE POLICY "Allow anon insert audit_logs" ON public.audit_logs FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon read audit_logs" ON public.audit_logs FOR SELECT USING (true);

CREATE POLICY "Allow anon read device_configs" ON public.device_configs FOR SELECT USING (true);
