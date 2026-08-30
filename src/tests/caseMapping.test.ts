import { describe, it, expect } from 'vitest';
import { toSnakeCase, toCamelCase } from '../utils/caseMapping';

describe('caseMapping', () => {
  it('converts camelCase to snake_case', () => {
    const ticket = {
      id: 'LOC01-DEV01-SEQ001',
      locationId: 'LOC01',
      localSeq: 1,
      cashierId: 'cashier-1',
      qrPayload: 'qr-text',
    };
    const row = toSnakeCase(ticket);
    expect(row.location_id).toBe('LOC01');
    expect(row.local_seq).toBe(1);
    expect(row.cashier_id).toBe('cashier-1');
    expect(row.qr_payload).toBe('qr-text');
    expect(row.locationId).toBeUndefined();
  });

  it('converts snake_case to camelCase', () => {
    const row = {
      id: 'LOC01-DEV01-SEQ001',
      location_id: 'LOC01',
      local_seq: 1,
      cashier_id: 'cashier-1',
      qr_payload: 'qr-text',
      updated_at: '2026-08-29T12:00:00.000Z',
    };
    const obj = toCamelCase(row);
    expect(obj.locationId).toBe('LOC01');
    expect(obj.localSeq).toBe(1);
    expect(obj.cashierId).toBe('cashier-1');
    expect(obj.qrPayload).toBe('qr-text');
    expect(obj.updatedAt).toBe('2026-08-29T12:00:00.000Z');
    expect(obj.location_id).toBeUndefined();
  });

  it('round-trips a ticket-shaped row through both directions', () => {
    const ticket = {
      id: 'LOC01-DEV01-SEQ001',
      locationId: 'LOC01',
      deviceId: 'DEV01',
      localSeq: 1,
      amount: 500,
      currency: '₦',
      status: 'paid',
      cashierId: 'cashier-1',
      createdAt: '2026-08-29T12:00:00.000Z',
      qrPayload: 'TICKET|1|500',
      voidReason: null,
      voidedBy: null,
      voidedAt: null,
      updatedAt: '2026-08-29T12:00:00.000Z',
    };
    expect(toCamelCase(toSnakeCase(ticket))).toEqual(ticket);
  });

  it('round-trips a shift-shaped row, including numeric and boolean-ish fields', () => {
    const shift = {
      id: 'shift-1',
      cashierId: 'cashier-1',
      cashierName: 'Test Cashier',
      locationId: 'LOC01',
      deviceId: 'DEV01',
      status: 'open',
      openingFloat: 5000,
      openedAt: '2026-08-29T08:00:00.000Z',
      closedAt: null,
      countedCash: null,
      expectedCash: null,
      variance: null,
      notes: null,
    };
    expect(toCamelCase(toSnakeCase(shift))).toEqual(shift);
  });

  it('leaves already-flat keys and non-object values untouched', () => {
    expect(toSnakeCase({ id: 'x', count: 3, active: true })).toEqual({ id: 'x', count: 3, active: true });
    expect(toCamelCase({ id: 'x', count: 3, active: true })).toEqual({ id: 'x', count: 3, active: true });
  });
});
