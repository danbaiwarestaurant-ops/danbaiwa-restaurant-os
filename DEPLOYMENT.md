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

## 2. Desktop Shell Build (Tauri v2 Native .exe)
To package as an isolated Windows `.exe` desktop application:
1. Initialize Tauri:
   ```bash
   npx @tauri-apps/cli init
   ```
2. Build standalone executable:
   ```bash
   npx tauri build
   ```

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
