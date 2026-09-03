import React, { useState } from 'react';
import { DollarSign, X, Droplet, Flame, SprayCan, ShoppingBasket, MoreHorizontal } from 'lucide-react';
import { useExpenseStore } from '../../store/useExpenseStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useDeviceStore } from '../../store/useDeviceStore';
import { formatCurrency } from '../../utils/currency';

/**
 * What a shift actually pays cash out for, in the order it happens.
 *
 * The stored value is the plain word, which is what the console's history, its CSV export
 * and any future per-category rollup read — so these must not be renamed casually, or old
 * rows stop grouping with new ones. 'Other' is last and deliberately unglamorous: it is
 * the escape hatch, not a default.
 */
const CATEGORIES = [
  { value: 'Water', label: 'Water', Icon: Droplet },
  { value: 'Gas', label: 'Gas', Icon: Flame },
  { value: 'Detergent', label: 'Detergent', Icon: SprayCan },
  { value: 'Groceries', label: 'Groceries', Icon: ShoppingBasket },
  { value: 'Other', label: 'Other', Icon: MoreHorizontal },
] as const;

interface ExpenseLoggerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (msg: string) => void;
}

export const ExpenseLoggerModal: React.FC<ExpenseLoggerModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [amount, setAmount] = useState('');
  // Nothing preselected. The dropdown defaulted to "Supplies", so anything submitted
  // without touching it was filed under a category nobody had actually chosen.
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const { logExpense } = useExpenseStore();
  const { openPinModal } = useAuthStore();
  const { config } = useDeviceStore();

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (!amt || amt <= 0 || !category || !description.trim()) return;

    // The payout is recorded as approved the moment it is entered, so the PIN is what
    // stands in for a manager's signature: the cashier is putting their own name to money
    // taken out of their drawer. Nothing is written until it verifies.
    openPinModal(
      `Confirm ${config.currencySymbol || '₦'}${amt.toLocaleString()} paid out — ${category}`,
      async (verified) => {
        if (!verified) return;

        await logExpense(amt, category, description.trim());
        onSuccess(
          `Expense ${formatCurrency(amt, config.currencySymbol || '₦')} recorded against your shift — deducted from expected cash`
        );
        setAmount('');
        setCategory('');
        setDescription('');
        onClose();
      },
      'cashier'
    );
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white border-2 border-slate-900 w-full max-w-sm overflow-hidden shadow-2xl rounded-none">
        <div className="bg-slate-900 text-white px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-sm text-amber-400">
            <DollarSign className="w-4 h-4" />
            <span>Log Mid-Shift Expense</span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
              Expense Amount (₦)
            </label>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="e.g. 1500"
              min="1"
              step="1"
              className="w-full p-2.5 border-2 border-slate-300 rounded-none font-mono font-bold text-lg text-slate-900 focus:border-amber-500 focus:outline-none"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1.5">
              What Was It For
            </label>
            {/* Tiles rather than a dropdown: on a touch screen a select costs an open, a
                scroll and a pick for what is nearly always one of four things. These are
                one tap, and the chosen one is readable across the counter. */}
            <div className="grid grid-cols-3 gap-2">
              {CATEGORIES.map(({ value, label, Icon }) => {
                const active = category === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setCategory(value)}
                    className={`flex flex-col items-center justify-center gap-1 py-3 px-1 border-2 rounded-none transition-colors ${
                      active
                        ? 'bg-amber-500 border-amber-600 text-white'
                        : 'bg-white border-slate-300 text-slate-600 hover:border-amber-400 hover:bg-amber-50'
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                    <span className="text-[11px] font-black uppercase tracking-wide">{label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
              Description / Notes
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Detail reason for cash payout"
              className="w-full p-2.5 border-2 border-slate-300 rounded-none text-sm text-slate-800 focus:border-amber-500 focus:outline-none"
              rows={3}
              required
            />
          </div>

          {/* Says what confirming actually does. The payout counts against the drawer from
              the moment it is entered, so the cashier should not discover that at close-out. */}
          <p className="text-[11px] text-slate-500 font-semibold leading-snug bg-slate-50 border border-slate-200 px-3 py-2 rounded-none">
            Your PIN signs for this payout. It comes off your expected cash straight away —
            a manager can reverse it from the dashboard.
          </p>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-bold uppercase border border-slate-300 rounded-none text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!amount || !category || !description.trim()}
              className="px-4 py-2 text-xs font-black uppercase bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-none border border-amber-600 shadow-xs"
            >
              Confirm With PIN
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
