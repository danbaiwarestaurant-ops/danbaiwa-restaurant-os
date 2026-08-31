import React, { useMemo } from 'react';
import { useTicketStore } from '../../../store/useTicketStore';
import { useExpenseStore } from '../../../store/useExpenseStore';
import { useDeviceStore } from '../../../store/useDeviceStore';
import { useConsolePeriodStore } from '../../../store/useConsolePeriodStore';
import { formatCurrency } from '../../../utils/currency';
import { summariseTickets, sumApprovedExpenses, bucketBreakdown } from '../../../utils/analytics';
import { bucketNoun, filterByPeriod, periodBuckets, shiftPeriod } from '../../../utils/period';
import { toCsv, downloadCsv, timestampedFilename } from '../../../utils/csv';
import { Panel, DataTable, EmptyState, StatStrip, ConsoleButton } from '../ConsoleUI';
import { BarChart3, Download } from 'lucide-react';

/** Signed change, rendered as its own column so a fall is visible rather than inferred. */
const Delta: React.FC<{ now: number; before: number; currency: string; higherIsBetter?: boolean }> = ({
  now, before, currency, higherIsBetter = true,
}) => {
  const diff = now - before;
  if (Math.abs(diff) < 0.01) return <span className="text-slate-400 font-semibold">no change</span>;
  const good = higherIsBetter ? diff > 0 : diff < 0;
  return (
    <span className={`font-bold ${good ? 'text-emerald-600' : 'text-rose-600'}`}>
      {diff > 0 ? '+' : '−'}{formatCurrency(Math.abs(diff), currency)}
    </span>
  );
};

export const ReportsView: React.FC = () => {
  const { tickets } = useTicketStore();
  const { expenses } = useExpenseStore();
  const { config } = useDeviceStore();
  const { period } = useConsolePeriodStore();
  const currency = config.currencySymbol || '₦';

  const report = useMemo(() => {
    const previous = shiftPeriod(period, -1);

    const ticketsNow = filterByPeriod(tickets, (t) => t.createdAt, period);
    const ticketsBefore = filterByPeriod(tickets, (t) => t.createdAt, previous);
    const expensesNow = filterByPeriod(expenses, (e) => e.loggedAt, period);
    const expensesBefore = filterByPeriod(expenses, (e) => e.loggedAt, previous);

    const totals = summariseTickets(ticketsNow);
    const prevTotals = summariseTickets(ticketsBefore);
    const spent = sumApprovedExpenses(expensesNow);
    const prevSpent = sumApprovedExpenses(expensesBefore);

    return {
      previous,
      totals,
      prevTotals,
      spent,
      prevSpent,
      rows: bucketBreakdown(ticketsNow, expensesNow, periodBuckets(period)),
    };
  }, [tickets, expenses, period]);

  // Empty buckets are real information on screen, but padding a CSV with 20 zero rows just
  // makes the file harder to read in a spreadsheet.
  const exportable = report.rows.filter((r) => r.ticketCount > 0 || r.expenses > 0);

  // "hour" | "day" | "month" — one word driving the heading, the column and the caption, so
  // a fourth unit cannot leave one of them saying something else.
  const noun = bucketNoun(period.unit);
  const Noun = noun[0].toUpperCase() + noun.slice(1);

  const handleExport = () => {
    const csv = toCsv(exportable, [
      { header: Noun, value: (r) => r.key },
      { header: 'Revenue', value: (r) => r.revenue },
      { header: 'Approved Expenses', value: (r) => r.expenses },
      { header: 'Net', value: (r) => r.net },
      { header: 'Tickets', value: (r) => r.ticketCount },
    ]);
    downloadCsv(timestampedFilename(`report-${period.label.replace(/\s+/g, '-')}`), csv);
  };

  const granularity = `${Noun} by ${noun}`;

  return (
    <div className="space-y-4">
      <Panel
        title={period.label}
        subtitle={`Tickets and approved expenses in this ${period.unit}, compared with ${report.previous.label}`}
        icon={BarChart3}
      >
        <StatStrip
          stats={[
            { label: 'Revenue', value: formatCurrency(report.totals.revenue, currency) },
            { label: 'Tickets', value: String(report.totals.ticketCount) },
            { label: 'Approved Expenses', value: formatCurrency(report.spent, currency) },
            { label: 'Net', value: formatCurrency(report.totals.revenue - report.spent, currency) },
          ]}
        />

        <DataTable headers={['Compared with ' + report.previous.label, 'Then', 'Now', 'Change']} alignRight={[1, 2, 3]}>
          <tr>
            <td className="py-2.5 font-semibold text-slate-700">Revenue</td>
            <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-slate-500">
              {formatCurrency(report.prevTotals.revenue, currency)}
            </td>
            <td className="py-2.5 pr-3 text-right font-mono tabular-nums font-bold">
              {formatCurrency(report.totals.revenue, currency)}
            </td>
            <td className="py-2.5 text-right font-mono tabular-nums">
              <Delta now={report.totals.revenue} before={report.prevTotals.revenue} currency={currency} />
            </td>
          </tr>
          <tr>
            <td className="py-2.5 font-semibold text-slate-700">Approved expenses</td>
            <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-slate-500">
              {formatCurrency(report.prevSpent, currency)}
            </td>
            <td className="py-2.5 pr-3 text-right font-mono tabular-nums font-bold">
              {formatCurrency(report.spent, currency)}
            </td>
            <td className="py-2.5 text-right font-mono tabular-nums">
              <Delta now={report.spent} before={report.prevSpent} currency={currency} higherIsBetter={false} />
            </td>
          </tr>
          <tr>
            <td className="py-2.5 font-semibold text-slate-700">Net</td>
            <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-slate-500">
              {formatCurrency(report.prevTotals.revenue - report.prevSpent, currency)}
            </td>
            <td className="py-2.5 pr-3 text-right font-mono tabular-nums font-bold">
              {formatCurrency(report.totals.revenue - report.spent, currency)}
            </td>
            <td className="py-2.5 text-right font-mono tabular-nums">
              <Delta
                now={report.totals.revenue - report.spent}
                before={report.prevTotals.revenue - report.prevSpent}
                currency={currency}
              />
            </td>
          </tr>
        </DataTable>

        <p className="text-[11px] text-slate-500 font-semibold mt-3">
          Net is revenue minus approved expenses. It is not gross profit — that would need
          cost prices, which this app does not record.
        </p>
      </Panel>

      <Panel
        title={granularity}
        subtitle={`Every ${noun} of ${period.label}, including the ones that traded nothing`}
        actions={
          <ConsoleButton onClick={handleExport} disabled={exportable.length === 0}>
            <span className="flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </span>
          </ConsoleButton>
        }
      >
        {exportable.length === 0 ? (
          <EmptyState>Nothing recorded in {period.label}</EmptyState>
        ) : (
          <DataTable
            headers={[Noun, 'Revenue', 'Expenses', 'Net', 'Tickets']}
            alignRight={[1, 2, 3, 4]}
          >
            {report.rows.map((r) => {
              const quiet = r.ticketCount === 0 && r.expenses === 0;
              return (
                <tr key={r.key} className={quiet ? 'text-slate-400' : 'hover:bg-slate-50'}>
                  <td className="py-2.5 pr-3 font-bold text-slate-900">
                    <span className={quiet ? 'text-slate-400 font-semibold' : ''}>{r.label}</span>
                  </td>
                  <td className={`py-2.5 pr-3 text-right font-mono tabular-nums font-bold ${quiet ? '' : 'text-emerald-600'}`}>
                    {formatCurrency(r.revenue, currency)}
                  </td>
                  <td className={`py-2.5 pr-3 text-right font-mono tabular-nums ${quiet ? '' : 'text-rose-600'}`}>
                    {formatCurrency(r.expenses, currency)}
                  </td>
                  <td className={`py-2.5 pr-3 text-right font-mono tabular-nums font-black ${quiet ? '' : 'text-amber-600'}`}>
                    {formatCurrency(r.net, currency)}
                  </td>
                  <td className="py-2.5 text-right font-mono tabular-nums">{r.ticketCount}</td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </Panel>
    </div>
  );
};
