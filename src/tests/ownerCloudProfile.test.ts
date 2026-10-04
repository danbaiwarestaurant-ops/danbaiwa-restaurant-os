import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => {
  const primary = { auth: { getSession: vi.fn(), updateUser: vi.fn() } };
  const owner = { auth: { signInWithPassword: vi.fn(), updateUser: vi.fn(), stopAutoRefresh: vi.fn() } };
  const createClient = vi.fn().mockReturnValueOnce(primary).mockReturnValue(owner);
  return { primary, owner, createClient };
});
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
import { updateOwnerCloudProfile, deriveSupabasePassword } from '../services/supabase/supabaseClient';
beforeEach(() => {
  mocks.primary.auth.getSession.mockReset(); mocks.primary.auth.updateUser.mockReset();
  mocks.owner.auth.signInWithPassword.mockReset(); mocks.owner.auth.updateUser.mockReset(); mocks.owner.auth.stopAutoRefresh.mockReset();
  mocks.primary.auth.updateUser.mockResolvedValue({ error: null });
  mocks.owner.auth.updateUser.mockResolvedValue({ error: null });
  mocks.owner.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'owner' } }, error: null });
  mocks.primary.auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'till', user_metadata: { kind: 'pos-till' } } } } });
});
describe('owner cloud profile security', () => {
  it('authenticates the owner separately and keeps the primary till credential unchanged', async () => {
    await updateOwnerCloudProfile('owner', 'owner@example.com', '1234', '6789');
    expect(mocks.owner.auth.signInWithPassword).toHaveBeenCalledWith({ email: 'owner@example.com', password: deriveSupabasePassword('1234') });
    expect(mocks.owner.auth.updateUser).toHaveBeenCalledWith({ password: deriveSupabasePassword('6789') });
    expect(mocks.primary.auth.updateUser).not.toHaveBeenCalled();
    expect(mocks.createClient).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  });
  it('rejects another authenticated owner rather than changing their credential', async () => {
    mocks.owner.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'someone-else' } }, error: null });
    await expect(updateOwnerCloudProfile('owner', 'owner@example.com', '1234', '6789')).rejects.toThrow('does not own');
    expect(mocks.owner.auth.updateUser).not.toHaveBeenCalled();
  });
  it('refuses changes on a till session without owner credentials', async () => {
    await expect(updateOwnerCloudProfile('owner', 'owner@example.com', undefined, '6789')).rejects.toThrow('current admin PIN');
    expect(mocks.primary.auth.updateUser).not.toHaveBeenCalled();
    expect(mocks.owner.auth.signInWithPassword).not.toHaveBeenCalled();
  });
  it('updates the existing owner session and requests verified cloud email changes', async () => {
    mocks.primary.auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'owner', user_metadata: {} } } } });
    await updateOwnerCloudProfile('owner', 'owner@example.com', undefined, '6789', 'new@example.com');
    expect(mocks.primary.auth.updateUser).toHaveBeenCalledWith({ password: deriveSupabasePassword('6789'), email: 'new@example.com' });
    expect(mocks.owner.auth.signInWithPassword).not.toHaveBeenCalled();
  });
});
