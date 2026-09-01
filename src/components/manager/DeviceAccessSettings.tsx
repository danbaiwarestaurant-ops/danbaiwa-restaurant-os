import React, { useCallback, useEffect, useState } from 'react';
import { MonitorSmartphone, Loader2, ShieldOff, ShieldCheck, RefreshCw } from 'lucide-react';
import { supabase, isSupabaseConfigured } from '../../services/supabase/supabaseClient';
import { loadDeviceIdentity } from '../../services/supabase/deviceIdentity';

interface DeviceRow {
  auth_user_id: string;
  account_id: string;
  device_id: string | null;
  location_id: string | null;
  label: string | null;
  status: string;
  enrolled_at: string;
  last_seen_at: string | null;
}

/**
 * The owner's view of every till enrolled with the account, and the switch that cuts one
 * off.
 *
 * This is the point of giving tills their own cloud identity. Previously every device
 * shared the owner's single login, so there was no such thing as revoking one machine:
 * the only lever was changing the admin PIN, which locks out every till at once and
 * changes how the owner signs in everywhere. Revoking here takes effect server-side
 * immediately — the till keeps working locally and keeps its data, it just stops being
 * able to read or write the account's cloud records.
 */
export const DeviceAccessSettings: React.FC = () => {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [thisDeviceId, setThisDeviceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    setError(null);
    try {
      const identity = await loadDeviceIdentity();
      setThisDeviceId(identity?.authUserId ?? null);

      const { data, error: qErr } = await supabase
        .from('account_devices')
        .select('*')
        .order('enrolled_at', { ascending: false });

      if (qErr) throw new Error(qErr.message);
      setDevices((data as DeviceRow[]) ?? []);
    } catch (e: any) {
      const message = e?.message ?? 'Could not read the device list.';
      // A project whose schema migration has not been run yet is not a fault to shout
      // about — it is a step that has not happened. Say which step.
      setError(
        /account_devices/i.test(message)
          ? 'Per-till cloud access is not set up on this Supabase project yet. Run supabase_schema.sql in the SQL Editor (see DEPLOYMENT.md §3a); until then every till syncs using the admin sign-in, exactly as before.'
          : message
      );
      setDevices([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setStatus = async (device: DeviceRow, status: 'active' | 'revoked') => {
    const name = device.label || device.device_id || 'this till';
    if (
      status === 'revoked' &&
      !window.confirm(
        `Revoke cloud access for ${name}?\n\n` +
          'It keeps working as a till and keeps everything already on it, but it stops sending to and receiving from the cloud immediately. ' +
          'An admin signing in on that machine with their PIN can enrol it again.'
      )
    ) {
      return;
    }

    setBusyId(device.auth_user_id);
    setError(null);
    try {
      const { error: uErr } = await supabase
        .from('account_devices')
        .update({ status })
        .eq('auth_user_id', device.auth_user_id);
      if (uErr) throw new Error(uErr.message);
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Could not change that device.');
    } finally {
      setBusyId(null);
    }
  };

  const when = (iso: string | null) => {
    if (!iso) return 'never';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
  };

  if (!isSupabaseConfigured) return null;

  return (
    <div className="bg-white border-2 border-slate-300 p-5 shadow-xs rounded-none space-y-4">
      <div className="flex items-center justify-between border-b-2 border-slate-200 pb-3">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-2">
          <MonitorSmartphone className="w-4 h-4 text-amber-500" />
          <span>Tills Connected to This Account</span>
        </h3>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1 border border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-700 text-[11px] font-black uppercase rounded-none disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      <p className="text-[11px] font-semibold text-slate-600 normal-case leading-relaxed">
        Each till signs in to the cloud as itself, so it can reconnect on its own without
        anyone entering a PIN. Revoking one cuts that till off from the account
        immediately — it keeps working and keeps its own records, it simply stops syncing.
      </p>

      {error && (
        <div
          className={`p-3 border-2 text-[11px] font-semibold normal-case rounded-none ${
            /not set up/i.test(error)
              ? 'bg-amber-50 border-amber-400 text-amber-950'
              : 'bg-rose-50 border-rose-400 text-rose-900'
          }`}
        >
          {error}
        </div>
      )}

      {devices === null ? (
        <div className="py-6 flex items-center justify-center gap-2 text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-xs font-bold uppercase">Loading tills…</span>
        </div>
      ) : devices.length === 0 ? (
        <div className="p-4 border-2 border-dashed border-slate-300 text-center">
          <p className="text-xs font-bold uppercase text-slate-600">No tills enrolled yet</p>
          <p className="text-[11px] font-semibold text-slate-500 normal-case mt-1">
            A till enrols itself the next time an admin signs in on it.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-2 border-slate-200">
            <thead className="bg-slate-100">
              <tr className="text-[10px] font-black uppercase tracking-wider text-slate-600">
                <th className="px-3 py-2 border-b-2 border-slate-200">Till</th>
                <th className="px-3 py-2 border-b-2 border-slate-200">Enrolled</th>
                <th className="px-3 py-2 border-b-2 border-slate-200">Last Seen</th>
                <th className="px-3 py-2 border-b-2 border-slate-200">Status</th>
                <th className="px-3 py-2 border-b-2 border-slate-200 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {devices.map((d) => {
                const isThis = d.auth_user_id === thisDeviceId;
                const isActive = d.status === 'active';
                return (
                  <tr key={d.auth_user_id} className={isThis ? 'bg-amber-50' : ''}>
                    <td className="px-3 py-2.5">
                      <div className="text-xs font-black text-slate-900">
                        {d.label || d.device_id || 'Unnamed till'}
                        {isThis && (
                          <span className="ml-2 px-1.5 py-0.5 bg-amber-500 text-white text-[9px] font-black uppercase">
                            This device
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] font-mono text-slate-500">
                        {d.location_id || '—'}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-[11px] font-semibold text-slate-600 normal-case">
                      {when(d.enrolled_at)}
                    </td>
                    <td className="px-3 py-2.5 text-[11px] font-semibold text-slate-600 normal-case">
                      {when(d.last_seen_at)}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 border text-[10px] font-black uppercase ${
                          isActive
                            ? 'bg-emerald-50 border-emerald-400 text-emerald-900'
                            : 'bg-rose-50 border-rose-400 text-rose-900'
                        }`}
                      >
                        {isActive ? <ShieldCheck className="w-3 h-3" /> : <ShieldOff className="w-3 h-3" />}
                        {isActive ? 'Active' : 'Revoked'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        onClick={() => setStatus(d, isActive ? 'revoked' : 'active')}
                        disabled={busyId === d.auth_user_id}
                        className={`px-3 py-1 text-[11px] font-black uppercase border rounded-none disabled:opacity-50 ${
                          isActive
                            ? 'bg-rose-600 hover:bg-rose-700 border-rose-700 text-white'
                            : 'bg-slate-800 hover:bg-slate-900 border-slate-900 text-white'
                        }`}
                      >
                        {busyId === d.auth_user_id ? '…' : isActive ? 'Revoke' : 'Re-enable'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
