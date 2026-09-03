import React, { useMemo, useState } from 'react';
import { useTicketStore } from '../../../store/useTicketStore';
import { useAuthStore } from '../../../store/useAuthStore';
import { useDeviceStore } from '../../../store/useDeviceStore';
import { useConsolePeriodStore } from '../../../store/useConsolePeriodStore';
import { formatCurrency, formatTimestamp } from '../../../utils/currency';
import { summariseTickets, splitByTender } from '../../../utils/analytics';
import { filterByPeriod } from '../../../utils/period';
import { toCsv, downloadCsv, timestampedFilename } from '../../../utils/csv';
import { Panel, DataTable, EmptyState, StatusBadge, StatStrip, ConsoleButton } from '../ConsoleUI';
import { Pager, usePagination } from '../../common/Pager';
import { BookOpen, Download } from 'lucide-react';

const PAGE_SIZE = 15;

export const SalesRecordView: React.FC = () => {
  const { tickets } = useTicketStore();
  const { users } = useAuthStore();
  const { config } = useDeviceStore();
  const { period } = useConsolePeriodStore();
  const currency = config.currencySymbol || '₦';

  // Replaces the old dashboard's hardcoded CASHIER-01/CASHIER-02 dropdown, whose value was
  // never actually read — this one is built from real staff and really filters.
  const [cashierId, setCashierId] = useState('ALL');
  const [status, setStatus] = useState('ALL');
  const [tender, setTender] = useState('ALL');

  // The date window is the console's shared period rather than a second pair of date boxes
  // in this panel: two independent date controls on one screen is how a manager ends up
  // reading August's tickets under a header that says July.
  const filtered = useMemo(() => {
    return filterByPeriod(tickets, (t) => t.createdAt, period).filter((t) => {
      if (cashierId !== 'ALL' && t.cashierId !== cashierId) return false;
      if (status !== 'ALL' && t.status !== status) return false;
      // Absent tender means cash — see isCashTicket. Filtering on the raw field would
      // hide every ticket issued before the split existed from the "Cash" filter.
      if (tender !== 'ALL' && (t.tender ?? 'cash') !== tender) return false;
      return true;
    });
  }, [tickets, period, cashierId, status, tender]);

  const totals = summariseTickets(filtered);
  const split = splitByTender(filtered);
  const { page, totalPages, start, visible, next, prev } = usePagination(filtered, PAGE_SIZE);
  const nameFor = (id: string) => users.find((u) => u.id === id)?.name ?? 'Unknown';

  const handleExport = () => {
    const csv = toCsv(filtered, [
      { header: 'Ticket ID', value: (t) => t.id },
      { header: 'Date', value: (t) => t.createdAt },
      { header: 'Amount', value: (t) => t.amount },
      { header: 'Currency', value: (t) => t.currency || currency },
      { header: 'Cashier', value: (t) => nameFor(t.cashierId) },
      { header: 'Payment', value: (t) => ((t.tender ?? 'cash') === 'transfer' ? 'Transfer/POS' : 'Cash') },
      { header: 'Status', value: (t) => t.status },
      { header: 'Void Reason', value: (t) => t.voidReason ?? '' },
      { header: 'Voided By', value: (t) => t.voidedBy ?? '' },
    ]);
    downloadCsv(timestampedFilename(`sales-record-${period.label.replace(/\s+/g, '-')}`), csv);
  };

  return (
    <Panel
      title="Sales Record Book"
      subtitle={`Every ticket recorded in ${period.label}, across all devices on this account`}
      icon={BookOpen}
      actions={
        <>
          <select
            value={cashierId}
            onChange={(e) => setCashierId(e.target.value)}
            aria-label="Filter by cashier"
            className="px-2 py-1.5 border-2 border-slate-300 text-[11px] font-bold text-slate-800 bg-white rounded-none"
          >
            <option value="ALL">All Cashiers</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filter by status"
            className="px-2 py-1.5 border-2 border-slate-300 text-[11px] font-bold text-slate-800 bg-white rounded-none"
          >
            <option value="ALL">All Statuses</option>
            <option value="paid">Paid</option>
            <option value="collected">Collected</option>
            <option value="void">Void</option>
          </select>
          <select
            value={tender}
            onChange={(e) => setTender(e.target.value)}
            aria-label="Filter by payment type"
            className="px-2 py-1.5 border-2 border-slate-300 text-[11px] font-bold text-slate-800 bg-white rounded-none"
          >
            <option value="ALL">All Payments</option>
            <option value="cash">Cash</option>
            <option value="transfer">Transfer / POS</option>
          </select>
          <ConsoleButton onClick={handleExport} disabled={filtered.length === 0}>
            <span className="flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </span>
          </ConsoleButton>
        </>
      }
    >
      <StatStrip
        stats={[
          { label: 'Tickets', value: String(totals.ticketCount) },
          { label: 'Revenue', value: formatCurrency(totals.revenue, currency) },
          { label: 'Average Ticket', value: formatCurrency(totals.averageTicket, currency) },
          { label: 'Cash', value: formatCurrency(split.cash, currency) },
          { label: 'Transfer / POS', value: formatCurrency(split.transfer, currency) },
          { label: 'Voided', value: String(totals.voidCount) },
        ]}
      />

      {filtered.length === 0 ? (
        <EmptyState>No tickets in {period.label} match these filters</EmptyState>
      ) : (
        <>
          <DataTable headers={['Ticket ID', 'Date', 'Amount', 'Payment', 'Cashier', 'Status']} alignRight={[5]}>
            {visible.map((t) => (
              <tr key={t.id} className="hover:bg-slate-50">
                <td className="py-2.5 pr-3 font-mono text-[11px] text-slate-500">#{t.id}</td>
                <td className="py-2.5 pr-3 text-slate-600">{formatTimestamp(t.createdAt)}</td>
                <td className="py-2.5 pr-3 font-mono font-black text-amber-600 tabular-nums">
                  {formatCurrency(t.amount, t.currency || currency)}
                </td>
                <td className="py-2.5 pr-3">
                  {(t.tender ?? 'cash') === 'transfer' ? (
                    <span className="font-bold text-sky-700">Transfer / POS</span>
                  ) : (
                    <span className="text-slate-500">Cash</span>
                  )}
                </td>
                <td className="py-2.5 pr-3 font-semibold text-slate-800">{nameFor(t.cashierId)}</td>
                <td className="py-2.5 text-right">
                  <StatusBadge tone={t.status === 'void' ? 'danger' : t.status === 'collected' ? 'muted' : 'ok'}>
                    {t.status}
                  </StatusBadge>
                </td>
              </tr>
            ))}
          </DataTable>

          <Pager
            page={page}
            totalPages={totalPages}
            start={start}
            pageSize={PAGE_SIZE}
            total={filtered.length}
            onPrev={prev}
            onNext={next}
            label="tickets"
            className="pt-4 mt-4 border-t-2 border-slate-200"
          />
        </>
      )}
    </Panel>
  );
};
