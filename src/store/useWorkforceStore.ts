import { create } from 'zustand';
import { dbService } from '../services/db/IndexedDbService';
import { PerformanceReward, RolePayConfig, StaffAssessment, WageLedgerEntry, WageLedgerKind, WagePenalty, assessmentId } from '../types/workforce';
import { UserAccount, UserRole } from '../types/user';
import { calculateAssessment } from '../utils/workforce';
import { useAuthStore } from './useAuthStore';
import { useSyncStore } from './useSyncStore';

export const DEFAULT_PAY_CONFIGS: Record<UserRole, Pick<RolePayConfig, 'metricLabel' | 'nairaPerUnit'>> = {
  admin: { metricLabel: 'Work completed', nairaPerUnit: 0 },
  server: { metricLabel: 'Food sales units / coolers', nairaPerUnit: 0 },
  kitchen: { metricLabel: 'Food portions cooked', nairaPerUnit: 0 },
  cashier: { metricLabel: 'Ticket value issued', nairaPerUnit: 0 },
  cleaner: { metricLabel: 'Tasks completed', nairaPerUnit: 0 },
  storekeeper: { metricLabel: 'Work completed', nairaPerUnit: 0 },
  other: { metricLabel: 'Work completed', nairaPerUnit: 0 },
};

interface WorkforceState {
  configs: RolePayConfig[];
  assessments: StaffAssessment[];
  ledger: WageLedgerEntry[];
  isLoading: boolean;
  load: () => Promise<void>;
  configFor: (role: UserRole) => RolePayConfig;
  saveConfig: (role: UserRole, metricLabel: string, nairaPerUnit: number) => Promise<void>;
  saveAssessment: (staff: UserAccount, businessDay: string, output: number, penalties: WagePenalty[], rewards?: PerformanceReward[], note?: string) => Promise<void>;
  finalizeDay: (businessDay: string) => Promise<void>;
  reopenAssessment: (id: string, reason: string) => Promise<void>;
  addLedgerEntry: (staff: UserAccount, kind: WageLedgerKind, amount: number, note: string, businessDay: string) => Promise<void>;
}

const syncNow = () => useSyncStore.getState().checkOutbox().then(() => useSyncStore.getState().triggerSyncWorker());

export const useWorkforceStore = create<WorkforceState>((set, get) => ({
  configs: [], assessments: [], ledger: [], isLoading: false,
  load: async () => {
    set({ isLoading: true });
    await dbService.init();
    const [configs, assessments, ledger] = await Promise.all([
      dbService.getRolePayConfigs(), dbService.getStaffAssessments(), dbService.getWageLedger(),
    ]);
    set({ configs, assessments, ledger, isLoading: false });
  },
  configFor: (role) => get().configs.find((c) => c.role === role) ?? {
    id: role, role, ...DEFAULT_PAY_CONFIGS[role], updatedBy: '', updatedAt: '',
  },
  saveConfig: async (role, metricLabel, nairaPerUnit) => {
    const actor = useAuthStore.getState().activeUser;
    const owner = useAuthStore.getState().users.find((u) => u.role === 'admin');
    useAuthStore.getState().assertAdminRole();
    const row: RolePayConfig = {
      // Role names repeat across restaurants. Prefix with the owner's UUID so two
      // accounts can both configure "cashier" without colliding on the cloud PK.
      id: `${owner?.id || actor?.accountId || 'local'}_${role}`, role, metricLabel: metricLabel.trim(),
      nairaPerUnit: Math.max(0, nairaPerUnit), updatedBy: actor?.id || 'ADMIN', updatedAt: new Date().toISOString(),
    };
    await dbService.saveRolePayConfig(row, actor?.id || 'ADMIN');
    set({ configs: [...get().configs.filter((c) => c.role !== role), row] });
    void syncNow();
  },
  saveAssessment: async (staff, businessDay, output, penalties, rewards = [], note) => {
    useAuthStore.getState().assertAdminRole();
    const actor = useAuthStore.getState().activeUser;
    const existing = get().assessments.find((a) => a.id === assessmentId(businessDay, staff.id));
    if (existing?.status === 'finalized') throw new Error('Reopen this finalized assessment before editing it.');
    const cfg = get().configFor(staff.role);
    if (cfg.nairaPerUnit <= 0) throw new Error(`Set a monetary reward for ${staff.role} before recording performance.`);
    const totals = calculateAssessment({ output, nairaPerUnit: cfg.nairaPerUnit, penalties, rewards });
    const row: StaffAssessment = {
      id: assessmentId(businessDay, staff.id), businessDay, staffId: staff.id, staffName: staff.name,
      role: staff.role, metricLabel: cfg.metricLabel, output: Math.max(0, output),
      nairaPerUnit: cfg.nairaPerUnit, ...totals, penalties, rewards, note: note?.trim() || undefined,
      status: 'draft', recordedBy: actor?.id || 'ADMIN', recordedByName: actor?.name,
      recordedAt: existing?.recordedAt || new Date().toISOString(),
    };
    await dbService.saveStaffAssessment(row, actor?.id || 'ADMIN', existing ? 'Daily assessment updated' : 'Daily assessment entered');
    set({ assessments: [row, ...get().assessments.filter((a) => a.id !== row.id)] });
    void syncNow();
  },
  finalizeDay: async (businessDay) => {
    useAuthStore.getState().assertAdminRole();
    const actor = useAuthStore.getState().activeUser;
    const drafts = get().assessments.filter((a) => a.businessDay === businessDay && a.status === 'draft');
    const now = new Date().toISOString();
    for (const row of drafts) {
      await dbService.saveStaffAssessment({ ...row, status: 'finalized', finalizedAt: now }, actor?.id || 'ADMIN', `Finalized ${businessDay}`);
    }
    set({ assessments: get().assessments.map((a) => a.businessDay === businessDay && a.status === 'draft' ? { ...a, status: 'finalized', finalizedAt: now } : a) });
    void syncNow();
  },
  reopenAssessment: async (id, reason) => {
    useAuthStore.getState().assertAdminRole();
    const actor = useAuthStore.getState().activeUser;
    const row = get().assessments.find((a) => a.id === id);
    if (!row || !reason.trim()) throw new Error('A reopening reason is required.');
    const updated: StaffAssessment = { ...row, status: 'draft', reopenedAt: new Date().toISOString(), reopenReason: reason.trim() };
    await dbService.saveStaffAssessment(updated, actor?.id || 'ADMIN', reason.trim());
    set({ assessments: get().assessments.map((a) => a.id === id ? updated : a) });
    void syncNow();
  },
  addLedgerEntry: async (staff, kind, amount, note, businessDay) => {
    useAuthStore.getState().assertAdminRole();
    if (!note.trim()) throw new Error('A reason is required.');
    const actor = useAuthStore.getState().activeUser;
    const row: WageLedgerEntry = {
      id: crypto.randomUUID(), staffId: staff.id, staffName: staff.name, businessDay, kind,
      amount: kind === 'payment' ? Math.abs(amount) : amount, note: note.trim(),
      recordedBy: actor?.id || 'ADMIN', recordedByName: actor?.name, recordedAt: new Date().toISOString(),
    };
    await dbService.saveWageLedgerEntry(row, actor?.id || 'ADMIN');
    set({ ledger: [row, ...get().ledger] });
    void syncNow();
  },
}));
