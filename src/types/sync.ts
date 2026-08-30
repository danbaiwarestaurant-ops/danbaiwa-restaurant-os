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
  /**
   * Earliest time this item may be retried, as ISO. Set by the exponential backoff in
   * markOutboxAttemptFailed. Absent means "eligible right now". A row is never dropped
   * for exceeding a retry budget — it only backs off, so unsynced data is never
   * abandoned on the device (see STUCK_AFTER_RETRIES for how it gets surfaced instead).
   */
  nextAttemptAt?: string;
}

export interface SyncState {
  isOnline: boolean;
  /**
   * Whether this browser currently holds a real Supabase session. Being online is NOT
   * enough: with no session every push is rejected by RLS, so this is what actually
   * determines whether the cloud is reachable for writes.
   */
  cloudConnected: boolean;
  /**
   * Why the cloud is unreachable, in the user's words, when we know. Surfaced in the
   * reconnect dialog — this used to exist only as a console.warn, so a till could sit
   * disconnected for days with the reason invisible to whoever was standing at it.
   */
  cloudError: string | null;
  /** Everything not yet in the cloud, including rows currently waiting out a backoff. */
  pendingCount: number;
  /** Rows that have failed repeatedly and need a human to look — still retried, never dropped. */
  stuckCount: number;
  lastSyncedAt?: string;
  isSyncing: boolean;
}
