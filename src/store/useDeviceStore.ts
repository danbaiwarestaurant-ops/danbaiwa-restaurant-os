import { create } from 'zustand';
import { DeviceConfig } from '../types/config';
import { dbService } from '../services/db/IndexedDbService';
import { cleanBusinessDayStartHour, BUSINESS_DAY_START_HOUR } from '../utils/shiftDay';

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
  businessDayStartHour: BUSINESS_DAY_START_HOUR,
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
        businessDayStartHour: cleanBusinessDayStartHour(saved.businessDayStartHour),
      }, isLoaded: true });
    } else {
      set({ config: defaultConfig, isLoaded: true });
    }
  },

  updateConfig: async (newConfig: Partial<DeviceConfig>) => {
    if (newConfig.businessDayStartHour !== undefined && (!Number.isInteger(newConfig.businessDayStartHour) || newConfig.businessDayStartHour < 0 || newConfig.businessDayStartHour > 23)) {
      throw new Error('Starting hour of day must be a whole hour from 00:00 to 23:00.');
    }
    const previous = get().config;
    const updated = { ...previous, ...newConfig };
    set({ config: updated });
    try { await dbService.saveDeviceConfig(updated); }
    catch (error) {
      if (get().config === updated) set({ config: previous });
      throw error;
    }
  },
}));
