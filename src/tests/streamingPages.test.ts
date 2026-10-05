import { describe, expect, it } from 'vitest';
import { selectPages } from '../services/supabase/pagedSelect';

describe('bounded cloud keyset pagination', () => {
  it('does not miss rows under a smaller server cap or use a growing offset', async () => {
    const rows = Array.from({ length: 1253 }, (_, i) => ({ id: String(i).padStart(6, '0') }));
    const requests: { after?: string; from: number; to: number }[] = [];
    const pages = selectPages(() => {
      let after: string | undefined;
      const query = {
        gt: (_column: string, value: string) => { after = value; return query; },
        order: () => query,
        range: async (from: number, to: number) => {
          requests.push({ after, from, to });
          return { data: rows.filter(row => !after || row.id > after).slice(0, 173), error: null };
        },
      };
      return query;
    });
    const received: string[] = [];
    for await (const page of pages) { expect(page.length).toBeLessThanOrEqual(500); received.push(...page.map(row => row.id)); }
    expect(received).toEqual(rows.map(row => row.id));
    expect(requests.every(request => request.from === 0 && request.to === 499)).toBe(true);
    expect(requests[1].after).toBe('000172');
  });
  it('surfaces a later page error without treating a partial pull as complete', async () => {
    let calls = 0;
    const pages = selectPages(() => {
      const query = { gt: () => query, order: () => query,
        range: async () => ++calls === 1 ? { data: [{ id: 'a' }], error: null } : { data: null, error: new Error('lost connection') } };
      return query;
    });
    expect((await pages.next()).value).toEqual([{ id: 'a' }]);
    await expect(pages.next()).rejects.toThrow('lost connection');
  });
  it('rejects a server that repeats its page instead of looping forever', async () => {
    const pages = selectPages(() => {
      const query = { gt: () => query, order: () => query, range: async () => ({ data: [{ id: 'a' }], error: null }) };
      return query;
    });
    await pages.next();
    await expect(pages.next()).rejects.toThrow('did not advance');
  });
});
