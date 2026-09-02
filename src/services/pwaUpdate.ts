import { create } from 'zustand';
import { registerSW } from 'virtual:pwa-register';

/**
 * pwaUpdate.ts
 *
 * Getting a new build onto a till that is already running one.
 *
 * The failure this exists to fix: a new service worker installs and then sits in the
 * "waiting" state until every window running the old one has closed. Reloading does not
 * close them — the reload is itself a client — so a till can be refreshed a thousand
 * times and keep serving the old build for ever. In kiosk mode, where the app never
 * closes and a banner at the bottom of the screen is easy to miss, that is the normal
 * outcome rather than the exception.
 *
 * Three things fix it:
 *
 *   * the till asks the server for a new version on a timer and whenever it comes back to
 *     the foreground, instead of only at startup;
 *   * the prompt is prominent, and comes back if it is dismissed, because an update that
 *     can be permanently waved away is an update that never happens;
 *   * the build is visible in the app, so "is this till on the new version?" is a
 *     question anyone can answer by looking, rather than by guessing from behaviour.
 *
 * Still a prompt rather than an automatic reload: reloading a POS mid-sale would lose
 * whatever the cashier was in the middle of typing. The prompt insists, but a person
 * still picks the moment.
 */

/** Injected at build time — see vite.config.ts. */
declare const __APP_BUILD__: { version: string; builtAt: string };

export const APP_BUILD: { version: string; builtAt: string } =
  typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : { version: 'dev', builtAt: 'dev' };

/** How the build reads on screen: version plus the day and time it was built. */
export function buildLabel(): string {
  if (APP_BUILD.builtAt === 'dev') return `v${APP_BUILD.version} (dev)`;
  const at = new Date(APP_BUILD.builtAt);
  return Number.isNaN(at.getTime())
    ? `v${APP_BUILD.version}`
    : `v${APP_BUILD.version} — ${at.toLocaleString()}`;
}

/** A dismissed prompt comes back, so an update cannot be waved away permanently. */
const RE_PROMPT_AFTER_MS = 10 * 60 * 1000;

/** Long enough not to hammer the server, short enough that a fix lands the same day. */
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;

interface UpdateState {
  /** A new build is downloaded and waiting to take over. */
  updateReady: boolean;
  /** Hidden until the re-prompt timer fires. */
  dismissed: boolean;
  /** True while a manual check is in flight, for the button that started it. */
  checking: boolean;
  /** Result of the last manual check, for the same button. */
  lastCheckMessage: string | null;

  dismiss: () => void;
  /** Activate the waiting worker and reload onto it. */
  applyUpdate: () => void;
  /** Ask the server now rather than waiting for the timer. */
  checkNow: () => Promise<void>;
}

let applyFn: ((reload?: boolean) => Promise<void>) | null = null;
let rePromptTimer: ReturnType<typeof setTimeout> | null = null;

export const useUpdateStore = create<UpdateState>((set, get) => ({
  updateReady: false,
  dismissed: false,
  checking: false,
  lastCheckMessage: null,

  dismiss: () => {
    set({ dismissed: true });
    if (rePromptTimer) clearTimeout(rePromptTimer);
    rePromptTimer = setTimeout(() => set({ dismissed: false }), RE_PROMPT_AFTER_MS);
  },

  applyUpdate: () => {
    // updateSW(true) tells the waiting worker to take over and reloads onto it. Without
    // it the worker waits for every window to close, which on a kiosk never happens.
    if (applyFn) void applyFn(true);
    else window.location.reload();
  },

  checkNow: async () => {
    if (get().checking) return;
    set({ checking: true, lastCheckMessage: null });
    try {
      const ok = await checkForUpdate();
      // A found update arrives through onNeedRefresh rather than from here, so this only
      // reports that the question was asked and answered.
      set({
        lastCheckMessage: !ok
          ? 'Could not reach the server to check. Check the internet connection.'
          : get().updateReady
            ? 'A new version is ready — press Update now.'
            : 'This till is on the latest version.',
      });
    } finally {
      set({ checking: false });
    }
  },
}));

/**
 * Ask the browser to re-fetch the service worker script.
 *
 * Returns false when the question could not be put at all (offline, no worker
 * registered), which is a different thing from "there is no update".
 */
async function checkForUpdate(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return false;
    await registration.update();
    return true;
  } catch {
    return false;
  }
}

/** Wires the service worker up. Called once, from main.tsx. */
export function initPwaUpdates(): void {
  applyFn = registerSW({
    onNeedRefresh() {
      useUpdateStore.setState({ updateReady: true, dismissed: false });
    },
    onOfflineReady() {
      console.info('[PWA] Ticket POS is ready to work offline.');
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;

      // The check that startup alone never performs. A till left running for a week
      // would otherwise never ask whether anything had changed.
      setInterval(() => {
        void registration.update();
      }, UPDATE_CHECK_INTERVAL_MS);
    },
  });

  // Coming back to the app, or back online, are both good moments to ask — and both
  // happen far more often on a till than a cold start does.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForUpdate();
  });
  window.addEventListener('online', () => {
    void checkForUpdate();
  });
}
