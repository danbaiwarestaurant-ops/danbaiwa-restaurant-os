import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const origin = process.env.MEAL_QA_URL || 'http://127.0.0.1:5182';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Lagos' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
await context.route('http://127.0.0.1:9100/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, version: 4 }), headers: { 'Access-Control-Allow-Origin': '*' } }));
async function waitFor(predicate, arg = null) {
  const deadline = Date.now() + 30000;
  while (!(await page.evaluate(predicate, arg))) {
    if (Date.now() > deadline) throw new Error('Condition timed out: ' + predicate.toString().slice(0, 160));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function navigate(name) {
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
}
async function setAllowance(name, limit) {
  await page.locator('tr').filter({ hasText: name }).getByRole('button', { name: 'Edit', exact: true }).click();
  const form = page.locator('form').filter({ has: page.getByLabel('Free meals per business day', { exact: true }) });
  await form.getByLabel('Free meals per business day', { exact: true }).fill(String(limit));
  await form.getByRole('button', { name: /save changes/i }).click();
  await waitFor(async ({ name, limit }) => (await import('/src/store/useAuthStore.ts')).useAuthStore.getState().users.some(user => user.name === name && user.dailyFoodCountLimit === limit), { name, limit });
}
async function issue(name) {
  await page.getByRole('button', { name: 'Staff Meal', exact: true }).click();
  await waitFor(() => Array.from(document.querySelectorAll('select option')).some(option => option.textContent.includes('Meal Cashier (Cashier)') && !option.textContent.includes('Loading')));
  const option = page.getByRole('option').filter({ hasText: name });
  const id = await option.getAttribute('value');
  await page.getByLabel('Employee', { exact: false }).selectOption(id);
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: /print meal ticket/i }).click();
  await page.getByLabel('Employee', { exact: false }).waitFor({ state: 'hidden' });
}
try {
  await page.clock.install({ time: new Date('2026-10-05T07:30:00+01:00') });
  await page.goto(origin);
  assert.equal(await page.evaluate(async () => (await import('/src/services/supabase/supabaseClient.ts')).isSupabaseConfigured), false);
  await page.getByRole('button', { name: 'Create Account', exact: true }).click();
  for (const [i, value] of ['Meal Owner', 'meal-owner@example.test', 'TestPassword!234', '9876'].entries()) await page.locator('form input').nth(i).fill(value);
  await page.getByRole('button', { name: /create account & log in/i }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  await navigate('Staff Management');
  await page.getByRole('tab', { name: /team & access/i }).click();
  const create = page.locator('form').filter({ hasText: 'Add Staff Member' });
  for (const [name, username, role, pin, allowance] of [['Meal Cashier', 'meal-cashier', 'cashier', '2468', 2], ['Meal Cook', 'meal-cook', 'kitchen', '3579', 0]]) {
    await create.getByPlaceholder('e.g. Sarah Connor').fill(name);
    await create.locator('input[type=text]').nth(1).fill(username);
    await create.locator('select').selectOption(role);
    await create.getByPlaceholder('Custom PIN').fill(pin);
    await create.getByRole('button', { name: 'Create Account', exact: true }).click();
    await page.getByText(name, { exact: true }).first().waitFor();
    await setAllowance(name, allowance);
  }
  await navigate('Settings');
  await page.getByLabel('Starting day of week', { exact: true }).selectOption('0');
  await page.getByLabel('Starting hour of day', { exact: true }).selectOption('8');
  await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
  await page.getByText(/Saved.*syncing to your other devices/i).waitFor();
  await navigate('Overview');
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  await waitFor(async () => {
    const period = (await import('/src/store/useConsolePeriodStore.ts')).useConsolePeriodStore.getState().period;
    return period.start.getDate() === 4 && period.start.getHours() === 8 && period.end.getDate() === 5;
  });
  await navigate('Settings');
  await page.reload();
  await page.getByLabel('Starting hour of day', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Starting hour of day', { exact: true }).inputValue(), '8');
  assert.equal(await page.getByLabel('Starting day of week', { exact: true }).inputValue(), '0');
  await navigate('Server Performance');
  assert.equal(await page.locator('input[type=date]').inputValue(), '2026-10-04');
  await navigate('Staff Management');
  assert.equal(await page.locator('input[type=date]').inputValue(), '2026-10-04');
  await page.getByRole('tab', { name: /team & access/i }).click();
  await page.locator('tr').filter({ hasText: 'Meal Cashier' }).getByText('2', { exact: true }).waitFor();
  await page.locator('tr').filter({ hasText: 'Meal Cook' }).getByText('0', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Log Out', exact: true }).click();
  await page.locator('form input[type=password]').fill('2468');
  await page.getByRole('button', { name: /log in to terminal/i }).click();
  await page.getByRole('button', { name: 'Staff Meal', exact: true }).waitFor();

  await issue('Meal Cashier (Cashier)');
  await page.getByRole('button', { name: 'Staff Meal', exact: true }).click();
  await page.getByRole('option', { name: /Meal Cashier \(Cashier\).*1\/2 meals.*1 left/ }).waitFor({ state: 'attached' });
  await page.getByRole('option', { name: /Meal Cook \(Kitchen Staff\).*0\/0 meals.*0 left/ }).waitFor({ state: 'attached' });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await issue('Meal Cashier (Cashier)');
  await issue('Meal Cashier (Cashier)');
  const charged = await page.evaluate(async () => {
    const { db } = await import('/src/services/db/dexieSchema.ts');
    const tickets = await db.tickets.toArray(), ledger = await db.wageLedger.toArray();
    return { count: tickets.length, deductions: tickets.map(ticket => ticket.staffMealWageDeduction).sort(), ledger: ledger.map(row => ({ amount: row.amount, day: row.businessDay })) };
  });
  assert.deepEqual(charged, { count: 3, deductions: [0, 0, 500], ledger: [{ amount: -500, day: '2026-10-04' }] });
  await page.getByRole('button', { name: 'Staff Meal', exact: true }).click();
  await page.getByRole('option', { name: /Meal Cashier \(Cashier\).*3\/2 meals.*0 left/ }).waitFor({ state: 'attached' });
  await page.clock.setSystemTime(new Date('2026-10-05T08:00:00+01:00'));
  await page.clock.runFor(1100);
  const fresh = page.getByRole('option', { name: /Meal Cashier \(Cashier\).*0\/2 meals.*2 left/ });
  await fresh.waitFor({ state: 'attached' });
  await page.getByLabel('Employee', { exact: false }).selectOption(await fresh.getAttribute('value'));
  await mkdir('artifacts/meal-calendar-qa', { recursive: true });
  await page.screenshot({ path: 'artifacts/meal-calendar-qa/counter.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: real registration; per-person allowances 2 and 0 persist; weekday/hour settings persist; reports and daily forms use the previous trading day before 08:00; all employee counters update; third meal charges once to the correct wage day; open form resets counters at 08:00.');
} catch (error) { console.error((await page.locator('body').innerText()).slice(-6000)); throw error; }
finally { await browser.close(); }
