import Dexie, { DBCore, DBCoreTransaction } from 'dexie';

/** Dexie middleware needs before-images for indexes, hooks and our counters. Share
 * those images within one native transaction rather than issuing the same hundreds
 * of IndexedDB get requests repeatedly. Never reuse an image across transactions. */
export function installTransactionReadCache(db: Dexie) {
  db.use({ stack: 'dbcore', name: 'bounded-transaction-images', level: -0.5,
    create(down: DBCore): DBCore {
      const transactions = new WeakMap<DBCoreTransaction, Map<string, Map<any, any>>>();
      function cacheFor(trans: DBCoreTransaction, table: string) {
        let tables = transactions.get(trans);
        if (!tables) { tables = new Map(); transactions.set(trans, tables); }
        let cache = tables.get(table);
        if (!cache) { cache = new Map(); tables.set(table, cache); }
        return cache;
      }
      return { ...down, table(name) {
        const table = down.table(name);
        const remember = (trans: DBCoreTransaction, keys: any[], values: any[]) => {
          const cache = cacheFor(trans, name);
          if (keys.length > 2000) return;
          if (cache.size + keys.length > 2000) cache.clear();
          keys.forEach((key, i) => cache.set(key, Dexie.deepClone(values[i])));
        };
        return { ...table,
          getMany(req) {
            const cache = cacheFor(req.trans, name);
            if (req.keys.every(key => cache.has(key))) return Dexie.Promise.resolve(req.keys.map(key => Dexie.deepClone(cache.get(key))));
            return table.getMany(req).then(values => { remember(req.trans, req.keys, values); return values; });
          },
          query(req) {
            return table.query(req).then(result => {
              if (req.values && result.result.length <= 2000) remember(req.trans, result.result.map(value => table.schema.primaryKey.extractKey!(value)), result.result);
              return result;
            });
          },
          mutate(req) {
            return table.mutate(req).then(result => {
              const cache = cacheFor(req.trans, name);
              if (req.type === 'deleteRange') cache.clear();
              else {
                const keys = req.type === 'delete' ? req.keys : req.keys || req.values.map(value => table.schema.primaryKey.extractKey!(value));
                if (keys.length > 2000) { cache.clear(); return result; }
                keys.forEach((key, i) => {
                  if (!result.failures[i]) cache.set(key, req.type === 'delete' ? undefined : Dexie.deepClone(req.values[i]));
                });
                if (cache.size > 2000) cache.clear();
              }
              return result;
            });
          },
        };
      } };
    },
  });
}
