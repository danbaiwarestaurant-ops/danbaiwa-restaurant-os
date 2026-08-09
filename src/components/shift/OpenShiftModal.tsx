import React, { useState } from 'react';
import { Lock, X, Play } from 'lucide-react';
import { useShiftStore } from '../../store/useShiftStore';

interface OpenShiftModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (msg: string) => void;
}

export const OpenShiftModal: React.FC<OpenShiftModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [openingFloat, setOpeningFloat] = useState('5000');
  const [cashierName, setCashierName] = useState('Main Cashier');
  const { openShift } = useShiftStore();

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const float = parseFloat(openingFloat);
    if (isNaN(float) || float < 0) return;

    await openShift(float, cashierName);
    onSuccess(`Shift opened with declared cash float ₦${float.toLocaleString()}`);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white border-2 border-slate-900 w-full max-w-sm overflow-hidden shadow-2xl rounded-none">
        <div className="bg-emerald-700 text-white px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-sm">
            <Lock className="w-4 h-4" />
            <span>Open Cashier Shift</span>
          </div>
          <button onClick={onClose} className="text-emerald-200 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
              Cashier Name
            </label>
            <input
              type="text"
              value={cashierName}
              onChange={e => setCashierName(e.target.value)}
              className="w-full p-2.5 border-2 border-slate-300 rounded-none font-semibold text-slate-800 focus:border-emerald-500 focus:outline-none"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
              Opening Cash Float (₦)
            </label>
            <input
              type="number"
              value={openingFloat}
              onChange={e => setOpeningFloat(e.target.value)}
              min="0"
              step="100"
              className="w-full p-2.5 border-2 border-slate-300 rounded-none font-mono font-bold text-lg text-slate-900 focus:border-emerald-500 focus:outline-none"
              required
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-bold uppercase border border-slate-300 rounded-none text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex items-center gap-1 px-4 py-2 text-xs font-black uppercase bg-emerald-600 hover:bg-emerald-700 text-white rounded-none shadow-xs"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Start Shift</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
