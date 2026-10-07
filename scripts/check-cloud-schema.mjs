import { loadEnv } from 'vite';

// Public-key, zero-row queries only. No sign-in or business data is required.
// Run against the deployment's env before releasing a client that writes these fields.
const env = { ...loadEnv('production', process.cwd(), ''), ...process.env };
const base = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_ANON_KEY;
if (!base || !key) {
  console.error('Cloud schema check needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  process.exit(1);
}
const contracts = {
  tickets: ['id', 'account_id', 'shift_id', 'updated_at'],
  shifts: ['id', 'account_id', 'installation_id', 'updated_at'],
  inventory_items: ['cooking_unit', 'base_units_per_cooking_unit', 'preparation_cost_per_cooking_unit', 'profit_per_cooking_unit'],
};
console.log(`Checking required schema on ${new URL(base).hostname} (zero records read).`);
let failed = false;
for (const [table, columns] of Object.entries(contracts)) {
  try {
    const url = new URL(`/rest/v1/${table}`, base);
    url.searchParams.set('select', columns.join(','));
    url.searchParams.set('limit', '0');
    const response = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      const error = await response.json();
      console.error(`${table}: FAILED [${error.code || response.status}] ${error.message || 'Cloud rejected schema check'}`);
      failed = true;
    } else {
      console.log(`${table}: OK (${columns.join(', ')})`);
    }
  } catch {
    console.error(`${table}: FAILED (cloud unavailable or invalid response)`);
    failed = true;
  }
}
if (failed) {
  console.error('Do not release the client yet. Apply the required database migrations, reload the API schema, and rerun this check.');
  process.exitCode = 1;
} else {
  console.log('Required columns are available. This check does not verify account permissions or record delivery.');
}
