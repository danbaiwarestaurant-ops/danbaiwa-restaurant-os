export interface DeviceConfig {
  locationId: string;
  locationName: string;
  deviceId: string;
  deviceName: string;
  businessName: string;
  currencySymbol: string;
  presetAmounts: number[];
  /**
   * Thermal roll width in millimetres — 58 or 80.
   *
   * Part of DeviceConfig because DeviceConfig is what syncs to account_settings, and
   * the roll is a property of the business rather than of one till: an account that
   * moves to 80mm printers moves all of them, and a replacement till should not have
   * to be told again. Absent on configs saved before this existed, which reads as 58.
   */
  paperWidthMm?: 58 | 80;
  isConfigured: boolean;
}

export interface UserSession {
  userId: string;
  userName: string;
  role: 'cashier' | 'manager';
  pinHash?: string;
}
