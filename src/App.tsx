import React, { useEffect, useState, useRef } from 'react';
import { useDeviceStore } from './store/useDeviceStore';
import { useTicketStore } from './store/useTicketStore';
import { useShiftStore } from './store/useShiftStore';
import { useExpenseStore } from './store/useExpenseStore';
import { useSyncStore } from './store/useSyncStore';
import { useAuthStore } from './store/useAuthStore';
import { useAuditStore } from './store/useAuditStore';

import { Header } from './components/common/Header';
import { Toast } from './components/common/Toast';
import { PinModal } from './components/common/PinModal';
import { QuickConfigModal } from './components/common/QuickConfigModal';
import { AuthPage } from './components/auth/AuthPage';
import { RecoveryKeyNotice } from './components/auth/RecoveryKeyNotice';

import { PresetCardGrid } from './components/ticket/PresetCardGrid';
import { CustomAmountInput } from './components/ticket/CustomAmountInput';
import { RecentTicketsSidebar } from './components/ticket/RecentTicketsSidebar';
import { ThermalReceiptTemplate } from './components/ticket/ThermalReceiptTemplate';
import { VoidReasonModal } from './components/ticket/VoidReasonModal';
import { ScanCollectorModal } from './components/ticket/ScanCollectorModal';

import { OpenShiftModal } from './components/shift/OpenShiftModal';
import { CloseShiftModal } from './components/shift/CloseShiftModal';
import { ExpenseLoggerModal } from './components/expense/ExpenseLoggerModal';
import { ManagerConsole } from './components/manager/ManagerConsole';

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 Minutes Idle Auto-Lock

export function App() {
  const { loadConfig } = useDeviceStore();
  const { loadTickets, voidTicket } = useTicketStore();
  const { currentShift, loadShift, loadShiftHistory } = useShiftStore();
  const { loadExpenses } = useExpenseStore();
  const { checkOutbox } = useSyncStore();
  const { loadAuditLogs } = useAuditStore();

  const {
    activeUser,
    isAuthenticated,
    isLoaded: isAuthLoaded,
    loadUsers,
    isPinModalOpen,
    pinModalPurpose,
    openPinModal,
    closePinModal,
    grantAdminAuthority,
    revokeAdminAuthority,
  } = useAuthStore();

  // Modals state
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isOpenShiftOpen, setIsOpenShiftOpen] = useState(false);
  const [isCloseShiftOpen, setIsCloseShiftOpen] = useState(false);
  const [isExpenseModalOpen, setIsExpenseModalOpen] = useState(false);
  const [isScanModalOpen, setIsScanModalOpen] = useState(false);
  const [isVoidModalOpen, setIsVoidModalOpen] = useState(false);
  const [selectedVoidTicketId, setSelectedVoidTicketId] = useState<string | null>(null);

  // View state
  const [isManagerView, setIsManagerView] = useState(false);

  // Toast feedback
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [toastType, setToastType] = useState<'success' | 'error'>('success');

  const idleTimerRef = useRef<NodeJS.Timeout | null>(null);

  const showSuccess = (msg: string) => {
    setToastMsg(msg);
    setToastType('success');
  };

  const showError = (msg: string) => {
    setToastMsg(msg);
    setToastType('error');
  };

  useEffect(() => {
    loadConfig();
    loadUsers();
    checkOutbox();
  }, []);

  // Reload data whenever the signed-in user or the view changes.
  //
  // At the till, tickets and expenses roll up across the account for an admin but stay
  // scoped to "my own" for a cashier. currentShift is never rolled up — it's a personal
  // "is my shift open" gate, always the signed-in user's own shift regardless of role (see
  // realtimeSync.ts's scheduleStoreReload for the same distinction on the sync side).
  //
  // The manager console is different: it is the account's books, so it always loads the
  // whole account. Entering it already requires the admin PIN, and whichever cashier is
  // signed in at the till has no bearing on what the owner is entitled to read — a console
  // that narrowed itself to the logged-in cashier would report that month's revenue as
  // whatever that one person happened to take.
  useEffect(() => {
    if (!isAuthenticated || !activeUser) return;

    if (isManagerView) {
      loadTickets();
      loadExpenses();
      loadUsers();
      loadShiftHistory();
      loadAuditLogs();
      return;
    }

    const rollupScope = activeUser.role === 'admin' ? undefined : activeUser.id;
    loadTickets(rollupScope);
    loadShift(activeUser.id);
    loadExpenses(undefined, rollupScope);
  }, [isAuthenticated, activeUser?.id, activeUser?.role, isManagerView]);

  // 5-Minute Inactivity Idle Auto-Lock Timer
  useEffect(() => {
    if (!isAuthenticated) return;

    const resetIdleTimer = () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        if (!isPinModalOpen) {
          openPinModal(
            'Screen Auto-Locked due to Inactivity',
            (verified) => {
              if (!verified) {
                showError('Authentication required to unlock till');
              }
            },
            // The signed-in cashier's own PIN reopens it. This used to demand an admin
            // PIN, so a cashier working a shift alone was locked out of the till by the
            // idle timer until the owner came over.
            'session'
          );
        }
      }, INACTIVITY_TIMEOUT_MS);
    };

    const events = ['mousemove', 'keydown', 'click', 'touchstart'];
    events.forEach(e => window.addEventListener(e, resetIdleTimer));
    resetIdleTimer();

    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      events.forEach(e => window.removeEventListener(e, resetIdleTimer));
    };
  }, [isAuthenticated, isPinModalOpen]);

  const handleOpenVoidModal = (ticketId: string) => {
    openPinModal(`Void Ticket #${ticketId}`, (verified) => {
      if (verified) {
        setSelectedVoidTicketId(ticketId);
        setIsVoidModalOpen(true);
      } else {
        showError('Invalid Manager PIN for void operation');
      }
    });
  };

  const handleConfirmVoid = async (reason: string) => {
    if (selectedVoidTicketId && activeUser) {
      await voidTicket(selectedVoidTicketId, reason, activeUser.name);
      showSuccess(`Voided ticket #${selectedVoidTicketId}`);
      setIsVoidModalOpen(false);
      setSelectedVoidTicketId(null);
    }
  };

  const handleToggleManagerView = () => {
    if (!isManagerView) {
      openPinModal('Access Manager Mode', (verified) => {
        if (verified) {
          // validatePin only ever matches an *admin* PIN, so a successful unlock is proof
          // of admin authority regardless of who is signed in at the till. The console's
          // admin-only actions check this rather than the signed-in role.
          grantAdminAuthority();
          setIsManagerView(true);
        } else {
          showError('Invalid Manager PIN');
        }
      });
    } else {
      revokeAdminAuthority();
      setIsManagerView(false);
    }
  };

  // 1. Loading Guard: Show safe black screen during SQLite/Auth bootstrap
  if (!isAuthLoaded) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6 selection:bg-amber-500">
        <div className="w-12 h-12 border-4 border-amber-500 border-t-transparent rounded-full animate-spin mb-4" />
        <div className="text-white font-black text-xs uppercase tracking-widest animate-pulse">
          INITIALIZING POS TILL...
        </div>
      </div>
    );
  }

  // 2. Auth Guard: Redirect unauthenticated requests to AuthPage
  if (!isAuthenticated) {
    return <AuthPage />;
  }

  // Renders only in the moment after a recovery key is issued — see RecoveryKeyNotice.
  // Mounted above every view so it cannot be skipped past by whatever screen follows
  // registration.

  const requireManagerPin = (purpose: string, onVerified: () => void) => {
    openPinModal(purpose, (verified) => {
      if (verified) onVerified();
      else showError('Manager PIN required');
    });
  };

  // The console takes the whole screen rather than rendering beneath the till header:
  // leaving the till is explicit, and the till's own controls are out of reach while
  // someone is doing back-office work.
  if (isManagerView) {
    return (
      <div className="font-sans text-slate-900 selection:bg-amber-100 selection:text-amber-900">
        <ManagerConsole
          onBackToTill={() => {
            revokeAdminAuthority();
            setIsManagerView(false);
          }}
          onRequirePin={requireManagerPin}
        />
        <Toast message={toastMsg} type={toastType} onClose={() => setToastMsg(null)} />
        <PinModal isOpen={isPinModalOpen} purpose={pinModalPurpose} onClose={closePinModal} />
        <RecoveryKeyNotice />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-100 font-sans text-slate-900 selection:bg-amber-100 selection:text-amber-900">
      {/* Top Header */}
      <Header
        onOpenConfig={() => setIsConfigOpen(true)}
        onOpenShiftModal={() => {
          if (currentShift) setIsCloseShiftOpen(true);
          else setIsOpenShiftOpen(true);
        }}
        onOpenExpenseModal={() => setIsExpenseModalOpen(true)}
        onToggleManagerView={handleToggleManagerView}
        onLockTill={() =>
          openPinModal('Till Locked — Enter Your PIN to Resume', () => {}, 'session')
        }
        isManagerView={isManagerView}
      />

      {/* Main Workspace Body */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-0 max-w-[1920px] mx-auto w-full">
        {/* Main Till Area */}
        <div className="p-6 space-y-6 overflow-y-auto">
          {/* Custom Amount Section */}
          <CustomAmountInput onTicketCreated={showSuccess} onError={showError} />

          {/* Quick Amount Grid */}
          <div className="bg-white border-2 border-slate-300 rounded-none p-5 shadow-xs">
            <PresetCardGrid onTicketCreated={showSuccess} onError={showError} />
          </div>
        </div>

        {/* Right Sidebar: Recent Tickets */}
        <RecentTicketsSidebar
          onOpenVoidModal={handleOpenVoidModal}
          onOpenScanModal={() => setIsScanModalOpen(true)}
        />
      </main>

      {/* Hidden Thermal Receipt Printable Area */}
      <ThermalReceiptTemplate />

      {/* Toast Feedback */}
      <Toast message={toastMsg} type={toastType} onClose={() => setToastMsg(null)} />

      {/* Global PIN Challenge Modal */}
      <PinModal
        isOpen={isPinModalOpen}
        purpose={pinModalPurpose}
        onClose={closePinModal}
      />

      {/* Modals */}
      <QuickConfigModal isOpen={isConfigOpen} onClose={() => setIsConfigOpen(false)} />
      <OpenShiftModal isOpen={isOpenShiftOpen} onClose={() => setIsOpenShiftOpen(false)} onSuccess={showSuccess} />
      <CloseShiftModal isOpen={isCloseShiftOpen} onClose={() => setIsCloseShiftOpen(false)} onSuccess={showSuccess} />
      <ExpenseLoggerModal isOpen={isExpenseModalOpen} onClose={() => setIsExpenseModalOpen(false)} onSuccess={showSuccess} />
      <ScanCollectorModal isOpen={isScanModalOpen} onClose={() => setIsScanModalOpen(false)} onSuccess={showSuccess} />
      <VoidReasonModal
        isOpen={isVoidModalOpen}
        ticketId={selectedVoidTicketId}
        onClose={() => setIsVoidModalOpen(false)}
        onConfirmVoid={handleConfirmVoid}
      />

      <RecoveryKeyNotice />
    </div>
  );
}
