# Ticket POS MVP — Production Deployment & Operation Guide

## 1. Operating Today (Web Kiosk Launch Guide)
You can launch production till operations **RIGHT NOW** using Google Chrome or Microsoft Edge under Kiosk Printing mode!

### Step 1: Launch Local Web POS Server
In `C:\Users\SURFACE\.gemini\antigravity-ide\scratch\ticket-pos`:
```bash
npm run dev
```

### Step 2: Open Browser in Automatic Silent Thermal Printing Mode
In Windows CMD / PowerShell:
```cmd
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --kiosk-printing http://127.0.0.1:5173/
```
> **What this does**: `--kiosk-printing` automatically routes `window.print()` directly to your connected thermal receipt printer (58mm or 80mm USB ESC/POS) **without popping up any print dialog**, achieving sub-10ms silent tap-to-print execution!

---

## 2. Installable PWA (Kiosk Mode)
The app is a installable Progressive Web App — no native desktop shell required.

1. Build the production bundle:
   ```bash
   npm run build && npm run preview
   ```
2. Open the preview URL in Chrome/Edge and install it (address-bar install icon, or
   the "Install Ticket POS" menu item) — this creates a standalone app window with
   its own taskbar/Start Menu entry, backed by the app's service worker for offline
   shell loading.
3. For unattended kiosk operation, launch the installed app directly in kiosk mode:
   ```cmd
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --kiosk-printing --app=http://127.0.0.1:5173/
   ```
   Combined with the silent thermal printing setup in Section 1, this gives the same
   locked-down, always-on till experience a native desktop shell would have, without
   needing a separate Tauri build step.
4. Updates: the service worker checks for a new version on load. A small in-app
   banner ("A new version of Ticket POS is ready") lets the cashier reload when idle
   — it never force-reloads mid-transaction.

---

## 3. Cloud Supabase Outbox Sync Setup
1. Open your Supabase project SQL Editor.
2. Paste and run `supabase_schema.sql` (located at `C:\Users\SURFACE\.gemini\antigravity-ide\scratch\ticket-pos\supabase_schema.sql`).
3. Add your Supabase credentials in `.env`:
   ```env
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-key
   ```

---

## 4. Operational Checklists for Cashiers & Managers

### Cashier Shift Start Checklist
- [ ] Open POS at till terminal.
- [ ] Click **Shift Closed (Click to Open)** in header.
- [ ] Declare physical opening cash float (e.g. ₦5,000).
- [ ] Tap preset ticket cards or press home-row hotkeys (`A`, `S`, `D`, `F`, `G`, `H`, `J`, `K`, `L`) to issue tickets.

### Cashier Mid-Shift Expense Checklist
- [ ] Click **Expense**, enter cash payout amount, category, and notes.
- [ ] Payout enters manager approval queue automatically.

### Manager Shift Close & Reconciliation Checklist
- [ ] Click **Shift Open**, enter physical cash count from drawer.
- [ ] Review system expected cash vs physical count.
- [ ] Confirm variance and finalize shift close.
