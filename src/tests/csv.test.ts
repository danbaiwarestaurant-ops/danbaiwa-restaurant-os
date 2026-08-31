import { describe, it, expect } from 'vitest';
import { escapeCsvValue, toCsv, timestampedFilename } from '../utils/csv';

describe('escapeCsvValue', () => {
  it('leaves plain values alone', () => {
    expect(escapeCsvValue('paid')).toBe('paid');
    expect(escapeCsvValue(1500)).toBe('1500');
  });

  it('quotes values containing a comma', () => {
    // Void reasons and expense descriptions are free text typed by staff, so a comma
    // reaching the file unescaped silently shifts every later column.
    expect(escapeCsvValue('Wrong amount, refunded')).toBe('"Wrong amount, refunded"');
  });

  it('doubles embedded quotes', () => {
    expect(escapeCsvValue('Customer said "no"')).toBe('"Customer said ""no"""');
  });

  it('quotes values containing newlines', () => {
    expect(escapeCsvValue('line one\nline two')).toBe('"line one\nline two"');
  });

  it('renders null and undefined as empty, not as the words', () => {
    expect(escapeCsvValue(null)).toBe('');
    expect(escapeCsvValue(undefined)).toBe('');
  });
});

describe('toCsv', () => {
  it('writes a header row then one row per record, CRLF separated', () => {
    const csv = toCsv(
      [
        { id: 'T-1', amount: 500, reason: '' },
        { id: 'T-2', amount: 900, reason: 'Wrong amount, voided' },
      ],
      [
        { header: 'Ticket', value: (r) => r.id },
        { header: 'Amount', value: (r) => r.amount },
        { header: 'Reason', value: (r) => r.reason },
      ]
    );

    expect(csv.split('\r\n')).toEqual([
      'Ticket,Amount,Reason',
      'T-1,500,',
      'T-2,900,"Wrong amount, voided"',
    ]);
  });

  it('emits a header-only file for an empty list rather than an empty string', () => {
    const csv = toCsv([], [{ header: 'Ticket', value: (r: any) => r.id }]);
    expect(csv).toBe('Ticket');
  });
});

describe('timestampedFilename', () => {
  it('pads month and day so filenames sort chronologically', () => {
    expect(timestampedFilename('sales-record', new Date(2026, 0, 5))).toBe('sales-record-2026-01-05.csv');
  });
});
