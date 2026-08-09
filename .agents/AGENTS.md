# Project Rules & Guidelines — Ticket POS MVP

## 1. Architecture & Core Tech Stack
- **Framework**: React 18 + Vite + TypeScript.
- **State Management**: Zustand stores (`useTicketStore`, `useShiftStore`, `useExpenseStore`, `useDeviceStore`, `useSyncStore`, `useAuthStore`).
- **Styling & Theme**: Tailwind CSS with a clean **Light Mode** design (light slate/warm neutral backgrounds `#f8fafc` / `#ffffff`, crisp borders `#e2e8f0`, dark bold typography `#0f172a`, amber `#f59e0b` / `#d97706` highlight accents, emerald green `#10b981` status badges).
- **Architecture Pattern**: Component-Based Scaffolding (`components/`, `store/`, `services/`, `hooks/`, `types/`, `utils/`).
- **Local Database**: Abstracted `IDbService` interface. SQLite WASM (`@sqlite.org/sqlite-wasm` / `sql.js`) in browser dev preview, Tauri SQL plugin (rusqlite SQLite WAL mode) in Tauri production.
- **Unit Testing**: Vitest for unit testing core business logic (ticket composite key generation, shift cash reconciliation & variance, outbox payload idempotency).

## 2. Functional Requirements & Specific UI Mechanics
- **FR1 (Ticket Creation)**: Preset amount cards + Home-row hotkeys (`A`, `S`, `D`, `F`, `G`, `H`, `J`, `K`, `L`) + Custom amount keypad input.
- **Visual Feedback**: Ticket stubs with notch cutouts (`amount-card` rounded top/bottom notches), key badge in top-left corner, visual flash effect (`flash` CSS / state animation) on card press or hotkey match.
- **Active Typing Detection**: Bypasses global keydown hotkeys whenever user is typing in input or textarea fields.
- **FR2 (Composite Ticket Numbering)**: Composite primary key format: `${location_id}-${device_id}-${local_seq}` (e.g. `LOC01-DEV01-000042`).
- **FR3 (Thermal Printing)**: Instant printable thermal receipt view (80mm layout) with Business Name, bold amount (Naira `₦`), `#ticketNo`, timestamp, and inline SVG QR code. Dev console logging + toast notification.
- **FR4 & Security (Void & Audit)**: Ticket voiding requires Manager PIN (Argon2 hashed) + mandatory reason. Every void creates an immutable append-only audit log entry (`audit_logs`).
- **FR5 (Collection Scanning)**: Scan/mark ticket status as `collected` from ticket list or scan modal.
- **FR9-FR11 (Shift Management & Cash Reconciliation)**: Cashier opens shift with declared float, closes shift with physical cash count. System automatically computes `expected_cash = opening_float + cash_ticket_total - approved_expenses` and surfaces `cash_variance = counted - expected` with mandatory manager flag if non-zero.
- **FR6-FR8 (Expense Queue)**: Cashier logs mid-shift expense (amount, category, description). Pending manager approval queue; rejection requires mandatory reason.
- **FR16-FR17 (Outbox Sync Worker)**: All mutations write to SQLite `sync_outbox` table within the same transaction. Background worker (5s interval when online) pushes outbox rows to Supabase idempotently via client UUIDs.

## 3. Durability & Testing Rules
- Zero business logic in React JSX event handlers — all math and key generation live in `utils/` or `services/` with 100% Vitest coverage.
- Append-only audit logs: Never modify or delete past void/edit records.
- Lockfiles committed, floating majors avoided in dependencies.
