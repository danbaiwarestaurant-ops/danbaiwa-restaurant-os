import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTicketStore } from '../../store/useTicketStore';
import { useDeviceStore } from '../../store/useDeviceStore';
import { formatCurrency, formatTimestamp } from '../../utils/currency';
import { Pager } from '../common/Pager';
import { useAuthStore } from '../../store/useAuthStore';
import { useShiftStore } from '../../store/useShiftStore';
import { paginateByShift, shiftTickets, summariseTickets } from '../../utils/analytics';
import { Ticket as TicketIcon, CheckCircle2, Ban, QrCode, Banknote, Smartphone } from 'lucide-react';

interface RecentTicketsSidebarProps {
  onOpenVoidModal: (ticketId: string) => void;
  onOpenScanModal: () => void;
}

/** Cards are tall enough that more than this needs scrolling on a typical till screen. */
const PAGE_SIZE = 8;

export const RecentTicketsSidebar: React.FC<RecentTicketsSidebarProps> = ({
  onOpenVoidModal,
  onOpenScanModal,
}) => {
  const { tickets, markCollected, changeTender } = useTicketStore();
  const { activeUser } = useAuthStore();
  const { shiftHistory, currentShift } = useShiftStore();
  const { config } = useDeviceStore();

  /**
   * The shift's running count and takings, directly above the tickets they are made of.
   *
   * These used to sit in the till header, where on a 13" screen the header's action row
   * wrapped and pushed them onto a line of their own — or off the useful part of the
   * screen entirely. Here they are always in the same place, at any width, and next to the
   * list a cashier checks them against.
   */
  const shiftTotals = useMemo(
    () => summariseTickets(currentShift ? shiftTickets(tickets, currentShift) : []),
    [tickets, currentShift]
  );

  /**
   * Pages that never mix two shifts.
   *
   * The shift in progress owns page one on its own, and the shift before it starts a page
   * of its own behind it. Fixed-size paging put the tail of somebody else's service at the
   * bottom of the current page, which is the one a cashier scrolls to check their own.
   * Older shifts stay reachable — this changes where the breaks fall, not what is kept.
   */
  const pages = useMemo(
    () => paginateByShift(tickets, shiftHistory, PAGE_SIZE),
    [tickets, shiftHistory]
  );

  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, pages.length);
  const safePage = Math.min(page, totalPages);
  const visible = pages[safePage - 1] ?? [];
  const total = tickets.length;
  // Pages vary in length now, so the "1–8 of 40" label counts what actually precedes this
  // one rather than assuming every page before it was full.
  const start = pages.slice(0, safePage - 1).reduce((n, p) => n + p.length, 0);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  // Jump back to the first page when a genuinely new ticket lands at the top, so the
  // ticket just issued is actually on screen. Keyed on the newest id rather than on the
  // array itself: the list reloads constantly now that realtime sync is running, and
  // resetting on every reload would yank the page out from under someone browsing back
  // through history.
  const newestId = tickets[0]?.id;
  const prevNewestId = useRef<string | undefined>(newestId);
  useEffect(() => {
    if (newestId && prevNewestId.current !== newestId) setPage(1);
    prevNewestId.current = newestId;
  }, [newestId, setPage]);

  return (
    <div className="bg-white border-l-2 border-slate-300 p-5 flex flex-col h-full overflow-hidden rounded-none">
      {/* This shift's totals. Voids are excluded from both, and both read '—' until a
          shift is open, because until then there is nothing for them to belong to. */}
      <div className="grid grid-cols-2 gap-3 pb-3 mb-3 border-b-2 border-slate-200">
        <div>
          <div className="text-2xl font-black font-mono text-amber-600 leading-none tabular-nums">
            {currentShift ? shiftTotals.ticketCount : '—'}
          </div>
          <div className="text-[10px] uppercase font-bold tracking-wider text-slate-500 mt-1">
            Tickets This Shift
          </div>
        </div>

        <div className="text-right min-w-0">
          <div className="text-2xl font-black font-mono text-slate-900 leading-none tabular-nums truncate">
            {currentShift ? formatCurrency(shiftTotals.revenue, config.currencySymbol || '₦') : '—'}
          </div>
          <div className="text-[10px] uppercase font-bold tracking-wider text-slate-500 mt-1">
            Shift Total
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between pb-3 border-b-2 border-slate-200 mb-4">
        <h2 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-2">
          <TicketIcon className="w-4 h-4 text-amber-500" />
          <span>Recent Tickets</span>
        </h2>

        <button
          onClick={onOpenScanModal}
          className="flex items-center gap-1 text-xs font-bold text-amber-900 hover:text-amber-950 bg-amber-50 border border-amber-300 px-2.5 py-1 rounded-none"
        >
          <QrCode className="w-3.5 h-3.5" />
          <span>Scan Ticket</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {total === 0 ? (
          <div className="text-center py-12 text-slate-400 text-xs font-bold uppercase tracking-wider">
            No tickets printed yet
          </div>
        ) : (
          visible.map(t => {
            const isVoid = t.status === 'void';
            const isCollected = t.status === 'collected';
            const isTransfer = (t.tender ?? 'cash') === 'transfer';

            return (
              <div
                key={t.id}
                className={`p-3 border-2 transition-all flex flex-col gap-2 rounded-none ${
                  isVoid
                    ? 'bg-rose-50/60 border-rose-200 opacity-75'
                    : isCollected
                    ? 'bg-slate-50 border-slate-200'
                    : 'bg-white border-slate-200 hover:border-amber-300 shadow-xs'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-mono font-bold text-sm text-slate-900 flex items-center gap-1.5">
                      <span>#{t.id}</span>
                      {isVoid && (
                        <span className="text-[10px] px-1.5 py-0.2 bg-rose-100 text-rose-800 font-bold uppercase border border-rose-200 rounded-none">
                          Void
                        </span>
                      )}
                      {isCollected && (
                        <span className="text-[10px] px-1.5 py-0.2 bg-slate-200 text-slate-800 font-bold uppercase border border-slate-300 rounded-none">
                          Collected
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 font-medium">
                      {formatTimestamp(t.createdAt)}
                    </div>
                  </div>

                  <div className="text-right">
                    <div className={`font-mono font-black text-base ${isVoid ? 'line-through text-slate-400' : 'text-amber-600'}`}>
                      {formatCurrency(t.amount, t.currency)}
                    </div>
                    {/* Only the exception is labelled. Badging every cash ticket would put a
                        tag on ~90% of the list and stop any of them being noticed. */}
                    {isTransfer && !isVoid && (
                      <div className="text-[10px] font-black uppercase tracking-wide text-sky-700">
                        Transfer / POS
                      </div>
                    )}
                  </div>
                </div>

                {/* Actions */}
                {!isVoid && (
                  <div className="flex items-center justify-end gap-2 pt-1 border-t border-slate-100 flex-wrap">
                    {/* Retag rather than void-and-reprint. A mis-tagged payment type is a
                        clerical slip, and voiding to fix one destroys a ticket the customer
                        is holding and buries the real voids in noise at close-out. */}
                    <button
                      onClick={() => changeTender(t.id, isTransfer ? 'cash' : 'transfer', activeUser?.id ?? 'UNKNOWN')}
                      title={isTransfer ? 'Recorded as transfer — change to cash' : 'Recorded as cash — change to transfer/POS'}
                      className="text-[11px] font-bold text-slate-700 hover:text-sky-900 bg-slate-100 hover:bg-sky-50 px-2 py-0.5 border border-slate-300 rounded-none flex items-center gap-1"
                    >
                      {isTransfer ? (
                        <Banknote className="w-3 h-3 text-emerald-600" />
                      ) : (
                        <Smartphone className="w-3 h-3 text-sky-600" />
                      )}
                      <span>{isTransfer ? 'Mark Cash' : 'Mark Transfer'}</span>
                    </button>
                    {!isCollected && (
                      <button
                        onClick={() => markCollected(t.id)}
                        className="text-[11px] font-bold text-slate-700 hover:text-emerald-900 bg-slate-100 hover:bg-emerald-50 px-2 py-0.5 border border-slate-300 rounded-none flex items-center gap-1"
                      >
                        <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                        <span>Collect</span>
                      </button>
                    )}
                    <button
                      onClick={() => onOpenVoidModal(t.id)}
                      className="text-[11px] font-bold text-slate-700 hover:text-rose-900 bg-slate-100 hover:bg-rose-50 px-2 py-0.5 border border-slate-300 rounded-none flex items-center gap-1"
                    >
                      <Ban className="w-3 h-3 text-rose-600" />
                      <span>Void</span>
                    </button>
                  </div>
                )}

                {isVoid && t.voidReason && (
                  <div className="text-[11px] text-rose-800 font-medium bg-rose-100/50 px-2 py-1 border border-rose-200 rounded-none">
                    Reason: {t.voidReason}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Pager — outside the scroll region so it stays reachable, and only when it earns
          its space. Previously the sidebar hard-capped at the 30 newest tickets with no
          way to reach anything older. */}
      <Pager
        page={safePage}
        totalPages={totalPages}
        start={start}
        pageSize={visible.length}
        total={total}
        onPrev={() => setPage((p) => Math.max(1, p - 1))}
        onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
        className="pt-3 mt-3 border-t-2 border-slate-200"
      />
    </div>
  );
};
