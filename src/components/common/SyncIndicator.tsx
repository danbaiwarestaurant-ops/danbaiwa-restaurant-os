import React from 'react';
import { RefreshCw } from 'lucide-react';
import { useSyncStore } from '../../store/useSyncStore';

export const SyncIndicator: React.FC = () => {
  const { pendingCount, isSyncing, triggerSyncWorker } = useSyncStore();

  return (
    <button
      onClick={() => triggerSyncWorker()}
      className={`flex items-center gap-1.5 px-3 py-1.5 border text-xs font-black uppercase transition rounded-none ${
        pendingCount > 0
          ? 'bg-amber-50 border-amber-400 text-amber-900 hover:bg-amber-100'
          : 'bg-emerald-50 border-emerald-400 text-emerald-950'
      }`}
      title="Click to trigger manual outbox sync"
    >
      <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin text-amber-600' : ''}`} />
      <span>{pendingCount > 0 ? `Sync (${pendingCount} pending)` : 'Online • Synced'}</span>
    </button>
  );
};
