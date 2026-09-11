import React, { useEffect, useMemo, useState } from 'react';
import { ClipboardList, Trophy, Save, Trash2 } from 'lucide-react';
import { useAuthStore } from '../../../store/useAuthStore';
import { useServerSalesStore } from '../../../store/useServerSalesStore';
import { useConsolePeriodStore } from '../../../store/useConsolePeriodStore';
import { businessDayKey, BUSINESS_DAY_START_HOUR } from '../../../utils/shiftDay';
import { countedManually, roleLabel } from '../../../utils/roles';
import { Panel, DataTable, EmptyState, ConsoleButton, StatStrip } from '../ConsoleUI';

/** Local `YYYY-MM-DD`, matching the shape businessDayKey produces. */
function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** A trading-day key rendered for a person, e.g. "Thu 10 Sep 2026". */
function readableDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return key;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Server ticket counts.
 *
 * Every other figure in this console is a by-product of the till: a sale was rung up, so
 * there is a ticket, so there is a number. Servers sit outside that entirely — they take
 * orders on the floor, the cashier handles all the money, and nothing about who sold what
 * reaches the system on its own. So this screen has two halves that no other view needs
 * both of: somewhere to type the counts in, and somewhere to read them back.
 *
 * The entry form is deliberately one day at a time. Counts are tallied at the end of a
 * service and entered for that service, and a form that let a manager edit a fortnight at
 * once would make a mistyped row very hard to notice and harder still to attribute.
 */
export const ServerSalesView: React.FC = () => {
  const { users } = useAuthStore();
  const { entries, loadServerSales, recordCount, removeCount } = useServerSalesStore();
  const { period } = useConsolePeriodStore();

  const [day, setDay] = useState(() => businessDayKey(new Date()));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  // The whole table, not the visible period: the entry form's day can sit outside the
  // reporting window (entering last night's counts while reading last month's figures),
  // and the volume here is a handful of rows per service — small enough that a scoped
  // read would cost more in reload complexity than it saves.
  useEffect(() => {
    void loadServerSales();
  }, [loadServerSales]);

  const servers = useMemo(
    () =>
      users
        .filter((u) => countedManually(u.role) && u.status === 'active')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [users]
  );

  /** What is already recorded for the day on screen, so the form opens showing it. */
  const existing = useMemo(() => {
    const map: Record<string, (typeof entries)[number]> = {};
    for (const e of entries) if (e.businessDay === day) map[e.serverId] = e;
    return map;
  }, [entries, day]);

  // Re-seed the inputs whenever the day changes, so switching to a day that already has
  // counts shows them rather than an empty form the manager would fill in a second time.
  useEffect(() => {
    const nextDrafts: Record<string, string> = {};
    const nextNotes: Record<string, string> = {};
    for (const s of servers) {
      const e = existing[s.id];
      nextDrafts[s.id] = e ? String(e.ticketCount) : '';
      nextNotes[s.id] = e?.note ?? '';
    }
    setDrafts(nextDrafts);
    setNotes(nextNotes);
    setSaved(null);
    // `existing` is derived from the day, so keying on both would re-seed the form under
    // the manager's cursor every time a sync pulled an unrelated row down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, servers]);

  /** Rows the manager has actually touched — a blank input is "not counted", not zero. */
  const pending = servers.filter((s) => {
    const raw = (drafts[s.id] ?? '').trim();
    const e = existing[s.id];
    if (raw === '') return false;
    const n = Number(raw);
    if (!Number.isFinite(n)) return false;
    return !e || e.ticketCount !== Math.round(n) || (e.note ?? '') !== (notes[s.id] ?? '').trim();
  });

  const handleSave = async () => {
    if (!pending.length || isSaving) return;
    setIsSaving(true);
    try {
      for (const s of pending) {
        await recordCount({
          serverId: s.id,
          serverName: s.name,
          businessDay: day,
          ticketCount: Number(drafts[s.id]),
          note: notes[s.id],
        });
      }
      setSaved(`Saved ${pending.length} ${pending.length === 1 ? 'count' : 'counts'} for ${readableDay(day)}`);
    } finally {
      setIsSaving(false);
    }
  };

  // ── The report half ───────────────────────────────────────────────────────
  // Trading days are compared as keys rather than parsed into dates: the day already IS
  // the unit here, and turning '2026-09-10' back into a Date only to re-derive the day
  // introduces a timezone question that has no business in this comparison.
  const fromKey = ymd(period.start);
  const toKey = ymd(new Date(period.end.getTime() - 1));

  const inPeriod = useMemo(
    () => entries.filter((e) => e.businessDay >= fromKey && e.businessDay <= toKey),
    [entries, fromKey, toKey]
  );

  const ranked = useMemo(() => {
    const rows: Record<string, { serverId: string; name: string; tickets: number; days: number }> = {};
    for (const e of inPeriod) {
      // Named off the entry, not the roster, so a season's figures still name people who
      // have since left and whose user row is gone.
      const row = rows[e.serverId] || { serverId: e.serverId, name: e.serverName, tickets: 0, days: 0 };
      row.tickets += e.ticketCount;
      row.days += 1;
      rows[e.serverId] = row;
    }
    return Object.values(rows).sort((a, b) => b.tickets - a.tickets);
  }, [inPeriod]);

  const totalTickets = ranked.reduce((sum, r) => sum + r.tickets, 0);
  const daysCovered = new Set(inPeriod.map((e) => e.businessDay)).size;

  const recent = useMemo(
    () => [...inPeriod].sort((a, b) => (a.businessDay < b.businessDay ? 1 : -1)).slice(0, 40),
    [inPeriod]
  );

  return (
    <div className="space-y-4">
      <Panel
        title="Enter Ticket Counts"
        subtitle={`Tallied on the floor and typed in here — servers do not use the till. Trading days run from ${BUSINESS_DAY_START_HOUR}am.`}
        icon={ClipboardList}
        actions={
          <>
            <input
              type="date"
              value={day}
              max={businessDayKey(new Date())}
              onChange={(e) => setDay(e.target.value)}
              className="px-2 py-1.5 text-[11px] font-bold border-2 border-slate-300 rounded-none text-slate-900 focus:border-amber-500 focus:outline-none"
            />
            <ConsoleButton variant="primary" onClick={handleSave} disabled={!pending.length || isSaving}>
              <span className="flex items-center gap-1.5">
                <Save className="w-3 h-3" />
                {isSaving ? 'Saving…' : `Save${pending.length ? ` (${pending.length})` : ''}`}
              </span>
            </ConsoleButton>
          </>
        }
      >
        {servers.length === 0 ? (
          <EmptyState>
            No servers on the roster — add them under Staff Management with the role “Server / Waiter”
          </EmptyState>
        ) : (
          <>
            <p className="text-[11px] text-slate-500 font-semibold mb-3">
              Showing <span className="text-slate-800 font-black">{readableDay(day)}</span>. Leave a
              box empty for anyone who did not work — an empty box is “not counted”, a 0 is “worked
              and sold nothing”.
            </p>
            <DataTable headers={['Server', 'Tickets', 'Note', '']} alignRight={[1, 3]}>
              {servers.map((s) => {
                const e = existing[s.id];
                return (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <td className="py-2 pr-3">
                      <div className="font-bold text-slate-900">{s.name}</div>
                      <div className="text-[10px] uppercase font-bold text-slate-400">
                        {roleLabel(s.role)}
                        {e && <span className="text-emerald-600"> · recorded by {e.recordedByName || '—'}</span>}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        inputMode="numeric"
                        value={drafts[s.id] ?? ''}
                        onChange={(ev) => setDrafts((d) => ({ ...d, [s.id]: ev.target.value }))}
                        placeholder="—"
                        className="w-20 px-2 py-1.5 text-right font-mono font-black tabular-nums text-sm border-2 border-slate-300 rounded-none text-slate-900 focus:border-amber-500 focus:outline-none"
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        type="text"
                        value={notes[s.id] ?? ''}
                        onChange={(ev) => setNotes((n) => ({ ...n, [s.id]: ev.target.value }))}
                        placeholder="Optional"
                        className="w-full min-w-[8rem] px-2 py-1.5 text-[11px] font-semibold border-2 border-slate-200 rounded-none text-slate-700 focus:border-amber-500 focus:outline-none"
                      />
                    </td>
                    <td className="py-2 text-right">
                      {e && (
                        <button
                          onClick={() => void removeCount(e.id)}
                          title="Remove this count"
                          className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-none"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </DataTable>
            {saved && (
              <p className="mt-3 text-[11px] font-black uppercase tracking-wide text-emerald-700">{saved}</p>
            )}
          </>
        )}
      </Panel>

      <Panel
        title="Server Performance"
        subtitle={`Tickets turned over in ${period.label}`}
        icon={Trophy}
      >
        {ranked.length === 0 ? (
          <EmptyState>No counts entered for this period</EmptyState>
        ) : (
          <>
            <div className="mb-4">
              <StatStrip
                stats={[
                  { label: 'Tickets', value: String(totalTickets) },
                  { label: 'Servers counted', value: String(ranked.length) },
                  { label: 'Days recorded', value: String(daysCovered) },
                  {
                    label: 'Avg per server / day',
                    // Per server-day rather than per calendar day: a server who worked
                    // three of the month's thirty days should not have their average
                    // diluted by the twenty-seven they were not there.
                    value: inPeriod.length ? (totalTickets / inPeriod.length).toFixed(1) : '0',
                  },
                ]}
              />
            </div>
            <DataTable headers={['#', 'Server', 'Days worked', 'Tickets', 'Share']} alignRight={[2, 3, 4]}>
              {ranked.map((r, i) => (
                <tr key={r.serverId} className="hover:bg-slate-50">
                  <td className="py-2.5 pr-3 font-black text-slate-400 tabular-nums">{i + 1}</td>
                  <td className="py-2.5 pr-3 font-bold text-slate-900">{r.name}</td>
                  <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-slate-600">{r.days}</td>
                  <td className="py-2.5 pr-3 text-right font-mono font-black tabular-nums text-slate-900">
                    {r.tickets}
                  </td>
                  <td className="py-2.5 text-right font-mono tabular-nums text-slate-500">
                    {totalTickets ? `${Math.round((r.tickets / totalTickets) * 100)}%` : '—'}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-slate-300 bg-slate-50">
                <td className="py-2.5 pr-3" />
                <td className="py-2.5 pr-3 font-black uppercase text-[11px] tracking-wider text-slate-700">
                  Total
                </td>
                <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-slate-500">{daysCovered}</td>
                <td className="py-2.5 pr-3 text-right font-mono font-black tabular-nums">{totalTickets}</td>
                <td className="py-2.5" />
              </tr>
            </DataTable>
          </>
        )}
      </Panel>

      {recent.length > 0 && (
        <Panel title="Entries" subtitle={`Every count recorded in ${period.label}`} icon={ClipboardList}>
          <DataTable headers={['Trading day', 'Server', 'Tickets', 'Note', 'Entered by']} alignRight={[2]}>
            {recent.map((e) => (
              <tr key={e.id} className="hover:bg-slate-50">
                <td className="py-2 pr-3 font-bold text-slate-700">{readableDay(e.businessDay)}</td>
                <td className="py-2 pr-3 font-bold text-slate-900">{e.serverName}</td>
                <td className="py-2 pr-3 text-right font-mono font-black tabular-nums">{e.ticketCount}</td>
                <td className="py-2 pr-3 text-slate-500">{e.note || '—'}</td>
                <td className="py-2 text-slate-500">{e.recordedByName || '—'}</td>
              </tr>
            ))}
          </DataTable>
        </Panel>
      )}
    </div>
  );
};
