import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, UtensilsCrossed, X } from 'lucide-react';
import { useDeviceStore } from '../../store/useDeviceStore';
import { useTicketStore } from '../../store/useTicketStore';
import { useShiftStore } from '../../store/useShiftStore';
import { useAuthStore } from '../../store/useAuthStore';
import { dbService } from '../../services/db/IndexedDbService';
import { Ticket } from '../../types/ticket';
import { businessDayKey } from '../../utils/shiftDay';
import { roleLabel } from '../../utils/roles';
import { formatCurrency } from '../../utils/currency';
import { staffMealWageDeduction, staffFoodCount } from '../../utils/staffMeals';

interface Props { isOpen: boolean; onClose: () => void; onSuccess: (msg: string) => void; onError: (msg: string) => void }
const FALLBACK_OPTIONS = [
  { id: 'food', name: 'Food', wageCharge: 500, isFree: true },
  { id: 'meat', name: 'Meat', wageCharge: 500, isFree: false },
  { id: 'fish', name: 'Fish', wageCharge: 500, isFree: false },
  { id: 'egg', name: 'Egg', wageCharge: 200, isFree: false },
];

export const StaffMealModal: React.FC<Props> = ({ isOpen, onClose, onSuccess, onError }) => {
  const { config } = useDeviceStore();
  const { createAndPrintTicket, tickets } = useTicketStore();
  const { currentShift } = useShiftStore();
  const { users, activeUser } = useAuthStore();
  const [staffId, setStaffId] = useState('');
  const [mealTickets, setMealTickets] = useState<Ticket[]>([]);
  const [countReady, setCountReady] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setCountReady(false);
    dbService.getTickets().then(rows => { if (!cancelled) { setMealTickets(rows); setCountReady(true); } }).catch(() => { if (!cancelled) onError('Could not load staff meal allowances. Try reopening the form.'); });
    return () => { cancelled = true; };
  }, [isOpen, tickets]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isIssuing, setIsIssuing] = useState(false);
  const options = config.staffMealOptions?.length ? config.staffMealOptions : FALLBACK_OPTIONS;
  const roster = useMemo(() => users.filter((u) => u.status === 'active').sort((a, b) => a.name.localeCompare(b.name)), [users]);
  const selected = roster.find((u) => u.id === staffId);
  const selectedOptions = options.filter((o) => selectedIds.includes(o.id));
  const today = businessDayKey(new Date());
  const baseMealsToday = staffId ? staffFoodCount(mealTickets, staffId, today) : 0;
  const freeLimit = selected?.dailyFoodCountLimit ?? 1;
  const allowanceExceeded = selectedOptions.some((o) => o.isFree) && baseMealsToday >= freeLimit;
  const deduction = staffMealWageDeduction(selectedOptions, baseMealsToday, freeLimit);
  const menuValue = selectedOptions.reduce((sum, option) => sum + option.wageCharge, 0);
  if (!isOpen) return null;

  const close = () => { setStaffId(''); setSelectedIds([]); onClose(); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !selectedOptions.length || isIssuing || !countReady) return;
    if (!activeUser) return onError('Sign in before issuing a staff meal.');
    if (!currentShift) return onError('Open a shift before issuing a staff meal.');
    setIsIssuing(true);
    try {
      const result = await createAndPrintTicket(menuValue, activeUser.id, 'staff', { staffId: selected.id, staffName: selected.name, description: selectedOptions.map((o) => o.name).join(', '), options: selectedOptions, wageDeduction: deduction });

      if (!result.success) return onError(result.message);
      const actualDeduction = result.ticket?.staffMealWageDeduction ?? deduction;
      onSuccess(`${result.message}${actualDeduction ? ` · ${formatCurrency(actualDeduction, config.currencySymbol || '₦')} deducted from wages` : ' · within free allowance'}`);
      close();
    } catch (err) { onError(err instanceof Error ? err.message : 'Could not issue staff meal.'); }
    finally { setIsIssuing(false); }
  };

  return <div className="fixed inset-0 bg-slate-900/60 z-50 flex items-center justify-center p-4"><div className="bg-white border-2 border-slate-900 w-full max-w-md shadow-2xl rounded-none">
    <div className="bg-slate-900 text-white px-5 py-4 flex justify-between"><div className="flex gap-2 font-black uppercase text-amber-400"><UtensilsCrossed className="w-4 h-4" />Staff Meal</div><button onClick={close}><X className="w-5 h-5" /></button></div>
    <form onSubmit={submit} className="p-5 space-y-4">
      <label className="block text-xs font-black uppercase">Employee<select required value={staffId} onChange={(e) => setStaffId(e.target.value)} className="mt-1 w-full p-3 border-2 border-slate-300 rounded-none bg-white normal-case"><option value="">Select employee…</option>{roster.map((u) => <option key={u.id} value={u.id}>{u.name} ({roleLabel(u.role)})</option>)}</select></label>
      {selected && <div className="text-[11px] font-bold bg-slate-50 border border-slate-300 p-2">{countReady ? <>Food issued today: {baseMealsToday} / {freeLimit} free meals. Remaining: {Math.max(0, freeLimit - baseMealsToday)}</> : 'Loading allowance...'}</div>}
      <fieldset><legend className="text-xs font-black uppercase mb-2">Select meal items</legend><div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{options.map((option) => <label key={option.id} className={`border-2 p-3 flex items-center gap-2 cursor-pointer ${selectedIds.includes(option.id) ? 'border-amber-500 bg-amber-50' : 'border-slate-300'}`}><input type="checkbox" checked={selectedIds.includes(option.id)} onChange={() => setSelectedIds((ids) => ids.includes(option.id) ? ids.filter((id) => id !== option.id) : [...ids, option.id])} /><span className="font-black text-xs uppercase">{option.name}</span><span className="ml-auto text-[10px] font-mono">{option.isFree ? 'Allowance' : formatCurrency(option.wageCharge, config.currencySymbol || '₦')}</span></label>)}</div></fieldset>
      {allowanceExceeded && <div className="bg-amber-50 border-2 border-amber-400 p-3 flex gap-2 text-[11px] font-bold text-amber-900"><AlertTriangle className="w-4 h-4 shrink-0" />Daily free-food limit exceeded. This food selection is charged once against wages.</div>}
      <div className={`border-2 p-3 text-sm font-black ${deduction ? 'border-rose-300 bg-rose-50 text-rose-800' : 'border-emerald-300 bg-emerald-50 text-emerald-800'}`}>Wage deduction: {formatCurrency(deduction, config.currencySymbol || '₦')}</div>
      <div className="flex justify-end gap-2 border-t pt-3"><button type="button" onClick={close} className="px-4 py-2 border border-slate-300 text-xs font-black uppercase">Cancel</button><button type="submit" disabled={!selected || !selectedOptions.length || isIssuing || !countReady} className="px-4 py-2 bg-amber-500 disabled:opacity-50 text-white text-xs font-black uppercase border border-amber-600">{isIssuing ? 'Printing…' : 'Print Meal Ticket'}</button></div>
    </form>
  </div></div>;
};
