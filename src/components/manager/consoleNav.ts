import {
  LayoutGrid, BookOpen, UtensilsCrossed, Boxes, Users,
  Wallet, ScrollText, BarChart3, ShieldCheck, Settings, Printer, LucideIcon,
} from 'lucide-react';

/**
 * Single source of truth for console navigation.
 *
 * The sidebar, the breadcrumb and the topbar title are all derived from this list, so
 * they cannot drift apart the way three hand-maintained copies would.
 */
export type ConsoleViewId =
  | 'overview'
  | 'salesHistory'
  | 'menu'
  | 'inventory'
  | 'staff'
  | 'expenses'
  | 'reconciliation'
  | 'reports'
  | 'audit'
  | 'printer'
  | 'settings';

export interface ConsoleNavItem {
  id: ConsoleViewId;
  label: string;
  /** Section heading in the sidebar; also the breadcrumb above the view title. */
  group: string;
  icon: LucideIcon;
  /** Marks a view with no data model behind it yet (see ComingSoonView). */
  placeholder?: boolean;
  /**
   * Whether the view reports over the console's shared date period, and so should show the
   * period picker. False for views that show live or current state rather than a record of
   * trading — the picker there would imply a filter that does nothing.
   */
  periodScoped?: boolean;
}

export const CONSOLE_NAV: ConsoleNavItem[] = [
  { id: 'overview', label: 'Overview', group: 'Dashboard', icon: LayoutGrid, periodScoped: true },

  // No "Live Tickets" tab: the till's own sidebar already shows the live queue to the
  // person who can act on it, and a second live view in the back office only invited
  // reading today's takings off a screen that was never the record.
  { id: 'salesHistory', label: 'Sales Record Book', group: 'Sales', icon: BookOpen, periodScoped: true },

  { id: 'menu', label: 'Menu Management', group: 'Operations', icon: UtensilsCrossed, placeholder: true },
  { id: 'inventory', label: 'Inventory', group: 'Operations', icon: Boxes, placeholder: true },
  { id: 'staff', label: 'Staff Management', group: 'Operations', icon: Users, periodScoped: true },

  { id: 'expenses', label: 'Expenses', group: 'Finance', icon: Wallet, periodScoped: true },
  { id: 'reconciliation', label: 'Shift Reconciliation', group: 'Finance', icon: ScrollText, periodScoped: true },
  { id: 'reports', label: 'Reports & Analytics', group: 'Finance', icon: BarChart3, periodScoped: true },

  { id: 'audit', label: 'Audit Log', group: 'System', icon: ShieldCheck, periodScoped: true },

  // Its own tab rather than a panel inside Settings: this is the one screen a
  // non-technical person is sent to when tickets stop printing, and it has to be
  // findable by name under pressure rather than scrolled to.
  { id: 'printer', label: 'Printer Setup', group: 'System', icon: Printer },
  { id: 'settings', label: 'Settings', group: 'System', icon: Settings },
];

/** Nav items in sidebar order, bucketed by group heading. */
export function navGroups(): { group: string; items: ConsoleNavItem[] }[] {
  const groups: { group: string; items: ConsoleNavItem[] }[] = [];
  for (const item of CONSOLE_NAV) {
    let bucket = groups.find((g) => g.group === item.group);
    if (!bucket) {
      bucket = { group: item.group, items: [] };
      groups.push(bucket);
    }
    bucket.items.push(item);
  }
  return groups;
}

export function navItem(id: ConsoleViewId): ConsoleNavItem {
  return CONSOLE_NAV.find((i) => i.id === id) ?? CONSOLE_NAV[0];
}
