import React, { useEffect, useMemo } from 'react';
import { useShiftStore } from '../../../store/useShiftStore';
import { useTicketStore } from '../../../store/useTicketStore';
import { useDeviceStore } from '../../../store/useDeviceStore';
import { useConsolePeriodStore } from '../../../store/useConsolePeriodStore';
import { formatCurrency, formatTimestamp } from '../../../utils/currency';
import { filterByPeriod } from '../../../utils/period';
import { shiftTickets, splitByTender } from '../../../utils/analytics';
import { Panel, DataTable, EmptyState, StatusBadge, StatStrip } from '../ConsoleUI';
import { Pager, usePagination } from '../../common/Pager';
import { ScrollText } from 'lucide-react';

const PAGE_SIZE = 12;

export const ReconciliationView: React.FC = () => {
  const { shiftHistory, loadShiftHistory } = useShiftStore();
  const { tickets } = useTicketStore();
  const { config } = useDeviceStore();
  const { period } = useConsolePeriodStore();
  const currency = config.currencySymbol || '₦';

  useEffect(() => {
    loadShiftHistory();
  }, [loadShiftHistory]);

  // Listed by the shift's own opening, so a shift appears in the period the staff worked it
  // rather than the period it happened to be closed in.
  const shifts = useMemo(
    () => filterByPeriod(shiftHistory, (s) => s.openedAt, period),
    [shiftHistory, period]
  );

  // Voids and the cash/transfer split are both attributed to a shift the same way its
  // takings are — the cashier's tickets inside the shift's open window — so a row's
  // figures are that cashier's own, and one pass over the tickets produces all of them.
  const byShift = useMemo(() => {
    const map = new Map<string, { voidCount: number; voidValue: number; cash: number; transfer: number }>();
    for (const s of shifts) {
      const own = shiftTickets(tickets, s);
      const voided = own.filter((t) => t.status === 'void');
      const split = splitByTender(own);
      map.set(s.id, {
        voidCount: voided.length,
        voidValue: voided.reduce((sum, t) => sum + t.amount, 0),
        cash: split.cash,
        transfer: split.transfer,
      });
    }
    return map;
  }, [shifts, tickets]);

  const rows = [...byShift.values()];
  const totalVoids = rows.reduce((sum, v) => sum + v.voidCount, 0);
  const totalVoidValue = rows.reduce((sum, v) => sum + v.voidValue, 0);
  const totalCash = rows.reduce((sum, v) => sum + v.cash, 0);
  const totalTransfer = rows.reduce((sum, v) => sum + v.transfer, 0);

  const closed = shifts.filter((s) => s.status === 'closed');
  const flagged = closed.filter((s) => Math.abs(s.variance ?? 0) > 0.01);
  const totalVariance = closed.reduce((sum, s) => sum + (s.variance ?? 0), 0);

  const { page, totalPages, start, visible, next, prev } = usePagination(shifts, PAGE_SIZE);

  return (
    <Panel
      title="Shift Reconciliation"
      subtitle={`Expected versus counted cash at close-out, for every till on this account, in ${period.label}`}
      icon={ScrollText}
    >
      <StatStrip
        stats={[
          { label: 'Shifts Closed', value: String(closed.length) },
          { label: 'With Variance', value: String(flagged.length) },
          { label: 'Net Variance', value: formatCurrency(totalVariance, currency) },
          { label: 'Still Open', value: String(shifts.length - closed.length) },
          { label: 'Cash Sales', value: formatCurrency(totalCash, currency) },
          { label: 'Transfer / POS', value: formatCurrency(totalTransfer, currency) },
          { label: 'Void Tickets', value: String(totalVoids) },
          { label: 'Void Value', value: formatCurrency(totalVoidValue, currency) },
        ]}
      />

      {shifts.length === 0 ? (
        <EmptyState>No shifts opened in {period.label}</EmptyState>
      ) : (
        <>
          <DataTable
            headers={[
              'Opened',
              'Cashier',
              'Till',
              'Cash',
              'Transfer / POS',
              'Voids',
              'Expected',
              'Counted',
              'Variance',
              'Status',
            ]}
            alignRight={[3, 4, 5, 6, 7, 8, 9]}
          >
            {visible.map((s) => {
              const isOpen = s.status === 'open';
              const variance = s.variance ?? 0;
              const flaggedRow = !isOpen && Math.abs(variance) > 0.01;
              const own = byShift.get(s.id) ?? { voidCount: 0, voidValue: 0, cash: 0, transfer: 0 };
              return (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="py-2.5 pr-3 text-slate-600">{formatTimestamp(s.openedAt)}</td>
                  <td className="py-2.5 pr-3 font-semibold text-slate-800">{s.cashierName}</td>
                  <td className="py-2.5 pr-3 font-mono text-[11px] text-slate-500">
                    {s.locationId}-{s.deviceId}
                  </td>
                  {/* What the drawer should hold, and what never touched it. Read together
                      these explain the Expected figure two columns along. */}
                  <td className="py-2.5 pr-3 text-right font-mono font-bold tabular-nums text-emerald-700">
                    {formatCurrency(own.cash, currency)}
                  </td>
                  <td
                    className={`py-2.5 pr-3 text-right font-mono tabular-nums ${
                      own.transfer > 0 ? 'font-bold text-sky-700' : 'text-slate-400'
                    }`}
                  >
                    {own.transfer > 0 ? formatCurrency(own.transfer, currency) : '—'}
                  </td>
                  {/* Count over value, in one cell: the count is what a manager scans a
                      column for, and the value is only ever the follow-up question. */}
                  <td
                    className={`py-2.5 pr-3 text-right tabular-nums ${
                      own.voidCount > 0 ? 'text-rose-600' : 'text-slate-400'
                    }`}
                  >
                    <div className="font-mono font-bold">{own.voidCount}</div>
                    {own.voidCount > 0 && (
                      <div className="font-mono text-[10px]">{formatCurrency(own.voidValue, currency)}</div>
                    )}
                  </td>
                  <td className="py-2.5 pr-3 text-right font-mono tabular-nums">
                    {isOpen ? '—' : formatCurrency(s.expectedCash ?? 0, currency)}
                  </td>
                  <td className="py-2.5 pr-3 text-right font-mono tabular-nums">
                    {isOpen ? '—' : formatCurrency(s.countedCash ?? 0, currency)}
                  </td>
                  <td
                    className={`py-2.5 pr-3 text-right font-mono font-bold tabular-nums ${
                      flaggedRow ? 'text-rose-600' : 'text-slate-700'
                    }`}
                  >
                    {isOpen ? '—' : formatCurrency(variance, currency)}
                  </td>
                  <td className="py-2.5 text-right">
                    <StatusBadge tone={isOpen ? 'warn' : flaggedRow ? 'danger' : 'ok'}>
                      {isOpen ? 'Open' : flaggedRow ? 'Variance' : 'Balanced'}
                    </StatusBadge>
                  </td>
                </tr>
              );
            })}
          </DataTable>

          <Pager
            page={page}
            totalPages={totalPages}
            start={start}
            pageSize={PAGE_SIZE}
            total={shifts.length}
            onPrev={prev}
            onNext={next}
            label="shifts"
            className="pt-4 mt-4 border-t-2 border-slate-200"
          />
        </>
      )}
    </Panel>
  );
};
