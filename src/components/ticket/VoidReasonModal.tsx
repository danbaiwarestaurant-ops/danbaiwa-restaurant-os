import React, { useState } from 'react';
import { Ban, X } from 'lucide-react';

interface VoidReasonModalProps {
  isOpen: boolean;
  ticketId: string | null;
  onClose: () => void;
  onConfirmVoid: (reason: string) => void;
}

export const VoidReasonModal: React.FC<VoidReasonModalProps> = ({
  isOpen,
  ticketId,
  onClose,
  onConfirmVoid,
}) => {
  const [reason, setReason] = useState('');

  if (!isOpen || !ticketId) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return;
    onConfirmVoid(reason.trim());
    setReason('');
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white border-2 border-slate-900 w-full max-w-sm overflow-hidden shadow-2xl rounded-none">
        <div className="bg-rose-600 text-white px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-sm">
            <Ban className="w-4 h-4" />
            <span>Void Ticket #{ticketId}</span>
          </div>
          <button onClick={onClose} className="text-rose-200 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6">
          <p className="text-xs text-slate-600 font-semibold mb-3">
            Voiding a ticket creates an immutable audit record. Manager PIN verification is required.
          </p>

          <div className="mb-4">
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
              Mandatory Void Reason
            </label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. Cashier mistake, Customer cancelled, Duplicate print"
              className="w-full p-3 border-2 border-slate-300 rounded-none focus:border-rose-500 focus:outline-none text-sm text-slate-800"
              rows={3}
              required
            />
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-bold uppercase border border-slate-300 rounded-none text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!reason.trim()}
              className="px-4 py-2 text-xs font-black uppercase bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white rounded-none shadow-xs"
            >
              Confirm Void
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
