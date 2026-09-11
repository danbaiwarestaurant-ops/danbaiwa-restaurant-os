/**
 * shiftDay.test.ts
 *
 * The trading-day boundary that decides when an open shift has outlived its day.
 *
 * These are the arithmetic the forced close-out stands on (see settleShiftForSignIn in
 * App.tsx), and date arithmetic is exactly where this kind of bug hides — a shift wrongly
 * judged stale interrupts a service that is still running, and one wrongly judged current
 * is the original fault: two days of takings reconciled as one.
 *
 * Local time throughout, constructed with `new Date(y, m, d, h)` rather than ISO strings,
 * so these assert the behaviour a restaurant sees on its own clock in any timezone.
 */

import { describe, it, expect } from 'vitest';
import { businessDayKey, isStaleShift, staleDayCount, BUSINESS_DAY_START_HOUR } from '../utils/shiftDay';
import { Shift } from '../types/shift';

const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min);

const openShiftAt = (opened: Date): Pick<Shift, 'status' | 'openedAt'> => ({
  status: 'open',
  openedAt: opened.toISOString(),
});

describe('the trading day a shift belongs to', () => {
  it('reads an evening as its own calendar day', () => {
    expect(businessDayKey(at(2026, 9, 10, 20))).toBe('2026-09-10');
  });

  it('keeps late-night service on the day it started', () => {
    // 00:30 on the 11th is the evening of the 10th — the crew is working one service,
    // not two, and midnight is not a boundary any kitchen recognises.
    expect(businessDayKey(at(2026, 9, 11, 0, 30))).toBe('2026-09-10');
    expect(businessDayKey(at(2026, 9, 11, BUSINESS_DAY_START_HOUR - 1, 59))).toBe('2026-09-10');
  });

  it('turns over at the start hour', () => {
    expect(businessDayKey(at(2026, 9, 11, BUSINESS_DAY_START_HOUR))).toBe('2026-09-11');
  });

  it('says nothing about a date it cannot parse', () => {
    expect(businessDayKey('not a date')).toBe('');
  });
});

describe('deciding an open shift has outlived its day', () => {
  it('leaves a shift opened this morning alone', () => {
    const shift = openShiftAt(at(2026, 9, 10, 9));
    expect(isStaleShift(shift, at(2026, 9, 10, 18))).toBe(false);
  });

  it('leaves a shift alone while its service runs past midnight', () => {
    // Opened 8pm, still going at 1am. This is the case that must not fire: forcing a cash
    // count on a cashier mid-service is worse than the bug being fixed.
    const shift = openShiftAt(at(2026, 9, 10, 20));
    expect(isStaleShift(shift, at(2026, 9, 11, 1))).toBe(false);
  });

  it('flags last night\'s shift once the new trading day has started', () => {
    const shift = openShiftAt(at(2026, 9, 10, 20));
    expect(isStaleShift(shift, at(2026, 9, 11, 9))).toBe(true);
  });

  it('flags a shift that has been open for days', () => {
    const shift = openShiftAt(at(2026, 9, 7, 11));
    expect(isStaleShift(shift, at(2026, 9, 10, 11))).toBe(true);
    expect(staleDayCount(shift, at(2026, 9, 10, 11))).toBe(3);
  });

  it('counts no days behind for a shift that is still today\'s', () => {
    const shift = openShiftAt(at(2026, 9, 10, 9));
    expect(staleDayCount(shift, at(2026, 9, 10, 23))).toBe(0);
  });

  it('never flags a shift that is already closed', () => {
    const shift = { status: 'closed' as const, openedAt: at(2026, 9, 1, 9).toISOString() };
    expect(isStaleShift(shift, at(2026, 9, 10, 9))).toBe(false);
  });

  it('never flags nothing at all', () => {
    expect(isStaleShift(null, at(2026, 9, 10, 9))).toBe(false);
    expect(isStaleShift(undefined, at(2026, 9, 10, 9))).toBe(false);
  });

  it('never forces a close it cannot explain', () => {
    // A shift whose openedAt cannot be read is one the till can say nothing about, so it
    // must not demand a cash count against it.
    const shift = { status: 'open' as const, openedAt: 'corrupt' };
    expect(isStaleShift(shift, at(2026, 9, 10, 9))).toBe(false);
  });

  it('survives a month boundary', () => {
    const shift = openShiftAt(at(2026, 8, 31, 21));
    expect(isStaleShift(shift, at(2026, 9, 1, 2))).toBe(false);
    expect(isStaleShift(shift, at(2026, 9, 1, 10))).toBe(true);
    expect(staleDayCount(shift, at(2026, 9, 1, 10))).toBe(1);
  });
});
