import { describe, expect, it } from 'vitest';
import { fifoAllocate } from '../utils/inventory';

describe('FIFO inventory valuation', () => {
  it('uses the oldest batches and reports shortages', () => {
    const batches = [
      { id: 'new', itemId: 'rice', receivedAt: '2026-02-02', remainingQuantityBase: 10, unitCostBase: 300 },
      { id: 'old', itemId: 'rice', receivedAt: '2026-02-01', remainingQuantityBase: 5, unitCostBase: 200 },
    ] as any;
    const used = fifoAllocate(batches, 8);
    expect(used.allocations.map((a) => [a.batchId, a.quantity])).toEqual([['old', 5], ['new', 3]]);
    expect(used.value).toBe(1900);
    expect(used.shortage).toBe(0);
    expect(fifoAllocate(batches, 20).shortage).toBe(5);
  });
});
