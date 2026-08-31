import React, { useState } from 'react';
import { Lock, X, Play, User, MapPin, Clock, Loader2 } from 'lucide-react';
import { useShiftStore } from '../../store/useShiftStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useDeviceStore } from '../../store/useDeviceStore';

interface OpenShiftModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (msg: string) => void;
}

/**
 * Confirmation only — no data entry.
 *
 * This used to ask for a cashier name and an opening cash float before every shift. The
 * name was already known (whoever is signed in) and re-typing it only created a way to
 * mislabel a shift, so both fields are gone: the shift opens for the signed-in user on
 * one click. Opening float is recorded as 0, which
 * calculateShiftReconciliation already handles — close-out reconciles tickets minus
 * approved expenses.
 */
export const OpenShiftModal: React.FC<OpenShiftModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const { activeUser } = useAuthStore();
  const { config } = useDeviceStore();
  const { openShift } = useShiftStore();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleConfirm = async () => {
    if (isSubmitting) return;

    if (!activeUser) {
      setError('No one is signed in on this till, so there is no cashier to open a shift for.');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);
      await openShift(0, activeUser.name, activeUser.id);
      onSuccess(`Shift opened for ${activeUser.name}`);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Could not open the shift.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white border-2 border-slate-900 w-full max-w-sm overflow-hidden shadow-2xl rounded-none">
        <div className="bg-emerald-700 text-white px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-sm">
            <Lock className="w-4 h-4" />
            <span>Open Cashier Shift</span>
          </div>
          <button onClick={onClose} className="text-emerald-200 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <p className="text-xs font-bold uppercase text-slate-600">
            Start a new shift on this till?
          </p>

          <div className="border-2 border-slate-200 divide-y divide-slate-200 rounded-none">
            <div className="flex items-center gap-3 px-4 py-3">
              <User className="w-4 h-4 text-amber-600 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase text-slate-500">Cashier</div>
                <div className="text-sm font-black text-slate-900 truncate">
                  {activeUser?.name || 'Not signed in'}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 px-4 py-3">
              <MapPin className="w-4 h-4 text-amber-600 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase text-slate-500">Till</div>
                <div className="text-sm font-mono font-bold text-slate-900 truncate">
                  {config.locationId}-{config.deviceId}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 px-4 py-3">
              <Clock className="w-4 h-4 text-amber-600 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase text-slate-500">Opening At</div>
                <div className="text-sm font-mono font-bold text-slate-900">
                  {new Date().toLocaleString()}
                </div>
              </div>
            </div>
          </div>

          {error && (
            <div className="p-3 bg-rose-50 border-2 border-rose-400 text-rose-900 text-[11px] font-semibold normal-case rounded-none">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-bold uppercase border border-slate-300 rounded-none text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={isSubmitting || !activeUser}
              autoFocus
              className="flex items-center gap-1 px-4 py-2 text-xs font-black uppercase bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-none shadow-xs"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Opening...</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" />
                  <span>Start Shift</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
