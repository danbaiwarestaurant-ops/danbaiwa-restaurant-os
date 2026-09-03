import React, { useState } from 'react';
import { useTicketStore } from '../../store/useTicketStore';
import { useDeviceStore } from '../../store/useDeviceStore';
import { useShiftStore } from '../../store/useShiftStore';
import { useAuthStore } from '../../store/useAuthStore';
import { TicketTender } from '../../types/ticket';
import { Banknote, Smartphone } from 'lucide-react';

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

  /**
   * Two explicit buttons rather than the grid's Ctrl modifier.
   *
   * The hotkey listener switches itself off while a field has focus — otherwise typing
   * "1000" would fire four tickets — so a keyboard modifier cannot reach this path at
   * all. Enter still prints cash, keeping the fast path a type-and-Enter; a transfer is
   * one deliberate tap, which is fine because the cashier's hands are already off the
   * keyboard and on the POS terminal or their phone at that moment.
   */
  const handlePrint = async (e: React.FormEvent, tender: TicketTender = 'cash') => {
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

    const res = await createAndPrintTicket(amount, activeUser.id, tender);
    if (res.success) {
      onTicketCreated(
        tender === 'transfer' ? `${res.message} — TRANSFER / POS (not in drawer)` : res.message
      );
      setCustomVal('');
    } else {
      onError(res.message);
    }
  };

  const disabled = !customVal || parseFloat(customVal) <= 0;

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

        {/* Cash keeps the primary treatment and the Enter key. Transfer sits beside it,
            deliberately quieter — it is the exception, and it should look like one. */}
        <button
          type="submit"
          disabled={disabled}
          className="px-6 py-3 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-black uppercase text-sm tracking-wider border-2 border-amber-600 shadow-xs flex items-center justify-center gap-2 transition active:scale-95 whitespace-nowrap rounded-none"
        >
          <Banknote className="w-4 h-4" />
          <span>Print Cash</span>
        </button>

        <button
          type="button"
          onClick={(e) => handlePrint(e, 'transfer')}
          disabled={disabled}
          className="px-6 py-3 bg-white hover:bg-sky-50 disabled:opacity-50 text-sky-800 font-black uppercase text-sm tracking-wider border-2 border-sky-600 shadow-xs flex items-center justify-center gap-2 transition active:scale-95 whitespace-nowrap rounded-none"
        >
          <Smartphone className="w-4 h-4" />
          <span>Print Transfer</span>
        </button>
      </form>
    </div>
  );
};
