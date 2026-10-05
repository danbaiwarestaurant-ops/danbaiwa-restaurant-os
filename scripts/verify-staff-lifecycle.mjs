import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const origin = process.env.STAFF_QA_URL || 'http://127.0.0.1:5185';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', dialog => dialog.accept());
async function waitFor(fn, arg = null) {
  const end = Date.now() + 30000;
  while (!await page.evaluate(fn, arg)) {
    if (Date.now() > end) throw new Error('Condition did not finish: ' + fn);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function navigate(name) {
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
}
try {
  await page.goto(origin);
  assert.equal(await page.evaluate(async () => (await import('/src/services/supabase/supabaseClient.ts')).isSupabaseConfigured), false);
  await page.getByRole('button', { name: 'Create Account', exact: true }).click();
  for (const [i, value] of ['Statement Owner', 'statement@example.test', 'QaPassword!246', '9876'].entries()) await page.locator('form input').nth(i).fill(value);
  await page.getByRole('button', { name: /create account & log in/i }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  await navigate('Staff Management');
  await page.getByRole('tab', { name: 'Team & access', exact: true }).click();
  const form = page.locator('form').filter({ hasText: 'Add Staff Member' });
  for (const [name, username, role, pin] of [['Statement Cashier', 'qa-cashier', 'cashier', '2468'], ['Statement Server', 'qa-server', 'server', '3579']]) {
    await form.getByPlaceholder('e.g. Sarah Connor').fill(name);
    await form.locator('input[type=text]').nth(1).fill(username);
    await form.locator('select').selectOption(role);
    await form.getByPlaceholder('Custom PIN').fill(pin);
    await form.getByRole('button', { name: 'Create Account', exact: true }).click();
    await page.locator('tr').filter({ hasText: name }).first().waitFor();
  }
  const ids = await page.evaluate(async () => {
    const auth = (await import('/src/store/useAuthStore.ts')).useAuthStore.getState();
    const cashier = auth.users.find(u => u.username === 'qa-cashier');
    const { useWorkforceStore } = await import('/src/store/useWorkforceStore.ts');
    const { businessDayKey } = await import('/src/utils/shiftDay.ts');
    const device = (await import('/src/store/useDeviceStore.ts')).useDeviceStore.getState();
    const day = businessDayKey(new Date(), device.config.businessDayStartHour);
    await useWorkforceStore.getState().saveConfig('cashier', 'tickets', 10);
    await useWorkforceStore.getState().saveAssessment(cashier, day, 100,
      [{ id: crypto.randomUUID(), kind: 'fixed', label: 'Late arrival', value: 100 }],
      [{ id: crypto.randomUUID(), label: 'Service bonus', value: 200 }], 'Verified shift');
    await useWorkforceStore.getState().finalizeDay(day);
    await useWorkforceStore.getState().addLedgerEntry(cashier, 'payment', 400, 'Advance payment', day);
    await useWorkforceStore.getState().addLedgerEntry(cashier, 'manual_adjustment', -100, 'Staff meal deduction: extra meal', day);
    const { dbService } = await import('/src/services/db/IndexedDbService.ts');
    await dbService.saveTicket({ id: 'QA-HISTORICAL-SALE', cashierId: cashier.id, accountId: cashier.accountId,
      createdAt: new Date().toISOString(), amount: 500, tender: 'cash', status: 'paid', currency: 'N', qrPayload: 'q' });
    const period = (await import('/src/store/useConsolePeriodStore.ts')).useConsolePeriodStore.getState().period;
    await dbService.saveTicket({ id: 'QA-PREVIOUS-PERIOD', cashierId: cashier.id, accountId: cashier.accountId,
      createdAt: new Date(period.start.getTime() - 86400000).toISOString(), amount: 600, tender: 'cash', status: 'paid', currency: 'N', qrPayload: 'q' });
    await (await import('/src/store/useTicketStore.ts')).useTicketStore.getState().loadTickets();
    return { cashier: cashier.id, owner: auth.activeUser.id };
  });
  await page.getByRole('tab', { name: 'Balances & payments', exact: true }).click();
  let row = page.locator('tr').filter({ hasText: 'Statement Cashier', has: page.getByRole('button', { name: 'Salary breakdown', exact: true }) });
  await row.getByRole('button', { name: 'Salary breakdown', exact: true }).click();
  let statement = page.getByLabel('Statement Cashier salary statement', { exact: true });
  for (const label of ['Opening balance', 'Base earnings', 'Performance bonuses', 'Meal deductions', 'Payments', 'Closing balance', 'Late arrival', 'Service bonus', 'Advance payment']) assert((await statement.innerText()).toLowerCase().includes(label.toLowerCase()), 'Missing salary detail: ' + label);
  assert.match(await statement.innerText(), /1,000/);
  assert.match(await statement.innerText(), /600/);
  await page.locator('tr').filter({ hasText: 'Statement Cashier', has: page.getByRole('button', { name: 'Record payment', exact: true }) }).getByRole('button', { name: 'Record payment', exact: true }).click();
  await page.getByLabel('Amount', { exact: true }).fill('200');
  await page.getByLabel('Mandatory reason', { exact: true }).fill('UI settlement');
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await statement.getByText('UI settlement', { exact: true }).waitFor();
  await waitFor(async () => (await import('/src/store/useWorkforceStore.ts')).useWorkforceStore.getState().ledger.some(r => r.note === 'UI settlement' && r.amount === 200));
  await navigate('Sales Record Book');
  assert.deepEqual(await page.getByLabel('Filter by cashier', { exact: true }).locator('option').allTextContents(), ['All Cashiers', 'Statement Cashier']);
  await page.getByLabel('Filter by cashier', { exact: true }).selectOption(ids.cashier);
  await page.getByText('#QA-HISTORICAL-SALE', { exact: true }).waitFor();
  assert.equal(await page.getByText('#QA-PREVIOUS-PERIOD', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Previous month', exact: true }).click();
  await page.getByText('#QA-PREVIOUS-PERIOD', { exact: true }).waitFor();
  assert.equal(await page.getByText('#QA-HISTORICAL-SALE', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'This Month', exact: true }).click();
  await page.getByText('#QA-HISTORICAL-SALE', { exact: true }).waitFor();
  await navigate('Staff Management');
  await page.getByRole('tab', { name: 'Team & access', exact: true }).click();
  await page.locator('tr').filter({ hasText: 'Statement Cashier', has: page.getByRole('button', { name: 'Delete', exact: true }) }).getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByLabel('Type Statement Cashier to confirm', { exact: true }).fill('Statement Cashier');
  await page.getByRole('button', { name: 'Delete Permanently', exact: true }).click();
  await waitFor(async id => !(await (await import('/src/services/db/dexieSchema.ts')).db.users.get(id)), ids.cashier);
  assert.equal(await page.locator('tr').filter({ hasText: 'Statement Cashier', has: page.getByRole('button', { name: 'Delete', exact: true }) }).count(), 0);
  await page.getByRole('tab', { name: 'Balances & payments', exact: true }).click();
  await page.locator('tr').filter({ hasText: 'Statement Cashier', has: page.getByRole('button', { name: 'Salary breakdown', exact: true }) }).getByRole('button', { name: 'Salary breakdown', exact: true }).click();
  statement = page.getByLabel('Statement Cashier salary statement', { exact: true });
  await statement.getByText(/Deleted staff/i).waitFor();
  assert.match(await statement.innerText(), /400/);
  await page.reload();
  await navigate('Sales Record Book');
  await page.getByLabel('Filter by cashier', { exact: true }).selectOption(ids.cashier);
  await page.getByText('#QA-HISTORICAL-SALE', { exact: true }).waitFor();
  const remaining = await page.evaluate(async id => {
    const { db } = await import('/src/services/db/dexieSchema.ts');
    const { dbService } = await import('/src/services/db/IndexedDbService.ts');
    return { sale: !!await db.tickets.get('QA-HISTORICAL-SALE'), wages: await db.staffAssessments.where('staffId').equals(id).count(),
      ledger: await db.wageLedger.where('staffId').equals(id).count(), lookup: (await dbService.findUsersByLoginKey('qa-cashier')).length };
  }, ids.cashier);
  assert.deepEqual(remaining, { sale: true, wages: 1, ledger: 3, lookup: 0 });
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Log Out', exact: true }).click();
  await page.getByRole('button', { name: 'Admin / email or staff ID sign-in', exact: true }).waitFor();
  await page.locator('form input[type=password]').fill('2468');
  await page.getByRole('button', { name: /log in to terminal/i }).click();
  await waitFor(async () => (await import('/src/store/useAuthStore.ts')).useAuthStore.getState().failedAttempts > 0);
  assert.equal(await page.evaluate(async () => (await import('/src/store/useAuthStore.ts')).useAuthStore.getState().isAuthenticated), false);
  assert.deepEqual(errors, []);
  console.log('PASS: real signup, staff creation, finalized wage/bonus/penalty breakdown, UI settlement, cashier-only filter, permanent deletion with history, retained salary/sales attribution after refresh, and deleted PIN rejected.');
} catch (error) { console.error((await page.locator('body').innerText()).slice(-6500)); throw error; }
finally { await browser.close(); }
