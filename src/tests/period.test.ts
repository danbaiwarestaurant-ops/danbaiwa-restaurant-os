import { describe, it, expect } from 'vitest';
import {
  periodFor, shiftPeriod, withUnit, periodContains, isCurrentPeriod,
  filterByPeriod, periodBuckets, bucketNoun,
} from '../utils/period';

describe('periodFor — day', () => {
  it('spans local midnight to midnight and names the weekday', () => {
    const p = periodFor('day', new Date(2026, 7, 30, 22, 45));
    expect(p.start.getHours()).toBe(0);
    expect(p.end.getDate()).toBe(31);
    expect(p.label).toBe('Sun 30 Aug 2026');
  });

  it('puts a late-evening ticket in that day, not the next', () => {
    const p = periodFor('day', new Date(2026, 7, 30));
    expect(periodContains(p, new Date(2026, 7, 30, 23, 59, 59).toISOString())).toBe(true);
    expect(periodContains(p, new Date(2026, 7, 31, 0, 0, 0).toISOString())).toBe(false);
  });

  it('steps back across a month boundary', () => {
    const p = shiftPeriod(periodFor('day', new Date(2026, 8, 1)), -1);
    expect(p.label).toBe('Mon 31 Aug 2026');
  });
});

describe('periodFor', () => {
  it('starts a week on Monday, not Sunday', () => {
    // Sunday 30 Aug 2026 belongs to the week that began Monday 24 Aug. Using getDay()
    // directly would start it on 30 Aug and push Monday's takings into the week before.
    const sunday = new Date(2026, 7, 30);
    const p = periodFor('week', sunday);
    expect(p.start.getDate()).toBe(24);
    expect(p.start.getDay()).toBe(1); // Monday
    expect(p.end.getDate()).toBe(31);
  });

  it('treats Monday itself as the first day of its own week', () => {
    const monday = new Date(2026, 7, 24);
    expect(periodFor('week', monday).start.getDate()).toBe(24);
  });

  it('spans exactly the calendar month, including a leap February', () => {
    const p = periodFor('month', new Date(2028, 1, 15));
    expect(p.start.getDate()).toBe(1);
    expect(p.end.getMonth()).toBe(2); // March
    const days = (p.end.getTime() - p.start.getTime()) / 86_400_000;
    expect(days).toBe(29);
  });

  it('spans the calendar year', () => {
    const p = periodFor('year', new Date(2026, 5, 5));
    expect(p.start.getFullYear()).toBe(2026);
    expect(p.end.getFullYear()).toBe(2027);
    expect(p.label).toBe('2026');
  });
});

describe('shiftPeriod', () => {
  it('steps back a month across a year boundary', () => {
    const jan = periodFor('month', new Date(2026, 0, 10));
    const dec = shiftPeriod(jan, -1);
    expect(dec.start.getFullYear()).toBe(2025);
    expect(dec.start.getMonth()).toBe(11);
    expect(dec.label).toBe('December 2025');
  });

  it('steps back a week across a month boundary', () => {
    const p = shiftPeriod(periodFor('week', new Date(2026, 8, 2)), -1);
    expect(p.start.getMonth()).toBe(7); // August
    expect(p.start.getDate()).toBe(24);
  });

  it('lands on the 31st-safe month when stepping back from a short one', () => {
    // Naive month arithmetic on a 31st rolls over: 31 March minus one month becomes
    // 3 March. Periods are anchored to the 1st, so this must stay in February.
    const p = shiftPeriod(periodFor('month', new Date(2026, 2, 31)), -1);
    expect(p.start.getMonth()).toBe(1);
    expect(p.label).toBe('February 2026');
  });
});

describe('withUnit', () => {
  const now = new Date(2026, 7, 30, 12); // 30 Aug 2026

  it('keeps the stretch of time being viewed when the granularity changes', () => {
    // Looking at March 2025 and switching to Year must give 2025, not the current year.
    const march2025 = periodFor('month', new Date(2025, 2, 15));
    expect(withUnit(march2025, 'year', now).label).toBe('2025');
  });

  it('drops from a month to today, not to the 1st', () => {
    expect(withUnit(periodFor('month', now), 'day', now).label).toBe('Sun 30 Aug 2026');
  });

  it('drops from a past month to that month’s first day', () => {
    const march = periodFor('month', new Date(2025, 2, 15));
    expect(withUnit(march, 'day', now).label).toBe('Sat 1 Mar 2025');
  });

  it('stays on the present when the current period is in view', () => {
    // Every period starts on its first day, so anchoring on that start would send
    // "this year" → January and "this month" → the week of the 1st: an empty console
    // mid-year with nothing on screen explaining why.
    const thisYear = periodFor('year', now);
    expect(withUnit(thisYear, 'month', now).label).toBe('August 2026');
    expect(withUnit(periodFor('month', now), 'week', now).start.getDate()).toBe(24);
  });

  it('survives a round trip through another unit and back', () => {
    const month = periodFor('month', now);
    const roundTripped = withUnit(withUnit(month, 'year', now), 'month', now);
    expect(roundTripped.label).toBe(month.label);
  });
});

describe('periodContains', () => {
  const august = periodFor('month', new Date(2026, 7, 15));

  it('includes the first instant and excludes the first instant of the next period', () => {
    expect(periodContains(august, new Date(2026, 7, 1, 0, 0, 0).toISOString())).toBe(true);
    expect(periodContains(august, new Date(2026, 7, 31, 23, 59, 59).toISOString())).toBe(true);
    expect(periodContains(august, new Date(2026, 8, 1, 0, 0, 0).toISOString())).toBe(false);
  });

  it('is false for an unparseable date rather than throwing', () => {
    expect(periodContains(august, 'not a date')).toBe(false);
  });
});

describe('bucketNoun', () => {
  it('names what one column of each period is', () => {
    expect(bucketNoun('day')).toBe('hour');
    expect(bucketNoun('week')).toBe('day');
    expect(bucketNoun('month')).toBe('day');
    expect(bucketNoun('year')).toBe('month');
  });
});

describe('isCurrentPeriod', () => {
  it('is true only for the period holding "now"', () => {
    const now = new Date(2026, 7, 30, 12);
    expect(isCurrentPeriod(periodFor('month', now), now)).toBe(true);
    expect(isCurrentPeriod(shiftPeriod(periodFor('month', now), -1), now)).toBe(false);
  });
});

describe('filterByPeriod', () => {
  it('keeps only records dated inside the period, and drops undated ones', () => {
    const rows = [
      { at: new Date(2026, 7, 10).toISOString() },
      { at: new Date(2026, 6, 31).toISOString() },
      { at: undefined as string | undefined },
    ];
    const kept = filterByPeriod(rows, (r) => r.at, periodFor('month', new Date(2026, 7, 1)));
    expect(kept).toHaveLength(1);
  });
});

describe('periodBuckets', () => {
  it('gives twenty-four hour-buckets for a day', () => {
    const b = periodBuckets(periodFor('day', new Date(2026, 7, 30)));
    expect(b).toHaveLength(24);
    expect(b[0].key).toBe('2026-08-30T00');
    expect(b[9].label).toBe('09');
    // The last bucket must close at midnight, not roll past it.
    expect(b[23].end.getDate()).toBe(31);
    expect(b[23].end.getHours()).toBe(0);
  });

  it('gives seven day-buckets for a week, Monday first', () => {
    const b = periodBuckets(periodFor('week', new Date(2026, 7, 26)));
    expect(b).toHaveLength(7);
    expect(b[0].start.getDay()).toBe(1);
    expect(b[6].start.getDay()).toBe(0);
  });

  it('gives one bucket per day of the month, including the last', () => {
    const b = periodBuckets(periodFor('month', new Date(2026, 7, 1)));
    expect(b).toHaveLength(31);
    expect(b[30].label).toBe('31');
  });

  it('gives twelve month-buckets for a year', () => {
    const b = periodBuckets(periodFor('year', new Date(2026, 3, 1)));
    expect(b).toHaveLength(12);
    expect(b[0].key).toBe('2026-01');
    expect(b[11].key).toBe('2026-12');
  });

  it.each(['day', 'week', 'month', 'year'] as const)(
    'covers a %s with no gap and no overlap between buckets',
    (unit) => {
      const p = periodFor(unit, new Date(2026, 7, 15, 13));
      const b = periodBuckets(p);
      expect(b[0].start.getTime()).toBe(p.start.getTime());
      expect(b[b.length - 1].end.getTime()).toBe(p.end.getTime());
      for (let i = 1; i < b.length; i++) {
        expect(b[i].start.getTime()).toBe(b[i - 1].end.getTime());
      }
    }
  );
});
