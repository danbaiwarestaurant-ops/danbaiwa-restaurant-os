import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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
  const { pendingCount, stuckCount, queueFault, cloudConnected, cloudError, isOnline, isSyncing, forceSyncNow,
    lastPulledAt, pullError, isPulling, realtimeConnected } =
    useSyncStore();
  const [isReconnectOpen, setIsReconnectOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [originalAdmins, setOriginalAdmins] = useState<{ id: string; email: string }[]>([]);
  const [reconnectAdmin, setReconnectAdmin] = useState<{ id: string; email: string } | undefined>();
  useEffect(() => {
    if (!detailsOpen || !/Account mismatch|Queued record belongs/i.test(queueFault?.reason ?? '')) {
      setOriginalAdmins([]); return;
    }
    let cancelled = false;
    void (async () => {
      const { db } = await import('../../services/db/dexieSchema');
      const { getAccountId } = await import('../../services/db/accountScope');
      const account = await getAccountId();
      // Bounded rejection sample, never scan the lifetime ticket/outbox history.
      const rows = [...await db.outbox.where('status').equals('failed').limit(200).toArray(),
        ...await db.outbox.where('[status+retryCount]').between(['pending', 1], ['pending', Number.MAX_SAFE_INTEGER], true, true).limit(200).toArray()];
      const sources = [...new Set(rows.map(row => row.payload.accountId).filter(id => typeof id === 'string' && id !== account))] as string[];
      const users = await db.users.bulkGet(sources);
      if (!cancelled) setOriginalAdmins(users.filter(user => user?.role === 'admin' && user.status === 'active' && user.email).map(user => ({ id: user!.id, email: user!.email! })));
    })().catch(e => { if (!cancelled) setRetryError(String(e)); });
    return () => { cancelled = true; };
  }, [detailsOpen, queueFault?.reason]);
  const retry = () => { setRetryError(null); void forceSyncNow().catch(e => setRetryError(String(e))); };

  // Being disconnected is the one state the operator can actually act on, so clicking
  // opens the fix rather than uselessly re-running a sync that has nowhere to go.
  const needsReconnect = isOnline && !cloudConnected;
  const schemaBlocked = /Database update required|\[(PGRST204|PGRST205|42703|42P01)\]/i.test(queueFault?.reason ?? '');

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
  } else if (schemaBlocked) {
    tone = 'bg-amber-100 border-amber-500 text-amber-950';
    label = `Database Update Required (${pendingCount})`;
    title = queueFault!.reason;
    Icon = AlertTriangle;
  } else if (stuckCount > 0) {
    tone = 'bg-amber-100 border-amber-500 text-amber-950';
    label = `${stuckCount} Stuck • ${pendingCount} Queued`;
    // The reason was recorded on the rows all along and shown nowhere, which left the
    // only actionable state in the whole badge saying "check the console".
    title = `${stuckCount} record(s) have been rejected by the cloud repeatedly. They are still retried and have not been lost, but they need attention.${
      queueFault ? `\n\n${queueFault.sampled ? 'Sampled rejection reason (at least ' : 'Most common reason ('}${queueFault.count} record(s)):\n${queueFault.reason}` : ''
    }`;
    Icon = AlertTriangle;
  } else if (pendingCount > 0) {
    // A queue that is being refused looks identical to a busy one if all you count is
    // rows, so say which of the two this is.
    const rejected = Boolean(queueFault);
    tone = rejected
      ? 'bg-amber-100 border-amber-500 text-amber-950'
      : 'bg-amber-50 border-amber-400 text-amber-900';
    const accountMismatch = /Account mismatch|Queued record belongs to another account/i.test(queueFault?.reason ?? '');
    label = accountMismatch ? `Account Mismatch (${pendingCount})` : rejected ? `Sync Blocked (${pendingCount})` : `Sync (${pendingCount} pending)`;
    title = rejected
      ? `The cloud is refusing queued records, so the count is not moving. Nothing is lost — they stay queued and keep retrying.\n\n${queueFault!.sampled ? 'Sampled rejection reason (at least ' : 'Most common reason ('}${queueFault!.count} record(s)):\n${queueFault!.reason}\n\nClick to retry them all now.`
      : 'Records are queued and on their way to the cloud.';
    Icon = rejected ? AlertTriangle : RefreshCw;
    if (accountMismatch) title = `Queued records are retained under their original account. They cannot upload to the account currently connected here.\n\n${queueFault!.reason}`;
  } else if (pullError) {
    tone = 'bg-amber-100 border-amber-500 text-amber-950';
    label = 'Cloud Refresh Failed';
    title = pullError;
    Icon = AlertTriangle;
  } else if (isPulling || !lastPulledAt) {
    tone = 'bg-slate-100 border-slate-400 text-slate-800';
    label = 'Checking Cloud';
    title = 'Uploads are clear. Incoming cloud records are being checked.';
    Icon = RefreshCw;
  } else {
    tone = 'bg-emerald-50 border-emerald-400 text-emerald-950';
    label = realtimeConnected ? 'Cloud Live' : 'Cloud Checked';
    title = `No queued uploads on this device. Last incoming check: ${new Date(lastPulledAt).toLocaleString()}. Other devices may still have unsent records.`;
    Icon = Cloud;
  }

  return (
    <>
      <button
        onClick={() => { if (needsReconnect) { setReconnectAdmin(undefined); setIsReconnectOpen(true); } else setDetailsOpen(true); }}
        className={`flex items-center gap-1.5 px-3 py-1.5 border text-xs font-black uppercase transition rounded-none ${tone}`}
        title={title}
      >
        <Icon className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
        <span>{label}</span>
      </button>

      {isReconnectOpen && createPortal(<CloudReconnectModal isOpen originalAdminId={reconnectAdmin?.id} originalAdminEmail={reconnectAdmin?.email} onClose={() => setIsReconnectOpen(false)} />, document.body)}
      {detailsOpen && createPortal(
        <div className="fixed inset-0 z-[100] bg-slate-950/50 flex items-center justify-center p-3" onClick={() => setDetailsOpen(false)}>
          <section role="dialog" aria-modal="true" aria-label="Cloud sync details" className="w-full max-w-lg max-h-[90dvh] overflow-y-auto bg-white border-2 border-slate-900 p-5 text-slate-900" onClick={event => event.stopPropagation()}>
            <h2 className="text-lg font-black">Cloud sync details</h2>
            <p className="mt-3 text-sm">{pendingCount} queued on this device; {stuckCount} repeatedly rejected.</p>
            <p className="mt-2 text-sm">Last successful incoming check: {lastPulledAt ? new Date(lastPulledAt).toLocaleString() : 'Not completed yet'}</p>
            <p className="mt-2 text-sm">{realtimeConnected ? 'Live connection established.' : 'Live connection unavailable; checking for changes every 30 seconds while this app is visible.'}</p>
            <p className="mt-2 text-sm">Records still queued on another till cannot appear here until that till uploads them.</p>
            {schemaBlocked && <p className="mt-3 text-sm font-bold">The cloud database is missing a required column or table. Apply the database migration before retrying. PIN resets and refreshing the till cannot repair it.</p>}
            {(queueFault || cloudError || pullError || retryError) && <pre className="mt-4 whitespace-pre-wrap break-words text-xs bg-amber-50 border border-amber-300 p-3">{[queueFault?.reason, cloudError, pullError, retryError].filter(Boolean).join('\n\n')}</pre>}
            <div className="mt-5 flex flex-wrap gap-3">
              {originalAdmins.map(admin => <button key={admin.id} className="border border-amber-500 bg-amber-50 px-4 py-3 text-sm font-bold break-all" onClick={() => { setReconnectAdmin(admin); setDetailsOpen(false); setIsReconnectOpen(true); }}>Reconnect {admin.email}</button>)}
              <button className="bg-slate-900 text-white px-4 py-3 text-sm font-bold disabled:opacity-50" disabled={isSyncing} onClick={retry}>{isSyncing ? 'Sending…' : 'Retry sync now'}</button>
              <button className="border border-slate-400 px-4 py-3 text-sm font-bold" onClick={() => setDetailsOpen(false)}>Close</button>
            </div>
          </section>
        </div>
      , document.body)}
    </>
  );
};
