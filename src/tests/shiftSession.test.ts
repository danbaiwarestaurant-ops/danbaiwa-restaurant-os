/**
 * shiftSession.test.ts
 *
 * A shift is the cashier's session: it opens when they sign in and closes when they sign
 * out. These cover the store-level guarantees that flow depends on — the App wires the UI
 * to them (see handleLogout and the data-loading effect in App.tsx).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useShiftStore } from '../store/useShiftStore';
import { useAuthStore } from '../store/useAuthStore';
import { useTicketStore } from '../store/useTicketStore';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';
import { dbService } from '../services/db/IndexedDbService';
import { UserAccount } from '../types/user';
import { paginateByShift, shiftTickets, summariseTickets } from '../utils/analytics';

const ada = { id: 'u-ada', name: 'Ada', role: 'cashier', status: 'active' } as unknown as UserAccount;
const bola = { id: 'u-bola', name: 'Bola', role: 'cashier', status: 'active' } as unknown as UserAccount;

describe('A shift is the cashier session', () => {
  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    await dbService.init();
    useShiftStore.setState({ currentShift: null, shiftHistory: [] });
    useTicketStore.setState({ tickets: [], scope: undefined });
    useAuthStore.setState({ activeUser: ada });
  });

  it('opens against the signed-in cashier, with no float to type in', async () => {
    const shift = await useShiftStore.getState().openShift(0, ada.name, ada.id);

    expect(shift.cashierId).toBe('u-ada');
    expect(shift.cashierName).toBe('Ada');
    expect(shift.status).toBe('open');
    expect(useShiftStore.getState().currentShift?.id).toBe(shift.id);
  });

  it('closing one leaves the till with no open shift, so tickets cannot be issued', async () => {
    await useShiftStore.getState().openShift(0, ada.name, ada.id);
    await useShiftStore.getState().closeShift(0, 'end of service');

    // PresetCardGrid and CustomAmountInput both refuse to print without this.
    expect(useShiftStore.getState().currentShift).toBeNull();
  });

  it("never hands one cashier the other's open shift", async () => {
    await useShiftStore.getState().openShift(0, ada.name, ada.id);

    // Bola signs in on the same till. Ada's shift is still open in the database — it must
    // not surface as Bola's, or Bola's takings would settle against Ada's drawer count.
    useAuthStore.setState({ activeUser: bola });
    await useShiftStore.getState().loadShift(bola.id);
    expect(useShiftStore.getState().currentShift).toBeNull();

    await useShiftStore.getState().loadShift(ada.id);
    expect(useShiftStore.getState().currentShift?.cashierId).toBe('u-ada');
  });

  it('records the takings against the shift that was open when they were rung up', async () => {
    const first = await useShiftStore.getState().openShift(0, ada.name, ada.id);
    await useTicketStore.getState().createAndPrintTicket(2000, ada.id);
    await useShiftStore.getState().closeShift(2000);

    const closed = (await dbService.getShifts()).find((s) => s.id === first.id)!;
    expect(closed.status).toBe('closed');
    expect(closed.expectedCash).toBe(2000);
    expect(closed.variance).toBe(0);

    // A second sign-in starts a clean shift: the previous session's sales are settled and
    // must not follow the next cashier into theirs.
    const second = await useShiftStore.getState().openShift(0, bola.name, bola.id);
    expect(second.id).not.toBe(first.id);
    expect(useShiftStore.getState().currentShift?.cashierId).toBe('u-bola');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What the till shows while a shift is running
// ─────────────────────────────────────────────────────────────────────────────

describe('The till header counts the shift, not the day', () => {
  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    await dbService.init();
    useShiftStore.setState({ currentShift: null, shiftHistory: [] });
    useTicketStore.setState({ tickets: [], scope: undefined });
    useAuthStore.setState({ activeUser: ada });
  });

  it("leaves the previous shift's takings out of the current one", async () => {
    // Ada works, closes, and Bola takes over the same till on the same day. The header is
    // what Bola checks her own drawer against, so Ada's ₦5,000 must not be in it.
    await useShiftStore.getState().openShift(0, ada.name, ada.id);
    await useTicketStore.getState().createAndPrintTicket(5000, ada.id);
    await useShiftStore.getState().closeShift(5000);

    useAuthStore.setState({ activeUser: bola });
    const bolasShift = await useShiftStore.getState().openShift(0, bola.name, bola.id);
    await useTicketStore.getState().createAndPrintTicket(2000, bola.id);
    await useTicketStore.getState().createAndPrintTicket(1000, bola.id);
    await useTicketStore.getState().loadTickets();

    const mine = shiftTickets(useTicketStore.getState().tickets, bolasShift);
    const totals = summariseTickets(mine);

    expect(totals.ticketCount).toBe(2);
    expect(totals.revenue).toBe(3000);
  });

  it('drops a voided ticket out of both the count and the total', async () => {
    const shift = await useShiftStore.getState().openShift(0, ada.name, ada.id);
    const first = await useTicketStore.getState().createAndPrintTicket(2500, ada.id);
    await useTicketStore.getState().createAndPrintTicket(1500, ada.id);
    await useTicketStore.getState().voidTicket(first.ticket!.id, 'wrong amount', ada.id);

    const totals = summariseTickets(shiftTickets(useTicketStore.getState().tickets, shift));
    expect(totals.ticketCount).toBe(1);
    expect(totals.revenue).toBe(1500);
  });
});

describe('The ticket sidebar breaks its pages on shift boundaries', () => {
  beforeEach(async () => {
    await Promise.all(TABLE_NAMES.map((name) => (db as any)[name].clear()));
    await dbService.init();
    useShiftStore.setState({ currentShift: null, shiftHistory: [] });
    useTicketStore.setState({ tickets: [], scope: undefined });
    useAuthStore.setState({ activeUser: ada });
  });

  it('never puts two shifts on one page, however few tickets each has', async () => {
    await useShiftStore.getState().openShift(0, ada.name, ada.id);
    await useTicketStore.getState().createAndPrintTicket(1000, ada.id);
    await useShiftStore.getState().closeShift(1000);

    useAuthStore.setState({ activeUser: bola });
    await useShiftStore.getState().openShift(0, bola.name, bola.id);
    await useTicketStore.getState().createAndPrintTicket(2000, bola.id);
    await useTicketStore.getState().loadTickets();

    const { tickets } = useTicketStore.getState();
    const { shiftHistory } = useShiftStore.getState();
    const pages = paginateByShift(tickets, shiftHistory, 8);

    // Two tickets, a page size of eight, and still two pages — the break is the handover.
    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(1);
    expect(pages[0][0].cashierId).toBe('u-bola');
    expect(pages[1][0].cashierId).toBe('u-ada');
  });

  it('still breaks a long shift every page-size tickets', async () => {
    const shift = await useShiftStore.getState().openShift(0, ada.name, ada.id);
    for (let i = 0; i < 5; i++) {
      await useTicketStore.getState().createAndPrintTicket(100 * (i + 1), ada.id);
    }
    await useTicketStore.getState().loadTickets();

    const pages = paginateByShift(useTicketStore.getState().tickets, [shift], 2);
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
  });

  it('keeps tickets that belong to no shift in their own group', async () => {
    // An admin who never opened a shift can still issue tickets. Those must not be swept
    // into whichever shift happens to sit next to them in the list.
    const shift = await useShiftStore.getState().openShift(0, ada.name, ada.id);
    await useTicketStore.getState().createAndPrintTicket(1000, ada.id);
    await useTicketStore.getState().createAndPrintTicket(2000, 'u-nobody');
    await useTicketStore.getState().loadTickets();

    const pages = paginateByShift(useTicketStore.getState().tickets, [shift], 8);
    expect(pages).toHaveLength(2);
  });
});
