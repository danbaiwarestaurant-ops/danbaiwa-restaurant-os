import React from 'react';
import { useDeviceStore } from '../../store/useDeviceStore';
import { useShiftStore } from '../../store/useShiftStore';
import { SyncIndicator } from './SyncIndicator';
import { Settings, LayoutDashboard, DollarSign, Lock } from 'lucide-react';

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
  const { currentShift } = useShiftStore();

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
            control: pressing this takes the cash count and then signs the cashier out. It
            also names who is signed in, which is why the till needs no account menu.
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

        {/* Lock Till, in place of the account menu.
            With log out on the shift button, locking was the only thing left behind that
            chip — and a menu you open to reach one item is a menu that costs a tap for
            nothing. Who is signed in is on the shift button beside it. */}
        <button
          onClick={onLockTill}
          title="Lock the till — your PIN reopens it"
          className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-900 text-xs font-black uppercase transition rounded-none"
        >
          <Lock className="w-3.5 h-3.5 text-slate-500" />
          <span>Lock Till</span>
        </button>

        {/* Settings last: it is the one control here nobody touches during service. */}
        <button
          onClick={onOpenConfig}
          className="p-1.5 border border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-700 transition rounded-none"
          title="Device Settings & Ticket Presets"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>

    </header>
  );
};
