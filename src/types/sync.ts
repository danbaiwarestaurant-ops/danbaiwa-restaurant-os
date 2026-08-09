export type SyncAction = 'INSERT' | 'UPDATE' | 'DELETE';
export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'failed';

export interface OutboxItem {
  id: string; // client UUID
  tableName: string;
  action: SyncAction;
  payload: Record<string, any>;
  createdAt: string;
  status: SyncStatus;
  retryCount: number;
  lastError?: string;
}

export interface SyncState {
  isOnline: boolean;
  pendingCount: number;
  lastSyncedAt?: string;
  isSyncing: boolean;
}
