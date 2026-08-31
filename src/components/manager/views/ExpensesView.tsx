import React, { useMemo } from 'react';
import { useExpenseStore } from '../../../store/useExpenseStore';
import { useDeviceStore } from '../../../store/useDeviceStore';
import { useConsolePeriodStore } from '../../../store/useConsolePeriodStore';
import { formatCurrency, formatTimestamp } from '../../../utils/currency';
import { filterByPeriod } from '../../../utils/period';
import { Panel, DataTable, EmptyState, StatusBadge } from '../ConsoleUI';
import { Pager, usePagination } from '../../common/Pager';
import { ExpenseApprovalQueue } from '../../expense/ExpenseApprovalQueue';
import { Wallet } from 'lucide-react';

const PAGE_SIZE = 12;

interface ExpensesViewProps {
  onRequirePin: (purpose: string, onVerified: () => void) => void;
}

export const ExpensesView: React.FC<ExpensesViewProps> = ({ onRequirePin }) => {
  const { expenses } = useExpenseStore();
  const { config } = useDeviceStore();
  const { period } = useConsolePeriodStore();
  const currency = config.currencySymbol || '₦';

  // The queue above handles pending and is deliberately *not* period-scoped: it is a list of
  // things still to be done, and an expense logged last month still needs approving today.
  // This panel is the settled record, so it follows the reporting window like every other.
  const history = useMemo(
    () =>
      filterByPeriod(expenses, (e) => e.loggedAt, period)
        .filter((e) => e.status !== 'pending')
        .sort((a, b) => (b.loggedAt || '').localeCompare(a.loggedAt || '')),
    [expenses, period]
  );

  const { page, totalPages, start, visible, next, prev } = usePagination(history, PAGE_SIZE);

  return (
    <div className="space-y-4">
      {/* Existing approval queue, unchanged — it already enforces the manager PIN. */}
      <ExpenseApprovalQueue onRequirePin={onRequirePin} />

      <Panel
        title="Expense History"
        subtitle={`Approved and rejected expenses logged in ${period.label}`}
        icon={Wallet}
      >
        {history.length === 0 ? (
          <EmptyState>No settled expenses in {period.label}</EmptyState>
        ) : (
          <>
            <DataTable headers={['Date', 'Description', 'Category', 'Logged By', 'Amount', 'Status']} alignRight={[4, 5]}>
              {visible.map((e) => (
                <tr key={e.id} className="hover:bg-slate-50">
                  <td className="py-2.5 pr-3 text-slate-600">{formatTimestamp(e.loggedAt)}</td>
                  <td className="py-2.5 pr-3 font-semibold text-slate-800">{e.description || '—'}</td>
                  <td className="py-2.5 pr-3 text-slate-600">{e.category}</td>
                  <td className="py-2.5 pr-3 text-slate-600">{e.cashierName}</td>
                  <td className="py-2.5 pr-3 text-right font-mono font-bold tabular-nums">
                    {formatCurrency(e.amount, currency)}
                  </td>
                  <td className="py-2.5 text-right">
                    <StatusBadge tone={e.status === 'approved' ? 'ok' : 'danger'}>{e.status}</StatusBadge>
                  </td>
                </tr>
              ))}
            </DataTable>

            <Pager
              page={page}
              totalPages={totalPages}
              start={start}
              pageSize={PAGE_SIZE}
              total={history.length}
              onPrev={prev}
              onNext={next}
              label="expenses"
              className="pt-4 mt-4 border-t-2 border-slate-200"
            />
          </>
        )}
      </Panel>
    </div>
  );
};
