import React, { useEffect, useMemo, useState } from 'react';
import { Banknote, Calculator, CheckCircle2, RotateCcw, Settings2 } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';
import { DEFAULT_PAY_CONFIGS, useWorkforceStore } from '../../store/useWorkforceStore';
import { STAFF_ROLES, roleLabel } from '../../utils/roles';
import { calculateAssessment, wageBalance } from '../../utils/workforce';
import { formatCurrency } from '../../utils/currency';
import { useDeviceStore } from '../../store/useDeviceStore';
import { PerformanceReward, WagePenalty } from '../../types/workforce';
import { useConsolePeriodStore } from '../../store/useConsolePeriodStore';
import { periodContains } from '../../utils/period';
import { ConsoleButton, DataTable, EmptyState, Panel, StatusBadge } from './ConsoleUI';
import { useShiftStore } from '../../store/useShiftStore';
import { businessDayKey } from '../../utils/shiftDay';
import { useServerSalesStore } from '../../store/useServerSalesStore';
import { useInventoryStore } from '../../store/useInventoryStore';
import { calculateServerItemSales, serverCollectionVariance, serverProfitContribution, totalServerPerformance } from '../../utils/serverPerformance';

type Draft = { output: string; fixed: string; fixedLabel: string; rewardLabel: string; note: string };
const blankDraft = (): Draft => ({ output: '', fixed: '', fixedLabel: '', rewardLabel: '', note: '' });
export type PayrollSection = 'assessment' | 'wages' | 'balances';

export const StaffPayroll: React.FC<{ section: PayrollSection }> = ({ section }) => {
  const { users } = useAuthStore();
  const { config: deviceConfig, updateConfig } = useDeviceStore();
  const { configs, assessments, ledger, load, configFor, saveConfig, saveAssessment, finalizeDay, reopenAssessment, addLedgerEntry } = useWorkforceStore();
  const today = () => businessDayKey(new Date(), deviceConfig.businessDayStartHour);
  const [day, setDay] = useState(today);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [serverItemDrafts, setServerItemDrafts] = useState<Record<string, Record<string, string>>>({});
  const [serverMoneyDrafts, setServerMoneyDrafts] = useState<Record<string, string>>({});
  const [configDrafts, setConfigDrafts] = useState<Record<string, { metric: string; rate: string }>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [settle, setSettle] = useState<{ staffId: string; amount: string; note: string; kind: 'payment' | 'debt_forgiveness' | 'manual_adjustment' } | null>(null);
  const currency = deviceConfig.currencySymbol || '₦';
  const penaltyRules = deviceConfig.penaltyRules || [];
  const rewardRules = deviceConfig.performanceRewardRules || [];
  const period = useConsolePeriodStore((s) => s.period);
  const { shiftHistory, loadShiftHistory } = useShiftStore();
  const { entries: serverSales, loadServerSales, recordPerformance } = useServerSalesStore();
  const { items: inventoryItems, load: loadInventory } = useInventoryStore();
  const staff = users.filter((u) => u.role !== 'admin' && u.status === 'active');
  const serverFoods = useMemo(() => inventoryItems.filter((item) => item.active && item.trackServerSales).sort((a, b) => a.name.localeCompare(b.name)), [inventoryItems]);

  useEffect(() => { void load(); void loadShiftHistory(); void loadServerSales(); void loadInventory(); }, [load, loadShiftHistory, loadServerSales, loadInventory]);
  useEffect(() => {
    const next: Record<string, Draft> = {};
    for (const person of staff) {
      const existing = assessments.find((a) => a.businessDay === day && a.staffId === person.id);
      const serverEntry = person.role === 'server' ? serverSales.find((entry) => entry.businessDay === day && entry.serverId === person.id) : undefined;
      next[person.id] = existing ? {
        output: String(existing.output), fixed: String(existing.fixedPenaltyTotal || ''),
        fixedLabel: existing.penalties.find((p) => p.kind === 'fixed')?.label || '',
        rewardLabel: (existing.rewards || []).map((reward) => reward.label).join(' | '),
        note: existing.note || '',
      } : { ...blankDraft(), output: serverEntry ? String(serverEntry.totalSalesUnits || 0) : '' };
    }
    setDrafts(next);
  }, [day, assessments.length, users.length, serverSales]);
  useEffect(() => {
    const quantities: Record<string, Record<string, string>> = {};
    const money: Record<string, string> = {};
    for (const person of staff.filter((row) => row.role === 'server')) {
      const existing = serverSales.find((entry) => entry.businessDay === day && entry.serverId === person.id);
      quantities[person.id] = Object.fromEntries(serverFoods.map((food) => [food.id, String(existing?.itemVolumes?.find((row) => row.itemId === food.id)?.quantity ?? '')]));
      money[person.id] = existing?.moneyGathered === undefined ? '' : String(existing.moneyGathered);
    }
    setServerItemDrafts(quantities);
    setServerMoneyDrafts(money);
  }, [day, users.length, serverSales, serverFoods]);
  useEffect(() => {
    const next: Record<string, { metric: string; rate: string }> = {};
    for (const role of STAFF_ROLES) {
      const cfg = configs.find((c) => c.role === role) || DEFAULT_PAY_CONFIGS[role];
      next[role] = { metric: cfg.metricLabel, rate: String(cfg.nairaPerUnit) };
    }
    setConfigDrafts(next);
  }, [configs]);

  const rowsForDay = assessments.filter((a) => a.businessDay === day);
  const serverPreview = (serverId: string) => {
    const rows = serverFoods.map((food) => calculateServerItemSales(food, Number(serverItemDrafts[serverId]?.[food.id] || 0)));
    const totals = totalServerPerformance(rows);
    const moneyGathered = Math.max(0, Number(serverMoneyDrafts[serverId]) || 0);
    return { rows, ...totals, moneyGathered, variance: serverCollectionVariance(totals.expectedSalesValue, moneyGathered), actualProfitContribution: serverProfitContribution(totals.totalCost, moneyGathered) };
  };
  const flash = (text: string) => { setError(''); setMessage(text); setTimeout(() => setMessage(''), 3500); };
  const fail = (e: unknown) => { setMessage(''); setError(e instanceof Error ? e.message : String(e)); setTimeout(() => setError(''), 6000); };
  const saveAll = async () => {
    try {
      let saved = 0;
      for (const person of staff) {
        const draft = drafts[person.id];
        if (!draft) continue;
        let output = draft.output === '' ? NaN : Number(draft.output);
        if (person.role === 'server') {
          const performance = serverPreview(person.id);
          const hasEntry = performance.totalSalesUnits > 0 || serverMoneyDrafts[person.id] !== '' || Boolean(serverSales.find((entry) => entry.businessDay === day && entry.serverId === person.id));
          if (!hasEntry) continue;
          await recordPerformance({ serverId: person.id, serverName: person.name, businessDay: day, itemVolumes: performance.rows, moneyGathered: performance.moneyGathered });
          output = performance.totalSalesUnits;
        }
        if (!Number.isFinite(output)) continue;
        const penalties: WagePenalty[] = [];
        if (Number(draft.fixed) > 0) penalties.push({ id: crypto.randomUUID(), kind: 'fixed', value: Number(draft.fixed), label: draft.fixedLabel.trim() || 'Fixed penalty' });
        const selectedRewards = draft.rewardLabel.split(' | ').filter(Boolean);
        const rewards: PerformanceReward[] = rewardRules.filter((rule) => selectedRewards.includes(rule.label)).map((rule) => ({ id: rule.id, label: rule.label, value: rule.fixedAmount }));
        await saveAssessment(person, day, output, penalties, rewards, draft.note);
        saved++;
      }
      flash(`${saved} assessment${saved === 1 ? '' : 's'} saved as draft`);
    } catch (e) { fail(e); }
  };
  const saveRoleConfig = async (role: typeof STAFF_ROLES[number]) => {
    const draft = configDrafts[role];
    try {
      if (!draft.metric.trim()) throw new Error('Enter a performance measure.');
      if (Number(draft.rate) <= 0) throw new Error('Monetary reward must be greater than zero.');
      await saveConfig(role, draft.metric, Number(draft.rate));
      flash(`${roleLabel(role)} wage rule saved`);
    } catch (e) { fail(e); }
  };
  const periodBalances = useMemo(() => staff.map((person) => ({
    person,
    balance: wageBalance(assessments.filter((a) => a.staffId === person.id), ledger.filter((l) => l.staffId === person.id)),
    earned: assessments.filter((a) => {
      if (a.staffId !== person.id || a.status !== 'finalized') return false;
      return periodContains(period, a.businessDay);
    }).reduce((sum, a) => sum + a.netPay, 0),
  })), [staff, assessments, ledger, period]);

  return <div className="space-y-4">
    {(message || error) && <div role="status" className={`fixed top-4 left-1/2 -translate-x-1/2 z-[100] w-[min(92vw,36rem)] border-2 p-3 shadow-2xl text-xs font-bold ${error ? 'bg-rose-50 border-rose-500 text-rose-900' : 'bg-emerald-50 border-emerald-500 text-emerald-900'}`}>{error || message}</div>}

    {section === 'wages' && <Panel title="Wage Configuration" subtitle="Set the performance measure and its monetary reward. Wage = performance recorded × reward per unit − penalties." icon={Settings2}>
      <DataTable headers={['Staff type', 'Performance measure', 'Monetary reward per unit', '']} alignRight={[2, 3]}>
        {STAFF_ROLES.map((role) => {
          const draft = configDrafts[role] || { metric: '', rate: '' };
          return <tr key={role}>
            <td className="py-2 pr-3 font-bold">{roleLabel(role)}</td>
            <td className="py-2 pr-3"><input value={draft.metric} onChange={(e) => setConfigDrafts((all) => ({ ...all, [role]: { ...draft, metric: e.target.value } }))} className="w-full border-2 border-slate-300 p-2 rounded-none" /></td>
            <td className="py-2 pr-3"><div className="flex items-center justify-end gap-1"><span className="font-black text-slate-500">{currency}</span><input aria-label={`${roleLabel(role)} monetary reward per unit`} type="number" min="0" value={draft.rate} onChange={(e) => setConfigDrafts((all) => ({ ...all, [role]: { ...draft, rate: e.target.value } }))} className="w-32 border-2 border-slate-300 p-2 text-right font-mono font-black rounded-none" /></div><div className="text-[9px] text-right text-slate-500 mt-1">for each {draft.metric || 'recorded unit'}</div></td>
            <td className="py-2 text-right"><ConsoleButton onClick={() => void saveRoleConfig(role)}>Save</ConsoleButton></td>
          </tr>;
        })}
      </DataTable>
      <div className="mt-5 border-t-2 border-slate-300 pt-4 grid grid-cols-1 xl:grid-cols-2 gap-5">
        <div className="border-2 border-emerald-300 bg-emerald-50/40 p-3"><div className="flex items-center justify-between mb-2 gap-2"><div><div className="text-xs font-black uppercase">Performance reward items</div><div className="text-[10px] text-slate-500">Fixed bonuses a manager can award for excellent performance.</div></div><ConsoleButton onClick={() => void updateConfig({ performanceRewardRules: [...rewardRules, { id: crypto.randomUUID(), label: 'Other reward', fixedAmount: 0 }] })}>Add reward</ConsoleButton></div><div className="space-y-2">{rewardRules.map((rule, index) => <div key={rule.id} className="grid grid-cols-[1fr_10rem_2rem] gap-2"><input aria-label="Reward item name" value={rule.label} onChange={(e) => { const next = [...rewardRules]; next[index] = { ...rule, label: e.target.value }; void updateConfig({ performanceRewardRules: next }); }} className="border-2 border-slate-300 p-2 text-xs font-bold" /><div className="flex"><span className="border-2 border-r-0 border-slate-300 p-2 text-xs font-black">{currency}</span><input aria-label={`${rule.label} fixed reward`} type="number" min="0" value={rule.fixedAmount} onChange={(e) => { const next = [...rewardRules]; next[index] = { ...rule, fixedAmount: Math.max(0, Number(e.target.value)) }; void updateConfig({ performanceRewardRules: next }); }} className="w-full border-2 border-slate-300 p-2 text-right font-mono text-xs" /></div><button aria-label={`Remove ${rule.label}`} onClick={() => void updateConfig({ performanceRewardRules: rewardRules.filter((x) => x.id !== rule.id) })} className="text-rose-700 font-black">×</button></div>)}</div></div>
        <div className="border-2 border-rose-300 bg-rose-50/40 p-3"><div className="flex items-center justify-between mb-2 gap-2"><div><div className="text-xs font-black uppercase">Fixed penalty items</div><div className="text-[10px] text-slate-500">Everyone starts Excellent. Select an infraction only when a deduction applies.</div></div><ConsoleButton onClick={() => void updateConfig({ penaltyRules: [...penaltyRules, { id: crypto.randomUUID(), label: 'Other', fixedFee: 0 }] })}>Add infraction</ConsoleButton></div><div className="space-y-2">{penaltyRules.map((rule, index) => <div key={rule.id} className="grid grid-cols-[1fr_10rem_2rem] gap-2"><input value={rule.label} onChange={(e) => { const next = [...penaltyRules]; next[index] = { ...rule, label: e.target.value }; void updateConfig({ penaltyRules: next }); }} className="border-2 border-slate-300 p-2 text-xs font-bold" /><div className="flex"><span className="border-2 border-r-0 border-slate-300 p-2 text-xs font-black">{currency}</span><input aria-label={`${rule.label} fixed penalty`} type="number" min="0" value={rule.fixedFee} onChange={(e) => { const next = [...penaltyRules]; next[index] = { ...rule, fixedFee: Math.max(0, Number(e.target.value)) }; void updateConfig({ penaltyRules: next }); }} className="w-full border-2 border-slate-300 p-2 text-right font-mono text-xs" /></div><button aria-label={`Remove ${rule.label}`} onClick={() => void updateConfig({ penaltyRules: penaltyRules.filter((x) => x.id !== rule.id) })} className="text-rose-700 font-black">×</button></div>)}</div></div>
      </div>
    </Panel>}

    {section === 'assessment' && <><Panel title="Cashier Variance" subtitle="Closed till shortages and overages for the selected trading day." icon={Calculator}>
      {shiftHistory.filter((shift) => shift.status === 'closed' && businessDayKey(shift.openedAt, deviceConfig.businessDayStartHour) === day).length === 0 ? <EmptyState>No closed cashier shifts for this day</EmptyState> : <DataTable headers={['Cashier', 'Expected cash', 'Counted cash', 'Variance']} alignRight={[1, 2, 3]}>{shiftHistory.filter((shift) => shift.status === 'closed' && businessDayKey(shift.openedAt, deviceConfig.businessDayStartHour) === day).map((shift) => <tr key={shift.id}><td className="py-2 pr-3 font-bold">{shift.cashierName}</td><td className="py-2 pr-3 text-right font-mono">{formatCurrency(shift.expectedCash || 0, currency)}</td><td className="py-2 pr-3 text-right font-mono">{formatCurrency(shift.countedCash || 0, currency)}</td><td className={`py-2 text-right font-mono font-black ${(shift.variance || 0) < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{formatCurrency(shift.variance || 0, currency)}</td></tr>)}</DataTable>}
    </Panel><Panel title="Daily Performance & Pay" subtitle="Everyone starts Excellent. Record work completed and add a penalty only when an infraction occurred." icon={Calculator} actions={<input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} className="border-2 border-slate-300 px-2 py-1.5 text-xs font-bold rounded-none" />}>
      {staff.length === 0 ? <EmptyState>Add active staff before recording performance</EmptyState> : <>
        <DataTable headers={['Staff', 'Performance recorded', 'Base reward', 'Performance rewards', 'Fixed penalties', 'Final wage', 'Status']} alignRight={[1, 2, 3, 4, 5, 6]}>
          {staff.map((person) => {
            const draft = drafts[person.id] || blankDraft();
            const cfg = configFor(person.role);
            const existing = rowsForDay.find((a) => a.staffId === person.id);
            const serverPerformance = person.role === 'server' ? serverPreview(person.id) : undefined;
            const performanceOutput = serverPerformance ? serverPerformance.totalSalesUnits : Number(draft.output);
            const hasPerformance = serverPerformance ? serverPerformance.totalSalesUnits > 0 || serverMoneyDrafts[person.id] !== '' : draft.output !== '';
            const selectedRewardLabels = draft.rewardLabel.split(' | ').filter(Boolean);
            const previewRewards = rewardRules.filter((rule) => selectedRewardLabels.includes(rule.label)).map((rule) => ({ id: rule.id, label: rule.label, value: rule.fixedAmount }));
            const calc = calculateAssessment({ output: performanceOutput, nairaPerUnit: cfg.nairaPerUnit, penalties: [
              { id: 'fixed', kind: 'fixed', value: Number(draft.fixed), label: '' },
            ], rewards: previewRewards });
            const locked = existing?.status === 'finalized';
            const change = (field: keyof Draft, value: string) => setDrafts((all) => ({ ...all, [person.id]: { ...draft, [field]: value } }));
            return <tr key={person.id} className="align-top">
              <td className="py-2 pr-3"><div className="font-bold">{person.name}</div><div className="text-[10px] text-slate-500">{roleLabel(person.role)} · {cfg.metricLabel}</div>{serverPerformance && <div className="mt-1 space-y-0.5 text-[9px] font-bold"><div className={serverPerformance.actualProfitContribution < 0 ? 'text-rose-700' : 'text-emerald-700'}>Actual {serverPerformance.actualProfitContribution < 0 ? 'loss' : 'profit'} contribution: {formatCurrency(Math.abs(serverPerformance.actualProfitContribution), currency)}</div><div className={serverPerformance.variance < 0 ? 'text-rose-700' : 'text-emerald-700'}>{serverPerformance.variance < 0 ? 'Shortage' : 'Surplus'}: {formatCurrency(Math.abs(serverPerformance.variance), currency)}</div></div>}<input value={draft.note} disabled={locked} onChange={(e) => change('note', e.target.value)} placeholder="Evidence / note" className="mt-1 w-40 border border-slate-300 p-1 text-[10px] rounded-none" /></td>
              <td className="py-2 pr-3">{serverPerformance ? <div className="w-full lg:min-w-[28rem] space-y-2"><div className="grid grid-cols-2 gap-2">{serverFoods.map((food) => <label key={food.id} className="text-[9px] font-black uppercase text-slate-600">{food.name} ({food.cookingUnit || food.salesUnit || food.baseUnit})<input aria-label={`${person.name} ${food.name}`} type="number" min="0" step="any" disabled={locked} value={serverItemDrafts[person.id]?.[food.id] || ''} onChange={(e) => setServerItemDrafts((all) => ({ ...all, [person.id]: { ...all[person.id], [food.id]: e.target.value } }))} className="mt-0.5 w-full border-2 border-slate-300 p-2 text-right font-mono text-xs rounded-none normal-case" /></label>)}</div>{serverFoods.length === 0 && <div className="border-2 border-amber-300 bg-amber-50 p-2 text-[10px] font-bold text-amber-900">Configure food items in Inventory and enable Server sales.</div>}<label className="block text-[9px] font-black uppercase text-slate-600">Money gathered / collected<input aria-label={`${person.name} money gathered`} type="number" min="0" step="any" disabled={locked} value={serverMoneyDrafts[person.id] || ''} onChange={(e) => setServerMoneyDrafts((all) => ({ ...all, [person.id]: e.target.value }))} className="mt-0.5 w-full border-2 border-slate-300 p-2 text-right font-mono text-xs rounded-none normal-case" /></label><div className="grid grid-cols-4 gap-2 border-t border-slate-300 pt-2 text-[9px]"><div><span className="block text-slate-500 uppercase font-bold">Units</span><strong>{serverPerformance.totalSalesUnits.toLocaleString()}</strong></div><div><span className="block text-slate-500 uppercase font-bold">Expected</span><strong>{formatCurrency(serverPerformance.expectedSalesValue, currency)}</strong></div><div><span className="block text-slate-500 uppercase font-bold">Profit / loss</span><strong className={serverPerformance.actualProfitContribution < 0 ? 'text-rose-700' : 'text-emerald-700'}>{serverPerformance.actualProfitContribution > 0 ? '+' : ''}{formatCurrency(serverPerformance.actualProfitContribution, currency)}</strong></div><div><span className="block text-slate-500 uppercase font-bold">Surplus / shortage</span><strong className={serverPerformance.variance < 0 ? 'text-rose-700' : 'text-emerald-700'}>{serverPerformance.variance > 0 ? '+' : ''}{formatCurrency(serverPerformance.variance, currency)}</strong></div></div></div> : <><input aria-label={`${person.name} ${cfg.metricLabel}`} type="number" min="0" disabled={locked} value={draft.output} onChange={(e) => change('output', e.target.value)} className="w-28 border-2 border-slate-300 p-2 text-right font-mono rounded-none" /><div className="text-[9px] text-slate-500 mt-1">{cfg.metricLabel}</div></>}</td>
              <td className="py-2 pr-3 text-right font-mono font-black">{!hasPerformance ? '—' : formatCurrency(calc.grossPay, currency)}<div className="text-[9px] text-slate-400 mt-1">{formatCurrency(cfg.nairaPerUnit, currency)} / unit</div></td>
              <td className="py-2 pr-3"><div className="w-36 space-y-0.5">{rewardRules.map((rule) => <label key={rule.id} className="flex gap-1 text-[9px] font-bold"><input type="checkbox" disabled={locked} checked={selectedRewardLabels.includes(rule.label)} onChange={(e) => { const labels = e.target.checked ? [...selectedRewardLabels, rule.label] : selectedRewardLabels.filter((label) => label !== rule.label); change('rewardLabel', labels.join(' | ')); }} />{rule.label} <span className="ml-auto text-emerald-700">+{formatCurrency(rule.fixedAmount, currency)}</span></label>)}{selectedRewardLabels.length === 0 && <div className="text-[9px] text-slate-400 font-bold">No bonus</div>}</div><div className="mt-1 text-right font-mono text-xs font-black text-emerald-700">+{formatCurrency(calc.rewardTotal, currency)}</div></td>
              <td className="py-2 pr-3"><input type="number" min="0" disabled={locked} value={draft.fixed} onChange={(e) => change('fixed', e.target.value)} placeholder={`${currency}0`} className="w-32 border-2 border-slate-300 p-2 text-right rounded-none" /><div className="mt-1 w-32 space-y-0.5">{penaltyRules.map((rule) => { const chosen = draft.fixedLabel.split(' | ').filter(Boolean); return <label key={rule.id} className="flex gap-1 text-[9px] font-bold"><input type="checkbox" disabled={locked} checked={chosen.includes(rule.label)} onChange={(e) => { const labels = e.target.checked ? [...chosen, rule.label] : chosen.filter((label) => label !== rule.label); const amount = penaltyRules.filter((item) => labels.includes(item.label)).reduce((sum, item) => sum + item.fixedFee, 0); setDrafts((all) => ({ ...all, [person.id]: { ...draft, fixedLabel: labels.join(' | '), fixed: String(amount || '') } })); }} />{rule.label}</label>; })}{!draft.fixedLabel && <div className="text-[9px] text-emerald-700 font-black">Excellent</div>}</div></td>
              <td className={`py-2 pr-3 text-right font-mono font-black ${calc.netPay < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{!hasPerformance ? '—' : formatCurrency(calc.netPay, currency)}</td>
              <td className="py-2 text-right">{locked ? <button onClick={() => { const reason = window.prompt('Reason for reopening this finalized assessment?'); if (reason) void reopenAssessment(existing.id, reason).catch(fail); }} className="text-[10px] font-black uppercase text-amber-700"><RotateCcw className="inline w-3 h-3" /> Reopen</button> : <StatusBadge tone={existing ? 'warn' : 'muted'}>{existing ? 'Draft' : cfg.nairaPerUnit > 0 ? 'Not entered' : 'Set wage rate'}</StatusBadge>}</td>
            </tr>;
          })}
        </DataTable>
        <div className="mt-4 flex justify-end gap-2"><ConsoleButton onClick={() => void saveAll()}>Save Drafts</ConsoleButton><ConsoleButton variant="primary" disabled={!rowsForDay.some((a) => a.status === 'draft')} onClick={() => void finalizeDay(day).then(() => flash(`${day} finalized`)).catch(fail)}><CheckCircle2 className="inline w-3 h-3 mr-1" />Finalize Day</ConsoleButton></div>
      </>}
    </Panel></>}

    {section === 'balances' && <Panel title="Wage Balances & Settlement" subtitle={`Earnings are for ${period.label}; current balance includes carried debt and payments. Positive is payable to staff.`} icon={Banknote}>
      <DataTable headers={['Staff', 'Period earnings', 'Current balance', 'Action']} alignRight={[1, 2, 3]}>
        {periodBalances.map(({ person, earned, balance }) => <tr key={person.id}>
          <td className="py-2.5 pr-3 font-bold">{person.name}<div className="text-[10px] text-slate-400">{roleLabel(person.role)}</div></td>
          <td className="py-2.5 pr-3 text-right font-mono">{formatCurrency(earned, currency)}</td>
          <td className={`py-2.5 pr-3 text-right font-mono font-black ${balance < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{formatCurrency(balance, currency)}</td>
          <td className="py-2.5 text-right"><ConsoleButton onClick={() => setSettle({ staffId: person.id, amount: '', note: '', kind: balance < 0 ? 'debt_forgiveness' : 'payment' })}>{balance < 0 ? 'Adjust debt' : 'Record payment'}</ConsoleButton></td>
        </tr>)}
      </DataTable>
      {settle && (() => { const person = staff.find((s) => s.id === settle.staffId)!; return <div className="mt-4 border-2 border-amber-300 bg-amber-50 p-3 grid grid-cols-1 sm:grid-cols-5 gap-2 items-end">
        <label className="text-[10px] font-black uppercase">Entry type<select value={settle.kind} onChange={(e) => setSettle({ ...settle, kind: e.target.value as typeof settle.kind })} className="mt-1 w-full border-2 border-slate-300 p-2 rounded-none normal-case"><option value="payment">Payment</option><option value="debt_forgiveness">Debt forgiveness</option><option value="manual_adjustment">Manual adjustment</option></select></label>
        <label className="text-[10px] font-black uppercase">Amount<input type="number" value={settle.amount} onChange={(e) => setSettle({ ...settle, amount: e.target.value })} className="mt-1 w-full border-2 border-slate-300 p-2 rounded-none normal-case" /></label>
        <label className="text-[10px] font-black uppercase sm:col-span-2">Mandatory reason<input value={settle.note} onChange={(e) => setSettle({ ...settle, note: e.target.value })} className="mt-1 w-full border-2 border-slate-300 p-2 rounded-none normal-case" /></label>
        <div className="flex gap-2"><ConsoleButton onClick={() => setSettle(null)}>Cancel</ConsoleButton><ConsoleButton variant="primary" disabled={!Number(settle.amount) || !settle.note.trim()} onClick={() => void addLedgerEntry(person, settle.kind, Number(settle.amount), settle.note, day).then(() => { setSettle(null); flash('Ledger entry recorded'); }).catch(fail)}>Record</ConsoleButton></div>
      </div>; })()}
    </Panel>}
  </div>;
};
