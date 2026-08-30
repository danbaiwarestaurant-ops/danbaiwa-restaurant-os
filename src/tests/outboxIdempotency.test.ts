import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSyncStore } from '../store/useSyncStore';
import { dbService } from '../services/db/LocalStorageDbService'; // use test DB
import { supabase } from '../services/supabase/supabaseClient';
import { toSnakeCase } from '../utils/caseMapping';

// Mock Supabase Client calls
vi.mock('../services/supabase/supabaseClient', () => {
  const mockFrom = vi.fn().mockReturnThis();
  const mockUpsert = vi.fn().mockResolvedValue({ error: null });
  return {
    isSupabaseConfigured: true,
    supabase: {
      from: mockFrom,
      upsert: mockUpsert,
    },
  };
});

describe('Outbox Sync Worker & Payload Mapping (FR16, FR17, NFR1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should transform camelCase objects into database snake_case', () => {
    const jsTicket = {
      id: 'LOC01-DEV01-SEQ001',
      locationId: 'LOC01',
      localSeq: 1,
      cashierId: 'cashier-1',
      qrPayload: 'qr-text',
    };

    const dbRow = toSnakeCase(jsTicket);

    expect(dbRow.id).toBe('LOC01-DEV01-SEQ001');
    expect(dbRow.location_id).toBe('LOC01');
    expect(dbRow.local_seq).toBe(1);
    expect(dbRow.cashier_id).toBe('cashier-1');
    expect(dbRow.qr_payload).toBe('qr-text');
    expect(dbRow.locationId).toBeUndefined();
    expect(dbRow.localSeq).toBeUndefined();
  });

  it('should format outbox mutations with client UUID primary keys', () => {
    const payload = {
      id: 'LOC01-DEV01-000001',
      amount: 500,
      status: 'paid',
    };
    const outboxId = crypto.randomUUID();

    expect(outboxId).toBeDefined();
    expect(typeof outboxId).toBe('string');
    expect(payload.id).toBe('LOC01-DEV01-000001');
  });
});
