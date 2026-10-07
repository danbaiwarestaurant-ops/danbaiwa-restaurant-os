-- Incident repair: PGRST204 / 42703 on tickets.shift_id and shifts.installation_id.
-- Run in the affected project's Supabase SQL Editor. Re-running is safe.
-- No records, policies, credentials or active shifts are removed or rewritten.
BEGIN;
-- Fail cleanly instead of waiting behind a busy transaction and stalling trading.
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS installation_id text;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS shift_id uuid;
NOTIFY pgrst, 'reload schema';
COMMIT;

-- Both rows below must be present, with the indicated types.
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'shifts' AND column_name = 'installation_id')
    OR (table_name = 'tickets' AND column_name = 'shift_id'))
ORDER BY table_name, column_name;
