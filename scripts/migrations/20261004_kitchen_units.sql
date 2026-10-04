-- Apply before deploying the phone/admin/kitchen-unit release.
-- Additive, replay-safe; existing rows and historical sales are unchanged.
BEGIN;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS cooking_unit TEXT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS base_units_per_cooking_unit NUMERIC CHECK (base_units_per_cooking_unit > 0);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS preparation_cost_per_cooking_unit NUMERIC(16,2) CHECK (preparation_cost_per_cooking_unit >= 0);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS profit_per_cooking_unit NUMERIC(16,2) CHECK (profit_per_cooking_unit >= 0);
COMMIT;
