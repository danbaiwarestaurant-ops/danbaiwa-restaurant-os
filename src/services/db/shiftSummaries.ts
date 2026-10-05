import Dexie, { DBCore, DBCoreMutateRequest, DBCoreTransaction } from 'dexie';
import { Ticket } from '../../types/ticket';
import { Shift } from '../../types/shift';
import { shiftTickets, splitByTender, summariseTickets } from '../../utils/analytics';

export interface ShiftSummary {
  id: string; cashierId: string; openedAt: string; closedAt?: string;
  ticketCount: number; voidCount: number; revenue: number; staffMealCount: number;
  staffMealValue: number; cash: number; transfer: number;
}
export function emptyShiftSummary(shift: Shift): ShiftSummary {
  return { id: shift.id, cashierId: shift.cashierId, openedAt: shift.openedAt, closedAt: shift.closedAt,
    ticketCount: 0, voidCount: 0, revenue: 0, staffMealCount: 0, staffMealValue: 0, cash: 0, transfer: 0 };
}
export function adjustShiftSummary(summary: ShiftSummary, row: Ticket | undefined, sign: number) {
  if (!row || !shiftTickets([row], summary).length) return;
  const sales = summariseTickets([row]), tender = splitByTender([row]);
  for (const key of ['ticketCount', 'voidCount', 'revenue', 'staffMealCount', 'staffMealValue'] as const) summary[key] += sign * sales[key];
  summary.cash += sign * tender.cash;
  summary.transfer += sign * tender.transfer;
}

/** Once an open shift's legacy history has been summarised, every sale, void,
 * tender change and remote merge maintains its totals atomically. Rendering and
 * printing never rescan a shift or lifetime history. This cache is local/derived. */
export function installShiftSummaries(db: Dexie) {
  db.use({ stack: 'dbcore', name: 'atomic-shift-summaries', create(down: DBCore): DBCore {
    const enabled = down.schema.tables.some(t => t.name === 'shiftSummaries');
    const chains = new WeakMap<DBCoreTransaction, Promise<unknown>>();
    return { ...down,
      transaction(stores, mode, options) {
        return down.transaction(enabled && mode === 'readwrite' && stores.includes('tickets')
          ? [...new Set([...stores, 'shiftSummaries', 'shifts'])] : stores, mode, options);
      },
      table(name) {
        const table = down.table(name);
        if (!enabled || name !== 'tickets') return table;
        const metadata = down.table('shiftSummaries'), shifts = down.table('shifts');
        return { ...table, mutate(req: DBCoreMutateRequest) {
          const run = async () => {
            if (req.type === 'deleteRange') {
              const result = await table.mutate(req);
              const cleared = await metadata.mutate({ type: 'deleteRange', trans: req.trans, range: { type: 3, lower: undefined, upper: undefined } });
              if (cleared.numFailures) { req.trans.abort(); throw cleared.failures[0]; }
              return result;
            }
            const keys = req.type === 'delete' ? req.keys : req.values.map(v => v.id);
            const before: (Ticket | undefined)[] = req.type === 'add' ? [] : await table.getMany({ trans: req.trans, keys });
            const after: readonly Ticket[] = req.type === 'delete' ? [] : req.values;
            const cashiers = new Set([...before, ...after].filter(Boolean).map(row => row!.cashierId)
              .filter((id): id is string => typeof id === 'string' && !!id));
            const openShifts: Shift[] = [];
            for (const cashierId of cashiers) {
              const result = await shifts.query({ trans: req.trans, values: true,
                query: { index: shifts.schema.getIndexByKeyPath(['cashierId', 'status'])!, range: { type: 1, lower: [cashierId, 'open'], upper: [cashierId, 'open'] } } });
              openShifts.push(...result.result.filter((s: Shift) => s.status === 'open'));
            }
            const cached: (ShiftSummary | undefined)[] = await metadata.getMany({ trans: req.trans, keys: openShifts.map(s => s.id) });
            const summaries = cached.filter((s): s is ShiftSummary => !!s);
            const result = await table.mutate(req);
            const previous = new Map(keys.map((key, i) => [key, before[i]]));
            for (let i = 0; i < keys.length; i++) {
              if (result.failures[i]) continue;
              for (const summary of summaries) {
                adjustShiftSummary(summary, previous.get(keys[i]), -1);
                adjustShiftSummary(summary, after[i], 1);
              }
              previous.set(keys[i], after[i]);
            }
            if (summaries.length) {
              const saved = await metadata.mutate({ type: 'put', trans: req.trans, values: summaries });
              if (saved.numFailures) { req.trans.abort(); throw saved.failures[0]; }
            }
            return result;
          };
          const next = Dexie.Promise.resolve(chains.get(req.trans)).then(run);
          chains.set(req.trans, next);
          return next;
        } };
      },
    };
  } });
}
