import { create } from 'zustand';
import { dbService } from '../services/db/IndexedDbService';
import { InventoryBatch, InventoryItem, InventoryMovement, InventoryMovementType } from '../types/inventory';
import { fifoAllocate, stockSummary } from '../utils/inventory';
import { useAuthStore } from './useAuthStore';
import { useSyncStore } from './useSyncStore';

interface InventoryState {
  items: InventoryItem[];
  batches: InventoryBatch[];
  movements: InventoryMovement[];
  isLoading: boolean;
  load: () => Promise<void>;
  addItem: (input: Omit<InventoryItem, 'id' | 'createdAt' | 'active'>) => Promise<void>;
  updateItem: (item: InventoryItem) => Promise<void>;
  receive: (item: InventoryItem, purchaseQuantity: number, purchaseUnitCost: number, supplier?: string, expiryDate?: string, note?: string) => Promise<void>;
  consume: (item: InventoryItem, quantityBase: number, type: 'usage' | 'waste', note: string) => Promise<void>;
  count: (item: InventoryItem, countedQuantity: number, note: string) => Promise<void>;
}

const dayKey = () => new Date().toLocaleDateString('en-CA');
const syncNow = () => useSyncStore.getState().checkOutbox().then(() => useSyncStore.getState().triggerSyncWorker());

export const useInventoryStore = create<InventoryState>((set, get) => ({
  items: [], batches: [], movements: [], isLoading: false,
  load: async () => {
    set({ isLoading: true });
    await dbService.init();
    const [items, batches, movements] = await Promise.all([
      dbService.getInventoryItems(), dbService.getInventoryBatches(), dbService.getInventoryMovements(),
    ]);
    set({ items, batches, movements, isLoading: false });
  },
  addItem: async (input) => {
    useAuthStore.getState().assertAdminRole();
    const actor = useAuthStore.getState().activeUser;
    if (!input.name.trim()) throw new Error('Ingredient name is required.');
    if (input.baseUnitsPerPurchaseUnit <= 0) throw new Error('Unit conversion must be greater than zero.');
    if (get().items.some((i) => i.name.trim().toLowerCase() === input.name.trim().toLowerCase())) throw new Error('That ingredient already exists.');
    const item: InventoryItem = { ...input, id: crypto.randomUUID(), active: true, createdAt: new Date().toISOString() };
    await dbService.saveInventoryItem(item, actor?.id || 'ADMIN');
    set({ items: [...get().items, item].sort((a, b) => a.name.localeCompare(b.name)) });
    void syncNow();
  },
  updateItem: async (item) => {
    useAuthStore.getState().assertAdminRole();
    const actor = useAuthStore.getState().activeUser;
    if (!item.name.trim() || !item.baseUnit.trim() || !item.purchaseUnit.trim()) throw new Error('Name and units are required.');
    if (item.baseUnitsPerPurchaseUnit <= 0 || item.reorderLevel < 0) throw new Error('Conversion must be positive and reorder level cannot be negative.');
    const duplicate = get().items.some((i) => i.id !== item.id && i.name.trim().toLowerCase() === item.name.trim().toLowerCase());
    if (duplicate) throw new Error('That ingredient name is already in use.');
    await dbService.saveInventoryItem(item, actor?.id || 'ADMIN');
    set({ items: get().items.map((i) => i.id === item.id ? item : i).sort((a, b) => a.name.localeCompare(b.name)) });
    void syncNow();
  },
  receive: async (item, purchaseQuantity, purchaseUnitCost, supplier, expiryDate, note) => {
    useAuthStore.getState().assertAdminRole();
    const actor = useAuthStore.getState().activeUser;
    if (purchaseQuantity <= 0) throw new Error('Received quantity must be greater than zero.');
    if (purchaseUnitCost < 0) throw new Error('Cost cannot be negative.');
    const now = new Date().toISOString();
    const quantityBase = purchaseQuantity * item.baseUnitsPerPurchaseUnit;
    const batch: InventoryBatch = {
      id: crypto.randomUUID(), itemId: item.id, receivedAt: now, expiryDate: expiryDate || undefined,
      supplier: supplier?.trim() || undefined, originalQuantityBase: quantityBase,
      remainingQuantityBase: quantityBase, unitCostBase: purchaseUnitCost / item.baseUnitsPerPurchaseUnit,
    };
    const movement: InventoryMovement = {
      id: crypto.randomUUID(), itemId: item.id, itemName: item.name, businessDay: dayKey(), type: 'receipt',
      quantityBase, value: purchaseQuantity * purchaseUnitCost,
      allocations: [{ batchId: batch.id, quantity: quantityBase, unitCost: batch.unitCostBase, value: purchaseQuantity * purchaseUnitCost }],
      supplier: batch.supplier, note: note?.trim() || undefined, recordedBy: actor?.id || 'ADMIN',
      recordedByName: actor?.name, recordedAt: now,
    };
    await dbService.receiveInventory(batch, movement, actor?.id || 'ADMIN');
    set({ batches: [...get().batches, batch], movements: [movement, ...get().movements] });
    void syncNow();
  },
  consume: async (item, quantityBase, type, note) => {
    useAuthStore.getState().assertAdminRole();
    const actor = useAuthStore.getState().activeUser;
    if (quantityBase <= 0) throw new Error('Quantity must be greater than zero.');
    if (!note.trim()) throw new Error('A reason is required.');
    const own = get().batches.filter((b) => b.itemId === item.id);
    const fifo = fifoAllocate(own, quantityBase);
    if (fifo.shortage > 0) throw new Error(`Only ${quantityBase - fifo.shortage} ${item.baseUnit} is available.`);
    const byId = new Map(fifo.allocations.map((a) => [a.batchId, a.quantity]));
    const updated = own.filter((b) => byId.has(b.id)).map((b) => ({ ...b, remainingQuantityBase: b.remainingQuantityBase - (byId.get(b.id) || 0) }));
    const movement: InventoryMovement = {
      id: crypto.randomUUID(), itemId: item.id, itemName: item.name, businessDay: dayKey(), type,
      quantityBase: -quantityBase, value: -fifo.value, allocations: fifo.allocations,
      note: note.trim(), recordedBy: actor?.id || 'ADMIN', recordedByName: actor?.name, recordedAt: new Date().toISOString(),
    };
    await dbService.issueInventory(movement, updated, actor?.id || 'ADMIN');
    const updates = new Map(updated.map((b) => [b.id, b]));
    set({ batches: get().batches.map((b) => updates.get(b.id) || b), movements: [movement, ...get().movements] });
    void syncNow();
  },
  count: async (item, countedQuantity, note) => {
    useAuthStore.getState().assertAdminRole();
    const actor = useAuthStore.getState().activeUser;
    const expected = stockSummary(item.id, get().batches).quantity;
    const variance = countedQuantity - expected;
    if (Math.abs(variance) < 0.000001) return;
    if (variance < 0) {
      const own = get().batches.filter((b) => b.itemId === item.id);
      const fifo = fifoAllocate(own, -variance);
      const byId = new Map(fifo.allocations.map((a) => [a.batchId, a.quantity]));
      const updated = own.filter((b) => byId.has(b.id)).map((b) => ({ ...b, remainingQuantityBase: b.remainingQuantityBase - (byId.get(b.id) || 0) }));
      const movement: InventoryMovement = { id: crypto.randomUUID(), itemId: item.id, itemName: item.name, businessDay: dayKey(), type: 'count_adjustment', quantityBase: variance, value: -fifo.value, allocations: fifo.allocations, expectedQuantityBefore: expected, countedQuantity, varianceQuantity: variance, note: note.trim(), recordedBy: actor?.id || 'ADMIN', recordedByName: actor?.name, recordedAt: new Date().toISOString() };
      await dbService.issueInventory(movement, updated, actor?.id || 'ADMIN');
      const updates = new Map(updated.map((b) => [b.id, b]));
      set({ batches: get().batches.map((b) => updates.get(b.id) || b), movements: [movement, ...get().movements] });
    } else {
      const active = get().batches.filter((b) => b.itemId === item.id && b.remainingQuantityBase > 0);
      const avg = active.reduce((s, b) => s + b.remainingQuantityBase * b.unitCostBase, 0) / (active.reduce((s, b) => s + b.remainingQuantityBase, 0) || 1);
      const now = new Date().toISOString();
      const batch: InventoryBatch = { id: crypto.randomUUID(), itemId: item.id, receivedAt: now, originalQuantityBase: variance, remainingQuantityBase: variance, unitCostBase: avg };
      const movement: InventoryMovement = { id: crypto.randomUUID(), itemId: item.id, itemName: item.name, businessDay: dayKey(), type: 'count_adjustment', quantityBase: variance, value: variance * avg, allocations: [{ batchId: batch.id, quantity: variance, unitCost: avg, value: variance * avg }], expectedQuantityBefore: expected, countedQuantity, varianceQuantity: variance, note: note.trim(), recordedBy: actor?.id || 'ADMIN', recordedByName: actor?.name, recordedAt: now };
      await dbService.receiveInventory(batch, movement, actor?.id || 'ADMIN');
      set({ batches: [...get().batches, batch], movements: [movement, ...get().movements] });
    }
    void syncNow();
  },
}));
