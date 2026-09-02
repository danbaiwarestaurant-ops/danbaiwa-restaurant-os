import React, { useState } from 'react';
import { useDeviceStore } from '../../../store/useDeviceStore';
import { useSyncStore } from '../../../store/useSyncStore';
import { Panel, DataTable, StatusBadge, ConsoleButton } from '../ConsoleUI';
import { AdminProfileSettings } from '../AdminProfileSettings';
import { RecoveryKeySettings } from '../RecoveryKeySettings';
import { DeviceAccessSettings } from '../DeviceAccessSettings';
import { PrinterSettings } from '../PrinterSettings';
import { Settings as SettingsIcon, Cloud } from 'lucide-react';

export const SettingsView: React.FC = () => {
  const { config, updateConfig } = useDeviceStore();
  const { cloudConnected, pendingCount, stuckCount, lastSyncedAt, isOnline } = useSyncStore();

  const [businessName, setBusinessName] = useState(config.businessName);
  const [locationName, setLocationName] = useState(config.locationName);
  const [locationId, setLocationId] = useState(config.locationId);
  const [deviceId, setDeviceId] = useState(config.deviceId);
  const [currencySymbol, setCurrencySymbol] = useState(config.currencySymbol);
  const [presets, setPresets] = useState(config.presetAmounts.join(', '));
  const [saved, setSaved] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = presets
      .split(',')
      .map((s) => parseFloat(s.trim()))
      .filter((n) => !isNaN(n) && n > 0);

    await updateConfig({
      businessName,
      locationName,
      locationId,
      deviceId,
      currencySymbol,
      presetAmounts: parsed.length > 0 ? parsed : config.presetAmounts,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const field = 'w-full p-2.5 border-2 border-slate-300 rounded-none text-xs font-semibold text-slate-900 focus:border-amber-500 focus:outline-none';
  const label = 'block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1.5';

  return (
    <div className="space-y-4">
      <Panel
        title="Business Settings"
        subtitle="These follow your account to every device you sign in on"
        icon={SettingsIcon}
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={label}>Business Name</label>
              <input className={field} value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
            </div>
            <div>
              <label className={label}>Location Name</label>
              <input className={field} value={locationName} onChange={(e) => setLocationName(e.target.value)} />
            </div>
            <div>
              <label className={label}>Location ID</label>
              <input className={field} value={locationId} onChange={(e) => setLocationId(e.target.value)} />
            </div>
            <div>
              <label className={label}>Device ID</label>
              <input className={field} value={deviceId} onChange={(e) => setDeviceId(e.target.value)} />
            </div>
            <div>
              <label className={label}>Currency Symbol</label>
              <input className={field} value={currencySymbol} onChange={(e) => setCurrencySymbol(e.target.value)} />
            </div>
            <div>
              <label className={label}>Preset Amounts (comma separated)</label>
              <input className={field} value={presets} onChange={(e) => setPresets(e.target.value)} />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <ConsoleButton variant="primary">Save Settings</ConsoleButton>
            {saved && (
              <span className="text-[11px] font-black uppercase text-emerald-700">
                Saved — syncing to your other devices
              </span>
            )}
          </div>
        </form>
      </Panel>

      <Panel title="Cloud Sync" icon={Cloud}>
        <DataTable headers={['Item', 'Status']} alignRight={[1]}>
          <tr>
            <td className="py-2.5 font-semibold text-slate-700">Cloud session</td>
            <td className="py-2.5 text-right">
              <StatusBadge tone={cloudConnected ? 'ok' : 'danger'}>
                {cloudConnected ? 'Connected' : 'Not signed in'}
              </StatusBadge>
            </td>
          </tr>
          <tr>
            <td className="py-2.5 font-semibold text-slate-700">Network</td>
            <td className="py-2.5 text-right">
              <StatusBadge tone={isOnline ? 'ok' : 'warn'}>{isOnline ? 'Online' : 'Offline'}</StatusBadge>
            </td>
          </tr>
          <tr>
            <td className="py-2.5 font-semibold text-slate-700">Records awaiting upload</td>
            <td className="py-2.5 text-right">
              <StatusBadge tone={pendingCount ? 'warn' : 'ok'}>{pendingCount || 'None'}</StatusBadge>
            </td>
          </tr>
          <tr>
            <td className="py-2.5 font-semibold text-slate-700">Records needing attention</td>
            <td className="py-2.5 text-right">
              <StatusBadge tone={stuckCount ? 'danger' : 'ok'}>{stuckCount || 'None'}</StatusBadge>
            </td>
          </tr>
          <tr>
            <td className="py-2.5 font-semibold text-slate-700">Last successful sync</td>
            <td className="py-2.5 text-right font-mono text-[11px] text-slate-600">
              {lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : '—'}
            </td>
          </tr>
        </DataTable>
      </Panel>

      <DeviceAccessSettings />

      <RecoveryKeySettings />

      {/* Existing component — admin profile and PIN change. */}
      <PrinterSettings />

      <AdminProfileSettings onLogoutAdmin={() => { /* handled by the account menu */ }} />
    </div>
  );
};
