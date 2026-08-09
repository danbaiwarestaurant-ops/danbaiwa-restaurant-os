import React, { useState } from 'react';
import { useExpenseStore } from '../../store/useExpenseStore';
import { formatCurrency, formatTimestamp } from '../../utils/currency';
import { CheckCircle2, XCircle } from 'lucide-react';

interface ExpenseApprovalQueueProps {
  onRequirePin: (purpose: string, onVerified: () => void) => void;
}

export const ExpenseApprovalQueue: React.FC<ExpenseApprovalQueueProps> = ({ onRequirePin }) => {
  const { expenses, approveExpense, rejectExpense } = useExpenseStore();
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');

  const handleApprove = (id: string) => {
    onRequirePin(`Approve Expense #${id.slice(0, 8)}`, () => {
      approveExpense(id, 'Manager');
    });
  };

  const handleRejectSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectingId || !rejectionReason.trim()) return;

    onRequirePin(`Reject Expense #${rejectingId.slice(0, 8)}`, () => {
      rejectExpense(rejectingId, 'Manager', rejectionReason.trim());
      setRejectingId(null);
      setRejectionReason('');
    });
  };

  return (
    <div className="bg-white border-2 border-slate-300 p-5 shadow-xs rounded-none">
      <h3 className="text-xs font-black uppercase tracking-wider text-slate-800 mb-4 flex items-center justify-between">
        <span>Expense Manager Approval Queue</span>
        <span className="text-[11px] font-mono text-slate-500 font-normal">
          FR6-FR8 Approval Pipeline
        </span>
      </h3>

      {expenses.length === 0 ? (
        <div className="text-center py-8 text-slate-400 text-xs font-bold uppercase tracking-wider">
          No expenses logged yet
        </div>
      ) : (
        <div className="space-y-3">
          {expenses.map(e => {
            const isPending = e.status === 'pending';
            const isApproved = e.status === 'approved';
            const isRejected = e.status === 'rejected';

            return (
              <div
                key={e.id}
                className={`p-4 border-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-none ${
                  isPending
                    ? 'bg-amber-50/50 border-amber-300'
                    : isApproved
                    ? 'bg-emerald-50/50 border-emerald-300'
                    : 'bg-rose-50/50 border-rose-300'
                }`}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-slate-900">{e.description}</span>
                    <span className="text-[10px] font-mono uppercase px-2 py-0.5 border border-slate-300 bg-slate-200 font-bold text-slate-800 rounded-none">
                      {e.category}
                    </span>
                    <span
                      className={`text-[10px] font-bold uppercase px-2 py-0.5 border rounded-none ${
                        isPending
                          ? 'bg-amber-200 border-amber-300 text-amber-900'
                          : isApproved
                          ? 'bg-emerald-200 border-emerald-300 text-emerald-900'
                          : 'bg-rose-200 border-rose-300 text-rose-900'
                      }`}
                    >
                      {e.status}
                    </span>
                  </div>

                  <div className="text-xs text-slate-500 mt-1">
                    Logged by <span className="font-semibold text-slate-700">{e.cashierName}</span> at{' '}
                    {formatTimestamp(e.loggedAt)}
                  </div>

                  {isRejected && e.rejectionReason && (
                    <div className="text-xs text-rose-700 mt-1 font-semibold">
                      Rejection Reason: {e.rejectionReason}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <div className="font-mono font-black text-lg text-slate-900">
                    {formatCurrency(e.amount)}
                  </div>

                  {isPending && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleApprove(e.id)}
                        className="p-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center gap-1 shadow-xs rounded-none"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Approve</span>
                      </button>
                      <button
                        onClick={() => setRejectingId(e.id)}
                        className="p-1.5 bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs flex items-center gap-1 shadow-xs rounded-none"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        <span>Reject</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Reject Reason Prompt Modal */}
      {rejectingId && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white border-2 border-slate-900 w-full max-w-sm p-5 rounded-none shadow-2xl">
            <h4 className="font-black text-sm uppercase text-slate-900 mb-2">
              Mandatory Rejection Reason
            </h4>
            <form onSubmit={handleRejectSubmit} className="space-y-3">
              <textarea
                value={rejectionReason}
                onChange={e => setRejectionReason(e.target.value)}
                placeholder="State why this expense was rejected..."
                className="w-full p-2.5 border-2 border-slate-300 text-xs text-slate-800 rounded-none"
                rows={3}
                required
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRejectingId(null)}
                  className="px-3 py-1.5 text-xs font-bold uppercase border border-slate-300 rounded-none"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!rejectionReason.trim()}
                  className="px-3 py-1.5 text-xs font-black uppercase bg-rose-600 text-white shadow-xs rounded-none"
                >
                  Submit Rejection
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
