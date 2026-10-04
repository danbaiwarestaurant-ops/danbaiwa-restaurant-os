import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

// Run against a local Vite server with placeholder Supabase settings, never live data.
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('dialog', dialog => dialog.accept());
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await mkdir('artifacts/mobile-qa', { recursive: true });
async function navigate(name) {
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
}
async function fits(name) {
  const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  assert(size.content <= size.width + 1, name + ' overflows phone viewport: ' + JSON.stringify(size));
}
try {
  await page.goto(process.env.MOBILE_QA_URL || 'http://127.0.0.1:5178');
  assert.equal(await page.evaluate(async () => (await import('/src/services/supabase/supabaseClient.ts')).isSupabaseConfigured), false, 'Use an isolated local server with cloud disabled');
  await page.getByRole('button', { name: 'Create Account', exact: true }).click();
  for (const [i, value] of ['Mobile Owner', 'mobile@example.com', 'TestPassword!234', '9876'].entries()) await page.locator('form input').nth(i).fill(value);
  await page.getByRole('button', { name: /create account & log in/i }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => (await import('/src/store/useShiftStore.ts')).useShiftStore.getState().currentShift), null);
  await fits('Overview');
  await page.screenshot({ path: 'artifacts/mobile-qa/overview.png', fullPage: true });

  await navigate('Staff Management');
  await page.getByRole('tab', { name: /team & access/i }).click();
  const createForm = page.locator('form').filter({ hasText: 'Add Staff Member' });
  await createForm.getByPlaceholder('e.g. Sarah Connor').fill('Mobile Cashier');
  await createForm.locator('input[type=text]').nth(1).fill('mobile-cashier');
  await createForm.getByPlaceholder('Custom PIN').fill('2468');
  await createForm.getByRole('button', { name: 'Create Account', exact: true }).click();
  const row = page.locator('tr').filter({ hasText: 'Mobile Cashier' });
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const editForm = page.locator('form').filter({ has: page.locator('input[value="Mobile Cashier"]') });
  await editForm.locator('input[type=number]').fill('2');
  await editForm.getByRole('button', { name: /save/i }).click();
  await page.waitForFunction(async () => (await import('/src/store/useAuthStore.ts')).useAuthStore.getState().users.some(u => u.name === 'Mobile Cashier' && u.dailyFoodCountLimit === 2));
  await createForm.getByPlaceholder('e.g. Sarah Connor').fill('Mobile Server');
  await createForm.locator('input[type=text]').nth(1).fill('mobile-server');
  await createForm.locator('select').selectOption('server');
  await createForm.getByPlaceholder('Custom PIN').fill('3579');
  await createForm.getByRole('button', { name: 'Create Account', exact: true }).click();
  await page.getByText('Mobile Server', { exact: true }).first().waitFor();
  await fits('Staff directory');
  await page.screenshot({ path: 'artifacts/mobile-qa/staff.png', fullPage: true });

  await navigate('Inventory');
  await page.getByRole('tab', { name: 'Ingredient setup', exact: true }).click();
  const form = page.locator('form');
  for (const [label, value] of [['Ingredient name', 'QA Rice'], ['Base unit', 'kg'], ['Purchase unit', 'bag'], ['Base units per purchase unit', '50'], ['Reorder level (base units)', '5'], ['Kitchen cooking unit', 'pot'], ['Base units per cooking unit', '10'], ['Server sales unit', 'cooler'], ['Base units per sales unit', '5'], ['Standard purchase cost', '50000'], ['Preparation cost per cooking unit', '12000'], ['Profit per cooking unit', '2000']]) await form.getByLabel(label, { exact: true }).fill(value);
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: /add ingredient/i }).click();
  await page.waitForFunction(async () => (await import('/src/store/useInventoryStore.ts')).useInventoryStore.getState().items.some(i => i.name === 'QA Rice' && i.baseUnitsPerCookingUnit === 10));
  await fits('Inventory');
  await page.screenshot({ path: 'artifacts/mobile-qa/inventory.png', fullPage: true });

  await page.getByRole('tab', { name: 'Record activity', exact: true }).click();
  await page.getByLabel('Quantity (bag)', { exact: true }).fill('2');
  await page.getByLabel('Cost per bag', { exact: true }).fill('50000');
  await page.getByRole('button', { name: 'Record Activity', exact: true }).click();
  await page.waitForFunction(async () => (await import('/src/store/useInventoryStore.ts')).useInventoryStore.getState().batches.length > 0);
  await page.getByLabel('Activity', { exact: true }).selectOption('usage');
  await page.getByLabel('Quantity unit', { exact: true }).selectOption('cooking');
  await page.getByLabel('Quantity (pot)', { exact: true }).fill('1');
  await page.getByLabel('Reason / note', { exact: true }).fill('Kitchen QA production');
  await page.getByRole('button', { name: 'Record Activity', exact: true }).click();
  await page.waitForFunction(async () => (await import('/src/store/useInventoryStore.ts')).useInventoryStore.getState().batches.reduce((n, b) => n + b.remainingQuantityBase, 0) === 90);
  await navigate('Server Performance');
  await page.getByLabel('Mobile Server QA Rice', { exact: true }).fill('2');
  await page.getByLabel('Mobile Server money gathered', { exact: true }).fill('28000');
  await page.getByRole('button', { name: 'Save all', exact: true }).click();
  await page.waitForFunction(async () => (await import('/src/store/useServerSalesStore.ts')).useServerSalesStore.getState().entries.some(e => e.totalCost === 24000 && e.expectedSalesValue === 28000 && e.itemVolumes[0].salesUnit === 'pot'));
  await page.screenshot({ path: 'artifacts/mobile-qa/server.png', fullPage: true });

  for (const view of ['Sales Record Book', 'Server Performance', 'Expenses', 'Shift Reconciliation', 'Reports & Analytics', 'Audit Log', 'Printer Setup', 'Settings']) {
    await navigate(view); for (const width of [320, 390, 768, 1280]) { await page.setViewportSize({ width, height: 844 }); await fits(view + ' at ' + width); }
    await page.setViewportSize({ width: 390, height: 844 }); console.log('Verified phone layout:', view);
  }
  await page.screenshot({ path: 'artifacts/mobile-qa/settings.png', fullPage: true });
  console.log('Beginning cashier lifecycle');
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Log Out', exact: true }).click();
  await page.getByRole('button', { name: 'Admin / email or staff ID sign-in', exact: true }).waitFor();
  await page.evaluate(async () => { (await import('/src/store/useAuthStore.ts')).useAuthStore.setState({ failedAttempts: 3, lockoutUntil: Date.now() + 1000 }); });
  await page.waitForFunction(() => document.querySelector('form button[type=submit]').disabled);
  await page.waitForFunction(() => !document.querySelector('form input[type=password]').disabled);
  await page.locator('form input[type=password]').fill('2468');
  await page.getByRole('button', { name: /log in to terminal/i }).click();
  await page.waitForFunction(async () => !!(await import('/src/store/useShiftStore.ts')).useShiftStore.getState().currentShift);
  const shiftId = await page.evaluate(async () => (await import('/src/store/useShiftStore.ts')).useShiftStore.getState().currentShift.id);
  await fits('Cashier till');
  await page.getByRole('button', { name: 'Staff Meal', exact: true }).click();
  await page.getByLabel('Employee', { exact: false }).selectOption({ label: 'Mobile Cashier (Cashier)' });
  await page.getByText(/remaining: 2/i).waitFor();
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: /print meal ticket/i }).click();
  await page.waitForFunction(async () => (await import('/src/store/useTicketStore.ts')).useTicketStore.getState().tickets.some(t => t.tender === 'staff'));
  await page.getByRole('button', { name: 'Staff Meal', exact: true }).click();
  await page.getByLabel('Employee', { exact: false }).selectOption({ label: 'Mobile Cashier (Cashier)' });
  await page.getByText(/remaining: 1/i).waitFor();
  await page.screenshot({ path: 'artifacts/mobile-qa/meal.png', fullPage: true });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Enter management through the cashier session and save the owner profile.
  await page.getByRole('button', { name: /manager/i }).click();
  for (const digit of ['9', '8', '7', '6']) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('heading', { name: /settings|overview/i }).first().waitFor();
  await navigate('Settings');
  const profile = page.locator('form').filter({ hasText: 'Admin Full Name' });
  await profile.locator('input[type=text]').fill('Mobile Owner Updated');
  await profile.getByRole('button', { name: /save admin profile/i }).click();
  await page.getByText(/admin profile saved successfully/i).waitFor();
  const session = await page.evaluate(async () => {
    const auth = (await import('/src/store/useAuthStore.ts')).useAuthStore.getState();
    const shifts = (await import('/src/store/useShiftStore.ts')).useShiftStore.getState();
    return { role: auth.activeUser.role, shift: shifts.currentShift.id };
  });
  assert.deepEqual(session, { role: 'cashier', shift: shiftId });
  assert.deepEqual(errors, []);
  console.log('PASS: real local signup, phone views, staff allowance edit, cooking unit creation, cashier shift, meal counter, and owner profile save without changing the cashier session.');
} catch (error) { console.error((await page.locator('body').innerText()).slice(-7000)); await page.screenshot({ path: 'artifacts/mobile-qa/failure.png', fullPage: true }); throw error; } finally { await browser.close(); }
