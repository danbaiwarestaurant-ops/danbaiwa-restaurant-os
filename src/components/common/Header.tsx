import React from 'react';
import { useDeviceStore } from '../../store/useDeviceStore';
import { useTicketStore } from '../../store/useTicketStore';
import { useShiftStore } from '../../store/useShiftStore';
import { useSyncStore } from '../../store/useSyncStore';
import { Settings, RefreshCw, LayoutDashboard, DollarSign, Lock } from 'lucide-react';

interface HeaderProps {
  onOpenConfig: () => void;
  onOpenShiftModal: () => void;
  onOpenExpenseModal: () => void;
  onToggleManagerView: () => void;
  isManagerView: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenConfig,
  onOpenShiftModal,
  onOpenExpenseModal,
  onToggleManagerView,
  isManagerView,
}) => {
  const { config } = useDeviceStore();
  const { ticketsTodayCount } = useTicketStore();
  const { currentShift } = useShiftStore();
  const { pendingCount, isSyncing, triggerSyncWorker } = useSyncStore();

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
          <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">
            TICKET POS SYSTEM — PRODUCTION MVP
          </div>
        </div>
      </div>

      {/* Action Controls & Badges */}
      <div className="flex items-center gap-2">
        {/* Outbox Sync Badge */}
        <button
          onClick={() => triggerSyncWorker()}
          className={`flex items-center gap-1.5 px-3 py-1.5 border text-xs font-black uppercase transition rounded-none ${
            pendingCount > 0
              ? 'bg-amber-50 border-amber-400 text-amber-900 hover:bg-amber-100'
              : 'bg-emerald-50 border-emerald-400 text-emerald-950'
          }`}
          title="Click to trigger manual outbox sync"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin text-amber-600' : ''}`} />
          <span>{pendingCount > 0 ? `Sync (${pendingCount} pending)` : 'Online • Synced'}</span>
        </button>

        {/* Shift Badge & Action */}
        <button
          onClick={onOpenShiftModal}
          className={`flex items-center gap-1.5 px-3 py-1.5 border text-xs font-black uppercase transition rounded-none ${
            currentShift
              ? 'bg-emerald-50 border-emerald-400 text-emerald-900 hover:bg-emerald-100'
              : 'bg-rose-50 border-rose-400 text-rose-900 hover:bg-rose-100'
          }`}
        >
          <Lock className="w-3.5 h-3.5" />
          <span>{currentShift ? `Shift Open (${currentShift.cashierName})` : 'Shift Closed (Click to Open)'}</span>
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
      </div>

      {/* Tickets Today Counter */}
      <div className="text-right border-l-2 border-slate-200 pl-4">
        <div className="text-3xl font-black font-mono text-amber-600 leading-none">
          {ticketsTodayCount}
        </div>
        <div className="text-[10px] uppercase font-bold tracking-wider text-slate-500 mt-0.5">
          Tickets Today
        </div>
      </div>
    </header>
  );
};
