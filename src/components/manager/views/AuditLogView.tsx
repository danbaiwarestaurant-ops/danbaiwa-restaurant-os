import React, { useEffect, useMemo } from 'react';
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
  return 'muted';
}

export const AuditLogView: React.FC = () => {
  const { auditLogs, loadAuditLogs } = useAuditStore();
  const { users } = useAuthStore();
  const { period } = useConsolePeriodStore();

  useEffect(() => {
    loadAuditLogs();
  }, [loadAuditLogs]);

  const entries = useMemo(
    () => filterByPeriod(auditLogs, (l) => l.timestamp, period),
    [auditLogs, period]
  );

  const { page, totalPages, start, visible, next, prev } = usePagination(entries, PAGE_SIZE);
  const actorName = (id: string) => users.find((u) => u.id === id)?.name ?? id ?? 'Unknown';

  return (
    <Panel
      title="Audit Log"
      subtitle={`Actions recorded in ${period.label}. Append-only — the database grants only SELECT and INSERT, so entries cannot be edited or deleted.`}
      icon={ShieldCheck}
    >
      {entries.length === 0 ? (
        // Previously this panel listed voided tickets and called itself an audit log, so
        // expense approvals and rejections never appeared anywhere in the UI at all.
        <EmptyState>No audited actions in {period.label}</EmptyState>
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
