import React, { useEffect } from 'react';
import { PresetCard } from './PresetCard';
import { useDeviceStore } from '../../store/useDeviceStore';
import { useTicketStore } from '../../store/useTicketStore';
import { useShiftStore } from '../../store/useShiftStore';
import { useAuthStore } from '../../store/useAuthStore';

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

  const presets = config.presetAmounts || [200, 300, 400, 500, 1000];

  // Map hotkeys to amounts
  const keyToAmountMap: Record<string, number> = {};
  presets.forEach((amt, i) => {
    if (HOTKEYS[i]) {
      keyToAmountMap[HOTKEYS[i]] = amt;
    }
  });

  const handlePrintRequest = async (amount: number) => {
    if (!activeUser) {
      if (onError) onError('Cashier account has to be created and logged in first before printing tickets!');
      return;
    }

    if (!currentShift) {
      if (onError) onError('Active shift must be opened by Cashier before printing tickets!');
      return;
    }

    const res = await createAndPrintTicket(amount, activeUser.id);
    if (res.success) {
      onTicketCreated(res.message);
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
        e.preventDefault();
        const amount = keyToAmountMap[key];
        await handlePrintRequest(amount);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [keyToAmountMap, activeUser, currentShift]);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">
          Quick Amount Presets
        </h3>
        <span className="text-[11px] text-slate-600 font-mono">
          Press hotkeys [A, S, D...] to issue tickets
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {presets.map((amt, idx) => (
          <PresetCard
            key={`${amt}-${idx}`}
            amount={amt}
            hotkey={HOTKEYS[idx] ? HOTKEYS[idx].toUpperCase() : undefined}
            isFlashing={activeFlashingAmount === amt}
            onClick={() => handlePrintRequest(amt)}
          />
        ))}
      </div>
    </div>
  );
};
