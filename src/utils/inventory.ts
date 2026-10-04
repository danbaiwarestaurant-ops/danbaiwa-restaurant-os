import { InventoryBatch, InventoryItem } from '../types/inventory';

export function validateInventoryUnits(item: Omit<InventoryItem, 'id' | 'createdAt' | 'active'>) {
  if (!item.name.trim() || !item.baseUnit.trim() || !item.purchaseUnit.trim()) throw new Error('Name, base and purchase units are required.');
  if (!Number.isFinite(item.baseUnitsPerPurchaseUnit) || item.baseUnitsPerPurchaseUnit <= 0) throw new Error('Purchase conversion must be greater than zero.');
  if (!Number.isFinite(item.reorderLevel) || item.reorderLevel < 0) throw new Error('Reorder level cannot be negative.');
  for (const [unit, conversion, label] of [[item.cookingUnit, item.baseUnitsPerCookingUnit, 'Cooking'], [item.salesUnit, item.baseUnitsPerSalesUnit, 'Sales']] as const) {
    if (unit && (!Number.isFinite(conversion) || Number(conversion) <= 0)) throw new Error(`${label} conversion must be greater than zero.`);
    if (conversion && !unit?.trim()) throw new Error(`${label} unit name is required.`);
  }
  for (const cost of [item.standardPurchaseCost, item.preparationCostPerSalesUnit, item.profitPerSalesUnit, item.preparationCostPerCookingUnit, item.profitPerCookingUnit]) {
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) throw new Error('Costs and profit must be finite, non-negative amounts.');
  }
}

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
