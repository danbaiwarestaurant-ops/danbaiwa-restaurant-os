import { describe, expect, it } from 'vitest';
import { calculateServerItemSales, serverCollectionVariance, serverProfitContribution, standardCostPerSalesUnit, totalServerPerformance } from '../utils/serverPerformance';
import { InventoryItem } from '../types/inventory';

const rice: InventoryItem = {
  id: 'rice', name: 'Rice', baseUnit: 'mudu', purchaseUnit: 'pot',
  baseUnitsPerPurchaseUnit: 20, salesUnit: 'cooler', baseUnitsPerSalesUnit: 5,
  standardPurchaseCost: 72000, preparationCostPerSalesUnit: 18000,
  profitPerSalesUnit: 7000, trackServerSales: true, reorderLevel: 10,
  active: true, createdAt: '2026-09-22T00:00:00.000Z',
};

describe('server food performance economics', () => {
  it('converts a ₦72,000 rice pot into four ₦18,000 coolers', () => {
    expect(standardCostPerSalesUnit(rice)).toBe(18000);
  });

  it('calculates expected collection as preparation cost plus configured profit', () => {
    const row = calculateServerItemSales(rice, 7);
    expect(row).toMatchObject({ quantity: 7, cost: 126000, sales: 175000, profit: 49000, expected: 175000 });
    expect(totalServerPerformance([row])).toEqual({ totalSalesUnits: 7, totalCost: 126000, totalSales: 175000, totalProfit: 49000, expectedSalesValue: 175000 });
  });

  it('classifies returned money as shortage or surplus against expected collection', () => {
    expect(serverCollectionVariance(175000, 170000)).toBe(-5000);
    expect(serverCollectionVariance(175000, 180000)).toBe(5000);
  });

  it('measures actual profit or loss after preparation cost is recovered', () => {
    expect(serverProfitContribution(126000, 180000)).toBe(54000);
    expect(serverProfitContribution(126000, 120000)).toBe(-6000);
  });
});
