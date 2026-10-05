import { AuditLogRow } from './dexieSchema';
import { UserAccount } from '../../types/user';

export const STAFF_DELETION_ENTITY = 'staff_identity';
/** The audit identity contains only attribution, never login keys or credentials. */
export function archivedStaff(log: AuditLogRow): UserAccount | null {
  if (log.entity !== STAFF_DELETION_ENTITY || log.action !== 'PERMANENT_DELETE') return null;
  try {
    const identity = JSON.parse(log.reason);
    if (identity.id !== log.entityId || typeof identity.name !== 'string' || identity.role === 'admin') return null;
    return { id: log.entityId, name: identity.name, role: identity.role, createdAt: identity.createdAt,
      accountId: log.accountId || identity.accountId, deletedAt: log.timestamp,
      status: 'deactivated', email: '', username: '', pinHash: '', pinSalt: '' };
  } catch { return null; }
}
