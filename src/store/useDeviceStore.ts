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
  staffMealOptions: [
    { id: 'food', name: 'Food', wageCharge: 500, isFree: true },
    { id: 'meat', name: 'Meat', wageCharge: 500, isFree: false },
    { id: 'fish', name: 'Fish', wageCharge: 500, isFree: false },
    { id: 'egg', name: 'Egg', wageCharge: 200, isFree: false },
  ],
  penaltyRules: [
    { id: 'son-zuciya', label: 'Son zuciya', fixedFee: 0 },
    { id: 'punctuality', label: 'Punctuality', fixedFee: 0 },
    { id: 'cleanliness', label: 'Cleanliness', fixedFee: 0 },
    { id: 'customer-engagement', label: 'Customer Engagement', fixedFee: 0 },
  ],
  performanceRewardRules: [
    { id: 'outstanding-sales', label: 'Outstanding sales', fixedAmount: 0 },
    { id: 'customer-praise', label: 'Customer praise', fixedAmount: 0 },
    { id: 'teamwork', label: 'Teamwork', fixedAmount: 0 },
    { id: 'extra-duty', label: 'Extra duty', fixedAmount: 0 },
  ],
  weekStartsOn: 1,
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
      set({ config: {
        ...defaultConfig,
        ...saved,
        staffMealOptions: saved.staffMealOptions ?? defaultConfig.staffMealOptions,
        penaltyRules: saved.penaltyRules ?? defaultConfig.penaltyRules,
        performanceRewardRules: saved.performanceRewardRules ?? defaultConfig.performanceRewardRules,
        weekStartsOn: saved.weekStartsOn ?? defaultConfig.weekStartsOn,
      }, isLoaded: true });
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
