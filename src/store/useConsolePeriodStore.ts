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
  weekStartsOn: number;
  businessDayStartHour: number;
  setUnit: (unit: PeriodUnit) => void;
  step: (delta: number) => void;
  goToCurrent: () => void;
  isCurrent: () => boolean;
  setWeekStartsOn: (day: number) => void;
  setCalendar: (weekStartsOn: number, businessDayStartHour: number) => void;
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
  weekStartsOn: 1,
  businessDayStartHour: 0,

  setUnit: (unit) => {
    try {
      localStorage.setItem(UNIT_KEY, unit);
    } catch {
      /* preference simply won't persist */
    }
    set({ period: withUnit(get().period, unit) });
  },

  step: (delta) => set({ period: shiftPeriod(get().period, delta) }),

  goToCurrent: () => set({ period: periodFor(get().period.unit, new Date(), get().weekStartsOn, get().businessDayStartHour) }),

  isCurrent: () => isCurrentPeriod(get().period),

  setWeekStartsOn: (day) => {
    get().setCalendar(day, get().businessDayStartHour);
  },

  setCalendar: (day, hour) => {
    const weekStartsOn = Number.isInteger(day) && day >= 0 && day <= 6 ? day : 1;
    const businessDayStartHour = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 6;
    if (weekStartsOn === get().weekStartsOn && businessDayStartHour === get().businessDayStartHour) return;
    const current = get().period;
    const anchor = isCurrentPeriod(current) ? new Date() : new Date(current.start);
    // Preserve a historical trading-date label when the boundary moves later.
    if (!isCurrentPeriod(current)) anchor.setHours(businessDayStartHour, 0, 0, 0);
    set({ weekStartsOn, businessDayStartHour, period: periodFor(current.unit, anchor, weekStartsOn, businessDayStartHour) });
  },
}));
