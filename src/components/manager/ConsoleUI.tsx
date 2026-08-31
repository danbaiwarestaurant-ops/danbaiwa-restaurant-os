import React from 'react';
import { LucideIcon } from 'lucide-react';

/**
 * Shared building blocks for the console views, so eleven views don't each invent their
 * own panel border, table header or empty state.
 */

export const Panel: React.FC<{
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  icon?: LucideIcon;
  className?: string;
  children: React.ReactNode;
}> = ({ title, subtitle, actions, icon: Icon, className = '', children }) => (
  <section className={`bg-white border-2 border-slate-300 rounded-none shadow-xs ${className}`}>
    {(title || actions) && (
      <div className="flex items-center justify-between gap-3 flex-wrap px-5 py-3.5 border-b-2 border-slate-200">
        <div>
          <h2 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-2">
            {Icon && <Icon className="w-4 h-4 text-amber-500" />}
            <span>{title}</span>
          </h2>
          {subtitle && (
            <p className="text-[11px] text-slate-500 font-semibold mt-0.5">{subtitle}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
      </div>
    )}
    <div className="p-5">{children}</div>
  </section>
);

/**
 * Change against the equivalent earlier period.
 *
 * `pct` is null when the earlier period earned nothing: a rise from zero is not "+100%" or
 * "+∞", it is simply a period that has a figure where the last one had none, and inventing
 * a percentage there would make a first trading week look like a collapse or a miracle.
 */
export interface KpiTrend {
  pct: number | null;
  /** What the comparison is against, e.g. "vs July 2026". */
  label: string;
  /** Whether a rise is good. Expenses rise badly; revenue rises well. */
  higherIsBetter?: boolean;
}

const TrendChip: React.FC<{ trend: KpiTrend }> = ({ trend }) => {
  if (trend.pct === null) {
    return <span className="text-[11px] font-semibold text-slate-400">No {trend.label.replace(/^vs /, '')} figure</span>;
  }
  const up = trend.pct > 0;
  const flat = Math.abs(trend.pct) < 0.5;
  const good = trend.higherIsBetter === false ? !up : up;
  const tone = flat ? 'text-slate-500' : good ? 'text-emerald-600' : 'text-rose-600';
  const arrow = flat ? '→' : up ? '▲' : '▼';
  return (
    <span className={`text-[11px] font-bold ${tone}`}>
      {arrow} {Math.abs(trend.pct).toFixed(0)}%{' '}
      <span className="text-slate-400 font-semibold">{trend.label}</span>
    </span>
  );
};

export const KpiCard: React.FC<{
  label: string;
  value: string;
  hint?: string;
  trend?: KpiTrend;
  tone?: 'neutral' | 'positive' | 'negative';
}> = ({ label, value, hint, trend, tone = 'neutral' }) => {
  const valueTone =
    tone === 'positive' ? 'text-emerald-600' : tone === 'negative' ? 'text-rose-600' : 'text-slate-900';
  return (
    <div className="bg-white border-2 border-slate-300 rounded-none shadow-xs p-4 border-l-4 border-l-amber-500">
      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`text-2xl font-black font-mono mt-1 tabular-nums ${valueTone}`}>{value}</div>
      {trend && <div className="mt-1"><TrendChip trend={trend} /></div>}
      {hint && <div className="text-[11px] text-slate-500 font-medium mt-1">{hint}</div>}
    </div>
  );
};

export const StatStrip: React.FC<{ stats: { label: string; value: string }[] }> = ({ stats }) => (
  <div className="flex flex-wrap gap-8 pb-4 mb-4 border-b-2 border-slate-200">
    {stats.map((s) => (
      <div key={s.label}>
        <div className="text-xl font-black font-mono text-slate-900 tabular-nums">{s.value}</div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mt-0.5">
          {s.label}
        </div>
      </div>
    ))}
  </div>
);

export const StatusBadge: React.FC<{
  tone: 'ok' | 'warn' | 'danger' | 'muted';
  children: React.ReactNode;
}> = ({ tone, children }) => {
  const tones = {
    ok: 'bg-emerald-50 text-emerald-800 border-emerald-300',
    warn: 'bg-amber-50 text-amber-900 border-amber-400',
    danger: 'bg-rose-50 text-rose-800 border-rose-300',
    muted: 'bg-slate-100 text-slate-700 border-slate-300',
  };
  return (
    <span
      className={`inline-block text-[10px] font-black uppercase tracking-wide px-2 py-0.5 border rounded-none whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
};

export const DataTable: React.FC<{
  headers: string[];
  /** Right-align these column indexes (money and counts read better right-aligned). */
  alignRight?: number[];
  children: React.ReactNode;
}> = ({ headers, alignRight = [], children }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-left text-xs border-collapse">
      <thead>
        <tr className="border-b-2 border-slate-200 text-slate-500 uppercase">
          {headers.map((h, i) => (
            <th
              key={h}
              className={`py-2 pr-3 text-[10px] font-black tracking-wider ${
                alignRight.includes(i) ? 'text-right pr-0' : ''
              }`}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">{children}</tbody>
    </table>
  </div>
);

export const EmptyState: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-center py-10 text-slate-400 text-xs font-bold uppercase tracking-wider">
    {children}
  </div>
);

export const ConsoleButton: React.FC<{
  onClick?: () => void;
  variant?: 'primary' | 'ghost';
  children: React.ReactNode;
  disabled?: boolean;
}> = ({ onClick, variant = 'ghost', children, disabled }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`px-3 py-1.5 text-[11px] font-black uppercase tracking-wide border rounded-none transition disabled:opacity-40 ${
      variant === 'primary'
        ? 'bg-amber-500 hover:bg-amber-600 text-white border-amber-600'
        : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-300'
    }`}
  >
    {children}
  </button>
);
