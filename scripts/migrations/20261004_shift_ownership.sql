-- Apply before releasing the app. Additive: existing shift/ticket history is retained.
BEGIN;
ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS installation_id text;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS shift_id uuid;
CREATE INDEX IF NOT EXISTS tickets_account_shift_idx ON public.tickets(account_id, shift_id);
NOTIFY pgrst, 'reload schema';
COMMIT;
