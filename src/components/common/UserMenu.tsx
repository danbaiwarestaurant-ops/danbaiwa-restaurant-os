import React, { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../../store/useAuthStore';
import { KeyRound, Lock, LogOut, UserCheck, ChevronDown } from 'lucide-react';

interface UserMenuProps {
  /** Locks the till behind the PIN screen — same path as the idle auto-lock. */
  onLockTill?: () => void;
  /** Dark styling for the manager console topbar. */
  variant?: 'light' | 'dark';
}

/**
 * Signed-in identity and every session action, behind one small chip.
 *
 * The till used to keep a cashier-name button and a red "Log Out" button permanently in
 * the action bar, side by side with the buttons used constantly during service. On a
 * touch screen that is an accidental logout waiting to happen — and logging out destroys
 * the Supabase session, so the till stops syncing until someone reconnects it with the
 * admin PIN. Both now live two taps deep instead of one.
 */
export const UserMenu: React.FC<UserMenuProps> = ({ onLockTill, variant = 'light' }) => {
  const { users, activeUser, switchCashierSession, logoutUser } = useAuthStore();

  const [isOpen, setIsOpen] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [switchPin, setSwitchPin] = useState('');
  const [switchError, setSwitchError] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click / Escape, or the popover strands itself over the till.
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setIsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen]);

  const initials = (activeUser?.name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('') || '?';

  const handleSwitchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUserId || !switchPin) return;

    const success = await switchCashierSession(selectedUserId, switchPin);
    if (success) {
      setIsSwitching(false);
      setSwitchPin('');
      setSwitchError(false);
    } else {
      setSwitchError(true);
      setSwitchPin('');
    }
  };

  const handleLogout = async () => {
    setIsOpen(false);
    if (window.confirm('Are you sure you want to log out of the POS System terminal?')) {
      await logoutUser();
    }
  };

  const isDark = variant === 'dark';

  return (
    <>
      <div className="relative" ref={wrapRef}>
        <button
          onClick={() => setIsOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          aria-label="Account menu"
          title={activeUser ? `${activeUser.name} — account menu` : 'Account menu'}
          className={`flex items-center gap-1.5 p-1 pr-2 border transition rounded-none ${
            isDark
              ? 'border-slate-700 bg-slate-800 hover:bg-slate-700'
              : 'border-slate-300 bg-slate-50 hover:bg-slate-100'
          }`}
        >
          <span className="w-7 h-7 bg-amber-500 text-white font-black text-[11px] flex items-center justify-center rounded-none">
            {initials}
          </span>
          <ChevronDown className={`w-3.5 h-3.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
        </button>

        {isOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full mt-1 w-60 bg-white border-2 border-slate-900 shadow-2xl rounded-none z-50"
          >
            <div className="px-4 py-3 border-b-2 border-slate-200 bg-slate-50">
              <div className="text-sm font-black text-slate-900 truncate">
                {activeUser?.name || 'Not signed in'}
              </div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                {activeUser?.role || '—'}
              </div>
            </div>

            <button
              role="menuitem"
              onClick={() => {
                if (users.length > 0) setSelectedUserId(users[0].id);
                setIsSwitching(true);
                setIsOpen(false);
              }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs font-bold uppercase text-slate-800 hover:bg-slate-100 text-left"
            >
              <UserCheck className="w-4 h-4 text-amber-600 flex-shrink-0" />
              <span>Switch Cashier</span>
            </button>

            {onLockTill && (
              <button
                role="menuitem"
                onClick={() => {
                  setIsOpen(false);
                  onLockTill();
                }}
                className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs font-bold uppercase text-slate-800 hover:bg-slate-100 text-left"
              >
                <Lock className="w-4 h-4 text-slate-500 flex-shrink-0" />
                <span>Lock Till</span>
              </button>
            )}

            <button
              role="menuitem"
              onClick={handleLogout}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs font-bold uppercase text-rose-800 hover:bg-rose-50 text-left border-t-2 border-slate-200"
            >
              <LogOut className="w-4 h-4 text-rose-600 flex-shrink-0" />
              <span>Log Out</span>
            </button>
          </div>
        )}
      </div>

      {/* Switch Cashier — unchanged behaviour, just no longer reachable by mis-tap. */}
      {isSwitching && (
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
                  onChange={(e) => setSelectedUserId(e.target.value)}
                  className="w-full p-2.5 border-2 border-slate-300 text-xs font-bold text-slate-900 bg-white rounded-none"
                >
                  {/* Deactivated accounts stay in the roster so an admin can reactivate
                      them, but they must not be offered as a way onto the till. */}
                  {users.filter((u) => u.status === 'active').map((u) => (
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
                  onChange={(e) => setSwitchPin(e.target.value.replace(/\D/g, ''))}
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
                    setIsSwitching(false);
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
    </>
  );
};
