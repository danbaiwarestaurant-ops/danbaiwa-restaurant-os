import React, { useEffect, useMemo, useState } from 'react';
import { ClipboardList, Save, Trophy } from 'lucide-react';
import { useAuthStore } from '../../../store/useAuthStore';
import { useServerSalesStore } from '../../../store/useServerSalesStore';
import { useInventoryStore } from '../../../store/useInventoryStore';
import { useConsolePeriodStore } from '../../../store/useConsolePeriodStore';
import { useDeviceStore } from '../../../store/useDeviceStore';
import { businessDayKey } from '../../../utils/shiftDay';
import { countedManually } from '../../../utils/roles';
import { calculateServerItemSales, serverCollectionVariance, serverProfitContribution, totalServerPerformance } from '../../../utils/serverPerformance';
import { formatCurrency } from '../../../utils/currency';
import { ConsoleButton, DataTable, EmptyState, Panel, StatStrip } from '../ConsoleUI';

const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const ServerSalesView: React.FC = () => {
  const users = useAuthStore((s) => s.users);
  const { entries, loadServerSales, recordPerformance } = useServerSalesStore();
  const { items, load: loadInventory } = useInventoryStore();
  const period = useConsolePeriodStore((s) => s.period);
  const currency = useDeviceStore((s) => s.config.currencySymbol || '₦');
  const [day, setDay] = useState(() => businessDayKey(new Date()));
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [moneyDrafts, setMoneyDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { void loadServerSales(); void loadInventory(); }, [loadServerSales, loadInventory]);
  const servers = useMemo(() => users.filter((u) => countedManually(u.role) && u.status === 'active').sort((a, b) => a.name.localeCompare(b.name)), [users]);
  const foods = useMemo(() => items.filter((item) => item.active && item.trackServerSales).sort((a, b) => a.name.localeCompare(b.name)), [items]);
  const existing = useMemo(() => Object.fromEntries(entries.filter((e) => e.businessDay === day).map((e) => [e.serverId, e])), [entries, day]);

  useEffect(() => {
    const next: Record<string, Record<string, string>> = {};
    const nextMoney: Record<string, string> = {};
    for (const server of servers) {
      next[server.id] = Object.fromEntries(foods.map((food) => [food.id, String(existing[server.id]?.itemVolumes?.find((v) => v.itemId === food.id)?.quantity ?? '')]));
      nextMoney[server.id] = existing[server.id]?.moneyGathered === undefined ? '' : String(existing[server.id].moneyGathered);
    }
    setDrafts(next);
    setMoneyDrafts(nextMoney);
  }, [day, servers, foods, existing]);

  const preview = (serverId: string) => {
    const rows = foods.map((food) => calculateServerItemSales(food, Number(drafts[serverId]?.[food.id] || 0)));
    const totals = totalServerPerformance(rows);
    const moneyGathered = Math.max(0, Number(moneyDrafts[serverId]) || 0);
    return { rows, ...totals, moneyGathered, variance: serverCollectionVariance(totals.expectedSalesValue, moneyGathered), actualProfitContribution: serverProfitContribution(totals.totalCost, moneyGathered) };
  };

  const save = async () => {
    setSaving(true); setError('');
    try {
      for (const server of servers) {
        const performance = preview(server.id);
        await recordPerformance({ serverId: server.id, serverName: server.name, businessDay: day, itemVolumes: performance.rows, moneyGathered: performance.moneyGathered });
      }
      setMessage(`Saved ${servers.length} server records for ${day}`);
      setTimeout(() => setMessage(''), 3500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTimeout(() => setError(''), 6000);
    } finally { setSaving(false); }
  };

  const from = localDay(period.start);
  const to = localDay(new Date(period.end.getTime() - 1));
  const inPeriod = entries.filter((e) => e.businessDay >= from && e.businessDay <= to);
  type Rollup = { id: string; name: string; items: Record<string, number>; units: number; cost: number; expectedProfit: number; actualProfit: number; expected: number; gathered: number; variance: number };
  const ranked = Object.values(inPeriod.reduce<Record<string, Rollup>>((map, entry) => {
    const row = map[entry.serverId] || { id: entry.serverId, name: entry.serverName, items: {}, units: 0, cost: 0, expectedProfit: 0, actualProfit: 0, expected: 0, gathered: 0, variance: 0 };
    for (const item of entry.itemVolumes || []) row.items[item.itemId] = (row.items[item.itemId] || 0) + item.quantity;
    row.units += entry.totalSalesUnits || 0;
    row.cost += entry.totalCost || 0;
    row.expectedProfit += entry.totalProfit || 0;
    row.expected += entry.expectedSalesValue || 0;
    row.gathered += entry.moneyGathered || 0;
    row.variance += entry.variance ?? serverCollectionVariance(entry.expectedSalesValue || 0, entry.moneyGathered || 0);
    row.actualProfit += entry.actualProfitContribution ?? serverProfitContribution(entry.totalCost || 0, entry.moneyGathered || 0);
    map[entry.serverId] = row;
    return map;
  }, {})).sort((a, b) => b.variance - a.variance);
  const totals = ranked.reduce((sum, row) => ({ units: sum.units + row.units, cost: sum.cost + row.cost, expectedProfit: sum.expectedProfit + row.expectedProfit, actualProfit: sum.actualProfit + row.actualProfit, expected: sum.expected + row.expected, gathered: sum.gathered + row.gathered, variance: sum.variance + row.variance }), { units: 0, cost: 0, expectedProfit: 0, actualProfit: 0, expected: 0, gathered: 0, variance: 0 });

  return <div className="space-y-4">
    {(message || error) && <div role="status" className={`fixed top-4 left-1/2 -translate-x-1/2 z-[100] border-2 p-3 shadow-2xl text-xs font-bold ${error ? 'bg-rose-50 border-rose-500 text-rose-900' : 'bg-emerald-50 border-emerald-500 text-emerald-900'}`}>{error || message}</div>}
    <Panel title="Daily Server Item Sales" subtitle="Enter each item sold and the money returned. Expected collection = preparation cost + configured profit." icon={ClipboardList} actions={<><input type="date" value={day} max={businessDayKey(new Date())} onChange={(e) => setDay(e.target.value)} className="border-2 border-slate-300 px-2 py-1.5 text-xs font-bold" /><ConsoleButton variant="primary" onClick={() => void save()} disabled={saving || !servers.length || !foods.length}><Save className="w-3 h-3 inline mr-1" />{saving ? 'Saving…' : 'Save all'}</ConsoleButton></>}>
      {!foods.length ? <EmptyState>Configure food items under Inventory → Ingredient setup, set preparation cost and profit, then enable “Server sales”.</EmptyState> : !servers.length ? <EmptyState>Add active servers under Staff → Team & access.</EmptyState> : <DataTable headers={['Server Name', ...foods.map((f) => `${f.name} (${f.salesUnit || f.baseUnit})`), 'Preparation', 'Expected profit', 'Expected', 'Money gathered', 'Actual profit / loss', 'Surplus / shortage']} alignRight={Array.from({ length: foods.length + 6 }, (_, i) => i + 1)}>{servers.map((server) => { const p = preview(server.id); return <tr key={server.id} className="align-top"><td className="py-2 pr-3 font-bold">{server.name}</td>{foods.map((food) => <td key={food.id} className="py-2 pr-2"><input aria-label={`${server.name} ${food.name}`} type="number" min="0" step="any" value={drafts[server.id]?.[food.id] || ''} onChange={(e) => setDrafts((all) => ({ ...all, [server.id]: { ...all[server.id], [food.id]: e.target.value } }))} className="w-20 border-2 border-slate-300 p-2 text-right font-mono" /></td>)}<td className="py-2 pr-3 text-right font-mono">{formatCurrency(p.totalCost, currency)}</td><td className="py-2 pr-3 text-right font-mono text-emerald-700">{formatCurrency(p.totalProfit, currency)}</td><td className="py-2 pr-3 text-right font-mono font-black">{formatCurrency(p.expectedSalesValue, currency)}</td><td className="py-2 pr-3"><input aria-label={`${server.name} money gathered`} type="number" min="0" step="any" value={moneyDrafts[server.id] || ''} onChange={(e) => setMoneyDrafts((all) => ({ ...all, [server.id]: e.target.value }))} className="w-32 border-2 border-slate-300 p-2 text-right font-mono font-black" /></td><td className={`py-2 pr-3 text-right font-mono font-black ${p.actualProfitContribution < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{p.actualProfitContribution > 0 ? '+' : ''}{formatCurrency(p.actualProfitContribution, currency)}</td><td className={`py-2 text-right font-mono font-black ${p.variance < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{p.variance > 0 ? '+' : ''}{formatCurrency(p.variance, currency)}<div className="text-[9px] uppercase">{p.variance < 0 ? 'Shortage' : p.variance > 0 ? 'Surplus' : 'Balanced'}</div></td></tr>; })}</DataTable>}
    </Panel>
    <Panel title="Server Performance" subtitle={`Item volumes, collections, and variance for ${period.label}`} icon={Trophy}>
      {!ranked.length ? <EmptyState>No server item sales recorded in this period.</EmptyState> : <><StatStrip stats={[{ label: 'Sales units', value: totals.units.toLocaleString() }, { label: 'Expected', value: formatCurrency(totals.expected, currency) }, { label: 'Money gathered', value: formatCurrency(totals.gathered, currency) }, { label: totals.actualProfit < 0 ? 'Actual loss' : 'Actual profit', value: formatCurrency(Math.abs(totals.actualProfit), currency) }, { label: totals.variance < 0 ? 'Net shortage' : 'Net surplus', value: formatCurrency(Math.abs(totals.variance), currency) }]} /><DataTable headers={['Server Name', ...foods.map((f) => f.name), 'Preparation', 'Expected profit', 'Expected', 'Gathered', 'Actual profit / loss', 'Surplus / shortage']} alignRight={Array.from({ length: foods.length + 6 }, (_, i) => i + 1)}>{ranked.map((row) => <tr key={row.id}><td className="py-2.5 pr-3 font-bold">{row.name}</td>{foods.map((food) => <td key={food.id} className="py-2.5 pr-3 text-right font-mono">{(row.items[food.id] || 0).toLocaleString()}</td>)}<td className="py-2.5 pr-3 text-right font-mono">{formatCurrency(row.cost, currency)}</td><td className="py-2.5 pr-3 text-right font-mono text-emerald-700">{formatCurrency(row.expectedProfit, currency)}</td><td className="py-2.5 pr-3 text-right font-mono font-bold">{formatCurrency(row.expected, currency)}</td><td className="py-2.5 pr-3 text-right font-mono font-bold">{formatCurrency(row.gathered, currency)}</td><td className={`py-2.5 pr-3 text-right font-mono font-black ${row.actualProfit < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{row.actualProfit > 0 ? '+' : ''}{formatCurrency(row.actualProfit, currency)}</td><td className={`py-2.5 text-right font-mono font-black ${row.variance < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{row.variance > 0 ? '+' : ''}{formatCurrency(row.variance, currency)}</td></tr>)}</DataTable></>}
    </Panel>
  </div>;
};
