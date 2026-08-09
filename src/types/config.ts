export interface DeviceConfig {
  locationId: string;
  locationName: string;
  deviceId: string;
  deviceName: string;
  businessName: string;
  currencySymbol: string;
  presetAmounts: number[];
  isConfigured: boolean;
}

export interface UserSession {
  userId: string;
  userName: string;
  role: 'cashier' | 'manager';
  pinHash?: string;
}
