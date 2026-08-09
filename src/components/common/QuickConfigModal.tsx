import React, { useState } from 'react';
import { useDeviceStore } from '../../store/useDeviceStore';
import { Settings, X, Save } from 'lucide-react';

interface QuickConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const QuickConfigModal: React.FC<QuickConfigModalProps> = ({ isOpen, onClose }) => {
  const { config, updateConfig } = useDeviceStore();
  const [businessName, setBusinessName] = useState(config.businessName);
  const [locationId, setLocationId] = useState(config.locationId);
  const [deviceId, setDeviceId] = useState(config.deviceId);
  const [currencySymbol, setCurrencySymbol] = useState(config.currencySymbol);
  const [presetsStr, setPresetsStr] = useState(config.presetAmounts.join(', '));

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const presets = presetsStr
      .split(',')
      .map(s => parseFloat(s.trim()))
      .filter(n => !isNaN(n) && n > 0);

    await updateConfig({
      businessName,
      locationId,
      deviceId,
      currencySymbol,
      presetAmounts: presets.length > 0 ? presets : config.presetAmounts,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white border-2 border-slate-900 w-full max-w-md overflow-hidden shadow-2xl rounded-none">
        <div className="bg-slate-900 text-white px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-sm text-amber-400">
            <Settings className="w-4 h-4" />
            <span>Device & Preset Settings</span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
              Business / Venue Name
            </label>
            <input
              type="text"
              value={businessName}
              onChange={e => setBusinessName(e.target.value)}
              className="w-full px-3 py-2 border-2 border-slate-300 rounded-none focus:border-amber-500 focus:outline-none font-semibold text-slate-800"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
                Location ID
              </label>
              <input
                type="text"
                value={locationId}
                onChange={e => setLocationId(e.target.value)}
                className="w-full px-3 py-2 border-2 border-slate-300 rounded-none focus:border-amber-500 focus:outline-none font-mono uppercase font-bold text-slate-800"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
                Device ID
              </label>
              <input
                type="text"
                value={deviceId}
                onChange={e => setDeviceId(e.target.value)}
                className="w-full px-3 py-2 border-2 border-slate-300 rounded-none focus:border-amber-500 focus:outline-none font-mono uppercase font-bold text-slate-800"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
              Currency Symbol
            </label>
            <input
              type="text"
              value={currencySymbol}
              onChange={e => setCurrencySymbol(e.target.value)}
              className="w-full px-3 py-2 border-2 border-slate-300 rounded-none focus:border-amber-500 focus:outline-none font-bold text-slate-800"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
              Preset Ticket Amounts (Comma Separated)
            </label>
            <input
              type="text"
              value={presetsStr}
              onChange={e => setPresetsStr(e.target.value)}
              className="w-full px-3 py-2 border-2 border-slate-300 rounded-none focus:border-amber-500 focus:outline-none font-mono text-sm text-slate-800"
              placeholder="200, 300, 400, 500, 1000"
              required
            />
            <p className="text-[11px] text-slate-500 mt-1">
              First 9 presets automatically map to keyboard hotkeys A, S, D, F, G, H, J, K, L.
            </p>
          </div>

          <div className="pt-3 border-t flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-bold uppercase border border-slate-300 rounded-none text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-black uppercase bg-amber-500 hover:bg-amber-600 text-white rounded-none border border-amber-600 shadow-xs"
            >
              <Save className="w-3.5 h-3.5" />
              <span>Save Settings</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
