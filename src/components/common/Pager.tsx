import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Pagination shared by the till's ticket sidebar and the console's record tables.
 *
 * The page-maths lives in the `usePagination` hook so it can be tested without mounting
 * anything, and so the two call sites cannot drift into slightly different clamping
 * behaviour.
 */

export interface Pagination<T> {
  page: number;
  totalPages: number;
  /** 0-based index of the first visible item — callers render `start + 1` to humans. */
  start: number;
  visible: T[];
  setPage: (n: number) => void;
  next: () => void;
  prev: () => void;
}

export function usePagination<T>(items: T[], pageSize: number): Pagination<T> {
  const [page, setPage] = useState(1);

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Voiding a row, changing a filter, or a shrinking sync result can all pull the list
  // out from under the current page.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;

  return {
    page: safePage,
    totalPages,
    start,
    visible: items.slice(start, start + pageSize),
    setPage: (n: number) => setPage(Math.min(Math.max(1, n), totalPages)),
    next: () => setPage((p) => Math.min(totalPages, p + 1)),
    prev: () => setPage((p) => Math.max(1, p - 1)),
  };
}

interface PagerProps {
  page: number;
  totalPages: number;
  start: number;
  pageSize: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  /** Noun for the range label, e.g. "tickets". Omit for a bare "1–8 of 40". */
  label?: string;
  className?: string;
}

export const Pager: React.FC<PagerProps> = ({
  page,
  totalPages,
  start,
  pageSize,
  total,
  onPrev,
  onNext,
  label,
  className = '',
}) => {
  if (total === 0) return null;

  return (
    <div className={`flex items-center justify-between gap-2 ${className}`}>
      <span className="text-[11px] font-bold uppercase text-slate-500 tabular-nums">
        {start + 1}&ndash;{Math.min(start + pageSize, total)} of {total}
        {label ? ` ${label}` : ''}
      </span>

      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <button
            onClick={onPrev}
            disabled={page === 1}
            aria-label="Previous page"
            className="p-1.5 border border-slate-300 bg-slate-50 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-slate-50 text-slate-700 rounded-none"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>

          <span className="text-[11px] font-black uppercase text-slate-700 tabular-nums px-1">
            {page} / {totalPages}
          </span>

          <button
            onClick={onNext}
            disabled={page === totalPages}
            aria-label="Next page"
            className="p-1.5 border border-slate-300 bg-slate-50 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-slate-50 text-slate-700 rounded-none"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};
