import React, { useEffect, useState } from 'react';
import { useDeviceStore } from '../../store/useDeviceStore';
import { useExpenseStore } from '../../store/useExpenseStore';
import { useSyncStore } from '../../store/useSyncStore';
import { useAuthStore } from '../../store/useAuthStore';
import { UserMenu } from '../common/UserMenu';
import { PeriodPicker } from './PeriodPicker';
import { CONSOLE_NAV, ConsoleViewId, navGroups, navItem } from './consoleNav';
import { OverviewView } from './views/OverviewView';
import { SalesRecordView } from './views/SalesRecordView';
import { StaffView } from './views/StaffView';
import { ExpensesView } from './views/ExpensesView';
import { ReconciliationView } from './views/ReconciliationView';
import { ReportsView } from './views/ReportsView';
import { AuditLogView } from './views/AuditLogView';
import { SettingsView } from './views/SettingsView';
import { ComingSoonView } from './views/ComingSoonView';
import { ArrowLeft, UtensilsCrossed, Boxes } from 'lucide-react';

const LAST_VIEW_KEY = 'ticket_pos_console_view';

interface ManagerConsoleProps {
  onBackToTill: () => void;
  onRequirePin: (purpose: string, onVerified: () => void) => void;
}

/**
 * The manager console shell.
 *
 * Replaces the old single-scroll ManagerDashboard, which stacked KPIs, profile settings,
 * staff management, the expense queue and an audit table on one page — and rendered
 * underneath the till header, so there was no sense of having left the till at all. This
 * takes the full screen: leaving the till is explicit, which is also what keeps the till's
 * own controls out of reach while someone is doing back-office work.
 *
 * View state is local rather than routed — this project has no router dependency and one
 * tab strip does not justify adding one.
 */
export const ManagerConsole: React.FC<ManagerConsoleProps> = ({ onBackToTill, onRequirePin }) => {
  const { config } = useDeviceStore();
  const { expenses } = useExpenseStore();
  const { stuckCount } = useSyncStore();
  const admin = useAuthStore((s) => s.users.find((u) => u.role === 'admin'));

  const [view, setView] = useState<ConsoleViewId>(() => {
    try {
      const saved = localStorage.getItem(LAST_VIEW_KEY) as ConsoleViewId | null;
      return saved && CONSOLE_NAV.some((n) => n.id === saved) ? saved : 'overview';
    } catch {
      return 'overview';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(LAST_VIEW_KEY, view);
    } catch {
      /* private mode — falling back to Overview next time is harmless */
    }
  }, [view]);

  const pendingApprovals = expenses.filter((e) => e.status === 'pending').length;
  const badgeFor = (id: ConsoleViewId): number | undefined => {
    if (id === 'expenses' && pendingApprovals) return pendingApprovals;
    if (id === 'settings' && stuckCount) return stuckCount;
    return undefined;
  };

  const active = navItem(view);

  const renderView = () => {
    switch (view) {
      case 'overview': return <OverviewView />;
      case 'salesHistory': return <SalesRecordView />;
      case 'staff': return <StaffView />;
      case 'expenses': return <ExpensesView onRequirePin={onRequirePin} />;
      case 'reconciliation': return <ReconciliationView />;
      case 'reports': return <ReportsView />;
      case 'audit': return <AuditLogView />;
      case 'settings': return <SettingsView />;
      case 'menu':
        return (
          <ComingSoonView
            title="Menu Management"
            icon={UtensilsCrossed}
            purpose="Maintain the dishes you sell — names, categories, prices and cost prices — so tickets can carry what was actually ordered instead of only a total."
            requires={[
              'A menu items table (name, category, price, cost price, active flag), with cloud sync and account scoping like every other table',
              'Line items on tickets — today a ticket stores a single flat amount, with no record of what it was for',
              'Ticket creation, the printed receipt and the QR payload all updated to carry those line items',
            ]}
          />
        );
      case 'inventory':
        return (
          <ComingSoonView
            title="Inventory"
            icon={Boxes}
            purpose="Track stock levels, reorder points and suppliers, and warn you before something runs out mid-service."
            requires={[
              'Ingredients, stock levels, reorder thresholds, suppliers and restock records — none of which exist in the data model today',
              'Menu Management first: stock only depletes automatically once a ticket knows which dishes it contained',
            ]}
          />
        );
      default:
        return <OverviewView />;
    }
  };

  return (
    <div className="min-h-screen flex bg-slate-100">
      {/* Sidebar */}
      <nav className="w-60 flex-shrink-0 bg-white border-r-2 border-slate-300 h-screen sticky top-0 overflow-y-auto flex flex-col">
        <div className="px-4 py-5 border-b-2 border-slate-200">
          <div className="font-black text-base uppercase tracking-wider text-slate-900 leading-tight">
            {config.businessName || 'Danbaiwa Restraunt'}
          </div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-amber-600 mt-0.5">
            Manager Console
          </div>
        </div>

        <div className="p-3 border-b-2 border-slate-200">
          <button
            onClick={onBackToTill}
            className="w-full flex items-center gap-2 px-3 py-2 bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-black uppercase tracking-wide rounded-none transition"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Till</span>
          </button>
        </div>

        <div className="flex-1 py-3">
          {navGroups().map(({ group, items }) => (
            <div key={group} className="mb-4">
              <div className="px-4 mb-1.5 text-[9px] font-black uppercase tracking-[0.12em] text-slate-400">
                {group}
              </div>
              {items.map((item) => {
                const Icon = item.icon;
                const isActive = item.id === view;
                const badge = badgeFor(item.id);
                return (
                  <button
                    key={item.id}
                    onClick={() => setView(item.id)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`w-full flex items-center gap-2.5 px-4 py-2 text-xs font-bold text-left transition ${
                      isActive
                        ? 'bg-amber-500 text-white'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    <Icon className="w-4 h-4 flex-shrink-0" />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.placeholder && !isActive && (
                      <span className="text-[8px] font-black uppercase tracking-wider text-slate-400 border border-slate-300 px-1 py-px">
                        Soon
                      </span>
                    )}
                    {badge !== undefined && (
                      <span className="text-[9px] font-black bg-rose-600 text-white px-1.5 py-px rounded-none">
                        {badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="px-4 py-3 border-t-2 border-slate-200 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
          {config.locationId}-{config.deviceId}
        </div>
      </nav>

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-20 bg-white/95 backdrop-blur-sm border-b-2 border-slate-300 px-6 py-3.5 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">
              {active.group}
            </div>
            <h1 className="text-lg font-black text-slate-900 leading-tight">{active.label}</h1>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {/* One date control governing the whole console — omitted on views that are
                either live (Live Tickets), account state rather than a record (Settings,
                Staff directory management) or not built yet. */}
            {active.periodScoped && <PeriodPicker />}
            {/* The console reports the account, not whoever is signed in at the till, so it
                names the admin whose books these are — the till's own identity stays in the
                avatar menu beside it. */}
            {admin && (
              <div className="text-right leading-tight border-l-2 border-slate-200 pl-3">
                <div className="text-[9px] font-black uppercase tracking-widest text-amber-600">
                  Admin Session
                </div>
                <div className="text-[11px] font-bold text-slate-700 truncate max-w-[10rem]">
                  {admin.name}
                </div>
              </div>
            )}
            <UserMenu />
          </div>
        </header>

        <main className="flex-1 p-6 max-w-[1600px] w-full">{renderView()}</main>
      </div>
    </div>
  );
};
