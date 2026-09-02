import React from 'react';
import { RefreshCw, ArrowDownCircle, CheckCircle2 } from 'lucide-react';
import { Panel, ConsoleButton } from './ConsoleUI';
import { buildLabel, useUpdateStore } from '../../services/pwaUpdate';

/**
 * Which build this till is running, and a way to move it on.
 *
 * "The site still shows the old version" is not a question anyone should have to answer
 * by looking at behaviour and guessing. Two tills side by side, both claiming to be on
 * the live link, can genuinely be on different builds — a service worker holds the old
 * one until every window closes — so the build has to be readable, per till, on screen.
 */
export const AppVersionSettings: React.FC = () => {
  const { updateReady, checking, lastCheckMessage, checkNow, applyUpdate } = useUpdateStore();

  return (
    <Panel
      title="App Version"
      subtitle="What this till is running, and whether anything newer exists"
      icon={RefreshCw}
    >
      <div className="space-y-3">
        <div className="flex items-baseline justify-between gap-3 border-b border-slate-200 pb-2">
          <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">
            This till
          </span>
          <span className="text-xs font-mono font-bold text-slate-800 text-right">{buildLabel()}</span>
        </div>

        {updateReady ? (
          <div className="p-3 bg-amber-50 border-2 border-amber-400 space-y-2">
            <div className="text-xs font-black uppercase text-amber-950 flex items-center gap-2">
              <ArrowDownCircle className="w-4 h-4 text-amber-600" />
              A newer version is downloaded and waiting
            </div>
            <p className="text-[11px] font-semibold text-amber-900">
              It will not take effect until the till reloads. Nothing is lost — queued
              tickets and settings are on the device, not in the page.
            </p>
            <ConsoleButton onClick={applyUpdate} variant="primary">
              Update now
            </ConsoleButton>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-600">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            No newer version has been downloaded yet.
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <ConsoleButton onClick={() => void checkNow()} disabled={checking}>
            {checking ? 'Checking...' : 'Check for updates'}
          </ConsoleButton>
          {lastCheckMessage && (
            <span className="text-[11px] font-semibold text-slate-600">{lastCheckMessage}</span>
          )}
        </div>

        <p className="text-[11px] font-semibold text-slate-500">
          The till checks on its own every fifteen minutes and whenever it comes back
          online. If a till is stuck on an old version and this button does not shift it,
          close the app completely — every window — and open it again.
        </p>
      </div>
    </Panel>
  );
};
