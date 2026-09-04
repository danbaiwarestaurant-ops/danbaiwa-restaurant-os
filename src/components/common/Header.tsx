import React, { useMemo } from 'react';
import { useDeviceStore } from '../../store/useDeviceStore';
import { useTicketStore } from '../../store/useTicketStore';
import { useShiftStore } from '../../store/useShiftStore';
import { SyncIndicator } from './SyncIndicator';
import { formatCurrency } from '../../utils/currency';
import { shiftTickets, summariseTickets } from '../../utils/analytics';
import { Settings, LayoutDashboard, DollarSign, Lock } from 'lucide-react';
import { UserMenu } from './UserMenu';

interface HeaderProps {
  onOpenConfig: () => void;
  onOpenExpenseModal: () => void;
  onToggleManagerView: () => void;
  onLockTill: () => void;
  /** Closes the open shift first — see App's handleLogout. */
  onLogout: () => void;
  isManagerView: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenConfig,
  onOpenExpenseModal,
  onToggleManagerView,
  onLockTill,
  onLogout,
  isManagerView,
}) => {
  const { config } = useDeviceStore();
  const { tickets } = useTicketStore();
  const { currentShift } = useShiftStore();

  /**
   * The shift's own trade, not the day's.
   *
   * A cashier checks these against what is in front of them — the drawer, the stack of
   * stubs — and neither of those carries over from the shift before. On a till worked by
   * two people in a day, a "today" figure counted the other person's takings into the
   * number this one is answerable for.
   */
  const shiftTotals = useMemo(
    () => summariseTickets(currentShift ? shiftTickets(tickets, currentShift) : []),
    [tickets, currentShift]
  );

  return (
    <header className="bg-white border-b-4 border-amber-500 px-6 py-4 shadow-xs flex flex-wrap items-center justify-between gap-4">
      {/* Brand & Device Meta */}
      <div className="flex items-center gap-3">
        <div className="w-3.5 h-3.5 bg-emerald-500 rounded-none shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
        <div>
          <div className="font-black text-lg tracking-wider uppercase text-slate-900 flex items-center gap-2">
            <span>{config.businessName || 'Danbaiwa Restraunt'}</span>
            <span className="text-xs px-2 py-0.5 border border-slate-300 bg-slate-100 text-slate-700 font-mono font-bold rounded-none">
              {config.locationId}-{config.deviceId}
            </span>
          </div>
          {/* Who is signed in lives in the account menu now — one place, not three. */}
          <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">
            TICKET POS SYSTEM
          </div>
        </div>
      </div>

      {/* Action Controls & Badges */}
      <div className="flex items-center gap-2">
        {/* Dedicated Cloud Sync Component */}
        <SyncIndicator />

        {/* Shift status *is* the log out button.
            Ending the shift and ending the session are one act now, so they are one
            control: pressing this takes the cash count and then signs the cashier out.
            Splitting them across a badge here and a "Log Out" buried in the account menu
            only invited someone to reach for the wrong one — so the account menu no longer
            carries a log out at all (see showLogout below).
            There is still nothing here that closes a shift *without* signing out: that is
            a manager action, in the console's topbar. */}
        <button
          onClick={onLogout}
          title={
            currentShift
              ? `Close ${currentShift.cashierName}'s shift, count the drawer and log out`
              : 'Log out of this till'
          }
          className={`flex items-center gap-2 px-3 py-1.5 border-2 text-xs font-black uppercase transition rounded-none ${
            currentShift
              ? 'bg-emerald-50 border-emerald-400 text-emerald-900 hover:bg-emerald-100'
              : 'bg-rose-50 border-rose-400 text-rose-900 hover:bg-rose-100'
          }`}
        >
          <Lock className="w-3.5 h-3.5" />
          <span>{currentShift ? `Shift Open (${currentShift.cashierName})` : 'No Open Shift'}</span>
          <span
            className={`pl-2 border-l text-[10px] tracking-wider ${
              currentShift ? 'border-emerald-300 text-emerald-700' : 'border-rose-300 text-rose-700'
            }`}
          >
            {currentShift ? 'End & Log Out' : 'Log Out'}
          </span>
        </button>

        {/* Expense Modal Button */}
        <button
          onClick={onOpenExpenseModal}
          className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-900 text-xs font-black uppercase transition rounded-none"
        >
          <DollarSign className="w-3.5 h-3.5 text-amber-600" />
          <span>Expense</span>
        </button>

        {/* Manager Mode Toggle */}
        <button
          onClick={onToggleManagerView}
          className={`flex items-center gap-1.5 px-3 py-1.5 border text-xs font-black uppercase transition rounded-none ${
            isManagerView
              ? 'bg-amber-500 border-amber-600 text-white'
              : 'bg-slate-900 border-slate-950 text-slate-100 hover:bg-slate-800'
          }`}
        >
          <LayoutDashboard className="w-3.5 h-3.5" />
          <span>{isManagerView ? 'Cashier Till' : 'Manager Mode'}</span>
        </button>

        {/* Quick Settings */}
        <button
          onClick={onOpenConfig}
          className="p-1.5 border border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-700 transition rounded-none"
          title="Device Settings & Ticket Presets"
        >
          <Settings className="w-4 h-4" />
        </button>

        {/* Identity + session actions, tucked behind one chip */}
        {/* No log out in here — it lives on the shift button, where ending the shift and
            ending the session are the same press. */}
        <UserMenu onLockTill={onLockTill} showLogout={false} />
      </div>

      {/* This shift's count and takings. Voids excluded from both. Empty until a shift is
          open, because until then there is nothing for either number to belong to. */}
      <div className="flex items-stretch gap-4 border-l-2 border-slate-200 pl-4">
        <div className="text-right">
          <div className="text-3xl font-black font-mono text-amber-600 leading-none">
            {currentShift ? shiftTotals.ticketCount : '—'}
          </div>
          <div className="text-[10px] uppercase font-bold tracking-wider text-slate-500 mt-0.5">
            Tickets This Shift
          </div>
        </div>

        <div className="text-right border-l border-slate-200 pl-4">
          <div className="text-3xl font-black font-mono text-slate-900 leading-none tabular-nums">
            {currentShift ? formatCurrency(shiftTotals.revenue, config.currencySymbol || '₦') : '—'}
          </div>
          <div className="text-[10px] uppercase font-bold tracking-wider text-slate-500 mt-0.5">
            Shift Total
          </div>
        </div>
      </div>

    </header>
  );
};
