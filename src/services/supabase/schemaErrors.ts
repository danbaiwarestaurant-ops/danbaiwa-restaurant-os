export interface CloudRequestError {
  code?: string;
  message?: string;
  hint?: string;
}

/** These faults describe the deployed database, rather than one bad sale. */
export function isCloudSchemaError(error: CloudRequestError | null): boolean {
  return ['PGRST204', 'PGRST205', '42703', '42P01'].includes(String(error?.code ?? ''));
}

export function cloudSchemaRepairMessage(table: string, error: CloudRequestError): string {
  const shiftOwnership = (table === 'tickets' && /\bshift_id\b/.test(error.message ?? '')) ||
    (table === 'shifts' && /\binstallation_id\b/.test(error.message ?? ''));
  const migration = shiftOwnership
    ? 'scripts/migrations/20261007_sync_schema_repair.sql'
    : 'the required migrations in supabase_schema.sql';
  return `Database update required. ${table} [${error.code}]: ${error.message || 'Required cloud schema is missing'}. ` +
    `Apply ${migration} in this business's Supabase project, then retry sync. ` +
    'Queued records remain on this device with their shift and account information intact. Resetting a PIN cannot fix this database error.';
}
