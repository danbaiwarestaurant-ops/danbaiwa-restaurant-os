import React, { useEffect, useState } from 'react';
import { PresetCard } from './PresetCard';
import { useDeviceStore } from '../../store/useDeviceStore';
import { useTicketStore } from '../../store/useTicketStore';
import { useShiftStore } from '../../store/useShiftStore';
import { useAuthStore } from '../../store/useAuthStore';
import { TicketTender } from '../../types/ticket';
import { Banknote, Smartphone } from 'lucide-react';

const HOTKEYS = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'];

interface PresetCardGridProps {
  onTicketCreated: (msg: string) => void;
  onError?: (msg: string) => void;
}

export const PresetCardGrid: React.FC<PresetCardGridProps> = ({ onTicketCreated, onError }) => {
  const { config } = useDeviceStore();
  const { createAndPrintTicket, activeFlashingAmount } = useTicketStore();
  const { currentShift } = useShiftStore();
  const { activeUser } = useAuthStore();

  /**
   * The tender the *next* ticket goes out as, and only the next one.
   *
   * Deliberately one-shot rather than a mode that stays switched on. A sticky
   * transfer mode is quicker during a run of transfers, but one forgotten toggle
   * mislabels every sale after it and nobody finds out until the drawer is counted.
   * Cash is the overwhelming majority of tickets, so cash is what the till returns
   * to on its own after every sale.
   */
  const [armedTender, setArmedTender] = useState<TicketTender>('cash');

  const presets = config.presetAmounts || [200, 300, 400, 500, 1000];

  // Map hotkeys to amounts
  const keyToAmountMap: Record<string, number> = {};
  presets.forEach((amt, i) => {
    if (HOTKEYS[i]) {
      keyToAmountMap[HOTKEYS[i]] = amt;
    }
  });

  const handlePrintRequest = async (amount: number, tender: TicketTender) => {
    if (!activeUser) {
      if (onError) onError('Cashier account has to be created and logged in first before printing tickets!');
      return;
    }

    if (!currentShift) {
      if (onError) onError('Active shift must be opened by Cashier before printing tickets!');
      return;
    }

    const res = await createAndPrintTicket(amount, activeUser.id, tender);
    // Back to cash whatever happened. Leaving it armed after a failed print is the same
    // trap as a sticky mode, just harder to notice.
    setArmedTender('cash');
    if (res.success) {
      onTicketCreated(
        tender === 'transfer' ? `${res.message} — TRANSFER / POS (not in drawer)` : res.message
      );
    } else if (onError) {
      onError(res.message);
    }
  };

  // Global keydown listener
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || (activeEl as HTMLElement).isContentEditable);
      if (isTyping) return;

      const key = e.key.toLowerCase();
      if (keyToAmountMap.hasOwnProperty(key)) {
        // Ctrl (or Cmd) held turns the same key into a transfer/POS sale, so the cash
        // path stays exactly one keystroke and nothing was added to the busy case.
        // Alt is excluded: on Windows Ctrl+Alt is AltGr, which is a character key on
        // several layouts a till may be running.
        if (e.altKey) return;
        const tender: TicketTender = e.ctrlKey || e.metaKey ? 'transfer' : armedTender;
        e.preventDefault();
        await handlePrintRequest(keyToAmountMap[key], tender);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [keyToAmountMap, activeUser, currentShift, armedTender]);

  const transferArmed = armedTender === 'transfer';

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">
          Quick Amount Presets
        </h3>
        <span className="text-[11px] text-slate-600 font-mono">
          [A, S, D...] cash · [CTRL] + key transfer
        </span>
      </div>

      {/* One-shot tender switch, for touch. Sits directly above the amounts it applies to
          so it cannot be mistaken for a setting that belongs to the whole till. */}
      <div className="flex items-stretch gap-0 mb-3 border-2 border-slate-300 rounded-none overflow-hidden w-full sm:w-auto sm:inline-flex">
        <button
          type="button"
          onClick={() => setArmedTender('cash')}
          className={`flex-1 sm:flex-none px-4 py-2 text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 transition-colors ${
            !transferArmed ? 'bg-emerald-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'
          }`}
        >
          <Banknote className="w-4 h-4" />
          <span>Cash</span>
        </button>
        <button
          type="button"
          onClick={() => setArmedTender('transfer')}
          className={`flex-1 sm:flex-none px-4 py-2 text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 border-l-2 border-slate-300 transition-colors ${
            transferArmed ? 'bg-sky-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'
          }`}
        >
          <Smartphone className="w-4 h-4" />
          <span>Transfer / POS</span>
        </button>
      </div>

      {/* Loud while armed: the whole point of one-shot is that the cashier can see, without
          looking for it, that this next ticket is not going in the drawer. */}
      {transferArmed && (
        <div className="mb-3 bg-sky-50 border-2 border-sky-500 px-4 py-2 text-xs font-black uppercase tracking-wider text-sky-900 rounded-none">
          Next ticket is Transfer / POS — reverts to cash after it prints
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {presets.map((amt, idx) => (
          <PresetCard
            key={`${amt}-${idx}`}
            amount={amt}
            hotkey={HOTKEYS[idx] ? HOTKEYS[idx].toUpperCase() : undefined}
            isFlashing={activeFlashingAmount === amt}
            isTransfer={transferArmed}
            onClick={() => handlePrintRequest(amt, armedTender)}
          />
        ))}
      </div>
    </div>
  );
};
