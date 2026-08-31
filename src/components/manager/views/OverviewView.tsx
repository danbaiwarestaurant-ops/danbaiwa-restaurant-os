import React, { useMemo } from 'react';
import { useTicketStore } from '../../../store/useTicketStore';
import { useExpenseStore } from '../../../store/useExpenseStore';
import { useShiftStore } from '../../../store/useShiftStore';
import { useAuthStore } from '../../../store/useAuthStore';
import { useSyncStore } from '../../../store/useSyncStore';
import { useDeviceStore } from '../../../store/useDeviceStore';
import { useConsolePeriodStore } from '../../../store/useConsolePeriodStore';
import { formatCurrency, formatTimestamp } from '../../../utils/currency';
import {
  summariseTickets, sumApprovedExpenses, bucketRevenue,
  cashierRollups, reconcileShift,
} from '../../../utils/analytics';
import { bucketNoun, filterByPeriod, periodBuckets, periodContains, shiftPeriod } from '../../../utils/period';
import { Panel, KpiCard, KpiTrend, DataTable, EmptyState, StatusBadge } from '../ConsoleUI';
import { RevenueChart } from '../RevenueChart';
import { TrendingUp, AlertTriangle, Users, Coins } from 'lucide-react';

/** Percentage change, or null when there is no earlier figure to compare against. */
function pctChange(now: number, before: number): number | null {
  if (!before) return null;
  return ((now - before) / before) * 100;
}

export const OverviewView: React.FC = () => {
  const { tickets } = useTicketStore();
  const { expenses } = useExpenseStore();
  const { shiftHistory } = useShiftStore();
  const { users } = useAuthStore();
  const { stuckCount, pendingCount, cloudConnected } = useSyncStore();
  const { config } = useDeviceStore();
  const { period } = useConsolePeriodStore();

  const currency = config.currencySymbol || '₦';

  const view = useMemo(() => {
    const previous = shiftPeriod(period, -1);

    const inPeriod = filterByPeriod(tickets, (t) => t.createdAt, period);
    const inPrevious = filterByPeriod(tickets, (t) => t.createdAt, previous);
    const expensesInPeriod = filterByPeriod(expenses, (e) => e.loggedAt, period);
    const expensesInPrevious = filterByPeriod(expenses, (e) => e.loggedAt, previous);

    const totals = summariseTickets(inPeriod);
    const prevTotals = summariseTickets(inPrevious);
    const approved = sumApprovedExpenses(expensesInPeriod);
    const prevApproved = sumApprovedExpenses(expensesInPrevious);

    // Shifts closed inside the period, newest first — the one a manager would be checking.
    const closedInPeriod = shiftHistory
      .filter((s) => s.status === 'closed' && s.closedAt && periodContains(period, s.closedAt))
      .sort((a, b) => (b.closedAt || '').localeCompare(a.closedAt || ''));

    const varianceInPeriod = closedInPeriod.filter((s) => Math.abs(s.variance ?? 0) > 0.01);
    const varianceOlder = shiftHistory.filter(
      (s) =>
        s.status === 'closed' &&
        Math.abs(s.variance ?? 0) > 0.01 &&
        !(s.closedAt && periodContains(period, s.closedAt))
    ).length;

    const pendingInPeriod = expensesInPeriod.filter((e) => e.status === 'pending').length;
    const pendingOlder =
      expenses.filter((e) => e.status === 'pending').length - pendingInPeriod;

    return {
      previous,
      totals,
      approved,
      series: bucketRevenue(inPeriod, periodBuckets(period)),
      topCashiers: cashierRollups(inPeriod, users).slice(0, 5),
      lastClosed: closedInPeriod[0] ?? null,
      varianceCount: varianceInPeriod.length,
      varianceOlder,
      pendingCountInPeriod: pendingInPeriod,
      pendingOlder,
      revenueTrend: pctChange(totals.revenue, prevTotals.revenue),
      expenseTrend: pctChange(approved, prevApproved),
      ticketTrend: pctChange(totals.ticketCount, prevTotals.ticketCount),
      averageTrend: pctChange(totals.averageTicket, prevTotals.averageTicket),
    };
  }, [tickets, expenses, shiftHistory, users, period]);

  const vsLabel = `vs ${view.previous.label}`;
  const trend = (pct: number | null, higherIsBetter = true): KpiTrend => ({
    pct,
    label: vsLabel,
    higherIsBetter,
  });

  const maxCashierRevenue = Math.max(1, ...view.topCashiers.map((c) => c.revenue));

  const recon = view.lastClosed ? reconcileShift(view.lastClosed, tickets, expenses) : null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label={`Revenue — ${period.label}`}
          value={formatCurrency(view.totals.revenue, currency)}
          trend={trend(view.revenueTrend)}
          hint={`${view.totals.ticketCount} tickets issued`}
        />
        {/* The mockup's "Profit" needs cost prices, which this app has no model for.
            Approved expenses is the real figure that exists. */}
        <KpiCard
          label="Approved Expenses"
          value={`−${formatCurrency(view.approved, currency)}`}
          trend={trend(view.expenseTrend, false)}
          hint="Paid out against the till"
          tone="negative"
        />
        <KpiCard
          label="Net After Expenses"
          value={formatCurrency(view.totals.revenue - view.approved, currency)}
          hint="Revenue minus approved expenses — not gross profit"
        />
        <KpiCard
          label="Average Ticket"
          value={formatCurrency(view.totals.averageTicket, currency)}
          trend={trend(view.averageTrend)}
          hint={view.totals.voidCount ? `${view.totals.voidCount} voided` : 'No voids'}
          tone={view.totals.voidCount ? 'negative' : 'neutral'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
        <Panel title={`Revenue — ${period.label}`} icon={TrendingUp}>
          <RevenueChart points={view.series} currency={currency} noun={bucketNoun(period.unit)} />
        </Panel>

        <Panel
          title="Cash Reconciliation"
          icon={Coins}
          subtitle={
            view.lastClosed
              ? `${view.lastClosed.cashierName} · closed ${formatTimestamp(view.lastClosed.closedAt!)}`
              : undefined
          }
        >
          {recon && view.lastClosed ? (
            <>
              <table className="w-full text-xs">
                <tbody className="divide-y divide-slate-100">
                  {recon.openingFloat > 0 && (
                    <tr>
                      <td className="py-2 text-slate-600 font-medium">Opening Float</td>
                      <td className="py-2 text-right font-mono font-bold">{formatCurrency(recon.openingFloat, currency)}</td>
                    </tr>
                  )}
                  <tr>
                    <td className="py-2 text-slate-600 font-medium">Cash Ticket Sales</td>
                    <td className="py-2 text-right font-mono font-bold text-emerald-600">
                      +{formatCurrency(recon.totalCashTickets, currency)}
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 text-slate-600 font-medium">Approved Expenses</td>
                    <td className="py-2 text-right font-mono font-bold text-rose-600">
                      −{formatCurrency(recon.totalApprovedExpenses, currency)}
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 text-slate-900 font-bold">Expected Cash</td>
                    <td className="py-2 text-right font-mono font-black text-amber-600">
                      {formatCurrency(recon.expectedCash, currency)}
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 text-slate-900 font-bold">Counted Cash</td>
                    <td className="py-2 text-right font-mono font-black">
                      {formatCurrency(recon.countedCash, currency)}
                    </td>
                  </tr>
                </tbody>
              </table>
              <div
                className={`mt-4 p-3 border-2 text-xs font-black uppercase rounded-none ${
                  recon.isVarianceFlagged
                    ? 'bg-rose-50 border-rose-400 text-rose-900'
                    : 'bg-emerald-50 border-emerald-400 text-emerald-900'
                }`}
              >
                {recon.isVarianceFlagged
                  ? `Variance ${formatCurrency(recon.variance, currency)} — needs review`
                  : '✓ Balanced'}
              </div>
            </>
          ) : (
            <EmptyState>No shift was closed in {period.label}</EmptyState>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
        {/* The mockup's "Best Selling Items" needs ticket line items, which don't exist.
            Per-cashier revenue is the equivalent insight this data can actually support. */}
        <Panel title={`Top Cashiers — ${period.label}`} icon={Users}>
          {view.topCashiers.length === 0 ? (
            <EmptyState>No tickets in {period.label}</EmptyState>
          ) : (
            <div className="space-y-3.5">
              {view.topCashiers.map((c, i) => (
                <div key={c.cashierId}>
                  <div className="flex justify-between text-xs font-bold mb-1.5">
                    <div className="truncate">
                      <span className="text-amber-600 font-black">#{i + 1}</span> {c.name}
                      <span className="text-slate-500 font-semibold ml-1.5">{c.ticketCount} tickets</span>
                    </div>
                    <div className="font-mono tabular-nums">{formatCurrency(c.revenue, currency)}</div>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-none overflow-hidden">
                    <div
                      className="h-full bg-amber-500"
                      style={{ width: `${((c.revenue / maxCashierRevenue) * 100).toFixed(0)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {/* Replaces the mockup's "Low Stock Alerts" — no inventory model exists, but these
            are the things that genuinely need a manager's attention. The first two rows count
            the period, then say how many more sit outside it: scoping them silently would
            hide an unapproved expense from three months ago, which is exactly the item that
            most needs chasing. */}
        <Panel title="Needs Attention" icon={AlertTriangle}>
          <DataTable headers={['Item', 'Status']} alignRight={[1]}>
            <tr>
              <td className="py-2.5 font-semibold text-slate-700">Expense approvals pending</td>
              <td className="py-2.5 text-right">
                <StatusBadge tone={view.pendingCountInPeriod || view.pendingOlder ? 'warn' : 'ok'}>
                  {view.pendingCountInPeriod || view.pendingOlder
                    ? `${view.pendingCountInPeriod}${view.pendingOlder ? ` +${view.pendingOlder} older` : ''}`
                    : 'None'}
                </StatusBadge>
              </td>
            </tr>
            <tr>
              <td className="py-2.5 font-semibold text-slate-700">Shifts with cash variance</td>
              <td className="py-2.5 text-right">
                <StatusBadge tone={view.varianceCount || view.varianceOlder ? 'danger' : 'ok'}>
                  {view.varianceCount || view.varianceOlder
                    ? `${view.varianceCount}${view.varianceOlder ? ` +${view.varianceOlder} older` : ''}`
                    : 'None'}
                </StatusBadge>
              </td>
            </tr>
            {/* Device state, not a record of trading — a reporting window does not apply. */}
            <tr>
              <td className="py-2.5 font-semibold text-slate-700">Records not yet in the cloud</td>
              <td className="py-2.5 text-right">
                <StatusBadge tone={stuckCount ? 'danger' : pendingCount ? 'warn' : 'ok'}>
                  {stuckCount ? `${stuckCount} stuck` : pendingCount ? `${pendingCount} queued` : 'All synced'}
                </StatusBadge>
              </td>
            </tr>
            <tr>
              <td className="py-2.5 font-semibold text-slate-700">Cloud connection</td>
              <td className="py-2.5 text-right">
                <StatusBadge tone={cloudConnected ? 'ok' : 'danger'}>
                  {cloudConnected ? 'Connected' : 'Not signed in'}
                </StatusBadge>
              </td>
            </tr>
          </DataTable>
        </Panel>
      </div>
    </div>
  );
};
