import Dexie, { DBCore, DBCoreMutateRequest, DBCoreTransaction } from 'dexie';
import { OutboxItem } from '../../types/sync';

export interface QueueCounters { key: 'outbox'; pending: number; failed: number; stuck: number }
export const emptyQueueCounters = (): QueueCounters => ({ key: 'outbox', pending: 0, failed: 0, stuck: 0 });

/** Derived metadata, maintained inside the SAME native transaction as every outbox
 * mutation (including restores and bulk writes). Never count the whole queue on a
 * sale, badge refresh or batch acknowledgement. No in-memory, cross-tab cache. */
export function installQueueCounters(db: Dexie) {
  db.use({ stack: 'dbcore', name: 'atomic-queue-counters', create(down: DBCore): DBCore {
    const enabled = down.schema.tables.some(t => t.name === 'queueCounters');
    const chains = new WeakMap<DBCoreTransaction, Promise<unknown>>();
    return {
      ...down,
      transaction(stores, mode, options) {
        return down.transaction(enabled && mode === 'readwrite' && stores.includes('outbox')
          ? [...new Set([...stores, 'queueCounters'])] : stores, mode, options);
      },
      table(name) {
        const table = down.table(name);
        if (!enabled || name !== 'outbox') return table;
        const metadata = down.table('queueCounters');
        return { ...table, mutate(req: DBCoreMutateRequest) {
          if (req.type === 'add' || req.type === 'put') req = { ...req,
            values: req.values.map(row => ({ ...row, readyAt: row.nextAttemptAt || '' })) };
          const run = async () => {
            const counters: QueueCounters = await metadata.get({ trans: req.trans, key: 'outbox' }) || emptyQueueCounters();
            let oldRows: (OutboxItem | undefined)[] = [];
            let keys: any[] = [];
            const rangeRemoved = { pending: 0, failed: 0, stuck: 0 };
            if (req.type === 'put' || req.type === 'delete') {
              keys = req.type === 'delete' ? req.keys : req.values.map(v => v.id);
              oldRows = await table.getMany({ trans: req.trans, keys });
            } else if (req.type === 'deleteRange' && req.range.type !== 3) {
              // Aggregate removed rows without retaining their payloads. Normal
              // pruning uses bounded bulkDelete, and clear needs no cursor.
              const cursor = await table.openCursor({ trans: req.trans, values: true,
                query: { index: table.schema.primaryKey, range: req.range } });
              if (cursor) await cursor.start(() => {
                const row = cursor.value as OutboxItem;
                if (row.status === 'pending' || row.status === 'failed') {
                  rangeRemoved[row.status]++;
                  if (row.retryCount >= 8) rangeRemoved.stuck++;
                }
                cursor.continue();
              });
            }
            const result = await table.mutate(req);
            const adjust = (row: OutboxItem | undefined, sign: number) => {
              if (!row || (row.status !== 'pending' && row.status !== 'failed')) return;
              counters[row.status] += sign;
              if (row.retryCount >= 8) counters.stuck += sign;
            };
            if (req.type === 'deleteRange') {
              if (req.range.type === 3) Object.assign(counters, emptyQueueCounters());
              else if (!result.numFailures) {
                counters.pending -= rangeRemoved.pending;
                counters.failed -= rangeRemoved.failed;
                counters.stuck -= rangeRemoved.stuck;
              }
            } else {
              const previous = new Map(keys.map((key, i) => [key, oldRows[i]]));
              const size = req.type === 'delete' ? req.keys.length : req.values.length;
              for (let i = 0; i < size; i++) {
                if (result.failures[i]) continue;
                const row = req.type === 'delete' ? undefined : req.values[i] as OutboxItem;
                const key = req.type === 'delete' ? req.keys[i] : row!.id;
                adjust(previous.get(key), -1);
                adjust(row, 1);
                previous.set(key, row);
              }
            }
            const saved = await metadata.mutate({ type: 'put', trans: req.trans, values: [counters] });
            if (saved.numFailures) { req.trans.abort(); throw saved.failures[0]; }
            return result;
          };
          // Dexie.Promise preserves IndexedDB's transaction zone. Serialize writes
          // within a transaction as callers may issue parallel bulk operations.
          const next = Dexie.Promise.resolve(chains.get(req.trans)).then(run);
          chains.set(req.trans, next);
          return next;
        } };
      },
    };
  } });
}
