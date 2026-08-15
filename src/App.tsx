import React, { useEffect, useState, useRef } from 'react';
import { useDeviceStore } from './store/useDeviceStore';
import { useTicketStore } from './store/useTicketStore';
import { useShiftStore } from './store/useShiftStore';
import { useExpenseStore } from './store/useExpenseStore';
import { useSyncStore } from './store/useSyncStore';
import { useAuthStore } from './store/useAuthStore';

import { Header } from './components/common/Header';
import { Toast } from './components/common/Toast';
import { PinModal } from './components/common/PinModal';
import { QuickConfigModal } from './components/common/QuickConfigModal';
import { AuthPage } from './components/auth/AuthPage';

import { PresetCardGrid } from './components/ticket/PresetCardGrid';
import { CustomAmountInput } from './components/ticket/CustomAmountInput';
import { RecentTicketsSidebar } from './components/ticket/RecentTicketsSidebar';
import { ThermalReceiptTemplate } from './components/ticket/ThermalReceiptTemplate';
import { VoidReasonModal } from './components/ticket/VoidReasonModal';
import { ScanCollectorModal } from './components/ticket/ScanCollectorModal';

import { OpenShiftModal } from './components/shift/OpenShiftModal';
import { CloseShiftModal } from './components/shift/CloseShiftModal';
import { ExpenseLoggerModal } from './components/expense/ExpenseLoggerModal';
import { ManagerDashboard } from './components/manager/ManagerDashboard';

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 Minutes Idle Auto-Lock

export function App() {
  const { loadConfig } = useDeviceStore();
  const { loadTickets, voidTicket } = useTicketStore();
  const { currentShift, loadShift } = useShiftStore();
  const { loadExpenses } = useExpenseStore();
  const { checkOutbox } = useSyncStore();

  const {
    activeUser,
    isAuthenticated,
    isLoaded: isAuthLoaded,
    loadUsers,
    isPinModalOpen,
    pinModalPurpose,
    openPinModal,
    closePinModal,
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

  // Reload user-scoped data whenever activeUser changes
  useEffect(() => {
    if (isAuthenticated && activeUser) {
      loadTickets(activeUser.id);
      loadShift(activeUser.id);
      loadExpenses(undefined, activeUser.id);
    }
  }, [isAuthenticated, activeUser?.id]);

  // 5-Minute Inactivity Idle Auto-Lock Timer
  useEffect(() => {
    if (!isAuthenticated) return;

    const resetIdleTimer = () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        if (!isPinModalOpen) {
          openPinModal('Screen Auto-Locked due to Inactivity', (verified) => {
            if (!verified) {
              showError('Authentication required to unlock till');
            }
          });
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
          setIsManagerView(true);
        } else {
          showError('Invalid Manager PIN');
        }
      });
    } else {
      setIsManagerView(false);
    }
  };

  if (isAuthLoaded && !isAuthenticated) {
    return <AuthPage />;
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
        isManagerView={isManagerView}
      />

      {/* Main Workspace Body */}
      {isManagerView ? (
        <ManagerDashboard
          onRequirePin={(purpose, onVerified) => {
            openPinModal(purpose, (verified) => {
              if (verified) onVerified();
              else showError('Manager PIN required');
            });
          }}
        />
      ) : (
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
      )}

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
    </div>
  );
}
