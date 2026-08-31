/**
 * csv.ts
 *
 * CSV export for the Sales Record Book and Reports views.
 *
 * Hand-rolled rather than pulled from a dependency because the requirement is small and
 * entirely about one thing: escaping. Ticket void reasons and expense descriptions are
 * free text typed by staff, so commas, quotes and pasted line breaks all reach this
 * function, and any of them will silently corrupt a spreadsheet's column alignment if
 * unescaped.
 */

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

/** RFC 4180 escaping: wrap in quotes when needed, and double any embedded quote. */
export function escapeCsvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => escapeCsvValue(c.header)).join(',');
  const body = rows.map((row) => columns.map((c) => escapeCsvValue(c.value(row))).join(','));
  return [head, ...body].join('\r\n');
}

/**
 * Triggers a download of `content` as `filename`.
 *
 * No-ops outside a browser (tests import this module for toCsv/escapeCsvValue and must
 * not touch document).
 */
export function downloadCsv(filename: string, content: string): void {
  if (typeof document === 'undefined') return;

  // Excel assumes the system codepage without a BOM, which mangles the ₦ sign.
  const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** `prefix-2026-08-30.csv` */
export function timestampedFilename(prefix: string, date: Date = new Date()): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${prefix}-${date.getFullYear()}-${m}-${d}.csv`;
}
