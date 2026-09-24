import React, { useEffect, useMemo, useState } from 'react';
import { useAuditStore } from '../../../store/useAuditStore';
import { useAuthStore } from '../../../store/useAuthStore';
import { useConsolePeriodStore } from '../../../store/useConsolePeriodStore';
import { formatTimestamp } from '../../../utils/currency';
import { filterByPeriod } from '../../../utils/period';
import { Panel, DataTable, EmptyState, StatusBadge } from '../ConsoleUI';
import { Pager, usePagination } from '../../common/Pager';
import { ShieldCheck } from 'lucide-react';

const PAGE_SIZE = 15;

/** VOID and REJECT_EXPENSE are the entries a manager scans for. */
function toneFor(action: string): 'ok' | 'warn' | 'danger' | 'muted' {
  const a = action.toUpperCase();
  if (a.includes('VOID') || a.includes('REJECT')) return 'danger';
  if (a.includes('APPROVE')) return 'ok';
  // A retagged payment type moves money between the drawer figure and the transfer
  // figure, so it is worth a manager's eye without being an alarm.
  if (a.includes('TENDER')) return 'warn';
  return 'muted';
}

export const AuditLogView: React.FC = () => {
  const { auditLogs, loadAuditLogs } = useAuditStore();
  const { users } = useAuthStore();
  const { period } = useConsolePeriodStore();
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('all');
  const [entity, setEntity] = useState('all');
  const [actor, setActor] = useState('all');

  useEffect(() => {
    loadAuditLogs();
  }, [loadAuditLogs]);

  const periodEntries = useMemo(
    () => filterByPeriod(auditLogs, (l) => l.timestamp, period),
    [auditLogs, period]
  );
  const actorName = (id: string) => users.find((u) => u.id === id)?.name ?? id ?? 'Unknown';
  const entries = useMemo(() => {
    const query = search.trim().toLowerCase();
    return periodEntries.filter((log) => {
      if (action !== 'all' && log.action !== action) return false;
      if (entity !== 'all' && log.entity !== entity) return false;
      if (actor !== 'all' && log.actorId !== actor) return false;
      if (!query) return true;
      return [log.action, log.entity, log.entityId, actorName(log.actorId), log.reason]
        .some((value) => String(value || '').toLowerCase().includes(query));
    });
  }, [periodEntries, search, action, entity, actor, users]);
  const actions = useMemo(() => [...new Set(periodEntries.map((log) => log.action))].sort(), [periodEntries]);
  const entities = useMemo(() => [...new Set(periodEntries.map((log) => log.entity))].sort(), [periodEntries]);
  const actors = useMemo(() => [...new Set(periodEntries.map((log) => log.actorId))].sort((a, b) => actorName(a).localeCompare(actorName(b))), [periodEntries, users]);

  const { page, totalPages, start, visible, next, prev } = usePagination(entries, PAGE_SIZE);

  return (
    <Panel
      title="Audit Log"
      subtitle={`Actions recorded in ${period.label}. Append-only — the database grants only SELECT and INSERT, so entries cannot be edited or deleted.`}
      icon={ShieldCheck}
    >
      <div className="mb-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-[minmax(16rem,1fr)_12rem_12rem_12rem_auto] gap-2 items-end border-2 border-slate-300 bg-slate-50 p-3">
        <label className="text-[10px] font-black uppercase text-slate-600">Search audit log<input aria-label="Search audit log" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Action, staff, entity, ID, or reason" className="mt-1 w-full border-2 border-slate-300 bg-white p-2 text-xs normal-case" /></label>
        <label className="text-[10px] font-black uppercase text-slate-600">Action<select aria-label="Filter audit action" value={action} onChange={(e) => setAction(e.target.value)} className="mt-1 w-full border-2 border-slate-300 bg-white p-2 text-xs normal-case"><option value="all">All actions</option>{actions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="text-[10px] font-black uppercase text-slate-600">Entity<select aria-label="Filter audit entity" value={entity} onChange={(e) => setEntity(e.target.value)} className="mt-1 w-full border-2 border-slate-300 bg-white p-2 text-xs normal-case"><option value="all">All entities</option>{entities.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="text-[10px] font-black uppercase text-slate-600">Actor<select aria-label="Filter audit actor" value={actor} onChange={(e) => setActor(e.target.value)} className="mt-1 w-full border-2 border-slate-300 bg-white p-2 text-xs normal-case"><option value="all">All actors</option>{actors.map((id) => <option key={id} value={id}>{actorName(id)}</option>)}</select></label>
        <button onClick={() => { setSearch(''); setAction('all'); setEntity('all'); setActor('all'); }} className="border-2 border-slate-300 bg-white px-3 py-2 text-[10px] font-black uppercase hover:bg-slate-100">Clear</button>
      </div>
      {entries.length === 0 ? (
        // Previously this panel listed voided tickets and called itself an audit log, so
        // expense approvals and rejections never appeared anywhere in the UI at all.
        <EmptyState>{periodEntries.length ? 'No audit entries match these filters' : `No audited actions in ${period.label}`}</EmptyState>
      ) : (
        <>
          <DataTable headers={['Timestamp', 'Action', 'Entity', 'Actor', 'Reason']}>
            {visible.map((log) => (
              <tr key={log.id} className="hover:bg-slate-50">
                <td className="py-2.5 pr-3 text-slate-500 whitespace-nowrap">{formatTimestamp(log.timestamp)}</td>
                <td className="py-2.5 pr-3">
                  <StatusBadge tone={toneFor(log.action)}>{log.action}</StatusBadge>
                </td>
                <td className="py-2.5 pr-3 font-mono text-[11px] text-slate-600">
                  {log.entity} #{log.entityId}
                </td>
                <td className="py-2.5 pr-3 font-semibold text-slate-800">{actorName(log.actorId)}</td>
                <td className="py-2.5 text-slate-700">{log.reason || '—'}</td>
              </tr>
            ))}
          </DataTable>

          <Pager
            page={page}
            totalPages={totalPages}
            start={start}
            pageSize={PAGE_SIZE}
            total={entries.length}
            onPrev={prev}
            onNext={next}
            label="entries"
            className="pt-4 mt-4 border-t-2 border-slate-200"
          />
        </>
      )}
    </Panel>
  );
};
