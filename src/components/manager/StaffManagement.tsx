import React, { useState } from 'react';
import { useAuthStore, StaffRecordCounts } from '../../store/useAuthStore';
import { UserAccount } from '../../types/user';
import {
  UserPlus, Users, KeyRound, CheckCircle2, Pencil, Trash2,
  UserMinus, UserCheck, AlertTriangle,
} from 'lucide-react';

/** Small square action button, matching the roster's density. */
const RowAction: React.FC<{
  onClick: () => void;
  icon: React.ElementType;
  label: string;
  tone?: 'neutral' | 'danger';
}> = ({ onClick, icon: Icon, label, tone = 'neutral' }) => (
  <button
    onClick={onClick}
    title={label}
    className={`px-2.5 py-1 text-[11px] font-bold uppercase border rounded-none flex items-center gap-1 transition ${
      tone === 'danger'
        ? 'bg-white hover:bg-rose-50 text-rose-700 border-rose-300'
        : 'bg-slate-100 hover:bg-amber-50 text-slate-700 hover:text-amber-900 border-slate-300'
    }`}
  >
    <Icon className="w-3 h-3" />
    <span>{label}</span>
  </button>
);

export const StaffManagement: React.FC = () => {
  const {
    users, activeUser, createStaffCashier, resetCashierPin,
    updateStaffMember, setStaffStatus, countStaffRecords, deleteStaffMember,
  } = useAuthStore();

  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [resetModalUser, setResetModalUser] = useState<{ id: string; name: string } | null>(null);
  const [newCashierPin, setNewCashierPin] = useState('');

  const [editUser, setEditUser] = useState<UserAccount | null>(null);
  const [editName, setEditName] = useState('');
  const [editUsername, setEditUsername] = useState('');

  // Delete is a two-part dialog: it first counts what the account owns, then either
  // refuses with the reason or asks the admin to type the name to confirm.
  const [deleteUser, setDeleteUser] = useState<UserAccount | null>(null);
  const [deleteCounts, setDeleteCounts] = useState<StaffRecordCounts | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  const flash = (m: string) => {
    setError(null);
    setMsg(m);
    setTimeout(() => setMsg(null), 3500);
  };
  const fail = (m: string) => {
    setMsg(null);
    setError(m);
  };

  const handleCreateCashier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !username.trim() || pin.length < 4) return;

    await createStaffCashier(name, username, pin);
    flash(`Cashier account "${name}" created successfully`);
    setName('');
    setUsername('');
    setPin('');
  };

  const handleResetCashierPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetModalUser || newCashierPin.length < 4) return;

    await resetCashierPin(resetModalUser.id, newCashierPin);
    flash(`PIN for "${resetModalUser.name}" reset successfully`);
    setResetModalUser(null);
    setNewCashierPin('');
  };

  const openEdit = (u: UserAccount) => {
    setError(null);
    setEditUser(u);
    setEditName(u.name);
    setEditUsername(u.username || '');
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editUser) return;
    const res = await updateStaffMember(editUser.id, editName, editUsername);
    if (!res.ok) {
      fail(res.message || 'Could not update that account.');
      return;
    }
    flash(`"${editName.trim()}" updated`);
    setEditUser(null);
  };

  const handleToggleStatus = async (u: UserAccount) => {
    const next = u.status === 'active' ? 'deactivated' : 'active';
    if (
      next === 'deactivated' &&
      !window.confirm(
        `Deactivate ${u.name}?\n\nThey will no longer be able to sign in or open a shift. ` +
          `Every ticket, shift and expense they recorded is kept, and you can reactivate them at any time.`
      )
    ) {
      return;
    }
    const res = await setStaffStatus(u.id, next);
    if (!res.ok) {
      fail(res.message || 'Could not change that account.');
      return;
    }
    flash(next === 'active' ? `${u.name} reactivated` : `${u.name} deactivated — their records are kept`);
  };

  const openDelete = async (u: UserAccount) => {
    setError(null);
    setDeleteConfirmText('');
    setDeleteCounts(null);
    setDeleteUser(u);
    setDeleteCounts(await countStaffRecords(u.id));
  };

  const handleDelete = async () => {
    if (!deleteUser) return;
    const res = await deleteStaffMember(deleteUser.id);
    if (!res.ok) {
      fail(res.message || 'Could not delete that account.');
      setDeleteUser(null);
      return;
    }
    flash(`"${deleteUser.name}" permanently deleted`);
    setDeleteUser(null);
  };

  const deletable = deleteCounts !== null && deleteCounts.total === 0;

  return (
    <div className="bg-white border-2 border-slate-300 p-5 shadow-xs rounded-none space-y-6">
      <div className="flex items-center justify-between border-b-2 border-slate-200 pb-3">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-2">
          <Users className="w-4 h-4 text-amber-500" />
          <span>Staff Cashier Management (Admin Only)</span>
        </h3>
        <span className="text-[11px] font-mono text-slate-500">
          Salted Local Auth • Supabase Outbox Synced
        </span>
      </div>

      {msg && (
        <div className="p-3 bg-emerald-50 border-2 border-emerald-400 text-emerald-950 text-xs font-bold uppercase rounded-none flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          <span>{msg}</span>
        </div>
      )}

      {error && (
        <div className="p-3 bg-rose-50 border-2 border-rose-400 text-rose-900 text-xs font-semibold normal-case rounded-none flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
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
              {users.map(u => {
                const isSelf = activeUser?.id === u.id;
                const isActive = u.status === 'active';
                return (
                  <tr key={u.id} className={`hover:bg-slate-50 ${isActive ? '' : 'bg-slate-50/60'}`}>
                    <td className="py-2.5 font-bold text-slate-900">@{u.username}</td>
                    <td className="py-2.5 font-sans font-bold text-slate-800">
                      {u.name}
                      {isSelf && (
                        <span className="ml-1.5 text-[10px] font-black uppercase text-amber-600">· at this till</span>
                      )}
                    </td>
                    <td className="py-2.5">
                      <span className={`px-2 py-0.5 border text-[10px] font-bold uppercase rounded-none ${
                        u.role === 'admin'
                          ? 'bg-amber-100 border-amber-300 text-amber-900'
                          : 'bg-slate-100 border-slate-300 text-slate-800'
                      }`}>
                        {u.role}
                      </span>
                    </td>
                    <td className={`py-2.5 font-bold uppercase ${isActive ? 'text-emerald-600' : 'text-slate-400'}`}>
                      {u.status}
                    </td>
                    <td className="py-2.5">
                      <div className="flex items-center justify-end gap-1.5 flex-wrap">
                        <RowAction onClick={() => openEdit(u)} icon={Pencil} label="Edit" />
                        {u.role === 'cashier' && (
                          <>
                            <RowAction
                              onClick={() => setResetModalUser({ id: u.id, name: u.name })}
                              icon={KeyRound}
                              label="Reset PIN"
                            />
                            <RowAction
                              onClick={() => handleToggleStatus(u)}
                              icon={isActive ? UserMinus : UserCheck}
                              label={isActive ? 'Deactivate' : 'Reactivate'}
                            />
                            <RowAction onClick={() => openDelete(u)} icon={Trash2} label="Delete" tone="danger" />
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-500 font-semibold mt-2.5">
          Deactivating blocks sign-in but keeps every record the cashier created. Deleting is
          only possible for an account that has never recorded anything.
        </p>
      </div>

      {/* Edit Staff Details */}
      {editUser && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white border-2 border-slate-900 w-full max-w-sm p-5 rounded-none shadow-2xl space-y-4">
            <h4 className="font-black text-sm uppercase text-slate-900 flex items-center gap-2">
              <Pencil className="w-4 h-4 text-amber-600" />
              <span>Edit {editUser.role === 'admin' ? 'Admin' : 'Cashier'} Details</span>
            </h4>

            <form onSubmit={handleEditSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold uppercase text-slate-700 mb-1">Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full p-2.5 border-2 border-slate-300 text-xs font-semibold text-slate-900 rounded-none focus:border-amber-500 focus:outline-none"
                  autoFocus
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold uppercase text-slate-700 mb-1">Staff ID / Username</label>
                <input
                  type="text"
                  value={editUsername}
                  onChange={(e) => setEditUsername(e.target.value)}
                  className="w-full p-2.5 border-2 border-slate-300 font-mono text-xs font-bold text-slate-900 rounded-none focus:border-amber-500 focus:outline-none"
                  required
                />
                <p className="text-[11px] text-slate-500 font-semibold mt-1 normal-case">
                  {editUser.role === 'admin'
                    ? 'The admin signs in with their email address, changed under Settings — this is their display ID.'
                    : 'This is what the cashier signs in with. Their PIN is unchanged.'}
                </p>
              </div>

              <div className="flex justify-end gap-2 border-t pt-3">
                <button
                  type="button"
                  onClick={() => setEditUser(null)}
                  className="px-3 py-1.5 text-xs font-bold uppercase border border-slate-300 rounded-none"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!editName.trim() || !editUsername.trim()}
                  className="px-4 py-1.5 text-xs font-black uppercase bg-amber-500 disabled:opacity-50 text-white rounded-none border border-amber-600 shadow-xs"
                >
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

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

      {/* Permanent delete — refuses outright when the account owns any history */}
      {deleteUser && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white border-4 border-rose-600 w-full max-w-md rounded-none shadow-2xl">
            <div className="bg-rose-600 text-white px-5 py-3.5 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5" />
              <h4 className="font-black text-sm uppercase tracking-wider">Delete {deleteUser.name} permanently</h4>
            </div>

            <div className="p-5 space-y-4">
              {deleteCounts === null ? (
                <p className="text-xs font-bold uppercase text-slate-500">Checking what this account owns…</p>
              ) : deletable ? (
                <>
                  <p className="text-xs font-semibold text-slate-700 normal-case leading-relaxed">
                    This account has never issued a ticket, opened a shift or logged an expense,
                    so nothing is lost by removing it. It will be deleted on this till and in the
                    cloud, on every device signed into this account.
                  </p>
                  <p className="text-xs font-semibold text-slate-700 normal-case leading-relaxed">
                    This cannot be undone. Type <span className="font-mono font-black text-rose-700">{deleteUser.name}</span> to confirm.
                  </p>
                  <input
                    type="text"
                    value={deleteConfirmText}
                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                    placeholder={deleteUser.name}
                    autoFocus
                    className="w-full p-2.5 border-2 border-slate-300 text-xs font-bold text-slate-900 rounded-none focus:border-rose-500 focus:outline-none"
                  />
                </>
              ) : (
                <>
                  <div className="p-3 bg-amber-50 border-2 border-amber-400 text-amber-950 text-xs font-semibold normal-case rounded-none leading-relaxed">
                    <span className="font-black uppercase">Cannot delete.</span> {deleteUser.name} owns
                    records, and a ticket keeps only the cashier's id — deleting the account would
                    strip their name off that history for good.
                  </div>
                  <table className="w-full text-xs">
                    <tbody className="divide-y divide-slate-100">
                      {[
                        ['Tickets', deleteCounts.tickets],
                        ['Shifts', deleteCounts.shifts],
                        ['Expenses', deleteCounts.expenses],
                        ['Audit entries', deleteCounts.auditLogs],
                      ].map(([label, n]) => (
                        <tr key={String(label)}>
                          <td className="py-1.5 text-slate-600 font-medium">{label}</td>
                          <td className="py-1.5 text-right font-mono font-bold tabular-nums">{n}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-xs font-semibold text-slate-700 normal-case leading-relaxed">
                    Deactivate them instead — they lose access immediately, and every record keeps
                    their name.
                  </p>
                </>
              )}

              <div className="flex justify-end gap-2 border-t pt-3">
                <button
                  type="button"
                  onClick={() => setDeleteUser(null)}
                  className="px-3 py-1.5 text-xs font-bold uppercase border border-slate-300 rounded-none text-slate-700 hover:bg-slate-100"
                >
                  Cancel
                </button>
                {deletable ? (
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleteConfirmText.trim() !== deleteUser.name}
                    className="px-4 py-1.5 text-xs font-black uppercase bg-rose-600 hover:bg-rose-700 disabled:opacity-40 text-white rounded-none border border-rose-700 shadow-xs"
                  >
                    Delete Permanently
                  </button>
                ) : (
                  deleteCounts !== null && (
                    <button
                      type="button"
                      onClick={async () => {
                        const u = deleteUser;
                        setDeleteUser(null);
                        await handleToggleStatus(u);
                      }}
                      disabled={deleteUser.status !== 'active'}
                      className="px-4 py-1.5 text-xs font-black uppercase bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white rounded-none shadow-xs"
                    >
                      Deactivate Instead
                    </button>
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
