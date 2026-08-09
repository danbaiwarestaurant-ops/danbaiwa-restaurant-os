import React from 'react';
import { formatCurrency } from '../../utils/currency';

interface PresetCardProps {
  amount: number;
  hotkey?: string;
  currencySymbol?: string;
  isFlashing?: boolean;
  onClick: () => void;
}

export const PresetCard: React.FC<PresetCardProps> = React.memo(({
  amount,
  hotkey,
  currencySymbol = '₦',
  isFlashing,
  onClick,
}) => {
  return (
    <button
      onClick={onClick}
      className={`ticket-stub group relative bg-white border-2 border-slate-300 hover:border-amber-500 py-7 px-4 rounded-none flex flex-col items-center justify-center transition-all duration-150 active:scale-95 shadow-xs hover:shadow-md cursor-pointer select-none overflow-hidden ${
        isFlashing ? 'card-flash' : ''
      }`}
    >
      {/* Key Badge in top-left */}
      {hotkey && (
        <div className="absolute top-2 left-2 w-6 h-6 bg-amber-100 border border-amber-400 text-amber-900 font-black text-xs flex items-center justify-center uppercase rounded-none">
          {hotkey}
        </div>
      )}

      {/* Main Amount */}
      <div className="text-3xl font-black font-mono text-slate-900 tracking-tight group-hover:text-amber-600 transition-colors">
        {formatCurrency(amount, currencySymbol)}
      </div>

      {/* Action Subtitle */}
      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mt-1">
        {hotkey ? `Key: ${hotkey.toUpperCase()}` : 'Tap to Print'}
      </div>
    </button>
  );
});
