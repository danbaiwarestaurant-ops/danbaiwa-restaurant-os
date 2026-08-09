import { create } from 'zustand';
import { UserSession } from '../types/config';
import { verifyPin } from '../services/auth/pinAuth';

interface AuthState {
  currentCashier: UserSession;
  activeRole: 'cashier' | 'manager';
  isPinModalOpen: boolean;
  pinModalPurpose: string | null;
  pinChallengeCallback: ((success: boolean) => void) | null;
  
  openPinModal: (purpose: string, onVerify: (success: boolean) => void) => void;
  closePinModal: () => void;
  validatePin: (pin: string) => Promise<boolean>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  currentCashier: {
    userId: 'CASHIER-01',
    userName: 'Main Till Cashier',
    role: 'cashier',
  },
  activeRole: 'cashier',
  isPinModalOpen: false,
  pinModalPurpose: null,
  pinChallengeCallback: null,

  openPinModal: (purpose: string, onVerify: (success: boolean) => void) => {
    set({
      isPinModalOpen: true,
      pinModalPurpose: purpose,
      pinChallengeCallback: onVerify,
    });
  },

  closePinModal: () => {
    set({
      isPinModalOpen: false,
      pinModalPurpose: null,
      pinChallengeCallback: null,
    });
  },

  validatePin: async (pin: string) => {
    const isValid = await verifyPin(pin, 'manager');
    const cb = get().pinChallengeCallback;
    if (cb) cb(isValid);
    if (isValid) get().closePinModal();
    return isValid;
  },
}));
