import { create } from 'zustand';
import { AuditLogRow } from '../services/db/dexieSchema';
import { dbService } from '../services/db/IndexedDbService';

/**
 * The audit trail, read from the real `audit_logs` table.
 *
 * Until now nothing in the app read that table — realtimeSync's audit_logs handler was
 * literally `break; // nothing reads this back yet`, and the Manager Dashboard's
 * "Immutable Audit Log" panel was actually just a list of voided tickets, so expense
 * approvals and rejections never appeared anywhere. The console's Audit Log view is the
 * reader that closes that loop.
 *
 * Read-only by design: audit rows are append-only, written by IndexedDbService as a side
 * effect of the action being audited, and the Postgres policies grant only SELECT and
 * INSERT so an UPDATE or DELETE is refused by the database itself.
 */
interface AuditState {
  auditLogs: AuditLogRow[];
  isLoading: boolean;
  loadAuditLogs: (entityId?: string, actorId?: string) => Promise<void>;
}

export const useAuditStore = create<AuditState>((set) => ({
  auditLogs: [],
  isLoading: false,

  loadAuditLogs: async (entityId?: string, actorId?: string) => {
    set({ isLoading: true });
    await dbService.init();
    const rows = await dbService.getAuditLogs(entityId, actorId);
    // Newest first — an audit trail is read from the most recent action backwards.
    rows.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    set({ auditLogs: rows, isLoading: false });
  },
}));
