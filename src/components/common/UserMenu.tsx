import React, { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../../store/useAuthStore';
import { Lock, LogOut, ChevronDown } from 'lucide-react';

interface UserMenuProps {
  /** Locks the till behind the PIN screen — same path as the idle auto-lock. */
  onLockTill?: () => void;
  /**
   * Logs out through the till's own flow, which closes the open shift (and takes the
   * cash count) before ending the session. Without it this falls back to a plain sign
   * out — correct only where there can be no shift to leave hanging.
   */
  onLogout?: () => void;
  /** Dark styling for the manager console topbar. */
  variant?: 'light' | 'dark';
}

/**
 * Signed-in identity and session actions for the manager console, behind one small chip.
 *
 * The till no longer renders this: its header carries the shift/log-out button and a Lock
 * Till button directly, because a menu you open to reach one item costs a tap for nothing.
 *
 * The till used to keep a cashier-name button and a red "Log Out" button permanently in
 * the action bar, side by side with the buttons used constantly during service. On a
 * touch screen that is an accidental logout waiting to happen. Both now live two taps
 * deep instead of one.
 *
 * Log Out here ends the staff session only; the device stays enrolled with the cloud so
 * the queue keeps draining. Disconnecting the device from the cloud is a separate,
 * explicit act (System Logout, in the console's settings).
 *
 * There is no "switch cashier" entry any more. A shift opens at sign-in and closes at
 * sign-out, so swapping who is on the till without going through both would file one
 * cashier's takings inside another's shift. Handing over is: log out, log in.
 */
export const UserMenu: React.FC<UserMenuProps> = ({ onLockTill, onLogout, variant = 'light' }) => {
  const { activeUser, logoutUser } = useAuthStore();

  const [isOpen, setIsOpen] = useState(false);

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

  const handleLogout = async () => {
    setIsOpen(false);
    // The till's own flow owns the confirmation, because on an open shift logging out
    // means counting the drawer first — a yes/no prompt would be answered before the
    // person knew what they were agreeing to.
    if (onLogout) {
      onLogout();
      return;
    }
    if (window.confirm('Log out of the till? Syncing carries on in the background.')) {
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

    </>
  );
};
