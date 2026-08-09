import React, { useState } from 'react';
import { useAuthStore } from '../../store/useAuthStore';
import { UserPlus, Users, KeyRound, CheckCircle2 } from 'lucide-react';

export const StaffManagement: React.FC = () => {
  const { users, createStaffCashier, resetCashierPin } = useAuthStore();
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  // Reset PIN modal state
  const [resetModalUser, setResetModalUser] = useState<{ id: string; name: string } | null>(null);
  const [newCashierPin, setNewCashierPin] = useState('');

  const handleCreateCashier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !username.trim() || pin.length < 4) return;

    await createStaffCashier(name, username, pin);
    setMsg(`Cashier account "${name}" created successfully`);
    setName('');
    setUsername('');
    setPin('');

    setTimeout(() => setMsg(null), 3000);
  };

  const handleResetCashierPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetModalUser || newCashierPin.length < 4) return;

    await resetCashierPin(resetModalUser.id, newCashierPin);
    setMsg(`PIN for "${resetModalUser.name}" reset successfully`);
    setResetModalUser(null);
    setNewCashierPin('');

    setTimeout(() => setMsg(null), 3000);
  };

  return (
    <div className="bg-white border-2 border-slate-300 p-5 shadow-xs rounded-none space-y-6">
      <div className="flex items-center justify-between border-b-2 border-slate-200 pb-3">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-2">
          <Users className="w-4 h-4 text-amber-500" />
          <span>Staff Cashier Management (Admin Only)</span>
        </h3>
        <span className="text-[11px] font-mono text-slate-500">
          Salted SQLite Auth • Supabase Outbox Synced
        </span>
      </div>

      {msg && (
        <div className="p-3 bg-emerald-50 border-2 border-emerald-400 text-emerald-950 text-xs font-bold uppercase rounded-none flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          <span>{msg}</span>
        </div>
      )}

      {/* Create New Staff Cashier Form */}
      <form onSubmit={handleCreateCashier} className="bg-slate-50 border-2 border-slate-200 p-4 space-y-3 rounded-none">
        <div className="text-xs font-bold uppercase text-slate-800 flex items-center gap-1.5">
          <UserPlus className="w-4 h-4 text-amber-600" />
          <span>Add New Staff Cashier Account</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-[11px] font-bold uppercase text-slate-600 mb-1">
              Cashier Name
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Sarah Connor"
              className="w-full p-2.5 border-2 border-slate-300 rounded-none text-xs font-semibold text-slate-900 focus:border-amber-500 focus:outline-none"
              required
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase text-slate-600 mb-1">
              Staff ID / Username
            </label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="e.g. cashier-02"
              className="w-full p-2.5 border-2 border-slate-300 rounded-none text-xs font-mono font-bold text-slate-900 focus:border-amber-500 focus:outline-none"
              required
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase text-slate-600 mb-1">
              Staff Cashier PIN (4-8 Digits)
            </label>
            <input
              type="password"
              value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
              placeholder="Custom PIN"
              maxLength={8}
              className="w-full p-2.5 border-2 border-slate-300 rounded-none font-mono font-black text-center text-sm text-slate-900 focus:border-amber-500 focus:outline-none"
              required
            />
          </div>
        </div>

        <div className="flex justify-end pt-1">
          <button
            type="submit"
            disabled={!name || !username || !pin}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-black uppercase text-xs tracking-wider border border-amber-600 rounded-none shadow-xs"
          >
            Create Cashier Account
          </button>
        </div>
      </form>

      {/* Existing Staff Roster Table */}
      <div>
        <h4 className="text-xs font-bold uppercase text-slate-600 mb-2">Registered Accounts Roster</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse font-mono">
            <thead>
              <tr className="border-b-2 border-slate-200 text-slate-500 uppercase">
                <th className="py-2">Staff ID</th>
                <th className="py-2">Name</th>
                <th className="py-2">Role</th>
                <th className="py-2">Status</th>
                <th className="py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map(u => (
                <tr key={u.id} className="hover:bg-slate-50">
                  <td className="py-2.5 font-bold text-slate-900">@{u.username}</td>
                  <td className="py-2.5 font-sans font-bold text-slate-800">{u.name}</td>
                  <td className="py-2.5">
                    <span className={`px-2 py-0.5 border text-[10px] font-bold uppercase rounded-none ${
                      u.role === 'admin'
                        ? 'bg-amber-100 border-amber-300 text-amber-900'
                        : 'bg-slate-100 border-slate-300 text-slate-800'
                    }`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="py-2.5 font-bold text-emerald-600 uppercase">{u.status}</td>
                  <td className="py-2.5 text-right">
                    {u.role === 'cashier' && (
                      <button
                        onClick={() => setResetModalUser({ id: u.id, name: u.name })}
                        className="px-2.5 py-1 text-[11px] font-bold uppercase bg-slate-100 hover:bg-amber-50 text-slate-700 hover:text-amber-900 border border-slate-300 rounded-none flex items-center gap-1 ml-auto"
                      >
                        <KeyRound className="w-3 h-3 text-amber-600" />
                        <span>Reset PIN</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Admin Reset Staff PIN Modal */}
      {resetModalUser && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white border-2 border-slate-900 w-full max-w-sm p-5 rounded-none shadow-2xl space-y-4">
            <h4 className="font-black text-sm uppercase text-slate-900 flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-amber-600" />
              <span>Reset PIN for {resetModalUser.name}</span>
            </h4>

            <form onSubmit={handleResetCashierPin} className="space-y-4">
              <div>
                <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
                  Enter New Cashier PIN
                </label>
                <input
                  type="password"
                  value={newCashierPin}
                  onChange={e => setNewCashierPin(e.target.value.replace(/\D/g, ''))}
                  placeholder="4-8 Digits"
                  maxLength={8}
                  className="w-full p-2.5 border-2 border-slate-300 text-center font-mono font-black text-lg text-slate-900 rounded-none focus:border-amber-500 focus:outline-none"
                  autoFocus
                  required
                />
              </div>

              <div className="flex justify-end gap-2 border-t pt-3">
                <button
                  type="button"
                  onClick={() => {
                    setResetModalUser(null);
                    setNewCashierPin('');
                  }}
                  className="px-3 py-1.5 text-xs font-bold uppercase border border-slate-300 rounded-none"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={newCashierPin.length < 4}
                  className="px-4 py-1.5 text-xs font-black uppercase bg-amber-500 text-white rounded-none border border-amber-600 shadow-xs"
                >
                  Update PIN
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
