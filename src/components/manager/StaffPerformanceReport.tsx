import React, { useEffect, useMemo } from 'react';
import { BarChart3 } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';
import { useConsolePeriodStore } from '../../store/useConsolePeriodStore';
import { useDeviceStore } from '../../store/useDeviceStore';
import { useInventoryStore } from '../../store/useInventoryStore';
import { useServerSalesStore } from '../../store/useServerSalesStore';
import { useWorkforceStore } from '../../store/useWorkforceStore';
import { formatCurrency } from '../../utils/currency';
import { roleLabel } from '../../utils/roles';
import { businessDayKey } from '../../utils/shiftDay';
import { EmptyState, DataTable, Panel, StatStrip, StatusBadge } from './ConsoleUI';

type Breakdown = Record<string, { count: number; amount: number }>;
type StaffRollup = {
  id: string; name: string; role: string; metric: string; days: Set<string>; output: number;
  gross: number; rewards: number; penalties: number; net: number; drafts: number;
  rewardItems: Breakdown; penaltyItems: Breakdown; itemVolumes: Record<string, number>;
  preparation: number; expected: number; gathered: number; actualProfit: number; variance: number;
};

const addBreakdown = (target: Breakdown, label: string, amount: number) => {
  const row = target[label] || { count: 0, amount: 0 };
  row.count += 1;
  row.amount += amount;
  target[label] = row;
};

const breakdownText = (rows: Breakdown, currency: string) => {
  const values = Object.entries(rows);
  if (!values.length) return '—';
  return values.map(([label, row]) => `${label} ×${row.count} (${formatCurrency(row.amount, currency)})`).join(' · ');
};

export const StaffPerformanceReport: React.FC = () => {
  const users = useAuthStore((state) => state.users);
  const currency = useDeviceStore((state) => state.config.currencySymbol || '₦');
  const period = useConsolePeriodStore((state) => state.period);
  const { assessments, load } = useWorkforceStore();
  const { entries: serverSales, loadServerSales } = useServerSalesStore();
  const { items, load: loadInventory } = useInventoryStore();

  useEffect(() => { void load(); void loadServerSales(); void loadInventory(); }, [load, loadServerSales, loadInventory]);
  const from = businessDayKey(period.start, period.businessDayStartHour ?? 0);
  const to = businessDayKey(new Date(period.end.getTime() - 1), period.businessDayStartHour ?? 0);
  const foods = useMemo(() => items.filter((item) => item.active && item.trackServerSales).sort((a, b) => a.name.localeCompare(b.name)), [items]);

  const rows = useMemo(() => {
    const map: Record<string, StaffRollup> = {};
    const ensure = (id: string, name: string, role: string, metric = '—') => map[id] ||= {
      id, name, role, metric, days: new Set(), output: 0, gross: 0, rewards: 0, penalties: 0, net: 0, drafts: 0,
      rewardItems: {}, penaltyItems: {}, itemVolumes: {}, preparation: 0, expected: 0, gathered: 0, actualProfit: 0, variance: 0,
    };
    for (const assessment of assessments) {
      if (assessment.businessDay < from || assessment.businessDay > to) continue;
      const row = ensure(assessment.staffId, assessment.staffName, assessment.role, assessment.metricLabel);
      row.days.add(assessment.businessDay);
      row.output += assessment.output || 0;
      row.gross += assessment.grossPay || 0;
      row.rewards += assessment.rewardTotal ?? (assessment.rewards || []).reduce((sum, reward) => sum + reward.value, 0);
      row.penalties += assessment.fixedPenaltyTotal || 0;
      row.net += assessment.netPay || 0;
      if (assessment.status === 'draft') row.drafts += 1;
      for (const reward of assessment.rewards || []) addBreakdown(row.rewardItems, reward.label, reward.value);
      for (const penalty of assessment.penalties || []) addBreakdown(row.penaltyItems, penalty.label, penalty.value);
    }
    for (const entry of serverSales) {
      if (entry.businessDay < from || entry.businessDay > to) continue;
      const user = users.find((candidate) => candidate.id === entry.serverId);
      const row = ensure(entry.serverId, entry.serverName, user?.role || 'server', 'Food sales units');
      row.days.add(entry.businessDay);
      for (const item of entry.itemVolumes || []) row.itemVolumes[item.itemId] = (row.itemVolumes[item.itemId] || 0) + item.quantity;
      row.preparation += entry.totalCost || 0;
      row.expected += entry.expectedSalesValue || 0;
      row.gathered += entry.moneyGathered || 0;
      row.actualProfit += entry.actualProfitContribution ?? ((entry.moneyGathered || 0) - (entry.totalCost || 0));
      row.variance += entry.variance ?? ((entry.moneyGathered || 0) - (entry.expectedSalesValue || 0));
    }
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  }, [assessments, serverSales, users, from, to]);

  const totals = rows.reduce((sum, row) => ({ days: sum.days + row.days.size, rewards: sum.rewards + row.rewards, penalties: sum.penalties + row.penalties, wages: sum.wages + row.net }), { days: 0, rewards: 0, penalties: 0, wages: 0 });

  return <Panel title="Staff Performance Report" subtitle={`Every recorded performance parameter in ${period.label}. Use the manager date picker for daily, weekly, monthly, or yearly views.`} icon={BarChart3}>
    {!rows.length ? <EmptyState>No staff performance recorded in {period.label}</EmptyState> : <>
      <StatStrip stats={[{ label: 'Staff assessed', value: String(rows.length) }, { label: 'Assessment days', value: String(totals.days) }, { label: 'Performance rewards', value: formatCurrency(totals.rewards, currency) }, { label: 'Fixed penalties', value: formatCurrency(totals.penalties, currency) }, { label: 'Final wages', value: formatCurrency(totals.wages, currency) }]} />
      <DataTable headers={['Staff', 'Days', 'Metric / output', 'Base reward', 'Reward items', 'Penalty items', 'Final wage', ...foods.map((food) => food.name), 'Preparation', 'Expected', 'Collected', 'Actual profit / loss', 'Surplus / shortage', 'Status']} alignRight={[1, 2, 3, 6, ...Array.from({ length: foods.length + 5 }, (_, index) => index + 7)]}>
        {rows.map((row) => <tr key={row.id} className="align-top">
          <td className="py-2.5 pr-3 font-bold">{row.name}<div className="text-[9px] uppercase text-slate-400">{roleLabel(row.role as any)}</div></td>
          <td className="py-2.5 pr-3 text-right font-mono">{row.days.size}</td>
          <td className="py-2.5 pr-3 text-right"><div className="font-mono font-black">{row.output.toLocaleString()}</div><div className="text-[9px] text-slate-500">{row.metric}</div></td>
          <td className="py-2.5 pr-3 text-right font-mono">{formatCurrency(row.gross, currency)}</td>
          <td className="py-2.5 pr-3 min-w-52"><div className="text-[10px] text-emerald-800">{breakdownText(row.rewardItems, currency)}</div><div className="text-right font-mono font-black text-emerald-700">+{formatCurrency(row.rewards, currency)}</div></td>
          <td className="py-2.5 pr-3 min-w-52"><div className="text-[10px] text-rose-800">{breakdownText(row.penaltyItems, currency)}</div><div className="text-right font-mono font-black text-rose-700">−{formatCurrency(row.penalties, currency)}</div></td>
          <td className={`py-2.5 pr-3 text-right font-mono font-black ${row.net < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{formatCurrency(row.net, currency)}</td>
          {foods.map((food) => <td key={food.id} className="py-2.5 pr-3 text-right font-mono">{(row.itemVolumes[food.id] || 0).toLocaleString()}</td>)}
          <td className="py-2.5 pr-3 text-right font-mono">{row.preparation ? formatCurrency(row.preparation, currency) : '—'}</td>
          <td className="py-2.5 pr-3 text-right font-mono">{row.expected ? formatCurrency(row.expected, currency) : '—'}</td>
          <td className="py-2.5 pr-3 text-right font-mono">{row.gathered ? formatCurrency(row.gathered, currency) : '—'}</td>
          <td className={`py-2.5 pr-3 text-right font-mono font-black ${row.actualProfit < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{row.preparation || row.gathered ? formatCurrency(row.actualProfit, currency) : '—'}</td>
          <td className={`py-2.5 pr-3 text-right font-mono font-black ${row.variance < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{row.expected || row.gathered ? formatCurrency(row.variance, currency) : '—'}</td>
          <td className="py-2.5 text-right"><StatusBadge tone={row.drafts ? 'warn' : 'ok'}>{row.drafts ? `${row.drafts} draft` : 'Finalized'}</StatusBadge></td>
        </tr>)}
      </DataTable>
    </>}
  </Panel>;
};
