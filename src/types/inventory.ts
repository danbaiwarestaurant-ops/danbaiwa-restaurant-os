export interface InventoryItem {
  id: string;
  name: string;
  baseUnit: string;
  purchaseUnit: string;
  baseUnitsPerPurchaseUnit: number;
  reorderLevel: number;
  /** Optional operational unit used when managers allocate production/sales to servers. */
  salesUnit?: string;
  /** Number of base units in one sales unit (for example 5 mudu in one cooler). */
  baseUnitsPerSalesUnit?: number;
  /** Standard cost of one purchase unit, used when there is no open FIFO batch yet. */
  standardPurchaseCost?: number;
  /** Direct preparation cost of one server sales unit. Falls back to the purchase conversion for legacy rows. */
  preparationCostPerSalesUnit?: number;
  /** Legacy sales-value field retained only so older synced rows remain readable. */
  expectedSalesPerSalesUnit?: number;
  /** Profit expected on one server sales unit. */
  profitPerSalesUnit?: number;
  /** Makes this ingredient available on the server daily-sales grid. */
  trackServerSales?: boolean;
  active: boolean;
  createdAt: string;
  updatedAt?: string;
  accountId?: string;
}

export interface InventoryBatch {
  id: string;
  itemId: string;
  receivedAt: string;
  expiryDate?: string;
  supplier?: string;
  originalQuantityBase: number;
  remainingQuantityBase: number;
  unitCostBase: number;
  accountId?: string;
  updatedAt?: string;
}

export type InventoryMovementType = 'receipt' | 'usage' | 'waste' | 'count_adjustment';

export interface FifoAllocation {
  batchId: string;
  quantity: number;
  unitCost: number;
  value: number;
}

export interface InventoryMovement {
  id: string;
  itemId: string;
  itemName: string;
  businessDay: string;
  type: InventoryMovementType;
  /** Positive for stock in, negative for stock out. Always stored in the item's base unit. */
  quantityBase: number;
  value: number;
  allocations: FifoAllocation[];
  expectedQuantityBefore?: number;
  countedQuantity?: number;
  varianceQuantity?: number;
  supplier?: string;
  note?: string;
  recordedBy: string;
  recordedByName?: string;
  recordedAt: string;
  accountId?: string;
  updatedAt?: string;
}
