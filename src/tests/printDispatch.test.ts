import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrintAdapter, resetPrintServerCache } from '../services/print/PrintAdapter';
import * as direct from '../services/print/directPrinter';
import { Ticket } from '../types/ticket';
import { db } from '../services/db/dexieSchema';

vi.mock('../services/print/escpos', () => ({
  buildTicketReceipt: async (spec: { ticketId: string }) => new TextEncoder().encode(spec.ticketId),
  bytesToBase64: () => '', paperSpec: () => ({}),
}));
const ticket = (id: string) => ({ id, amount: 500, currency: 'N', createdAt: new Date().toISOString() }) as Ticket;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetPrintServerCache(); });

describe('receipt dispatch', () => {
  it('reuses an open serial connection and releases its writer between receipts', async () => {
    const writer = { write: vi.fn(async () => {}), releaseLock: vi.fn(), close: vi.fn() };
    const port: any = { writable: null, getInfo: () => ({}), close: vi.fn() };
    port.open = vi.fn(async () => { port.writable = { getWriter: () => writer }; });
    vi.stubGlobal('navigator', { serial: { requestPort: vi.fn(), getPorts: async () => [port] } });
    await db.config.put({ key: 'printer_link', value: { transport: 'serial', baudRate: 9600 } });
    await direct.printDirect(new Uint8Array([1]));
    await direct.printDirect(new Uint8Array([2]));
    expect(port.open).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledTimes(2);
    expect(writer.releaseLock).toHaveBeenCalledTimes(2);
    expect(writer.close).not.toHaveBeenCalled();
    expect(port.close).not.toHaveBeenCalled();
    await db.config.delete('printer_link');
  });

  it('marks an incomplete USB transfer as uncertain instead of claiming success', async () => {
    const device = { opened: true, configuration: {}, configurations: [{ interfaces: [{ interfaceNumber: 1, alternates: [{ interfaceClass: 7, endpoints: [{ direction: 'out', type: 'bulk', endpointNumber: 1 }] }] }] }], claimInterface: vi.fn(), releaseInterface: vi.fn(), transferOut: async () => ({ status: 'ok', bytesWritten: 1 }) };
    vi.stubGlobal('navigator', { usb: { requestDevice: vi.fn(), getDevices: async () => [device] } });
    await db.config.put({ key: 'printer_link', value: { transport: 'usb' } });
    await expect(direct.printDirect(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ dispatchUncertain: true });
    await db.config.delete('printer_link');
  });

  it('serialises rapid receipts before acquiring a printer port', async () => {
    vi.spyOn(direct, 'isDirectPrinterReady').mockResolvedValue(true);
    let release!: () => void;
    const hold = new Promise<void>(done => { release = done; });
    const sent: string[] = [];
    vi.spyOn(direct, 'printDirect').mockImplementation(async bytes => {
      sent.push(new TextDecoder().decode(bytes));
      if (sent.length === 1) await hold;
    });
    const first = PrintAdapter.printTicket(ticket('first'));
    const second = PrintAdapter.printTicket(ticket('second'));
    await vi.waitFor(() => expect(sent).toEqual(['first']));
    release();
    expect((await first).success).toBe(true);
    expect((await second).success).toBe(true);
    expect(sent).toEqual(['first', 'second']);
  });

  it('does not print a second copy through the agent after a partial direct dispatch', async () => {
    vi.spyOn(direct, 'isDirectPrinterReady').mockResolvedValue(true);
    vi.spyOn(direct, 'printDirect').mockRejectedValue(Object.assign(new Error('Dispatch uncertain'), { dispatchUncertain: true }));
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await PrintAdapter.printTicket(ticket('uncertain'));
    expect(result.success).toBe(false);
    expect(result.message).toBe('Dispatch uncertain');
    expect(fetch).not.toHaveBeenCalled();
  });
});
