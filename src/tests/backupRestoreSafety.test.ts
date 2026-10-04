import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, TABLE_NAMES } from '../services/db/dexieSchema';
import { IndexedDbService } from '../services/db/IndexedDbService';

let downloadGate: Promise<void> | null = null;
let downloadStarted = false;
let snapshot: any;
vi.mock('../services/supabase/supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'account-A' } } } }),
      getUser: async () => ({ data: { user: { user_metadata: { location_id: 'LOC01' } } } }),
    },
    storage: { from: () => ({
      list: async () => ({ data: [{ name: 'latest.json', updated_at: '2026-10-04T12:00:00Z' }], error: null }),
      download: async () => {
        downloadStarted = true;
        if (downloadGate) await downloadGate;
        return { data: new Blob([JSON.stringify(snapshot)]), error: null };
      },
    }) },
  },
}));
import { restoreFromCloud } from '../services/db/cloudBackup';

let service: IndexedDbService;
beforeEach(async () => {
  await Promise.all(TABLE_NAMES.map(name => (db as any)[name].clear()));
  service = new IndexedDbService(); await service.init();
  downloadGate = null;
  downloadStarted = false;
  snapshot = { version: 1, accountId: 'account-A', tables: {
    config: [
      { key: 'installation_id', value: 'SOURCE' },
      { key: 'device_cloud_identity', value: { authUserId: 'source-till' } },
      { key: 'printer_link', value: { transport: 'serial', label: 'source-printer' } },
      { key: 'active_shift_cashier', value: 'source-shift' },
      { key: 'device_config', value: { businessName: 'Restored business' } },
    ],
    sequences: [{ key: 'seq_SOURCE', nextVal: 20000 }],
    tickets: [{ id: 'source-ticket', amount: 500, cashierId: 'cashier', createdAt: '2026-10-04T12:00:00Z' }],
  } };
});
describe('snapshot restore safety', () => {
  it('restores records without cloning installation, numbering, printer or cloud credentials', async () => {
    const install = await service.getInstallationId();
    await db.config.put({ key: 'printer_link', value: { label: 'this-till-printer' } });
    expect((await restoreFromCloud()).restored).toBe(true);
    expect(await service.getInstallationId()).toBe(install);
    expect((await db.config.get('printer_link'))?.value.label).toBe('this-till-printer');
    expect(await db.config.get('device_cloud_identity')).toBeUndefined();
    expect(await db.config.get('active_shift_cashier')).toBeUndefined();
    expect((await db.config.get('device_config'))?.value.businessName).toBe('Restored business');
    expect(await db.tickets.count()).toBe(1);
    expect(await service.getNextSeq('LOC01', 'DEV01')).toBe(1);
    expect(await db.sequences.get('seq_SOURCE')).toBeUndefined();
  });
  it('cancels if a sale commits while a snapshot is downloading', async () => {
    let release!: () => void;
    downloadGate = new Promise(resolve => { release = resolve; });
    const restoring = restoreFromCloud();
    // Wait for discovery to reach download, then write a real local sale.
    await vi.waitFor(() => expect(downloadStarted).toBe(true));
    await db.tickets.put({ id: 'live-sale', cashierId: 'cashier', amount: 800, createdAt: new Date().toISOString() } as any);
    release();
    expect((await restoring).restored).toBe(false);
    expect((await db.tickets.toArray()).map(row => row.id)).toEqual(['live-sale']);
  });
});
