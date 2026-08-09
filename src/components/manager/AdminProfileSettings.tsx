import React, { useState } from 'react';
import { useAuthStore } from '../../store/useAuthStore';
import { UserCheck, Mail, KeyRound, CheckCircle2, Shield, LogOut } from 'lucide-react';

interface AdminProfileSettingsProps {
  onLogoutAdmin?: () => void;
}

export const AdminProfileSettings: React.FC<AdminProfileSettingsProps> = ({ onLogoutAdmin }) => {
  const { users, updateAdminProfile, logoutUser } = useAuthStore();
  const currentAdmin = users.find(u => u.role === 'admin');

  const [name, setName] = useState(currentAdmin ? currentAdmin.name : '');
  const [email, setEmail] = useState(currentAdmin ? currentAdmin.email || currentAdmin.username : '');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!currentAdmin) return null;

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setError(null);

    if (!name.trim() || !email.trim()) {
      setError('Name and Email are required');
      return;
    }

    if (!email.includes('@') || !email.includes('.')) {
      setError('Please enter a valid email address');
      return;
    }

    if (newPin) {
      if (newPin.length < 4 || newPin.length > 8) {
        setError('New PIN must be 4 to 8 numeric digits');
        return;
      }

      if (newPin !== confirmPin) {
        setError('New PINs do not match');
        return;
      }
    }

    const success = await updateAdminProfile(currentAdmin.id, name, email, newPin || undefined);
    if (success) {
      setMsg('Admin Profile & Security Settings updated successfully');
      setNewPin('');
      setConfirmPin('');
      setTimeout(() => setMsg(null), 3000);
    } else {
      setError('Failed to update Admin Profile');
    }
  };

  const handleLogout = async () => {
    await logoutUser();
    if (onLogoutAdmin) onLogoutAdmin();
  };

  return (
    <div className="bg-white border-2 border-slate-300 p-5 shadow-xs rounded-none space-y-4">
      <div className="flex items-center justify-between border-b-2 border-slate-200 pb-3">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-2">
          <Shield className="w-4 h-4 text-amber-500" />
          <span>Admin Profile & Security Settings</span>
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-slate-500 uppercase">
            PRIMARY ADMIN
          </span>
          <button
            onClick={handleLogout}
            className="flex items-center gap-1 px-3 py-1 bg-rose-600 hover:bg-rose-700 text-white text-xs font-black uppercase transition border border-rose-700 rounded-none shadow-xs"
            title="Logout Admin session and exit Manager Mode"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Logout Admin Session</span>
          </button>
        </div>
      </div>

      {msg && (
        <div className="p-3 bg-emerald-50 border-2 border-emerald-400 text-emerald-950 text-xs font-bold uppercase rounded-none flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          <span>{msg}</span>
        </div>
      )}

      {error && (
        <div className="p-3 bg-rose-50 border-2 border-rose-400 text-rose-900 text-xs font-bold uppercase rounded-none">
          {error}
        </div>
      )}

      <form onSubmit={handleUpdateProfile} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1 flex items-center gap-1">
              <UserCheck className="w-3.5 h-3.5 text-amber-600" />
              <span>Admin Full Name</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full p-2.5 border-2 border-slate-300 rounded-none text-xs font-semibold text-slate-900 focus:border-amber-500 focus:outline-none"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-700 mb-1 flex items-center gap-1">
              <Mail className="w-3.5 h-3.5 text-amber-600" />
              <span>Registered Owner Email</span>
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full p-2.5 border-2 border-slate-300 rounded-none text-xs font-mono font-bold text-slate-900 focus:border-amber-500 focus:outline-none"
              required
            />
          </div>
        </div>

        {/* Change Admin PIN Section */}
        <div className="bg-slate-50 border-2 border-slate-200 p-4 space-y-3 rounded-none">
          <div className="text-xs font-bold uppercase text-slate-800 flex items-center gap-1.5">
            <KeyRound className="w-4 h-4 text-amber-600" />
            <span>Change Admin PIN (Optional)</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-bold uppercase text-slate-600 mb-1">
                New Admin PIN (4-8 Digits)
              </label>
              <input
                type="password"
                value={newPin}
                onChange={e => setNewPin(e.target.value.replace(/\D/g, ''))}
                placeholder="Leave blank to keep current PIN"
                maxLength={8}
                className="w-full p-2 border-2 border-slate-300 text-center font-mono font-black text-sm text-slate-900 rounded-none focus:border-amber-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-[11px] font-bold uppercase text-slate-600 mb-1">
                Confirm New Admin PIN
              </label>
              <input
                type="password"
                value={confirmPin}
                onChange={e => setConfirmPin(e.target.value.replace(/\D/g, ''))}
                placeholder="Confirm new PIN"
                maxLength={8}
                className="w-full p-2 border-2 border-slate-300 text-center font-mono font-black text-sm text-slate-900 rounded-none focus:border-amber-500 focus:outline-none"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2 border-t">
          <button
            type="button"
            onClick={handleLogout}
            className="px-4 py-2 bg-rose-50 hover:bg-rose-100 text-rose-900 border border-rose-300 font-bold uppercase text-xs rounded-none flex items-center gap-1.5"
          >
            <LogOut className="w-3.5 h-3.5 text-rose-600" />
            <span>Logout Admin</span>
          </button>

          <button
            type="submit"
            className="px-5 py-2 bg-amber-500 hover:bg-amber-600 text-white font-black uppercase text-xs tracking-wider border border-amber-600 rounded-none shadow-xs transition active:scale-95"
          >
            Save Admin Profile Changes
          </button>
        </div>
      </form>
    </div>
  );
};
