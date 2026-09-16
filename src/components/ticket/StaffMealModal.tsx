import React, { useMemo, useState } from 'react';
import { UtensilsCrossed, X, AlertTriangle } from 'lucide-react';
import { useDeviceStore } from '../../store/useDeviceStore';
import { useTicketStore } from '../../store/useTicketStore';
import { useShiftStore } from '../../store/useShiftStore';
import { useAuthStore } from '../../store/useAuthStore';
import { formatCurrency } from '../../utils/currency';
import { isStaffMeal } from '../../utils/analytics';
import { businessDayKey } from '../../utils/shiftDay';
import { roleLabel } from '../../utils/roles';

interface StaffMealModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

const MEAL_DESCRIPTION_PRESETS = ['Meat', 'Fish', 'Egg'] as const;

/**
 * Issuing a meal to an employee.
 *
 * Deliberately its own screen rather than a third setting on the tender switch beside
 * cash and transfer. That switch is one-shot and one tap, which is exactly right for a
 * queue at the counter — and exactly wrong here, because a staff meal needs a name
 * attached, and a name cannot be armed in advance without becoming the kind of sticky
 * mode that mislabels the ticket after it. Two deliberate taps is the right cost for
 * something that is not a sale.
 */
export const StaffMealModal: React.FC<StaffMealModalProps> = ({ isOpen, onClose, onSuccess, onError }) => {
  const { config } = useDeviceStore();
  const { createAndPrintTicket, tickets } = useTicketStore();
  const { currentShift } = useShiftStore();
  const { users, activeUser } = useAuthStore();

  const [staffId, setStaffId] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [isIssuing, setIsIssuing] = useState(false);

  const presets = config.presetAmounts || [200, 300, 400, 500, 1000];
  const currency = config.currencySymbol || '₦';

  // Everyone on the roster, whatever they do — kitchen, store and floor alike. This is
  // the one place every role appears together, because eating is the one thing they all
  // do: a system that only fed cashiers would push every other meal off the record.
  // Admins included, since an owner eating their own food is the commonest staff meal
  // there is. Deactivated accounts are excluded: a meal for someone who no longer works
  // here is a mistake, not a case to support.
  const roster = useMemo(
    () => users.filter((u) => u.status === 'active').sort((a, b) => a.name.localeCompare(b.name)),
    [users]
  );

  /**
   * What each person has already had today, so the cashier sees it before adding another.
   *
   * Shown rather than enforced. A second meal on a double shift is legitimate, and a till
   * that refused it would simply be worked around by ringing up a ₦0 sale — which is the
   * untracked giveaway this whole feature exists to replace.
   */
  const mealsToday = useMemo(() => {
    const today = businessDayKey(new Date());
    const counts: Record<string, number> = {};
    for (const t of tickets) {
      if (!isStaffMeal(t) || t.status === 'void' || !t.staffId) continue;
      if (businessDayKey(t.createdAt) !== today) continue;
      counts[t.staffId] = (counts[t.staffId] || 0) + 1;
    }
    return counts;
  }, [tickets]);

  if (!isOpen) return null;

  const selected = roster.find((u) => u.id === staffId);
  const amountNum = parseFloat(amount) || 0;
  const cleanDescription = description.trim();
  const alreadyHad = staffId ? mealsToday[staffId] || 0 : 0;

  const reset = () => {
    setStaffId('');
    setDescription('');
    setAmount('');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !cleanDescription || amountNum <= 0 || isIssuing) return;

    if (!activeUser) {
      onError('Sign in before issuing a staff meal.');
      return;
    }
    // The same gate a sale passes: a ticket outside a shift belongs to nobody's
    // reconciliation, and a staff meal is still a plate to account for at close-out.
    if (!currentShift) {
      onError('Open a shift before issuing a staff meal.');
      return;
    }

    setIsIssuing(true);
    const res = await createAndPrintTicket(amountNum, activeUser.id, 'staff', {
      staffId: selected.id,
      staffName: selected.name,
      description: cleanDescription,
    });
    setIsIssuing(false);

    if (!res.success) {
      onError(res.message);
      return;
    }
    onSuccess(res.message);
    reset();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white border-2 border-slate-900 w-full max-w-md overflow-hidden shadow-2xl rounded-none">
        <div className="bg-slate-900 text-white px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-sm text-amber-400">
            <UtensilsCrossed className="w-4 h-4" />
            <span>Staff Meal</span>
          </div>
          <button onClick={handleClose} className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <p className="text-[11px] text-slate-600 leading-snug font-medium">
            Prints a ticket the kitchen can honour, marked <span className="font-black">NOT FOR SALE</span>.
            It is not counted as a sale and never enters the drawer count — it is reported
            separately as a cost.
          </p>

          {roster.length === 0 ? (
            <div className="bg-amber-50 border-2 border-amber-400 p-3 text-[11px] font-bold text-amber-900 rounded-none">
              No active staff accounts to issue a meal to. Add them under Manager Mode → Staff.
            </div>
          ) : (
            <div>
              <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
                Who is this for?
              </label>
              <select
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
                required
                className="w-full p-3 border-2 border-slate-300 rounded-none text-sm font-bold text-slate-900 bg-white focus:border-amber-500 focus:outline-none"
              >
                <option value="">Select an employee…</option>
                {roster.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({roleLabel(u.role)})
                    {mealsToday[u.id] ? ` — ${mealsToday[u.id]} today` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {alreadyHad > 0 && (
            <div className="bg-amber-50 border-2 border-amber-400 p-3 flex items-start gap-2 rounded-none">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-[11px] font-bold text-amber-900 leading-snug">
                {selected?.name} has already had {alreadyHad} meal{alreadyHad > 1 ? 's' : ''} today.
                Issue another only if it is meant.
              </p>
            </div>
          )}

          <div>
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
              Meal description
            </label>
            <div className="grid grid-cols-3 gap-2 mb-2">
              {MEAL_DESCRIPTION_PRESETS.map((meal) => (
                <button
                  key={meal}
                  type="button"
                  onClick={() => setDescription(meal)}
                  className={`px-2 py-2 text-xs font-black uppercase border-2 rounded-none transition ${
                    cleanDescription.toLowerCase() === meal.toLowerCase()
                      ? 'bg-amber-500 border-amber-600 text-white'
                      : 'bg-white border-slate-300 text-slate-700 hover:bg-amber-50'
                  }`}
                >
                  {meal}
                </button>
              ))}
            </div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Jollof rice, chicken and salad"
              rows={2}
              maxLength={160}
              required
              className="w-full p-3 border-2 border-slate-300 rounded-none text-sm font-semibold text-slate-900 resize-none focus:border-amber-500 focus:outline-none"
            />
            <div className="mt-1 text-right text-[10px] font-medium text-slate-500">
              {description.length}/160
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
              Menu value
            </label>
            {/* The real price, not zero. What the kitchen gave away is the number an owner
                needs; a ₦0 staff meal records that something happened and nothing about
                what it cost. */}
            <div className="grid grid-cols-3 gap-2 mb-2">
              {presets.map((amt) => (
                <button
                  key={amt}
                  type="button"
                  onClick={() => setAmount(String(amt))}
                  className={`px-2 py-2 text-xs font-black border-2 rounded-none transition ${
                    amountNum === amt
                      ? 'bg-amber-500 border-amber-600 text-white'
                      : 'bg-white border-slate-300 text-slate-700 hover:bg-amber-50'
                  }`}
                >
                  {formatCurrency(amt, currency)}
                </button>
              ))}
            </div>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Or type the amount"
              min="1"
              step="1"
              required
              className="w-full p-3 border-2 border-slate-300 rounded-none font-mono font-black text-xl text-slate-900 focus:border-amber-500 focus:outline-none"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-2 text-xs font-bold uppercase border border-slate-300 rounded-none text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!selected || !cleanDescription || amountNum <= 0 || isIssuing}
              className="px-4 py-2 text-xs font-black uppercase bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-none border border-amber-600 shadow-xs"
            >
              {isIssuing ? 'Printing…' : 'Print Staff Meal'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
