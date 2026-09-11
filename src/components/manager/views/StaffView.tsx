import React, { useEffect, useMemo } from 'react';
import { useTicketStore } from '../../../store/useTicketStore';
import { useAuthStore } from '../../../store/useAuthStore';
import { useDeviceStore } from '../../../store/useDeviceStore';
import { useConsolePeriodStore } from '../../../store/useConsolePeriodStore';
import { useServerSalesStore } from '../../../store/useServerSalesStore';
import { formatCurrency } from '../../../utils/currency';
import { staffSalesRollups, staffMealRollups } from '../../../utils/analytics';
import { filterByPeriod } from '../../../utils/period';
import { Panel, DataTable, EmptyState, StatusBadge } from '../ConsoleUI';
import { StaffManagement } from '../StaffManagement';
import { Users, UtensilsCrossed } from 'lucide-react';
import { roleLabel, takesSales, countedManually } from '../../../utils/roles';

export const StaffView: React.FC = () => {
  const { tickets } = useTicketStore();
  const { users } = useAuthStore();
  const { config } = useDeviceStore();
  const { period } = useConsolePeriodStore();
  const { entries: serverEntries, loadServerSales } = useServerSalesStore();
  const currency = config.currencySymbol || '₦';

  useEffect(() => {
    void loadServerSales();
  }, [loadServerSales]);

  /**
   * A server's tickets for the period, from what a manager typed in.
   *
   * Servers never touch the till, so nothing in `tickets` is theirs — without this their
   * row here would read as a dash for ever, which is the "the system treats everyone as a
   * cashier" problem wearing a different hat. Revenue stays a dash: only a count is
   * entered, and inventing a naira figure from it would be a guess presented as a record.
   *
   * Trading days are compared as YYYY-MM-DD keys, which is what they are — the day is
   * already the unit, and re-parsing it into a Date only invites a timezone question.
   */
  const serverTickets = useMemo(() => {
    const ymd = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const from = ymd(period.start);
    const to = ymd(new Date(period.end.getTime() - 1));
    const totals: Record<string, number> = {};
    for (const e of serverEntries) {
      if (e.businessDay < from || e.businessDay > to) continue;
      totals[e.serverId] = (totals[e.serverId] || 0) + e.ticketCount;
    }
    return totals;
  }, [serverEntries, period]);

  // Scoped to the period so this reads as "how did they do this month" rather than a
  // lifetime tally, which only ever grows and so quietly favours whoever was hired first.
  const rollups = useMemo(
    () => staffSalesRollups(filterByPeriod(tickets, (t) => t.createdAt, period), users),
    [tickets, users, period]
  );
  const rollupFor = (id: string) => rollups.find((r) => r.staffId === id);

  // Driven by the tickets rather than the roster, so a meal issued to someone who has
  // since left still appears against their name instead of vanishing from the total.
  const meals = useMemo(
    () => staffMealRollups(filterByPeriod(tickets, (t) => t.createdAt, period), users),
    [tickets, users, period]
  );
  const mealTotal = meals.reduce((sum, m) => sum + m.value, 0);
  const mealCount = meals.reduce((sum, m) => sum + m.mealCount, 0);

  return (
    <div className="space-y-4">
      <Panel
        title="Staff Directory"
        subtitle={`Performance in ${period.label}. * marks a ticket count entered by a manager rather than rung up at the till.`}
        icon={Users}
      >
        {users.length === 0 ? (
          <EmptyState>No staff accounts yet</EmptyState>
        ) : (
          <DataTable headers={['Name', 'Role', 'Tickets', 'Revenue', 'Voids', 'Status']} alignRight={[2, 3, 4, 5]}>
            {users.map((u) => {
              const r = rollupFor(u.id);
              // Kitchen and store staff never ring anything up, so a row of zeroes against
              // their name is not information — it reads as underperformance by someone
              // whose job has no tickets in it. Dashes say "not applicable" instead.
              const sells = takesSales(u.role) || u.role === 'admin';
              const manual = countedManually(u.role);
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
                  <td className="py-2.5 pr-3 text-slate-600 uppercase text-[11px] font-bold">{roleLabel(u.role)}</td>
                  <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-slate-400">
                    {sells ? (
                      <span className="text-slate-900">{r?.ticketCount ?? 0}</span>
                    ) : manual ? (
                      // Marked, because this number was typed in rather than rung up, and a
                      // column that mixed the two without saying so would be read as one thing.
                      <span className="text-slate-900" title="Entered by a manager — servers do not use the till">
                        {serverTickets[u.id] ?? 0}
                        <span className="text-amber-600 font-black">*</span>
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="py-2.5 pr-3 text-right font-mono font-bold tabular-nums text-slate-400">
                    {sells ? (
                      <span className="text-slate-900">{formatCurrency(r?.revenue ?? 0, currency)}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="py-2.5 pr-3 text-right">
                    {sells ? (
                      <StatusBadge tone={(r?.voidCount ?? 0) > 0 ? 'warn' : 'ok'}>{r?.voidCount ?? 0}</StatusBadge>
                    ) : (
                      <span className="font-mono text-slate-400">—</span>
                    )}
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

      {/* Staff meals are a cost, not a sale, so they are reported here against the people
          who had them rather than anywhere near the revenue figures. Kept in the staff
          view for the same reason: the question an owner asks of this number is about a
          person ("is one shift eating twice as much as the others?"), not about a day. */}
      <Panel
        title="Staff Meals"
        subtitle={`Meals issued to employees in ${period.label} — menu value, never counted as revenue`}
        icon={UtensilsCrossed}
      >
        {meals.length === 0 ? (
          <EmptyState>No staff meals issued in this period</EmptyState>
        ) : (
          <>
            <DataTable headers={['Employee', 'Meals', 'Value']} alignRight={[1, 2]}>
              {meals.map((m) => (
                <tr key={m.staffId} className="hover:bg-slate-50">
                  <td className="py-2.5 pr-3 font-bold text-slate-900">{m.name}</td>
                  <td className="py-2.5 pr-3 text-right font-mono tabular-nums">{m.mealCount}</td>
                  <td className="py-2.5 text-right font-mono font-bold tabular-nums text-amber-700">
                    {formatCurrency(m.value, currency)}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-slate-300 bg-slate-50">
                <td className="py-2.5 pr-3 font-black uppercase text-[11px] tracking-wider text-slate-700">
                  Total
                </td>
                <td className="py-2.5 pr-3 text-right font-mono font-black tabular-nums">{mealCount}</td>
                <td className="py-2.5 text-right font-mono font-black tabular-nums text-amber-700">
                  {formatCurrency(mealTotal, currency)}
                </td>
              </tr>
            </DataTable>
          </>
        )}
      </Panel>

      {/* Existing component, unchanged — it already handles creation and PIN resets. */}
      <StaffManagement />
    </div>
  );
};
