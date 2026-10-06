import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  signIn: vi.fn(), signUp: vi.fn(), setSession: vi.fn(),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: {
  signInWithPassword: fakes.signIn, signUp: fakes.signUp, setSession: fakes.setSession,
} }) }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://qa.example.test'); vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-key');
  vi.stubGlobal('navigator', { onLine: true });
  fakes.setSession.mockResolvedValue({ error: null });
});
describe('existing account reconnection', () => {
  it('never creates a new cloud account when the old PIN fails', async () => {
    fakes.signIn.mockResolvedValue({ data: {}, error: { message: 'Invalid credentials' } });
    const { authenticateAdminWithSupabase } = await import('../services/supabase/supabaseClient');
    await expect(authenticateAdminWithSupabase('old@example.test', '1234', 'LOC01', 'original-owner')).rejects.toThrow('does not create a new account');
    expect(fakes.signUp).not.toHaveBeenCalled(); expect(fakes.setSession).not.toHaveBeenCalled();
  });
  it('keeps the enrolled session if the email now points to another owner', async () => {
    fakes.signIn.mockResolvedValue({ data: { user: { id: 'replacement-owner' }, session: { access_token: 'wrong' } }, error: null });
    const { authenticateAdminWithSupabase } = await import('../services/supabase/supabaseClient');
    await expect(authenticateAdminWithSupabase('old@example.test', '1234', 'LOC01', 'original-owner')).rejects.toThrow('different cloud account');
    expect(fakes.setSession).not.toHaveBeenCalled(); expect(fakes.signUp).not.toHaveBeenCalled();
  });
  it('adopts only the verified original owner session', async () => {
    const session = { access_token: 'verified', refresh_token: 'refresh' };
    fakes.signIn.mockResolvedValue({ data: { user: { id: 'original-owner', email: 'old@example.test' }, session }, error: null });
    const { authenticateAdminWithSupabase } = await import('../services/supabase/supabaseClient');
    expect((await authenticateAdminWithSupabase('old@example.test', '1234', 'LOC01', 'original-owner')).userId).toBe('original-owner');
    expect(fakes.setSession).toHaveBeenCalledWith(session);
    expect(fakes.signUp).not.toHaveBeenCalled();
  });
});
