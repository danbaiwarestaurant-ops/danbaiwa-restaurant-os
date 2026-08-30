import React, { useState } from 'react';
import { RefreshCw, CloudOff, AlertTriangle, Cloud } from 'lucide-react';
import { useSyncStore } from '../../store/useSyncStore';
import { CloudReconnectModal } from './CloudReconnectModal';

/**
 * Reports the real state of cloud sync.
 *
 * This used to show a reassuring green "Online • Synced" whenever the pending count was
 * zero — which was precisely the state reached once unsynced rows had been written off,
 * and on a till holding no cloud session at all. The badge was at its most confident
 * exactly when data was being stranded. Every state that means "the cloud does not have
 * your data yet" is now visually distinct from the one state that means it does.
 */
export const SyncIndicator: React.FC = () => {
  const { pendingCount, stuckCount, cloudConnected, cloudError, isOnline, isSyncing, triggerSyncWorker } =
    useSyncStore();
  const [isReconnectOpen, setIsReconnectOpen] = useState(false);

  // Being disconnected is the one state the operator can actually act on, so clicking
  // opens the fix rather than uselessly re-running a sync that has nowhere to go.
  const needsReconnect = isOnline && !cloudConnected;

  let tone: string;
  let label: string;
  let title: string;
  let Icon = Cloud;

  if (!isOnline) {
    tone = 'bg-slate-100 border-slate-400 text-slate-800';
    label = pendingCount > 0 ? `Offline (${pendingCount} queued)` : 'Offline';
    title = 'This device is offline. Work continues normally and everything is queued locally — it will sync once the connection returns.';
    Icon = CloudOff;
  } else if (!cloudConnected) {
    tone = 'bg-rose-50 border-rose-400 text-rose-900 hover:bg-rose-100';
    label = pendingCount > 0 ? `Not Signed In to Cloud (${pendingCount})` : 'Not Signed In to Cloud';
    title = `${cloudError ?? 'This till is online but has no cloud session, so nothing can reach your other devices.'}\n\nClick to reconnect with the admin PIN.`;
    Icon = CloudOff;
  } else if (stuckCount > 0) {
    tone = 'bg-amber-100 border-amber-500 text-amber-950';
    label = `${stuckCount} Stuck • ${pendingCount} Queued`;
    title = `${stuckCount} record(s) have been rejected by the cloud repeatedly. They are still retried and have not been lost, but they need attention — check the console for the last error.`;
    Icon = AlertTriangle;
  } else if (pendingCount > 0) {
    tone = 'bg-amber-50 border-amber-400 text-amber-900';
    label = `Sync (${pendingCount} pending)`;
    title = 'Records are queued and on their way to the cloud.';
    Icon = RefreshCw;
  } else {
    tone = 'bg-emerald-50 border-emerald-400 text-emerald-950';
    label = 'Cloud Synced';
    title = 'Everything on this device has reached the cloud and is available on your other devices.';
    Icon = Cloud;
  }

  return (
    <>
      <button
        onClick={() => (needsReconnect ? setIsReconnectOpen(true) : triggerSyncWorker())}
        className={`flex items-center gap-1.5 px-3 py-1.5 border text-xs font-black uppercase transition rounded-none ${tone}`}
        title={title}
      >
        <Icon className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
        <span>{label}</span>
      </button>

      <CloudReconnectModal isOpen={isReconnectOpen} onClose={() => setIsReconnectOpen(false)} />
    </>
  );
};
