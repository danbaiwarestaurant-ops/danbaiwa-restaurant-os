// A cashier's identity belongs to this tab. Cloud/device credentials remain shared.
const KEY = 'ticket_pos_session_user_id';
const MIGRATED = 'ticket_pos_session_identity_migrated';

export function readSessionIdentity(): string | null {
  if (typeof localStorage === 'undefined') return null;
  if (typeof sessionStorage === 'undefined') return localStorage.getItem(KEY);
  const current = sessionStorage.getItem(KEY);
  if (current) return current;
  // Resume an existing installation once when upgrading. A newly opened admin tab
  // then starts at login instead of borrowing the working cashier's identity.
  if (!localStorage.getItem(MIGRATED)) {
    localStorage.setItem(MIGRATED, '1');
    const legacy = localStorage.getItem(KEY);
    if (legacy) sessionStorage.setItem(KEY, legacy);
    return legacy;
  }
  return null;
}

export function writeSessionIdentity(id: string | null): void {
  if (typeof sessionStorage !== 'undefined') {
    localStorage.setItem(MIGRATED, '1');
    if (id) sessionStorage.setItem(KEY, id);
    else sessionStorage.removeItem(KEY);
  } else if (typeof localStorage !== 'undefined') {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  }
}
