import React, { useState } from 'react';
import { useDeviceStore } from '../../store/useDeviceStore';
import { useTicketStore } from '../../store/useTicketStore';
import { useShiftStore } from '../../store/useShiftStore';
import { useAuthStore } from '../../store/useAuthStore';
import { SyncIndicator } from './SyncIndicator';
import { Settings, LayoutDashboard, DollarSign, Lock, UserCheck, KeyRound, LogOut } from 'lucide-react';

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
  const { users, activeUser, switchCashierSession, logoutUser } = useAuthStore();

  const [isSwitchingCashier, setIsSwitchingCashier] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [switchPin, setSwitchPin] = useState('');
  const [switchError, setSwitchError] = useState(false);

  const handleSwitchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUserId || !switchPin) return;

    const success = await switchCashierSession(selectedUserId, switchPin);
    if (success) {
      setIsSwitchingCashier(false);
      setSwitchPin('');
      setSwitchError(false);
    } else {
      setSwitchError(true);
      setSwitchPin('');
    }
  };

  const handleSystemLogout = async () => {
    if (window.confirm('Are you sure you want to log out of the POS System terminal?')) {
      await logoutUser();
    }
  };

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
          <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold flex items-center gap-2">
            <span>TICKET POS SYSTEM</span>
            <span>•</span>
            <span className="text-slate-700 font-black">
              CASHIER: {activeUser ? activeUser.name : 'UNASSIGNED'}
            </span>
          </div>
        </div>
      </div>

      {/* Action Controls & Badges */}
      <div className="flex items-center gap-2">
        {/* Cashier Session Switch Button */}
        <button
          onClick={() => {
            if (users.length > 0) {
              setSelectedUserId(users[0].id);
              setIsSwitchingCashier(true);
            }
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-900 text-xs font-black uppercase transition rounded-none"
          title="Switch active cashier session"
        >
          <UserCheck className="w-3.5 h-3.5 text-amber-600" />
          <span>{activeUser ? activeUser.name : 'Switch Staff'}</span>
        </button>

        {/* Prominent System Logout Button */}
        <button
          onClick={handleSystemLogout}
          className="flex items-center gap-1 px-3 py-1.5 border border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-900 text-xs font-black uppercase transition rounded-none"
          title="Log Out of System Terminal"
        >
          <LogOut className="w-3.5 h-3.5 text-rose-600" />
          <span>Log Out</span>
        </button>

        {/* Dedicated Cloud Sync Component */}
        <SyncIndicator />

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

      {/* Switch Cashier Session PIN Modal */}
      {isSwitchingCashier && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white border-2 border-slate-900 w-full max-w-sm p-6 rounded-none shadow-2xl">
            <h4 className="font-black text-sm uppercase text-slate-900 mb-3 flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-amber-600" />
              <span>Switch Cashier Session</span>
            </h4>

            {switchError && (
              <div className="mb-3 p-2 bg-rose-50 border border-rose-400 text-rose-900 text-xs font-bold uppercase rounded-none">
                Invalid Staff PIN
              </div>
            )}

            <form onSubmit={handleSwitchSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
                  Select Staff Member
                </label>
                <select
                  value={selectedUserId}
                  onChange={e => setSelectedUserId(e.target.value)}
                  className="w-full p-2.5 border-2 border-slate-300 text-xs font-bold text-slate-900 bg-white rounded-none"
                >
                  {users.map(u => (
                    <option key={u.id} value={u.id}>
                      {u.name} (@{u.username}) — {u.role.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
                  Enter Staff PIN
                </label>
                <input
                  type="password"
                  value={switchPin}
                  onChange={e => setSwitchPin(e.target.value.replace(/\D/g, ''))}
                  placeholder="Enter PIN"
                  maxLength={8}
                  className="w-full p-2.5 border-2 border-slate-300 text-center font-mono font-black text-lg text-slate-900 rounded-none focus:border-amber-500 focus:outline-none"
                  autoFocus
                  required
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t">
                <button
                  type="button"
                  onClick={() => {
                    setIsSwitchingCashier(false);
                    setSwitchPin('');
                    setSwitchError(false);
                  }}
                  className="px-3 py-1.5 text-xs font-bold uppercase border border-slate-300 rounded-none"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!switchPin}
                  className="px-4 py-1.5 text-xs font-black uppercase bg-amber-500 text-white rounded-none border border-amber-600 shadow-xs"
                >
                  Switch Session
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </header>
  );
};
