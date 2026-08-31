import React from 'react';
import { useConsolePeriodStore } from '../../store/useConsolePeriodStore';
import { PeriodUnit } from '../../utils/period';
import { ChevronLeft, ChevronRight, CalendarRange } from 'lucide-react';

const UNITS: { id: PeriodUnit; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
];

const CURRENT_LABEL: Record<PeriodUnit, string> = {
  day: 'Today',
  week: 'This Week',
  month: 'This Month',
  year: 'This Year',
};

/**
 * The console's one date control, in the topbar so it reads as governing the whole screen
 * rather than any single panel.
 *
 * Forward navigation stops at the present: there is no data in the future, and an empty
 * "September 2026" would look like a reporting failure rather than a date that has not
 * happened yet.
 */
export const PeriodPicker: React.FC = () => {
  const { period, setUnit, step, goToCurrent, isCurrent } = useConsolePeriodStore();
  const atPresent = isCurrent();

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex border-2 border-slate-300 rounded-none overflow-hidden">
        {UNITS.map((u) => (
          <button
            key={u.id}
            onClick={() => setUnit(u.id)}
            aria-pressed={period.unit === u.id}
            className={`px-3 py-1.5 text-[11px] font-black uppercase tracking-wide transition ${
              period.unit === u.id
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            {u.label}
          </button>
        ))}
      </div>

      <div className="flex items-center border-2 border-slate-300 rounded-none bg-white">
        <button
          onClick={() => step(-1)}
          aria-label={`Previous ${period.unit}`}
          className="px-2 py-1.5 text-slate-600 hover:bg-slate-100 transition"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-slate-900 min-w-[9.5rem] text-center flex items-center justify-center gap-1.5">
          <CalendarRange className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
          <span>{period.label}</span>
        </div>
        <button
          onClick={() => step(1)}
          disabled={atPresent}
          aria-label={`Next ${period.unit}`}
          className="px-2 py-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent transition"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <button
        onClick={goToCurrent}
        disabled={atPresent}
        className="px-3 py-1.5 text-[11px] font-black uppercase tracking-wide border-2 border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-30 rounded-none transition"
      >
        {CURRENT_LABEL[period.unit]}
      </button>
    </div>
  );
};
