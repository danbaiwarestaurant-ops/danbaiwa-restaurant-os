import { create } from 'zustand';
import { Ticket, TicketStatus } from '../types/ticket';
import { dbService } from '../services/db/LocalStorageDbService';
import { generateCompositeKey } from '../utils/compositeKey';
import { PrintAdapter } from '../services/print/PrintAdapter';
import { useDeviceStore } from './useDeviceStore';

interface TicketState {
  tickets: Ticket[];
  ticketsTodayCount: number;
  isLoading: boolean;
  activeFlashingAmount: number | null;
  loadTickets: (userId?: string) => Promise<void>;
  createAndPrintTicket: (amount: number, cashierId?: string) => Promise<{ success: boolean; ticket?: Ticket; message: string }>;
  markCollected: (ticketId: string) => Promise<void>;
  voidTicket: (ticketId: string, reason: string, voidedBy: string) => Promise<void>;
  triggerFlash: (amount: number) => void;
}

export const useTicketStore = create<TicketState>((set, get) => ({
  tickets: [],
  ticketsTodayCount: 0,
  isLoading: false,
  activeFlashingAmount: null,

  loadTickets: async (userId?: string) => {
    set({ isLoading: true });
    await dbService.init();
    const tickets = await dbService.getTickets(userId);
    
    // Count today's tickets
    const todayStr = new Date().toISOString().split('T')[0];
    const todayCount = tickets.filter(t => t.createdAt.startsWith(todayStr) && t.status !== 'void').length;

    set({ tickets, ticketsTodayCount: todayCount, isLoading: false });
  },

  createAndPrintTicket: async (amount: number, cashierId: string = 'CASHIER-01') => {
    const config = useDeviceStore.getState().config;
    const locationId = config.locationId || 'LOC01';
    const deviceId = config.deviceId || 'DEV01';

    // Synchronous memory sequence calculation for 0ms delay
    const currentTickets = get().tickets;
    const nextSeq = currentTickets.length > 0 ? currentTickets[0].localSeq + 1 : 1;
    const compositeId = generateCompositeKey(locationId, deviceId, nextSeq);
    const nowIso = new Date().toISOString();

    const newTicket: Ticket = {
      id: compositeId,
      locationId,
      deviceId,
      localSeq: nextSeq,
      amount,
      currency: config.currencySymbol || '₦',
      status: 'paid',
      createdAt: nowIso,
      cashierId,
      qrPayload: `TICKET|${compositeId}|${amount}|${nowIso}`,
    };

    // 1. INSTANT SYNCHRONOUS UI STATE UPDATE (<1ms)
    const updatedTickets = [newTicket, ...currentTickets];
    const todayStr = nowIso.split('T')[0];
    const todayCount = updatedTickets.filter(t => t.createdAt.startsWith(todayStr) && t.status !== 'void').length;

    set({ tickets: updatedTickets, ticketsTodayCount: todayCount });

    // 2. Visual Flash effect
    get().triggerFlash(amount);

    // 3. Dispatch Thermal Print immediately
    const printRes = await PrintAdapter.printTicket(newTicket, config.businessName);

    // 4. Non-blocking asynchronous local DB persist
    setTimeout(() => {
      dbService.saveTicket(newTicket).catch(console.error);
    }, 0);

    return {
      success: true,
      ticket: newTicket,
      message: printRes.message,
    };
  },

  markCollected: async (ticketId: string) => {
    await dbService.updateTicketStatus(ticketId, 'collected');
    await get().loadTickets();
  },

  voidTicket: async (ticketId: string, reason: string, voidedBy: string) => {
    await dbService.updateTicketStatus(ticketId, 'void', reason, voidedBy);
    await get().loadTickets();
  },

  triggerFlash: (amount: number) => {
    set({ activeFlashingAmount: amount });
    setTimeout(() => {
      if (get().activeFlashingAmount === amount) {
        set({ activeFlashingAmount: null });
      }
    }, 250);
  },
}));
