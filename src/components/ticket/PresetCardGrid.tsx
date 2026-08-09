import React, { useEffect } from 'react';
import { PresetCard } from './PresetCard';
import { useDeviceStore } from '../../store/useDeviceStore';
import { useTicketStore } from '../../store/useTicketStore';

const HOTKEYS = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'];

interface PresetCardGridProps {
  onTicketCreated: (msg: string) => void;
}

export const PresetCardGrid: React.FC<PresetCardGridProps> = ({ onTicketCreated }) => {
  const { config } = useDeviceStore();
  const { createAndPrintTicket, activeFlashingAmount } = useTicketStore();

  const presets = config.presetAmounts || [200, 300, 400, 500, 1000];

  // Map hotkeys to amounts
  const keyToAmountMap: Record<string, number> = {};
  presets.forEach((amt, i) => {
    if (HOTKEYS[i]) {
      keyToAmountMap[HOTKEYS[i]] = amt;
    }
  });

  // Global keydown listener
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Ignore keydown if active focus is inside an input or textarea
      const activeEl = document.activeElement;
      const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || (activeEl as HTMLElement).isContentEditable);
      if (isTyping) return;

      const key = e.key.toLowerCase();
      if (keyToAmountMap.hasOwnProperty(key)) {
        e.preventDefault();
        const amount = keyToAmountMap[key];
        const res = await createAndPrintTicket(amount);
        if (res.success) {
          onTicketCreated(res.message);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [keyToAmountMap, createAndPrintTicket, onTicketCreated]);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-600">
          Quick Preset Tickets (Tap or Press Key)
        </span>
        <span className="text-[11px] font-mono text-slate-500">
          Home-row Hotkeys: A, S, D, F, G, H, J, K, L
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
        {presets.map((amount, i) => {
          const hotkey = HOTKEYS[i];
          return (
            <PresetCard
              key={i}
              amount={amount}
              hotkey={hotkey}
              currencySymbol={config.currencySymbol}
              isFlashing={activeFlashingAmount === amount}
              onClick={async () => {
                const res = await createAndPrintTicket(amount);
                if (res.success) {
                  onTicketCreated(res.message);
                }
              }}
            />
          );
        })}
      </div>
    </div>
  );
};
