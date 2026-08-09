import React, { useState } from 'react';
import { DollarSign, X } from 'lucide-react';
import { useExpenseStore } from '../../store/useExpenseStore';

interface ExpenseLoggerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (msg: string) => void;
}

export const ExpenseLoggerModal: React.FC<ExpenseLoggerModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('Supplies');
  const [description, setDescription] = useState('');
  const { logExpense } = useExpenseStore();

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (!amt || amt <= 0 || !description.trim()) return;

    await logExpense(amt, category, description.trim());
    onSuccess(`Mid-shift expense ₦${amt.toLocaleString()} submitted for manager approval`);
    setAmount('');
    setDescription('');
    onClose();
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
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
              Category
            </label>
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              className="w-full p-2.5 border-2 border-slate-300 rounded-none font-semibold text-sm text-slate-800 focus:border-amber-500 focus:outline-none bg-white"
            >
              <option value="Supplies">Supplies & Cleaning</option>
              <option value="Maintenance">Equipment Repairs</option>
              <option value="Staff Refreshment">Staff Allowance</option>
              <option value="Vendor Cash Payment">Vendor Cash Outflow</option>
              <option value="Other">Other</option>
            </select>
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
              disabled={!amount || !description.trim()}
              className="px-4 py-2 text-xs font-black uppercase bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-none border border-amber-600 shadow-xs"
            >
              Submit Expense
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
