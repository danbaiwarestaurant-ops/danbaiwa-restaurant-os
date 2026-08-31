import React, { useMemo } from 'react';
import { useTicketStore } from '../../../store/useTicketStore';
import { useAuthStore } from '../../../store/useAuthStore';
import { useDeviceStore } from '../../../store/useDeviceStore';
import { useConsolePeriodStore } from '../../../store/useConsolePeriodStore';
import { formatCurrency } from '../../../utils/currency';
import { cashierRollups } from '../../../utils/analytics';
import { filterByPeriod } from '../../../utils/period';
import { Panel, DataTable, EmptyState, StatusBadge } from '../ConsoleUI';
import { StaffManagement } from '../StaffManagement';
import { Users } from 'lucide-react';

export const StaffView: React.FC = () => {
  const { tickets } = useTicketStore();
  const { users } = useAuthStore();
  const { config } = useDeviceStore();
  const { period } = useConsolePeriodStore();
  const currency = config.currencySymbol || '₦';

  // Scoped to the period so this reads as "how did they do this month" rather than a
  // lifetime tally, which only ever grows and so quietly favours whoever was hired first.
  const rollups = useMemo(
    () => cashierRollups(filterByPeriod(tickets, (t) => t.createdAt, period), users),
    [tickets, users, period]
  );
  const rollupFor = (id: string) => rollups.find((r) => r.cashierId === id);

  return (
    <div className="space-y-4">
      <Panel
        title="Staff Directory"
        subtitle={`Performance in ${period.label}, across every device on this account`}
        icon={Users}
      >
        {users.length === 0 ? (
          <EmptyState>No staff accounts yet</EmptyState>
        ) : (
          <DataTable headers={['Name', 'Role', 'Tickets', 'Revenue', 'Voids', 'Status']} alignRight={[2, 3, 4, 5]}>
            {users.map((u) => {
              const r = rollupFor(u.id);
              return (
                <tr key={u.id} className="hover:bg-slate-50">
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center gap-2.5">
                      <span className="w-6 h-6 bg-amber-500 text-white font-black text-[10px] flex items-center justify-center rounded-none flex-shrink-0">
                        {(u.name || '?').split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('')}
                      </span>
                      <span className="font-bold text-slate-900">{u.name}</span>
                    </div>
                  </td>
                  <td className="py-2.5 pr-3 text-slate-600 uppercase text-[11px] font-bold">{u.role}</td>
                  <td className="py-2.5 pr-3 text-right font-mono tabular-nums">{r?.ticketCount ?? 0}</td>
                  <td className="py-2.5 pr-3 text-right font-mono font-bold tabular-nums">
                    {formatCurrency(r?.revenue ?? 0, currency)}
                  </td>
                  <td className="py-2.5 pr-3 text-right">
                    <StatusBadge tone={(r?.voidCount ?? 0) > 0 ? 'warn' : 'ok'}>{r?.voidCount ?? 0}</StatusBadge>
                  </td>
                  <td className="py-2.5 text-right">
                    <StatusBadge tone={u.status === 'active' ? 'ok' : 'muted'}>{u.status}</StatusBadge>
                  </td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </Panel>

      {/* Existing component, unchanged — it already handles creation and PIN resets. */}
      <StaffManagement />
    </div>
  );
};
