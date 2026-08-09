import React, { useState } from 'react';
import { useTicketStore } from '../../store/useTicketStore';
import { useDeviceStore } from '../../store/useDeviceStore';
import { useShiftStore } from '../../store/useShiftStore';
import { useAuthStore } from '../../store/useAuthStore';
import { Printer } from 'lucide-react';

interface CustomAmountInputProps {
  onTicketCreated: (msg: string) => void;
  onError: (msg: string) => void;
}

export const CustomAmountInput: React.FC<CustomAmountInputProps> = ({ onTicketCreated, onError }) => {
  const [customVal, setCustomVal] = useState('');
  const { createAndPrintTicket } = useTicketStore();
  const { config } = useDeviceStore();
  const { currentShift } = useShiftStore();
  const { activeUser } = useAuthStore();

  const handlePrint = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeUser) {
      onError('Cashier account has to be created and logged in first before printing tickets!');
      return;
    }

    if (!currentShift) {
      onError('Active shift must be opened by Cashier before printing tickets!');
      return;
    }

    const amount = parseFloat(customVal);
    if (!amount || amount <= 0) {
      onError('Please enter a valid ticket amount');
      return;
    }

    const res = await createAndPrintTicket(amount, activeUser.id);
    if (res.success) {
      onTicketCreated(res.message);
      setCustomVal('');
    } else {
      onError(res.message);
    }
  };

  return (
    <div className="bg-white border-2 border-slate-300 p-5 shadow-xs rounded-none">
      <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-2">
        Custom Amount Entry ({config.currencySymbol || '₦'})
      </label>

      <form onSubmit={handlePrint} className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500 font-bold font-mono text-lg">
            {config.currencySymbol || '₦'}
          </div>
          <input
            type="number"
            value={customVal}
            onChange={e => setCustomVal(e.target.value)}
            placeholder="Enter custom amount"
            min="1"
            step="1"
            className="w-full pl-9 pr-4 py-3 border-2 border-slate-300 rounded-none text-lg font-bold font-mono text-slate-900 bg-slate-50 focus:bg-white focus:border-amber-500 focus:outline-none transition-colors"
          />
        </div>

        <button
          type="submit"
          disabled={!customVal || parseFloat(customVal) <= 0}
          className="px-6 py-3 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-black uppercase text-sm tracking-wider border-2 border-amber-600 shadow-xs flex items-center justify-center gap-2 transition active:scale-95 whitespace-nowrap rounded-none"
        >
          <Printer className="w-4 h-4" />
          <span>Print Custom Ticket</span>
        </button>
      </form>
    </div>
  );
};
