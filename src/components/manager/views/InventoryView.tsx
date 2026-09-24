import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Boxes, ClipboardCheck, PackagePlus } from 'lucide-react';
import { useInventoryStore } from '../../../store/useInventoryStore';
import { useDeviceStore } from '../../../store/useDeviceStore';
import { formatCurrency } from '../../../utils/currency';
import { stockSummary } from '../../../utils/inventory';
import { standardCostPerSalesUnit } from '../../../utils/serverPerformance';
import { ConsoleButton, DataTable, EmptyState, KpiCard, Panel, StatusBadge } from '../ConsoleUI';

export const InventoryView: React.FC = () => {
  const [section, setSection] = useState<'overview' | 'activity' | 'ingredients' | 'history'>('overview');
  const { items, batches, movements, load, addItem, updateItem, receive, consume, count } = useInventoryStore();
  const currency = useDeviceStore((s) => s.config.currencySymbol || '₦');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [newItem, setNewItem] = useState({ name: '', baseUnit: 'mudu', purchaseUnit: 'pot', conversion: '', reorder: '', salesUnit: 'cooler', salesConversion: '', standardCost: '', preparationCost: '', profit: '', trackServerSales: false });
  const [selected, setSelected] = useState('');
  const [operation, setOperation] = useState<'receipt' | 'usage' | 'waste' | 'count'>('receipt');
  const [entry, setEntry] = useState({ quantity: '', cost: '', supplier: '', expiry: '', note: '' });
  const [editing, setEditing] = useState<{ id: string; name: string; baseUnit: string; purchaseUnit: string; conversion: string; reorder: string; salesUnit: string; salesConversion: string; standardCost: string; preparationCost: string; profit: string; trackServerSales: boolean } | null>(null);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!selected && items[0]) setSelected(items[0].id); }, [items, selected]);
  const item = items.find((i) => i.id === selected);
  const summaries = useMemo(() => items.map((i) => ({ item: i, ...stockSummary(i.id, batches) })), [items, batches]);
  const low = summaries.filter((s) => s.quantity <= s.item.reorderLevel);
  const totalValue = summaries.reduce((s, x) => s + x.value, 0);
  const expiryCutoff = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const expiring = batches.filter((b) => b.remainingQuantityBase > 0 && b.expiryDate && b.expiryDate <= expiryCutoff);
  const flash = (s: string) => { setError(''); setMessage(s); setTimeout(() => setMessage(''), 3500); };
  const fail = (e: unknown) => { setMessage(''); setError(e instanceof Error ? e.message : String(e)); setTimeout(() => setError(''), 6000); };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await addItem({ name: newItem.name.trim(), baseUnit: newItem.baseUnit.trim(), purchaseUnit: newItem.purchaseUnit.trim(), baseUnitsPerPurchaseUnit: Number(newItem.conversion), reorderLevel: Number(newItem.reorder), salesUnit: newItem.salesUnit.trim() || undefined, baseUnitsPerSalesUnit: Number(newItem.salesConversion) || undefined, standardPurchaseCost: Number(newItem.standardCost) || 0, preparationCostPerSalesUnit: Number(newItem.preparationCost) || 0, profitPerSalesUnit: Number(newItem.profit) || 0, trackServerSales: newItem.trackServerSales });
      setNewItem({ name: '', baseUnit: 'mudu', purchaseUnit: 'pot', conversion: '', reorder: '', salesUnit: 'cooler', salesConversion: '', standardCost: '', preparationCost: '', profit: '', trackServerSales: false });
      flash('Ingredient added');
    } catch (err) { fail(err); }
  };
  const loadFoodDefaults = async () => {
    const defaults = [
      { name: 'Rice', baseUnit: 'mudu', purchaseUnit: 'pot', baseUnitsPerPurchaseUnit: 20, reorderLevel: 10, salesUnit: 'cooler', baseUnitsPerSalesUnit: 5, standardPurchaseCost: 72000, preparationCostPerSalesUnit: 18000, profitPerSalesUnit: 0, trackServerSales: true },
      { name: 'Beans', baseUnit: 'bucket', purchaseUnit: 'bucket', baseUnitsPerPurchaseUnit: 1, reorderLevel: 2, salesUnit: 'bucket', baseUnitsPerSalesUnit: 1, standardPurchaseCost: 4500, preparationCostPerSalesUnit: 4500, profitPerSalesUnit: 0, trackServerSales: true },
      { name: 'Spaghetti', baseUnit: 'cooler', purchaseUnit: 'cooler', baseUnitsPerPurchaseUnit: 1, reorderLevel: 2, salesUnit: 'cooler', baseUnitsPerSalesUnit: 1, standardPurchaseCost: 13500, preparationCostPerSalesUnit: 13500, profitPerSalesUnit: 0, trackServerSales: true },
    ];
    try {
      for (const item of defaults) if (!items.some((existing) => existing.name.toLowerCase() === item.name.toLowerCase())) await addItem(item);
      flash('Rice, Beans and Spaghetti defaults loaded. Set preparation cost and profit per sales unit before recording server sales.');
    } catch (err) { fail(err); }
  };

  const record = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!item) return;
    try {
      if (operation === 'receipt') await receive(item, Number(entry.quantity), Number(entry.cost), entry.supplier, entry.expiry, entry.note);
      else if (operation === 'count') await count(item, Number(entry.quantity), entry.note || 'Physical count');
      else await consume(item, Number(entry.quantity), operation, entry.note || operation);
      setEntry({ quantity: '', cost: '', supplier: '', expiry: '', note: '' });
      flash(`${operation === 'count' ? 'Physical count' : operation} recorded`);
    } catch (err) { fail(err); }
  };

  return <div className="space-y-4">
    {(message || error) && <div role="status" className={`fixed top-4 left-1/2 -translate-x-1/2 z-[100] w-[min(92vw,36rem)] border-2 p-3 shadow-2xl text-xs font-bold ${error ? 'bg-rose-50 border-rose-500 text-rose-900' : 'bg-emerald-50 border-emerald-500 text-emerald-900'}`}>{error || message}</div>}
    <div className="sticky top-[70px] z-10 bg-slate-100 border-b-2 border-slate-300 flex gap-0 overflow-x-auto" role="tablist" aria-label="Inventory sections">{[
      ['overview', 'Stock & alerts'], ['activity', 'Record activity'], ['ingredients', 'Ingredient setup'], ['history', 'Movement history'],
    ].map(([id, label]) => <button key={id} role="tab" aria-selected={section === id} onClick={() => setSection(id as typeof section)} className={`px-4 py-3 whitespace-nowrap border-x border-t-2 text-[11px] font-black uppercase tracking-wide ${section === id ? 'bg-white border-amber-500 text-slate-900 border-b-2 border-b-white -mb-0.5' : 'bg-slate-200 border-slate-300 text-slate-600 hover:bg-slate-50'}`}>{label}</button>)}</div>
    {section === 'overview' && <><div className="grid grid-cols-1 md:grid-cols-4 gap-3"><KpiCard label="Ingredients" value={String(items.length)} hint="Active ingredient records" /><KpiCard label="Stock value (FIFO)" value={formatCurrency(totalValue, currency)} hint="Remaining batch cost" /><KpiCard label="Reorder alerts" value={String(low.length)} tone={low.length ? 'negative' : 'positive'} hint="At or below reorder level" /><KpiCard label="Expiry alerts" value={String(expiring.length)} tone={expiring.length ? 'negative' : 'positive'} hint="Expired or due in 7 days" /></div>
    {low.length > 0 && <Panel title="Reorder Now" subtitle="Ingredients at or below the manager-set reorder level" icon={AlertTriangle}><div className="grid grid-cols-1 sm:grid-cols-3 gap-2">{low.map((s) => <div key={s.item.id} className="border-2 border-rose-300 bg-rose-50 p-3"><div className="font-black text-rose-900">{s.item.name}</div><div className="text-xs text-rose-700">{s.quantity.toLocaleString()} {s.item.baseUnit} left · reorder at {s.item.reorderLevel.toLocaleString()}</div></div>)}</div></Panel>}
    {expiring.length > 0 && <Panel title="Expiry Attention" subtitle="Open FIFO batches expired or due within seven days" icon={AlertTriangle}><DataTable headers={['Ingredient', 'Expiry', 'Quantity', 'Supplier']} alignRight={[2]}>{expiring.map((b) => { const i = items.find((x) => x.id === b.itemId); return <tr key={b.id}><td className="py-2 pr-3 font-bold">{i?.name || 'Unknown'}</td><td className="py-2 pr-3 text-rose-700 font-bold">{b.expiryDate}</td><td className="py-2 pr-3 text-right font-mono">{b.remainingQuantityBase} {i?.baseUnit}</td><td className="py-2">{b.supplier || '—'}</td></tr>; })}</DataTable></Panel>}</>}

    {section === 'ingredients' && <div>
      <Panel title="Add Ingredient" subtitle="Define purchase, sales and base-unit conversions once; stock and server calculations reuse them." icon={Boxes} actions={<ConsoleButton onClick={() => void loadFoodDefaults()}>Load food defaults</ConsoleButton>}>
        <form onSubmit={create} className="space-y-3">
          <Field label="Ingredient name"><input required value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} className="input" /></Field>
          <div className="grid grid-cols-2 gap-2"><Field label="Base unit"><input required value={newItem.baseUnit} onChange={(e) => setNewItem({ ...newItem, baseUnit: e.target.value })} className="input" /></Field><Field label="Purchase unit"><input required value={newItem.purchaseUnit} onChange={(e) => setNewItem({ ...newItem, purchaseUnit: e.target.value })} className="input" /></Field></div>
          <Field label="Base units per purchase unit"><input required type="number" min="0.000001" step="any" value={newItem.conversion} onChange={(e) => setNewItem({ ...newItem, conversion: e.target.value })} placeholder="e.g. 50 kg per bag" className="input" /></Field>
          <Field label="Reorder level (base units)"><input required type="number" min="0" step="any" value={newItem.reorder} onChange={(e) => setNewItem({ ...newItem, reorder: e.target.value })} className="input" /></Field>
          <div className="grid grid-cols-2 gap-2"><Field label="Server sales unit"><input value={newItem.salesUnit} onChange={(e) => setNewItem({ ...newItem, salesUnit: e.target.value })} placeholder="cooler" className="input" /></Field><Field label="Base units per sales unit"><input type="number" min="0" step="any" value={newItem.salesConversion} onChange={(e) => setNewItem({ ...newItem, salesConversion: e.target.value })} placeholder="5 mudu per cooler" className="input" /></Field></div>
          <div className="grid grid-cols-3 gap-2"><Field label="Standard purchase cost"><input type="number" min="0" value={newItem.standardCost} onChange={(e) => setNewItem({ ...newItem, standardCost: e.target.value })} placeholder="72000" className="input" /></Field><Field label="Preparation cost per sales unit"><input type="number" min="0" value={newItem.preparationCost} onChange={(e) => setNewItem({ ...newItem, preparationCost: e.target.value })} placeholder="18000" className="input" /></Field><Field label="Profit per sales unit"><input type="number" min="0" value={newItem.profit} onChange={(e) => setNewItem({ ...newItem, profit: e.target.value })} className="input" /></Field></div>
          <label className="flex items-center gap-2 text-xs font-black uppercase"><input type="checkbox" checked={newItem.trackServerSales} onChange={(e) => setNewItem({ ...newItem, trackServerSales: e.target.checked })} />Show on server sales grid</label>
          <ConsoleButton variant="primary" disabled={!newItem.name.trim() || Number(newItem.conversion) <= 0}>Add Ingredient</ConsoleButton>
        </form>
      </Panel>

    </div>}

    {section === 'activity' && <div><Panel title="Record Stock Activity" subtitle="Receipts create FIFO batches; usage and waste consume the oldest stock." icon={PackagePlus}>
        {items.length === 0 ? <EmptyState>Add an ingredient first</EmptyState> : <form onSubmit={record} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><Field label="Ingredient"><select value={selected} onChange={(e) => setSelected(e.target.value)} className="input">{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field><Field label="Activity"><select value={operation} onChange={(e) => setOperation(e.target.value as any)} className="input"><option value="receipt">Receive stock</option><option value="usage">Ingredient usage</option><option value="waste">Wastage</option><option value="count">Physical count</option></select></Field></div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3"><Field label={operation === 'receipt' ? `Quantity (${item?.purchaseUnit || ''})` : operation === 'count' ? `Counted quantity (${item?.baseUnit || ''})` : `Quantity (${item?.baseUnit || ''})`}><input required type="number" min="0" step="any" value={entry.quantity} onChange={(e) => setEntry({ ...entry, quantity: e.target.value })} className="input" /></Field>{operation === 'receipt' && <><Field label={`Cost per ${item?.purchaseUnit}`}><input required type="number" min="0" step="any" value={entry.cost} onChange={(e) => setEntry({ ...entry, cost: e.target.value })} className="input" /></Field><Field label="Supplier (optional)"><input value={entry.supplier} onChange={(e) => setEntry({ ...entry, supplier: e.target.value })} className="input" /></Field><Field label="Expiry (optional)"><input type="date" value={entry.expiry} onChange={(e) => setEntry({ ...entry, expiry: e.target.value })} className="input" /></Field></>}</div>
          <Field label="Reason / note"><input required={operation !== 'receipt'} value={entry.note} onChange={(e) => setEntry({ ...entry, note: e.target.value })} placeholder={operation === 'receipt' ? 'Optional delivery note' : 'Required for audit trail'} className="input" /></Field>
          <ConsoleButton variant="primary" disabled={!item || Number(entry.quantity) < 0 || (operation === 'receipt' && entry.cost === '')}>Record Activity</ConsoleButton>
        </form>}
      </Panel></div>}

    {(section === 'overview' || section === 'ingredients') && <Panel title={section === 'ingredients' ? 'Configure Ingredients' : 'Ingredient Stock'} subtitle={section === 'ingredients' ? 'Edit units, conversions, and reorder levels in one place.' : 'On-hand quantity and FIFO value after every receipt, usage, waste, and count'} icon={ClipboardCheck}>
      {summaries.length === 0 ? <EmptyState>No ingredients configured</EmptyState> : <DataTable headers={['Ingredient', 'Unit conversion', 'On hand', 'Reorder level', 'FIFO value', 'Status', ...(section === 'ingredients' ? ['Action'] : [])]} alignRight={[2, 3, 4, 5, 6]}>{summaries.map((s) => <tr key={s.item.id}><td className="py-2.5 pr-3 font-bold">{s.item.name}</td><td className="py-2.5 pr-3 text-slate-500">1 {s.item.purchaseUnit} = {s.item.baseUnitsPerPurchaseUnit} {s.item.baseUnit}{s.item.salesUnit && s.item.baseUnitsPerSalesUnit ? ` · 1 ${s.item.salesUnit} = ${s.item.baseUnitsPerSalesUnit} ${s.item.baseUnit}` : ''}</td><td className="py-2.5 pr-3 text-right font-mono font-black">{s.quantity.toLocaleString()} {s.item.baseUnit}</td><td className="py-2.5 pr-3 text-right font-mono">{s.item.reorderLevel.toLocaleString()}</td><td className="py-2.5 pr-3 text-right font-mono font-bold">{formatCurrency(s.value, currency)}</td><td className="py-2.5 text-right"><StatusBadge tone={s.quantity <= s.item.reorderLevel ? 'danger' : 'ok'}>{s.quantity <= s.item.reorderLevel ? 'Reorder' : 'In stock'}</StatusBadge></td>{section === 'ingredients' && <td className="py-2.5 text-right"><ConsoleButton onClick={() => setEditing({ id: s.item.id, name: s.item.name, baseUnit: s.item.baseUnit, purchaseUnit: s.item.purchaseUnit, conversion: String(s.item.baseUnitsPerPurchaseUnit), reorder: String(s.item.reorderLevel), salesUnit: s.item.salesUnit || '', salesConversion: String(s.item.baseUnitsPerSalesUnit || ''), standardCost: String(s.item.standardPurchaseCost || ''), preparationCost: String(s.item.preparationCostPerSalesUnit ?? standardCostPerSalesUnit(s.item)), profit: String(s.item.profitPerSalesUnit || ''), trackServerSales: Boolean(s.item.trackServerSales) })}>Configure</ConsoleButton></td>}</tr>)}</DataTable>}
      {section === 'ingredients' && editing && <div className="mt-4 border-2 border-amber-300 bg-amber-50 p-3 grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
        <Field label="Name"><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field><Field label="Base unit"><input value={editing.baseUnit} onChange={(e) => setEditing({ ...editing, baseUnit: e.target.value })} /></Field><Field label="Purchase unit"><input value={editing.purchaseUnit} onChange={(e) => setEditing({ ...editing, purchaseUnit: e.target.value })} /></Field><Field label="Base / purchase"><input type="number" min="0.000001" step="any" value={editing.conversion} onChange={(e) => setEditing({ ...editing, conversion: e.target.value })} /></Field><Field label="Reorder at"><input type="number" min="0" step="any" value={editing.reorder} onChange={(e) => setEditing({ ...editing, reorder: e.target.value })} /></Field>
        <Field label="Sales unit"><input value={editing.salesUnit} onChange={(e) => setEditing({ ...editing, salesUnit: e.target.value })} /></Field><Field label="Base / sales unit"><input type="number" min="0" step="any" value={editing.salesConversion} onChange={(e) => setEditing({ ...editing, salesConversion: e.target.value })} /></Field><Field label="Purchase cost"><input type="number" min="0" value={editing.standardCost} onChange={(e) => setEditing({ ...editing, standardCost: e.target.value })} /></Field><Field label="Preparation / sales unit"><input type="number" min="0" value={editing.preparationCost} onChange={(e) => setEditing({ ...editing, preparationCost: e.target.value })} /></Field><Field label="Profit / unit"><input type="number" min="0" value={editing.profit} onChange={(e) => setEditing({ ...editing, profit: e.target.value })} /></Field>
        <label className="text-[10px] font-black uppercase flex gap-2 items-center"><input type="checkbox" checked={editing.trackServerSales} onChange={(e) => setEditing({ ...editing, trackServerSales: e.target.checked })} />Server sales</label><div className="flex gap-1 md:col-span-4 justify-end"><ConsoleButton onClick={() => setEditing(null)}>Cancel</ConsoleButton><ConsoleButton variant="primary" onClick={() => { const original = items.find((i) => i.id === editing.id)!; void updateItem({ ...original, name: editing.name.trim(), baseUnit: editing.baseUnit.trim(), purchaseUnit: editing.purchaseUnit.trim(), baseUnitsPerPurchaseUnit: Number(editing.conversion), reorderLevel: Number(editing.reorder), salesUnit: editing.salesUnit.trim() || undefined, baseUnitsPerSalesUnit: Number(editing.salesConversion) || undefined, standardPurchaseCost: Number(editing.standardCost) || 0, preparationCostPerSalesUnit: Number(editing.preparationCost) || 0, profitPerSalesUnit: Number(editing.profit) || 0, trackServerSales: editing.trackServerSales }).then(() => { setEditing(null); flash('Ingredient configuration updated'); }).catch(fail); }}>Save</ConsoleButton></div>
      </div>}
    </Panel>}
    {section === 'history' && <Panel title="Movement & Variance Report" subtitle="Latest receipts, consumption, wastage, and physical-count variances" icon={ClipboardCheck}>
      {movements.length === 0 ? <EmptyState>No stock movements recorded</EmptyState> : <DataTable headers={['Date', 'Ingredient', 'Type', 'Quantity', 'Value', 'Variance / note', 'Manager']} alignRight={[3, 4]}>{movements.slice(0, 100).map((m) => { const unit = items.find((i) => i.id === m.itemId)?.baseUnit || ''; return <tr key={m.id}><td className="py-2 pr-3 font-mono">{m.businessDay}</td><td className="py-2 pr-3 font-bold">{m.itemName}</td><td className="py-2 pr-3 uppercase text-[10px] font-black">{m.type.replace('_', ' ')}</td><td className={`py-2 pr-3 text-right font-mono font-bold ${m.quantityBase < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{m.quantityBase > 0 ? '+' : ''}{m.quantityBase.toLocaleString()} {unit}</td><td className="py-2 pr-3 text-right font-mono">{formatCurrency(m.value, currency)}</td><td className="py-2 pr-3 text-slate-500">{m.varianceQuantity !== undefined ? `Variance ${m.varianceQuantity > 0 ? '+' : ''}${m.varianceQuantity} ${unit}. ` : ''}{m.note || '—'}</td><td className="py-2">{m.recordedByName || 'Manager'}</td></tr>; })}</DataTable>}
    </Panel>}
  </div>;
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => <label className="block text-[10px] font-black uppercase">{label}{React.isValidElement(children) ? React.cloneElement(children as React.ReactElement<any>, { className: `${(children as any).props.className || ''} mt-1 w-full border-2 border-slate-300 p-2 rounded-none normal-case` }) : children}</label>;
