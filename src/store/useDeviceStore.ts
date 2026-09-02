import { create } from 'zustand';
import { DeviceConfig } from '../types/config';
import { dbService } from '../services/db/IndexedDbService';

interface DeviceState {
  config: DeviceConfig;
  isLoaded: boolean;
  loadConfig: () => Promise<void>;
  updateConfig: (newConfig: Partial<DeviceConfig>) => Promise<void>;
}

const defaultConfig: DeviceConfig = {
  locationId: 'LOC01',
  locationName: 'Danbaiwa Restraunt',
  deviceId: 'DEV01',
  deviceName: 'Till Alpha 1',
  businessName: 'Danbaiwa Restraunt',
  currencySymbol: '₦',
  presetAmounts: [200, 300, 400, 500, 1000],
  paperWidthMm: 58,
  isConfigured: true,
};

export const useDeviceStore = create<DeviceState>((set, get) => ({
  config: defaultConfig,
  isLoaded: false,

  loadConfig: async () => {
    await dbService.init();
    const saved = await dbService.getDeviceConfig();
    if (saved) {
      set({ config: saved, isLoaded: true });
    } else {
      set({ config: defaultConfig, isLoaded: true });
    }
  },

  updateConfig: async (newConfig: Partial<DeviceConfig>) => {
    const updated = { ...get().config, ...newConfig };
    set({ config: updated });
    await dbService.saveDeviceConfig(updated);
  },
}));
