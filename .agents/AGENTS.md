# Project Rules & Guidelines — Ticket POS (Danbaiwa Restaurant OS)

## 1. MANDATORY UNIT TESTING (VITEST)
- **Vitest First Principle**: All core business logic (PIN hashing, RBAC role checks, user management, composite key generation, shift float reconciliation, cash variance math, and outbox idempotency formatting) MUST be covered by unit tests in `src/tests/` running via `npm run test`.
- **Zero Regression Policy**: Never break or bypass Vitest suite before declaring any feature or bug fix complete.

## 2. SECURITY & ZERO HARDCODED CREDENTIALS RULE
- **CRITICAL**: ABSOLUTELY NO hardcoded PINs, passwords, or fallback credentials anywhere in source code (e.g. no `DEFAULT_PINS = '9999'`).
- **Dynamic Account Management**: System initializes via a First-Launch Admin Setup screen on first boot where the venue owner creates the primary Admin account.
- **Salted Hashing**: All user PINs (Admin and Staff Cashiers) are hashed using `crypto.subtle.digest('SHA-256', salt + pin)` with a unique 16-byte cryptographically random salt generated via `crypto.getRandomValues()`.
- **Stored in SQLite Only**: Hashes and salts are stored strictly in the SQLite `users` table (`id`, `name`, `username`, `role`, `pin_hash`, `pin_salt`, `created_at`, `status`).

## 3. SUPABASE CLOUD SYNC FOR ALL DATA (OUTBOX PATTERN)
- **Full Outbox Coverage**: ALL local database mutations across ALL tables (`users`, `tickets`, `shifts`, `expenses`, `audit_logs`) MUST be written to `sync_outbox` in the exact same database transaction.
- **Idempotency Keys**: All outbox payloads use client-generated UUID primary keys (`id`) to ensure 100% replay-safe idempotent upserts on Supabase Postgres backend.
- **Background Outbox Worker**: Polling worker (5s interval when online) drains `sync_outbox` to Supabase without blocking the main UI thread.

## 4. CODE ARCHITECTURE & STYLING
- **Component-Based Architecture**: Modular organization (`src/components/`, `src/store/`, `src/services/`, `src/hooks/`, `src/types/`, `src/utils/`, `src/tests/`).
- **Light Mode POS Aesthetics**: High-contrast light slate theme (`#f8fafc` background, `#ffffff` panels, `#e2e8f0` borders, `#0f172a` typography, `#f59e0b` amber accents, `#10b981` status badges).
- **Strict 90-Degree Zero Radius (`rounded-none`)**: NO rounded corners on any elements — crisp industrial POS edges across all cards, modals, buttons, and ticket stubs.

## 5. MANDATORY DEEP END-TO-END FUNCTIONAL TESTING RULE
- **Complete End-to-End Life-Cycle Verification**: When testing a feature or bug fix, verifying UI rendering or page navigation alone is NOT sufficient. You MUST verify the complete end-to-end functional lifecycle down to the final target outcome (e.g. for password/PIN resets: verify credential update in database, verify old password/PIN is rejected, and verify logging in with the new password/PIN authenticates the user and hydrates their session).

## 6. MANDATORY BUG DOCUMENTATION RULE
- **Log Every Bug You Fix**: Whenever a bug is found and fixed, add an entry to `BUGFIXES.md` (project root) before considering the work done. This applies whether the bug was reported by the user or discovered while working on something else.
- **What to write**: what broke, what the user actually saw, the root cause, the fix, and the file(s) touched. Written so someone with no memory of this conversation can understand it later.
- **Why this rule exists**: so the same bug never gets silently reintroduced or re-debugged from scratch months later.
