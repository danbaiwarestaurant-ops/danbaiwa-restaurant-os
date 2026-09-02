import React from 'react';
import { ArrowDownCircle, X } from 'lucide-react';
import { useUpdateStore } from '../../services/pwaUpdate';

/**
 * The "a new version is ready" prompt.
 *
 * At the TOP of the screen, deliberately. The previous banner sat at the bottom, which on
 * a kiosk is the one edge that is easy to miss entirely — and a prompt nobody sees is why
 * a till can sit on a month-old build while everyone assumes it updated.
 *
 * Dismiss hides it for ten minutes rather than for good (see pwaUpdate.ts): the cashier
 * gets to finish what they are doing, and the update still lands today.
 */
export const UpdateBanner: React.FC = () => {
  const { updateReady, dismissed, applyUpdate, dismiss } = useUpdateStore();

  if (!updateReady || dismissed) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[9999] bg-amber-500 border-b-4 border-amber-700 shadow-lg">
      <div className="max-w-5xl mx-auto flex items-center gap-3 px-4 py-2.5">
        <ArrowDownCircle className="w-5 h-5 text-amber-950 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-black uppercase tracking-wide text-amber-950">
            A new version of the till is ready
          </div>
          <div className="text-[11px] font-semibold text-amber-900">
            Finish what you are doing, then press Update. It takes a second.
          </div>
        </div>
        <button
          type="button"
          onClick={applyUpdate}
          className="px-4 py-2 bg-slate-900 text-white text-xs font-black uppercase tracking-wide hover:bg-slate-800 flex-shrink-0"
        >
          Update Now
        </button>
        <button
          type="button"
          onClick={dismiss}
          title="Remind me in 10 minutes"
          className="p-1.5 text-amber-950 hover:bg-amber-600 flex-shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
