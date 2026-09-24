import { InventoryBatch } from '../types/inventory';

export function fifoAllocate(batches: InventoryBatch[], requested: number) {
  let remaining = Math.max(0, requested);
  const ordered = batches
    .filter((b) => b.remainingQuantityBase > 0)
    .slice()
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
  const allocations = [] as { batchId: string; quantity: number; unitCost: number; value: number }[];
  for (const batch of ordered) {
    if (remaining <= 0) break;
    const quantity = Math.min(remaining, batch.remainingQuantityBase);
    allocations.push({
      batchId: batch.id,
      quantity,
      unitCost: batch.unitCostBase,
      value: quantity * batch.unitCostBase,
    });
    remaining -= quantity;
  }
  return {
    allocations,
    shortage: remaining,
    value: allocations.reduce((sum, a) => sum + a.value, 0),
  };
}

export function stockSummary(itemId: string, batches: InventoryBatch[]) {
  const own = batches.filter((b) => b.itemId === itemId);
  return {
    quantity: own.reduce((sum, b) => sum + b.remainingQuantityBase, 0),
    value: own.reduce((sum, b) => sum + b.remainingQuantityBase * b.unitCostBase, 0),
  };
}
