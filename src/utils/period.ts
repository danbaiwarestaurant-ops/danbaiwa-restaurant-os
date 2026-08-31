/**
 * period.ts
 *
 * The reporting window every console view answers for.
 *
 * A restaurant's questions are "how did this week go", "how does August compare to July",
 * "what did last year total" — never "what is the sum of everything since installation".
 * An all-time figure grows monotonically and so says nothing: it cannot fall, cannot be
 * compared to anything, and quietly buries a bad month inside a good year.
 *
 * So the console has no all-time anywhere. Every view reads one Period, and the period is
 * navigable backwards through history.
 *
 * Pure and free of React so the boundary arithmetic — which is where date bugs live — is
 * unit-testable. All boundaries are local time: a shift that opens at 23:50 belongs to the
 * day the staff worked, not to whichever UTC day it happens to land in.
 */

export type PeriodUnit = 'day' | 'week' | 'month' | 'year';

export interface Period {
  unit: PeriodUnit;
  /** Inclusive start, local midnight. */
  start: Date;
  /** Exclusive end — the first instant of the next period. */
  end: Date;
  /** Human label, e.g. "18 – 24 Aug 2026", "August 2026", "2026". */
  label: string;
}

/** Local midnight of the given date, without mutating it. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Monday-based week start.
 *
 * `getDay()` is 0 for Sunday, so the naive `date - getDay()` gives Sunday-based weeks and
 * puts Monday's trading at the end of the *previous* week — the exact off-by-one that makes
 * a Monday's takings disappear from the week a manager is looking at.
 */
function startOfWeek(d: Date): Date {
  const day = startOfDay(d);
  const dow = (day.getDay() + 6) % 7; // Mon = 0 … Sun = 6
  day.setDate(day.getDate() - dow);
  return day;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function shortDate(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
}

function build(unit: PeriodUnit, start: Date, end: Date): Period {
  let label: string;
  if (unit === 'year') {
    label = String(start.getFullYear());
  } else if (unit === 'month') {
    label = `${MONTHS[start.getMonth()]} ${start.getFullYear()}`;
  } else if (unit === 'day') {
    // Names the weekday: a single day's takings mean little without knowing whether it
    // was a Saturday or a Tuesday.
    label = `${WEEKDAYS[start.getDay()]} ${shortDate(start)} ${start.getFullYear()}`;
  } else {
    // End is exclusive; the last day of the week is the day before it.
    const last = new Date(end);
    last.setDate(last.getDate() - 1);
    label = `${shortDate(start)} – ${shortDate(last)} ${last.getFullYear()}`;
  }
  return { unit, start, end, label };
}

/** The period of `unit` that contains `anchor`. */
export function periodFor(unit: PeriodUnit, anchor: Date = new Date()): Period {
  if (unit === 'year') {
    const start = new Date(anchor.getFullYear(), 0, 1);
    return build(unit, start, new Date(anchor.getFullYear() + 1, 0, 1));
  }
  if (unit === 'month') {
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    return build(unit, start, new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1));
  }
  if (unit === 'day') {
    const start = startOfDay(anchor);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return build(unit, start, end);
  }
  const start = startOfWeek(anchor);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return build(unit, start, end);
}

/** Move `delta` periods forward (positive) or back (negative), keeping the same unit. */
export function shiftPeriod(p: Period, delta: number): Period {
  const a = new Date(p.start);
  if (p.unit === 'year') a.setFullYear(a.getFullYear() + delta);
  else if (p.unit === 'month') a.setMonth(a.getMonth() + delta);
  else if (p.unit === 'day') a.setDate(a.getDate() + delta);
  else a.setDate(a.getDate() + delta * 7);
  return periodFor(p.unit, a);
}

/**
 * Switch unit while staying on the same stretch of time — a manager looking at March 2025
 * who clicks "Year" wants 2025, not the current year.
 *
 * Except when they are looking at the present: every period starts on its first day, so
 * anchoring on `p.start` would turn "this year" into "the month of January" and "this
 * month" into "the week containing the 1st". Both look like ordinary periods, quietly
 * showing an empty console mid-year with nothing on screen to say why. So while the
 * current period holds `now`, the new one is anchored on `now` too.
 */
export function withUnit(p: Period, unit: PeriodUnit, now: Date = new Date()): Period {
  return periodFor(unit, isCurrentPeriod(p, now) ? now : p.start);
}

export function periodContains(p: Period, when: string | Date): boolean {
  const t = when instanceof Date ? when.getTime() : Date.parse(when);
  if (Number.isNaN(t)) return false;
  return t >= p.start.getTime() && t < p.end.getTime();
}

/** True when `now` falls inside the period — i.e. there is nothing later to navigate to. */
export function isCurrentPeriod(p: Period, now: Date = new Date()): boolean {
  return periodContains(p, now);
}

export function filterByPeriod<T>(items: T[], getDate: (item: T) => string | undefined, p: Period): T[] {
  return items.filter((item) => {
    const d = getDate(item);
    return !!d && periodContains(p, d);
  });
}

export interface Bucket {
  /** Stable key: YYYY-MM-DD for daily buckets, YYYY-MM for monthly. */
  key: string;
  /** Axis label, kept short enough to fit under a chart column. */
  label: string;
  start: Date;
  end: Date;
}

/**
 * The chart's x-axis for a period: 24 hours for a day, 7 days for a week, one per day for
 * a month, 12 months for a year.
 *
 * Built from the calendar and then filled, never derived by grouping the records — a day
 * with no sales has to render as a zero column. Drop it instead and every later column
 * slides left, so the chart shows the right total against the wrong day.
 */
export function periodBuckets(p: Period): Bucket[] {
  const buckets: Bucket[] = [];

  if (p.unit === 'day') {
    const dayPart = `${p.start.getFullYear()}-${String(p.start.getMonth() + 1).padStart(2, '0')}-${String(p.start.getDate()).padStart(2, '0')}`;
    for (let h = 0; h < 24; h++) {
      const start = new Date(p.start);
      start.setHours(h, 0, 0, 0);
      const end = new Date(start);
      // setHours(24) rolls into the next day, which is exactly the exclusive end wanted
      // for the 23:00 bucket.
      end.setHours(h + 1, 0, 0, 0);
      buckets.push({
        key: `${dayPart}T${String(h).padStart(2, '0')}`,
        label: String(h).padStart(2, '0'),
        start,
        end,
      });
    }
    return buckets;
  }

  if (p.unit === 'year') {
    for (let m = 0; m < 12; m++) {
      const start = new Date(p.start.getFullYear(), m, 1);
      const end = new Date(p.start.getFullYear(), m + 1, 1);
      buckets.push({
        key: `${start.getFullYear()}-${String(m + 1).padStart(2, '0')}`,
        label: MONTHS[m].slice(0, 3),
        start,
        end,
      });
    }
    return buckets;
  }

  const cursor = new Date(p.start);
  while (cursor < p.end) {
    const start = new Date(cursor);
    const end = new Date(cursor);
    end.setDate(end.getDate() + 1);
    buckets.push({
      key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`,
      // A week is short enough to name its days; a month would collide, so number them.
      label: p.unit === 'week'
        ? start.toLocaleDateString('en-NG', { weekday: 'short' })
        : String(start.getDate()),
      start,
      end,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return buckets;
}

/** What one bucket of this period is called, for table headings and captions. */
export function bucketNoun(unit: PeriodUnit): 'hour' | 'day' | 'month' {
  if (unit === 'day') return 'hour';
  if (unit === 'year') return 'month';
  return 'day';
}
