/**
 * shiftDay.ts
 *
 * Which trading day a shift belongs to, and whether an open one has outlived it.
 *
 * Nothing in the till ever closed a shift on its own: a shift opens when a cashier signs
 * in and ends only when a person counts the drawer. A cashier who signed out at night
 * without closing was handed the same shift back the next morning, so a second day of
 * tickets was filed against it and expected cash accumulated across both. The variance
 * recorded when it was finally closed covered two days of trading and belonged to nobody.
 *
 * The boundary is NOT midnight. A kitchen still serving at 00:30 is working the evening
 * that started the night before, and cutting the shift underneath them would be worse
 * than the bug — so the trading day runs from BUSINESS_DAY_START_HOUR to the same hour
 * the following morning. Local time throughout, for the reason period.ts gives: the day
 * a restaurant works to is the one on its own clock.
 */

import { Shift } from '../types/shift';

/**
 * When one trading day gives way to the next.
 *
 * 06:00: late enough that a night that ran long is still counted as the night before,
 * and early enough to be ahead of the first delivery or prep shift. A restaurant that
 * genuinely trades through this hour would want it moved; it is a single constant so
 * that stays a one-line change.
 */
export const BUSINESS_DAY_START_HOUR = 6;

/**
 * The trading day an instant falls in, as local YYYY-MM-DD.
 *
 * Anything before the start hour counts as the previous calendar day — 00:30 on the 12th
 * is the evening of the 11th.
 */
export function businessDayKey(
  iso: string | Date,
  startHour: number = BUSINESS_DAY_START_HOUR
): string {
  const at = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  const shifted = new Date(at);
  if (shifted.getHours() < startHour) shifted.setDate(shifted.getDate() - 1);

  const m = String(shifted.getMonth() + 1).padStart(2, '0');
  const d = String(shifted.getDate()).padStart(2, '0');
  return `${shifted.getFullYear()}-${m}-${d}`;
}

/**
 * True when this shift is open and was opened on an earlier trading day.
 *
 * A shift with an unparseable openedAt is deliberately NOT stale: the till must never
 * force a close-out it cannot explain, and a shift it cannot date is one it cannot say
 * anything about.
 */
export function isStaleShift(
  shift: Pick<Shift, 'status' | 'openedAt'> | null | undefined,
  now: Date = new Date(),
  startHour: number = BUSINESS_DAY_START_HOUR
): boolean {
  if (!shift || shift.status !== 'open') return false;

  const openedOn = businessDayKey(shift.openedAt, startHour);
  if (!openedOn) return false;

  return openedOn < businessDayKey(now, startHour);
}

/** How many trading days an open shift has been running. 0 while it is still today's. */
export function staleDayCount(
  shift: Pick<Shift, 'status' | 'openedAt'>,
  now: Date = new Date(),
  startHour: number = BUSINESS_DAY_START_HOUR
): number {
  if (!isStaleShift(shift, now, startHour)) return 0;

  // Compared as trading days rather than elapsed hours, so the answer matches the dates
  // the cashier is being shown rather than drifting with the time of day.
  const from = Date.parse(`${businessDayKey(shift.openedAt, startHour)}T00:00:00`);
  const to = Date.parse(`${businessDayKey(now, startHour)}T00:00:00`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;

  return Math.round((to - from) / 86_400_000);
}
