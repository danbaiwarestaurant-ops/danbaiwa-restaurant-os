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
