import React from 'react';
import { Panel } from '../ConsoleUI';
import { Construction, LucideIcon } from 'lucide-react';

interface ComingSoonViewProps {
  title: string;
  icon?: LucideIcon;
  /** What this section would do once its data model exists. */
  purpose: string;
  /** What has to be built first — stated plainly rather than implied. */
  requires: string[];
}

/**
 * Placeholder for a nav section that has no data model behind it yet.
 *
 * States exactly what is missing instead of showing an empty table that reads like a
 * bug. Menu Management and Inventory both need schema work that hasn't happened: a
 * ticket in this app is a flat amount, with no line items, product names, or cost
 * prices anywhere in the data model.
 */
export const ComingSoonView: React.FC<ComingSoonViewProps> = ({ title, icon, purpose, requires }) => (
  <Panel title={title} icon={icon ?? Construction}>
    <div className="max-w-2xl space-y-4 py-4">
      <div className="inline-block px-2.5 py-1 bg-slate-100 border border-slate-300 text-[10px] font-black uppercase tracking-wider text-slate-600 rounded-none">
        Not set up yet
      </div>

      <p className="text-sm font-semibold text-slate-700 leading-relaxed">{purpose}</p>

      <div>
        <div className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2">
          Needs building first
        </div>
        <ul className="space-y-1.5">
          {requires.map((r) => (
            <li key={r} className="flex items-start gap-2 text-xs text-slate-600 font-medium">
              <span className="text-amber-500 font-black mt-px">•</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-[11px] text-slate-500 font-medium border-t-2 border-slate-200 pt-3">
        Nothing on this screen is wired to live data — it is listed here so the shape of
        the product is visible, not because it is partly working.
      </p>
    </div>
  </Panel>
);
