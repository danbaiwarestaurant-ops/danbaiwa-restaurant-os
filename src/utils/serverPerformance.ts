import { InventoryItem } from '../types/inventory';
import { ServerItemSales } from '../types/serverSales';

export function standardCostPerSalesUnit(item: InventoryItem): number {
  const purchaseCost = Math.max(0, item.standardPurchaseCost || 0);
  const basePerPurchase = Math.max(0, item.baseUnitsPerPurchaseUnit || 0);
  const basePerSales = Math.max(0, item.baseUnitsPerSalesUnit || 0);
  if (!purchaseCost || !basePerPurchase || !basePerSales) return 0;
  return (purchaseCost / basePerPurchase) * basePerSales;
}

export function standardCostPerCookingUnit(item: InventoryItem): number {
  return standardCostPerSalesUnit({ ...item, baseUnitsPerSalesUnit: item.baseUnitsPerCookingUnit ?? item.baseUnitsPerSalesUnit });
}

export function calculateServerItemSales(item: InventoryItem, quantity: number): ServerItemSales {
  const cleanQuantity = Math.max(0, Number.isFinite(quantity) ? quantity : 0);
  const scale = item.cookingUnit && item.baseUnitsPerCookingUnit && item.baseUnitsPerSalesUnit
    ? item.baseUnitsPerCookingUnit / item.baseUnitsPerSalesUnit : 1;
  const legacyCost = item.preparationCostPerSalesUnit == null ? undefined : item.preparationCostPerSalesUnit * scale;
  const configuredPreparationCost = Number(item.preparationCostPerCookingUnit ?? legacyCost);
  const unitCost = Number.isFinite(configuredPreparationCost) && configuredPreparationCost >= 0
    ? configuredPreparationCost
    : standardCostPerCookingUnit(item);
  const unitProfit = Math.max(0, item.profitPerCookingUnit ?? (item.profitPerSalesUnit || 0) * scale);
  const unitSales = unitCost + unitProfit;
  const cost = cleanQuantity * unitCost;
  const sales = cleanQuantity * unitSales;
  const profit = cleanQuantity * unitProfit;
  return {
    itemId: item.id,
    itemName: item.name,
    quantity: cleanQuantity,
    salesUnit: item.cookingUnit || item.salesUnit || item.baseUnit,
    unitCost,
    unitSales,
    unitProfit,
    cost,
    sales,
    profit,
    expected: sales,
  };
}

/** Negative means the server returned less than expected; positive means a surplus. */
export function serverCollectionVariance(expected: number, moneyGathered: number): number {
  return (Number.isFinite(moneyGathered) ? moneyGathered : 0) - (Number.isFinite(expected) ? expected : 0);
}

/** Actual profit after recovering preparation cost; a negative result is a real operating loss. */
export function serverProfitContribution(preparationCost: number, moneyGathered: number): number {
  return (Number.isFinite(moneyGathered) ? moneyGathered : 0) - (Number.isFinite(preparationCost) ? preparationCost : 0);
}

export function totalServerPerformance(items: ServerItemSales[]) {
  return items.reduce((total, item) => ({
    totalSalesUnits: total.totalSalesUnits + item.quantity,
    totalCost: total.totalCost + item.cost,
    totalSales: total.totalSales + item.sales,
    totalProfit: total.totalProfit + item.profit,
    expectedSalesValue: total.expectedSalesValue + item.expected,
  }), { totalSalesUnits: 0, totalCost: 0, totalSales: 0, totalProfit: 0, expectedSalesValue: 0 });
}
