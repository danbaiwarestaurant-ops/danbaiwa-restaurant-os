import React, { useEffect, useMemo } from 'react';
import { useShiftStore } from '../../../store/useShiftStore';
import { useTicketStore } from '../../../store/useTicketStore';
import { useDeviceStore } from '../../../store/useDeviceStore';
import { useConsolePeriodStore } from '../../../store/useConsolePeriodStore';
import { formatCurrency, formatTimestamp } from '../../../utils/currency';
import { filterByPeriod } from '../../../utils/period';
import { shiftTickets } from '../../../utils/analytics';
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

  // Voids are attributed to a shift the same way its takings are — the cashier's tickets
  // inside the shift's open window — so the count on a row is that cashier's own write-offs.
  const voidsByShift = useMemo(() => {
    const map = new Map<string, { count: number; value: number }>();
    for (const s of shifts) {
      const voided = shiftTickets(tickets, s).filter((t) => t.status === 'void');
      map.set(s.id, {
        count: voided.length,
        value: voided.reduce((sum, t) => sum + t.amount, 0),
      });
    }
    return map;
  }, [shifts, tickets]);

  const totalVoids = [...voidsByShift.values()].reduce((sum, v) => sum + v.count, 0);
  const totalVoidValue = [...voidsByShift.values()].reduce((sum, v) => sum + v.value, 0);

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
              'Voids',
              'Void Value',
              'Expected',
              'Counted',
              'Variance',
              'Status',
            ]}
            alignRight={[3, 4, 5, 6, 7, 8]}
          >
            {visible.map((s) => {
              const isOpen = s.status === 'open';
              const variance = s.variance ?? 0;
              const flaggedRow = !isOpen && Math.abs(variance) > 0.01;
              const voids = voidsByShift.get(s.id) ?? { count: 0, value: 0 };
              return (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="py-2.5 pr-3 text-slate-600">{formatTimestamp(s.openedAt)}</td>
                  <td className="py-2.5 pr-3 font-semibold text-slate-800">{s.cashierName}</td>
                  <td className="py-2.5 pr-3 font-mono text-[11px] text-slate-500">
                    {s.locationId}-{s.deviceId}
                  </td>
                  <td
                    className={`py-2.5 pr-3 text-right font-mono font-bold tabular-nums ${
                      voids.count > 0 ? 'text-rose-600' : 'text-slate-400'
                    }`}
                  >
                    {voids.count}
                  </td>
                  <td
                    className={`py-2.5 pr-3 text-right font-mono tabular-nums ${
                      voids.count > 0 ? 'text-rose-600' : 'text-slate-400'
                    }`}
                  >
                    {voids.count > 0 ? formatCurrency(voids.value, currency) : '—'}
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
