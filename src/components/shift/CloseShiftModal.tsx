import React, { useState } from 'react';
import { Lock, X, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useShiftStore } from '../../store/useShiftStore';
import { useTicketStore } from '../../store/useTicketStore';
import { useExpenseStore } from '../../store/useExpenseStore';
import { formatCurrency } from '../../utils/currency';
import { calculateShiftReconciliation } from '../../utils/reconciliation';
import { shiftTickets, shiftExpenses, summariseTickets, sumApprovedExpenses } from '../../utils/analytics';

interface CloseShiftModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (msg: string) => void;
}

export const CloseShiftModal: React.FC<CloseShiftModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const { currentShift, closeShift } = useShiftStore();
  const { tickets } = useTicketStore();
  const { expenses } = useExpenseStore();
  const [countedCash, setCountedCash] = useState('');
  const [notes, setNotes] = useState('');

  if (!isOpen || !currentShift) return null;

  // Live shift totals, bounded to *this* shift: the cashier's own tickets, taken since the
  // shift opened, and the expenses charged to it. Summing the whole store instead — which
  // is what this did — showed the cashier an expected-cash figure covering every ticket
  // the till had ever issued, so the drawer could never balance.
  const totalCashTickets = summariseTickets(shiftTickets(tickets, currentShift)).revenue;
  const approvedExpenses = sumApprovedExpenses(shiftExpenses(expenses, currentShift));

  const countedNum = parseFloat(countedCash) || 0;
  const recon = calculateShiftReconciliation(
    currentShift.openingFloat,
    totalCashTickets,
    approvedExpenses,
    countedNum
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await closeShift(countedNum, notes);
    onSuccess(
      `Shift closed! Expected: ${formatCurrency(recon.expectedCash)}, Counted: ${formatCurrency(recon.countedCash)}, Variance: ${formatCurrency(recon.variance)}`
    );
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white border-2 border-slate-900 w-full max-w-md overflow-hidden shadow-2xl rounded-none">
        <div className="bg-slate-900 text-white px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-sm text-amber-400">
            <Lock className="w-4 h-4" />
            <span>Close Shift & Reconcile Cash</span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Summary Rollup Box */}
          <div className="bg-slate-50 border-2 border-slate-200 p-4 space-y-2 text-xs rounded-none">
            {/* Shifts no longer record an opening float, so this line would read ₦0 on
                every new shift. Still shown for older shifts that did record one. */}
            {recon.openingFloat > 0 && (
              <div className="flex justify-between text-slate-600 font-medium">
                <span>Opening Cash Float:</span>
                <span className="font-mono font-bold">{formatCurrency(recon.openingFloat)}</span>
              </div>
            )}
            <div className="flex justify-between text-slate-600 font-medium">
              <span>(+) Total Cash Ticket Sales:</span>
              <span className="font-mono font-bold text-emerald-600">+{formatCurrency(recon.totalCashTickets)}</span>
            </div>
            <div className="flex justify-between text-slate-600 font-medium">
              <span>(−) Approved Shift Expenses:</span>
              <span className="font-mono font-bold text-rose-600">−{formatCurrency(recon.totalApprovedExpenses)}</span>
            </div>
            <div className="border-t border-slate-300 pt-2 flex justify-between font-bold text-slate-900 text-sm">
              <span>Expected Cash Total:</span>
              <span className="font-mono text-amber-600">{formatCurrency(recon.expectedCash)}</span>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
              Physical Cash Count (Physical Drawer Count)
            </label>
            <input
              type="number"
              value={countedCash}
              onChange={e => setCountedCash(e.target.value)}
              placeholder="Enter physical cash counted"
              min="0"
              step="1"
              className="w-full p-3 border-2 border-slate-300 rounded-none font-mono font-black text-xl text-slate-900 focus:border-amber-500 focus:outline-none"
              required
            />
          </div>

          {/* Variance Flag Alert */}
          {countedCash && (
            <div className={`p-3 border-2 flex items-center justify-between font-bold text-xs rounded-none ${
              recon.isVarianceFlagged
                ? recon.variance < 0
                  ? 'bg-rose-50 border-rose-400 text-rose-900'
                  : 'bg-amber-50 border-amber-400 text-amber-900'
                : 'bg-emerald-50 border-emerald-400 text-emerald-950'
            }`}>
              <div className="flex items-center gap-2">
                {recon.isVarianceFlagged ? (
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                )}
                <span>Variance:</span>
              </div>
              <span className="font-mono font-black text-sm">
                {recon.variance > 0 ? `+${formatCurrency(recon.variance)}` : formatCurrency(recon.variance)}
              </span>
            </div>
          )}

          <div>
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
              Closing Shift Notes (Optional)
            </label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Variance reason, cash bag number"
              className="w-full p-2.5 border-2 border-slate-300 rounded-none text-xs text-slate-800 focus:border-amber-500 focus:outline-none"
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
              disabled={!countedCash}
              className="px-4 py-2 text-xs font-black uppercase bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-none border border-amber-600 shadow-xs"
            >
              Finalize Shift Close
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
