import { create } from 'zustand';
import { Period, PeriodUnit, periodFor, shiftPeriod, withUnit, isCurrentPeriod } from '../utils/period';

const UNIT_KEY = 'ticket_pos_console_period_unit';

function savedUnit(): PeriodUnit {
  try {
    const v = localStorage.getItem(UNIT_KEY);
    if (v === 'day' || v === 'week' || v === 'month' || v === 'year') return v;
  } catch {
    /* private mode — the default is fine */
  }
  return 'month';
}

interface ConsolePeriodState {
  period: Period;
  setUnit: (unit: PeriodUnit) => void;
  step: (delta: number) => void;
  goToCurrent: () => void;
  isCurrent: () => boolean;
}

/**
 * The reporting window shared by every console view.
 *
 * Shared rather than per-view so that moving back to July on Overview and then opening
 * Reports shows July there too — two tabs disagreeing about which month you are reading is
 * how a manager ends up comparing the wrong numbers.
 *
 * Only the *unit* is persisted, never the anchor: a preference for monthly reporting should
 * survive a reload, but reopening the console in October and landing silently on August —
 * with nothing on screen obviously wrong — should not be possible.
 */
export const useConsolePeriodStore = create<ConsolePeriodState>((set, get) => ({
  period: periodFor(savedUnit()),

  setUnit: (unit) => {
    try {
      localStorage.setItem(UNIT_KEY, unit);
    } catch {
      /* preference simply won't persist */
    }
    set({ period: withUnit(get().period, unit) });
  },

  step: (delta) => set({ period: shiftPeriod(get().period, delta) }),

  goToCurrent: () => set({ period: periodFor(get().period.unit) }),

  isCurrent: () => isCurrentPeriod(get().period),
}));
