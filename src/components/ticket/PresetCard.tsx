import React from 'react';
import { formatCurrency } from '../../utils/currency';

interface PresetCardProps {
  amount: number;
  hotkey?: string;
  currencySymbol?: string;
  isFlashing?: boolean;
  /** The next sale is armed as transfer/POS — the card says so rather than printing a surprise. */
  isTransfer?: boolean;
  onClick: () => void;
}

export const PresetCard: React.FC<PresetCardProps> = React.memo(({
  amount,
  hotkey,
  currencySymbol = '₦',
  isFlashing,
  isTransfer,
  onClick,
}) => {
  return (
    <button
      onClick={onClick}
      className={`ticket-stub group relative bg-white border-2 py-7 px-4 rounded-none flex flex-col items-center justify-center transition-all duration-150 active:scale-95 shadow-xs hover:shadow-md cursor-pointer select-none overflow-hidden ${
        isTransfer ? 'border-sky-500 hover:border-sky-600' : 'border-slate-300 hover:border-amber-500'
      } ${isFlashing ? 'card-flash' : ''}`}
    >
      {/* Key Badge in top-left */}
      {hotkey && (
        <div className="absolute top-2 left-2 w-6 h-6 bg-amber-100 border border-amber-400 text-amber-900 font-black text-xs flex items-center justify-center uppercase rounded-none">
          {hotkey}
        </div>
      )}

      {/* Main Amount */}
      <div
        className={`text-3xl font-black font-mono tracking-tight transition-colors ${
          isTransfer ? 'text-sky-700' : 'text-slate-900 group-hover:text-amber-600'
        }`}
      >
        {formatCurrency(amount, currencySymbol)}
      </div>

      {/* Action Subtitle — replaced by the tender while one is armed, since which key to
          press matters less at that moment than where the money is about to be recorded. */}
      <div
        className={`text-[11px] font-bold uppercase tracking-wider mt-1 ${
          isTransfer ? 'text-sky-700' : 'text-slate-500'
        }`}
      >
        {isTransfer ? 'Transfer / POS' : hotkey ? `Key: ${hotkey.toUpperCase()}` : 'Tap to Print'}
      </div>
    </button>
  );
});
