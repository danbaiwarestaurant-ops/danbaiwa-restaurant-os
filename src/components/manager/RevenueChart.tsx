import React, { useRef, useState } from 'react';
import { DayPoint } from '../../utils/analytics';
import { formatCurrency } from '../../utils/currency';

const W = 700;
const H = 190;
const PAD = 12;

/**
 * Inline SVG area chart. No charting dependency — this draws one series and adding a
 * library for it would cost more bundle than the whole console.
 *
 * Hovering (or, on a till, touching and dragging) reads out the exact figure for a column.
 * A shape alone only shows relative height, so without this the chart could say "Tuesday
 * was the good day" but never how good, and the peak caption was the only number on it.
 */
export const RevenueChart: React.FC<{
  points: DayPoint[];
  currency?: string;
  /** What one column is, so "Peak: 14" cannot be read as a day when it means an hour. */
  noun?: 'hour' | 'day' | 'month';
}> = ({ points, currency = '₦', noun = 'day' }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  // A flat-zero week would divide by zero and collapse every point onto the baseline.
  const max = Math.max(1, ...points.map((p) => p.revenue));
  const stepX = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;

  const coords = points.map((p, i) => {
    const x = PAD + i * stepX;
    const y = H - PAD - (p.revenue / max) * (H - PAD * 2);
    return [x, y] as const;
  });

  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c[0].toFixed(1)} ${c[1].toFixed(1)}`).join(' ');
  const area = coords.length
    ? `${line} L ${coords[coords.length - 1][0].toFixed(1)} ${H} L ${coords[0][0].toFixed(1)} ${H} Z`
    : '';

  const traded = points.filter((p) => p.revenue > 0);
  const peak = traded.reduce<DayPoint | null>(
    (best, p) => (!best || p.revenue > best.revenue ? p : best),
    null
  );
  // The quietest column that still traded. Only meaningful once there is a spread to
  // compare against — with one trading column it is the same point as the peak.
  const trough =
    traded.length > 1
      ? traded.reduce<DayPoint | null>((low, p) => (!low || p.revenue < low.revenue ? p : low), null)
      : null;

  const dense = points.length > 14;
  const labelEvery = points.length > 24 ? 5 : 3;

  /** Critical points stay marked even when the rest of the series is too dense for dots. */
  const isCritical = (p: DayPoint) => p === peak || p === trough;

  const pick = (clientX: number) => {
    const el = wrapRef.current;
    if (!el || points.length === 0) return;
    const box = el.getBoundingClientRect();
    if (box.width === 0) return;
    // The svg uses preserveAspectRatio="none", so viewBox x maps linearly onto the
    // rendered width — convert back through that same ratio rather than assuming pixels.
    const vbX = ((clientX - box.left) / box.width) * W;
    const i = stepX ? Math.round((vbX - PAD) / stepX) : 0;
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };

  const active = hover === null ? null : points[hover];
  const activeCoord = hover === null ? null : coords[hover];
  // Flip the tooltip to the left of the guide line near the right edge so it cannot be
  // clipped by the panel.
  const tipLeftPct = activeCoord ? (activeCoord[0] / W) * 100 : 0;
  const flip = tipLeftPct > 62;

  return (
    <div>
      <div
        ref={wrapRef}
        className="relative"
        style={{ height: H }}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerDown={(e) => pick(e.clientX)}
        onPointerLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
          <defs>
            <linearGradient id="revArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.32" />
              <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
            </linearGradient>
          </defs>
          {area && <path d={area} fill="url(#revArea)" />}
          {line && (
            <path d={line} fill="none" stroke="#d97706" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
          )}

          {activeCoord && (
            <line
              x1={activeCoord[0]}
              y1={0}
              x2={activeCoord[0]}
              y2={H}
              stroke="#0f172a"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              opacity={0.45}
            />
          )}

          {/* A month is 31 points; a marker on each turns the line into a bead curtain.
              Past a fortnight only the critical points and whatever is hovered are marked. */}
          {coords.map((c, i) => {
            const p = points[i];
            const show = !dense || isCritical(p) || i === hover;
            if (!show) return null;
            const critical = isCritical(p);
            return (
              <circle
                key={i}
                cx={c[0]}
                cy={c[1]}
                r={i === hover ? 6 : critical ? 5.5 : 4}
                fill={critical ? '#d97706' : '#ffffff'}
                stroke={i === hover ? '#0f172a' : '#d97706'}
                strokeWidth={2.5}
              />
            );
          })}
        </svg>

        {active && (
          <div
            className="absolute pointer-events-none z-10 bg-slate-900 text-white border-2 border-amber-500 rounded-none px-3 py-2 shadow-xl whitespace-nowrap"
            style={{
              left: `${tipLeftPct}%`,
              top: 6,
              transform: flip ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
            }}
          >
            <div className="text-[10px] font-black uppercase tracking-widest text-amber-400">
              {active.label}
              {noun === 'hour' ? ':00' : ''}
              {peak === active && <span className="ml-1.5 text-white">· Busiest</span>}
              {trough === active && <span className="ml-1.5 text-white">· Quietest</span>}
            </div>
            <div className="text-sm font-black font-mono tabular-nums leading-tight mt-0.5">
              {formatCurrency(active.revenue, currency)}
            </div>
            <div className="text-[11px] font-semibold text-slate-300">
              {active.ticketCount === 0
                ? 'No tickets'
                : `${active.ticketCount} ticket${active.ticketCount === 1 ? '' : 's'}`}
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-between mt-2 text-[10px] font-bold uppercase text-slate-500">
        {points.map((p, i) => (
          // Same reason as the markers: thin the axis rather than let 31 labels overlap
          // into a smear. A hovered or critical column is always named.
          <span
            key={p.day}
            className={i === hover ? 'text-slate-900 font-black' : isCritical(p) ? 'text-amber-700' : ''}
          >
            {!dense || i % labelEvery === 0 || i === hover || isCritical(p) ? p.label : ' '}
          </span>
        ))}
      </div>

      {peak && (
        <div className="mt-3 text-[11px] font-semibold text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
          <span>
            Busiest {noun}: <span className="text-slate-800 font-bold">{peak.label}{noun === 'hour' ? ':00' : ''}</span>
            {' · '}{formatCurrency(peak.revenue, currency)}
          </span>
          {trough && (
            <span>
              Quietest {noun}: <span className="text-slate-800 font-bold">{trough.label}{noun === 'hour' ? ':00' : ''}</span>
              {' · '}{formatCurrency(trough.revenue, currency)}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
