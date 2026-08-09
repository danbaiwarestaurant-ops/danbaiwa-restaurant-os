import React, { useState } from 'react';
import { useTicketStore } from '../../store/useTicketStore';
import { useExpenseStore } from '../../store/useExpenseStore';
import { useDeviceStore } from '../../store/useDeviceStore';
import { formatCurrency, formatTimestamp } from '../../utils/currency';
import { TrendingUp, ShieldAlert, Globe, Filter } from 'lucide-react';
import { ExpenseApprovalQueue } from '../expense/ExpenseApprovalQueue';
import { StaffManagement } from './StaffManagement';
import { AdminProfileSettings } from './AdminProfileSettings';

interface ManagerDashboardProps {
  onRequirePin: (purpose: string, onVerified: () => void) => void;
}

export const ManagerDashboard: React.FC<ManagerDashboardProps> = ({ onRequirePin }) => {
  const { tickets } = useTicketStore();
  const { expenses } = useExpenseStore();
  const { config } = useDeviceStore();
  const [filterCashier, setFilterCashier] = useState('ALL');

  // Compute rollups
  const validTickets = tickets.filter(t => t.status !== 'void');
  const voidTickets = tickets.filter(t => t.status === 'void');
  const totalSales = validTickets.reduce((sum, t) => sum + t.amount, 0);

  const approvedExpenses = expenses
    .filter(e => e.status === 'approved')
    .reduce((sum, e) => sum + e.amount, 0);

  const grossProfit = totalSales - approvedExpenses;

  // Multi-location aggregation simulation (NFR12 / FR15)
  const locations = [
    { id: config.locationId || 'LOC01', name: config.businessName || 'Danbaiwa Restraunt', sales: totalSales, active: true },
    { id: 'LOC02', name: 'Danbaiwa Annex (Outlet #2)', sales: 48500, active: false },
  ];

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between border-b-2 border-slate-200 pb-4">
        <div>
          <h1 className="text-xl font-black uppercase text-slate-900 tracking-wide flex items-center gap-2">
            <TrendingUp className="w-6 h-6 text-amber-500" />
            <span>Manager Analytics & Audit Dashboard</span>
          </h1>
          <p className="text-xs text-slate-500 font-semibold uppercase">
            Live Ticket Feed • Gross Profit Rollups • Immutable Audit Logs
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-slate-400" />
          <select
            value={filterCashier}
            onChange={e => setFilterCashier(e.target.value)}
            className="p-2 border-2 border-slate-300 font-semibold text-xs text-slate-800 bg-white rounded-none"
          >
            <option value="ALL">All Cashiers</option>
            <option value="CASHIER-01">CASHIER-01 (Main Till)</option>
            <option value="CASHIER-02">CASHIER-02 (Mobile Scanner)</option>
          </select>
        </div>
      </div>

      {/* Analytics KPI Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border-2 border-slate-300 p-4 shadow-xs rounded-none">
          <div className="text-xs font-bold uppercase text-slate-500">Total Gross Ticket Sales</div>
          <div className="text-2xl font-black font-mono text-slate-900 mt-1">
            {formatCurrency(totalSales)}
          </div>
          <div className="text-[11px] text-emerald-600 font-bold mt-1">
            {validTickets.length} paid tickets logged
          </div>
        </div>

        <div className="bg-white border-2 border-slate-300 p-4 shadow-xs rounded-none">
          <div className="text-xs font-bold uppercase text-slate-500">Approved Shift Expenses</div>
          <div className="text-2xl font-black font-mono text-rose-600 mt-1">
            −{formatCurrency(approvedExpenses)}
          </div>
          <div className="text-[11px] text-slate-500 font-medium mt-1">
            {expenses.filter(e => e.status === 'approved').length} approved payouts
          </div>
        </div>

        <div className="bg-white border-2 border-slate-300 p-4 shadow-xs rounded-none">
          <div className="text-xs font-bold uppercase text-slate-500">Net Gross Profit</div>
          <div className="text-2xl font-black font-mono text-amber-600 mt-1">
            {formatCurrency(grossProfit)}
          </div>
          <div className="text-[11px] text-slate-500 font-medium mt-1">
            Sales minus approved expenses
          </div>
        </div>

        <div className="bg-white border-2 border-slate-300 p-4 shadow-xs rounded-none">
          <div className="text-xs font-bold uppercase text-slate-500">Void Audit Rate</div>
          <div className="text-2xl font-black font-mono text-rose-700 mt-1">
            {voidTickets.length} Voids
          </div>
          <div className="text-[11px] text-rose-600 font-bold mt-1">
            Requires Manager PIN + Reason
          </div>
        </div>
      </div>

      {/* Admin Profile & Security Settings Panel */}
      <AdminProfileSettings onLogoutAdmin={() => {
        // Exit Manager Mode on Admin Logout
        window.location.reload();
      }} />

      {/* Staff Management Panel (Admin Only) */}
      <StaffManagement />

      {/* Expense Approval Queue Section */}
      <ExpenseApprovalQueue onRequirePin={onRequirePin} />

      {/* Multi-Location Aggregation View (FR15) */}
      <div className="bg-white border-2 border-slate-300 p-5 shadow-xs rounded-none">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-800 mb-3 flex items-center gap-2">
          <Globe className="w-4 h-4 text-amber-500" />
          <span>Multi-Location Rollup View (FR15)</span>
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {locations.map(loc => (
            <div key={loc.id} className="p-3 border-2 border-slate-200 flex justify-between items-center bg-slate-50 rounded-none">
              <div>
                <div className="font-bold text-xs text-slate-900 uppercase">{loc.name}</div>
                <div className="text-[10px] text-slate-500 font-mono">{loc.id} • {loc.active ? 'LIVE AT TILL' : 'OFFLINE SYNC'}</div>
              </div>
              <div className="font-mono font-black text-sm text-slate-900">
                {formatCurrency(loc.sales)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Immutable Audit Log Table (FR14, NFR7) */}
      <div className="bg-white border-2 border-slate-300 p-5 shadow-xs rounded-none">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-800 mb-3 flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-rose-600" />
          <span>Immutable Audit Log Trail (FR14)</span>
        </h3>

        {tickets.filter(t => t.status === 'void').length === 0 ? (
          <div className="text-center py-6 text-slate-400 text-xs font-bold uppercase">
            No voided tickets or overrides in audit log
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b-2 border-slate-200 text-slate-500 uppercase">
                  <th className="py-2">Ticket #</th>
                  <th className="py-2">Amount</th>
                  <th className="py-2">Action</th>
                  <th className="py-2">Reason</th>
                  <th className="py-2">Actor ID</th>
                  <th className="py-2">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {tickets.filter(t => t.status === 'void').map(t => (
                  <tr key={t.id} className="hover:bg-slate-50 font-mono">
                    <td className="py-2.5 font-bold text-slate-900">#{t.id}</td>
                    <td className="py-2.5 text-rose-600 font-bold">{formatCurrency(t.amount, t.currency)}</td>
                    <td className="py-2.5 font-bold text-rose-700">VOID</td>
                    <td className="py-2.5 font-sans font-medium text-slate-700">{t.voidReason || 'N/A'}</td>
                    <td className="py-2.5 font-bold text-slate-700">{t.voidedBy || 'MANAGER'}</td>
                    <td className="py-2.5 text-slate-500 font-sans">{formatTimestamp(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
