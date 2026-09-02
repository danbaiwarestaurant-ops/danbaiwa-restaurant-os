import React, { useEffect, useState } from 'react';
import { Stethoscope, ChevronDown, ChevronUp } from 'lucide-react';
import { dbService } from '../../services/db/IndexedDbService';
import { supabase, isSupabaseConfigured, SUPABASE_URL } from '../../services/supabase/supabaseClient';
import { hasWebCrypto } from '../../services/auth/loginErrors';
import { buildLabel } from '../../services/pwaUpdate';

/**
 * What this till actually is, shown on the sign-in screen itself.
 *
 * A kiosk has no address bar, no devtools and no console. When a login is refused there,
 * every question worth asking — which address is this, is it a secure origin, is there a
 * cloud at all, which accounts does this machine even have — is unanswerable from the
 * seat, and the same three failures get reported as "it just says wrong password".
 *
 * The insecure-origin case is the one that most deserves saying out loud: browsers
 * withhold crypto.subtle on plain http:// (a LAN address like http://192.168.1.20:5173),
 * every PIN comparison throws, and no combination of correct credentials can ever work.
 * localhost and https:// are exempt, which is why the same build is fine on the machine
 * it was set up on and dead on the till next to it.
 */

interface Facts {
  address: string;
  secure: boolean;
  crypto: boolean;
  online: boolean;
  cloudHost: string | null;
  session: string | null;
  accounts: { label: string; role: string; status: string }[];
  dbError: string | null;
}

const Row: React.FC<{ label: string; value: string; bad?: boolean }> = ({ label, value, bad }) => (
  <div className="flex items-baseline justify-between gap-3 py-1 border-b border-slate-200 last:border-b-0">
    <span className="text-[10px] font-black uppercase tracking-wider text-slate-500 flex-shrink-0">{label}</span>
    <span className={`text-[11px] font-mono font-bold text-right break-all ${bad ? 'text-rose-700' : 'text-slate-800'}`}>
      {value}
    </span>
  </div>
);

export const TillDiagnostics: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [facts, setFacts] = useState<Facts | null>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    (async () => {
      let accounts: Facts['accounts'] = [];
      let dbError: string | null = null;
      try {
        // Every local account, not the account-scoped roster: "which accounts does this
        // machine hold" is precisely the question, and scoping it would hide the answer.
        const users = await dbService.getUsers();
        accounts = users.map((u) => ({
          label: u.username || u.email || u.id,
          role: u.role,
          status: u.status,
        }));
      } catch (e: any) {
        dbError = e?.message || 'local database could not be opened';
      }

      let session: string | null = null;
      if (isSupabaseConfigured) {
        try {
          const { data } = await supabase.auth.getSession();
          session = data?.session?.user?.email ?? null;
        } catch {
          session = null;
        }
      }

      if (cancelled) return;
      setFacts({
        address: `${window.location.origin}${window.location.pathname}`,
        secure: window.isSecureContext,
        crypto: hasWebCrypto(),
        online: navigator.onLine,
        cloudHost: isSupabaseConfigured ? new URL(SUPABASE_URL).host : null,
        session,
        accounts,
        dbError,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <div className="border-2 border-slate-300 rounded-none">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-slate-100 hover:bg-slate-200 transition"
      >
        <span className="flex items-center gap-2 text-[11px] font-black uppercase tracking-wider text-slate-700">
          <Stethoscope className="w-3.5 h-3.5 text-slate-500" />
          Why can&apos;t I sign in?
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
      </button>

      {open && (
        <div className="p-3 space-y-2 bg-white">
          {!facts ? (
            <div className="text-[11px] font-bold uppercase text-slate-400">Checking this till...</div>
          ) : (
            <>
              {/* The one condition that refuses every correct credential, stated first. */}
              {!facts.crypto && (
                <div className="p-2 bg-rose-50 border-2 border-rose-400 text-[11px] font-semibold text-rose-900 normal-case">
                  <span className="font-black uppercase">This is the problem.</span> This address is not a
                  secure origin, so the browser withholds the crypto engine and no PIN or password can be
                  checked — correct ones included. Open the till over <span className="font-mono font-bold">https://</span>{' '}
                  or at <span className="font-mono font-bold">http://localhost</span>. A plain{' '}
                  <span className="font-mono font-bold">http://</span> LAN address will never work.
                </div>
              )}

              {facts.dbError && (
                <div className="p-2 bg-rose-50 border-2 border-rose-400 text-[11px] font-semibold text-rose-900 normal-case">
                  <span className="font-black uppercase">Local storage is unavailable:</span> {facts.dbError}.
                  Private/Incognito windows and blocked site data both do this.
                </div>
              )}

              <div>
                <Row label="App version" value={buildLabel()} />
                <Row label="Address" value={facts.address} />
                <Row label="Secure origin" value={facts.secure ? 'yes' : 'no'} bad={!facts.secure} />
                <Row label="PIN checks possible" value={facts.crypto ? 'yes' : 'no'} bad={!facts.crypto} />
                <Row label="Network" value={facts.online ? 'online' : 'offline'} bad={!facts.online} />
                <Row
                  label="Cloud"
                  value={facts.cloudHost ?? 'not configured in this build'}
                  bad={!facts.cloudHost}
                />
                <Row label="Cloud session" value={facts.session ?? 'none'} />
                <Row label="Accounts on this till" value={String(facts.accounts.length)} />
              </div>

              {facts.accounts.length > 0 && (
                <div className="pt-1">
                  <div className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1">
                    Sign in as one of these
                  </div>
                  <ul className="space-y-0.5">
                    {facts.accounts.map((a) => (
                      <li key={a.label} className="text-[11px] font-mono font-bold text-slate-800">
                        {a.label}{' '}
                        <span className="font-sans font-semibold text-slate-500">
                          ({a.role}
                          {a.status !== 'active' ? `, ${a.status}` : ''})
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-[10px] font-semibold text-slate-500 normal-case">
                    Anything not on this list has to come down from the cloud, which needs the admin
                    email and admin PIN.
                  </p>
                </div>
              )}

              {facts.accounts.length === 0 && !facts.dbError && (
                <p className="text-[11px] font-semibold text-slate-600 normal-case">
                  This till holds no accounts yet, so every sign-in has to be pulled from the cloud —
                  use the admin email address and the admin PIN, not a staff ID.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
