import { db } from './dexieSchema';
import { getAccountId, getServerAccountId } from './accountScope';
import { loadDeviceIdentity } from '../supabase/deviceIdentity';
import { supabase } from '../supabase/supabaseClient';
import { OutboxItem } from '../../types/sync';

const tables: Record<string, string> = {
  users: 'users', tickets: 'tickets', shifts: 'shifts', expenses: 'expenses',
  audit_logs: 'auditLogs', server_sales: 'serverSales', role_pay_configs: 'rolePayConfigs',
  staff_assessments: 'staffAssessments', wage_ledger: 'wageLedger',
  inventory_items: 'inventoryItems', inventory_batches: 'inventoryBatches', inventory_movements: 'inventoryMovements',
};

/** Only repair the known legacy device-id stamping bug. Another owner's account
 * is never a repair candidate. Both current server scope AND device membership
 * must independently prove ownership before queue/domain rows change atomically. */
export async function repairLegacyDeviceScope(items: OutboxItem[], accountId: string): Promise<OutboxItem[]> {
  const identity = await loadDeviceIdentity();
  if (!identity || identity.accountId !== accountId || identity.authUserId === accountId) return items;
  const candidates = items.filter(item => item.payload.accountId === identity.authUserId);
  if (!candidates.length) return items;
  const scope = await getServerAccountId();
  if (!scope.ok || scope.accountId !== accountId) return items;
  const { data, error } = await supabase.from('account_devices').select('account_id,status')
    .eq('auth_user_id', identity.authUserId).maybeSingle();
  if (error || data?.status !== 'active' || data.account_id !== accountId || await getAccountId() !== accountId) return items;

  const domainTables = [...new Set(candidates.map(item => tables[item.tableName]).filter(Boolean))].map(name => (db as any)[name]);
  await db.transaction('rw', [db.outbox, ...domainTables], async () => {
    for (const item of candidates) {
      const current = await db.outbox.get(item.id);
      if (!current || !['pending', 'failed'].includes(current.status) || current.payload.accountId !== identity.authUserId) continue;
      const table = (db as any)[tables[current.tableName]];
      const row = table && current.payload.id ? await table.get(current.payload.id) : null;
      // A conflicting local owner is evidence against reassignment.
      if (row?.accountId && row.accountId !== identity.authUserId && row.accountId !== accountId) continue;
      if (row?.accountId === identity.authUserId) await table.put({ ...row, accountId });
      await db.outbox.put({ ...current, payload: { ...current.payload, accountId },
        status: 'pending', retryCount: 0, nextAttemptAt: undefined, lastError: undefined });
    }
  });
  const refreshed = await db.outbox.bulkGet(items.map(item => item.id));
  return refreshed.filter((item): item is OutboxItem => Boolean(item));
}
