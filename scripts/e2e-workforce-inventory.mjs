import { chromium } from 'playwright';

const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:4173';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

try {
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.waitForFunction(async () => {
    const databases = await indexedDB.databases();
    if (!databases.some((d) => d.name === 'ticket_pos_dexie_v1')) return false;
    return await new Promise((resolve) => {
      const request = indexedDB.open('ticket_pos_dexie_v1');
      request.onsuccess = () => {
        const ready = request.result.objectStoreNames.contains('users');
        request.result.close();
        resolve(ready);
      };
      request.onerror = () => resolve(false);
    });
  });
  await page.evaluate(async () => {
    const salt = '00112233445566778899aabbccddeeff';
    const hashPin = async (pin) => {
      const bytes = new TextEncoder().encode(`danbaiwa_pos_salt_${salt}_secret_${pin}`);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    const hash = await hashPin('2468');
    const serverHash = await hashPin('1357');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('ticket_pos_dexie_v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction('users', 'readwrite');
    const users = tx.objectStore('users');
    users.put({ id: '11111111-1111-4111-8111-111111111111', name: 'E2E Manager', email: 'e2e@example.test', username: 'e2e@example.test', pinHash: hash, pinSalt: salt, role: 'admin', createdAt: new Date().toISOString(), status: 'active', loginKeys: ['e2e@example.test'] });
    users.put({ id: '22222222-2222-4222-8222-222222222222', name: 'Test Server', email: 'server-e2e', username: 'server-e2e', pinHash: serverHash, pinSalt: salt, role: 'server', createdAt: new Date().toISOString(), status: 'active', loginKeys: ['server-e2e'] });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByPlaceholder('Enter PIN').fill('2468');
  await page.getByRole('button', { name: /Log In to Terminal/i }).click();
  await page.waitForTimeout(500);
  if (!(await page.getByRole('button', { name: /Manager Mode/i }).count())) console.log(await page.locator('body').innerText());
  await page.getByRole('button', { name: /Manager Mode/i }).waitFor();
  await page.getByRole('button', { name: /Manager Mode/i }).click();
  await page.keyboard.type('2468');
  await page.getByRole('heading', { name: /Overview/i }).waitFor();

  await page.getByRole('button', { name: /Staff Management/i }).click();
  await page.getByRole('tab', { name: 'Wage configuration' }).click();
  await page.getByText('Wage Configuration', { exact: true }).waitFor();
  const configRow = page.locator('tr').filter({ hasText: 'Server / Waiter' }).filter({ has: page.locator('input') }).first();
  const configInputs = configRow.locator('input');
  await configInputs.nth(1).fill('200');
  await configRow.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByLabel('Outstanding sales fixed reward').fill('500');

  await page.getByRole('button', { name: 'Inventory', exact: true }).click();
  await page.getByRole('tab', { name: 'Ingredient setup' }).click();
  await page.locator('h2').filter({ hasText: 'Add Ingredient' }).waitFor();
  const addPanel = page.locator('section').filter({ hasText: 'Add Ingredient' });
  const addInputs = addPanel.locator('input');
  await addInputs.nth(0).fill('Rice');
  await addInputs.nth(1).fill('mudu');
  await addInputs.nth(2).fill('pot');
  await addInputs.nth(3).fill('20');
  await addInputs.nth(4).fill('10');
  await addInputs.nth(5).fill('cooler');
  await addInputs.nth(6).fill('5');
  await addInputs.nth(7).fill('72000');
  await addInputs.nth(8).fill('18000');
  await addInputs.nth(9).fill('7000');
  await addInputs.nth(10).check();
  await addPanel.getByRole('button', { name: 'Add Ingredient' }).click();

  await page.getByRole('tab', { name: 'Record activity' }).click();
  const activity = page.locator('section').filter({ hasText: 'Record Stock Activity' });
  let inputs = activity.locator('input');
  await inputs.nth(0).fill('3');
  await inputs.nth(1).fill('72000');
  await inputs.nth(2).fill('E2E Supplier');
  await activity.getByRole('button', { name: 'Record Activity' }).click();
  await page.getByRole('tab', { name: 'Stock & alerts' }).click();
  await page.getByText(/60 mudu/).first().waitFor();
  await page.getByText(/216,000/).first().waitFor();

  await page.getByRole('tab', { name: 'Record activity' }).click();
  await activity.locator('select').nth(1).selectOption('usage');
  inputs = activity.locator('input');
  await inputs.nth(0).fill('10');
  await inputs.nth(1).fill('Dinner service');
  await activity.getByRole('button', { name: 'Record Activity' }).click();
  await page.getByRole('tab', { name: 'Stock & alerts' }).click();
  await page.getByText(/50 mudu/).first().waitFor();

  await page.getByRole('tab', { name: 'Record activity' }).click();
  await activity.locator('select').nth(1).selectOption('count');
  inputs = activity.locator('input');
  await inputs.nth(0).fill('45');
  await inputs.nth(1).fill('Physical count');
  await activity.getByRole('button', { name: 'Record Activity' }).click();
  await page.getByRole('tab', { name: 'Stock & alerts' }).click();
  await page.getByText(/45 mudu/).first().waitFor();
  await page.getByRole('tab', { name: 'Movement history' }).click();
  await page.getByText(/Variance -5 mudu/i).waitFor();

  await page.getByRole('button', { name: /Staff Management/i }).click();
  await page.getByRole('tab', { name: 'Daily performance' }).click();
  const assessmentRow = page.locator('tr').filter({ hasText: 'Test Server' }).filter({ has: page.locator('input') }).first();
  await assessmentRow.getByLabel('Test Server Rice').fill('7');
  await assessmentRow.getByLabel('Test Server money gathered').fill('180000');
  await assessmentRow.locator('input[type="number"]').nth(2).fill('100');
  await assessmentRow.getByText(/Outstanding sales/).locator('input[type="checkbox"]').check();
  await page.getByText(/Actual profit contribution/i).waitFor();
  await page.getByText(/54,000/).first().waitFor();
  await page.getByText(/5,000/).first().waitFor();
  await page.getByRole('button', { name: 'Save Drafts' }).click();
  await page.getByText(/assessment saved as draft/i).waitFor();
  await page.getByRole('button', { name: /Finalize Day/i }).click();
  await page.getByText(/finalized/i).last().waitFor();
  await page.getByText(/1,800/).first().waitFor();

  await page.getByRole('tab', { name: 'Performance reports' }).click();
  await page.getByText('Staff Performance Report', { exact: true }).waitFor();
  const performancePanel = page.locator('section').filter({ has: page.getByText('Staff Performance Report', { exact: true }) });
  const performanceRow = performancePanel.locator('tr').filter({ hasText: 'Test Server' }).first();
  await performanceRow.getByText(/Outstanding sales/).waitFor();
  await performanceRow.getByText(/1,800/).waitFor();

  await page.getByRole('button', { name: 'Server Performance', exact: true }).click();
  await page.getByText(/175,000/).first().waitFor();
  await page.getByText(/5,000/).first().waitFor();
  const persistedServerResult = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('ticket_pos_dexie_v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise((resolve, reject) => {
      const request = db.transaction('serverSales').objectStore('serverSales').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const row = rows.find((entry) => entry.serverId === '22222222-2222-4222-8222-222222222222');
    return row && { expected: row.expectedSalesValue, gathered: row.moneyGathered, variance: row.variance, actualProfit: row.actualProfitContribution, rice: row.itemVolumes?.[0]?.quantity };
  });
  if (JSON.stringify(persistedServerResult) !== JSON.stringify({ expected: 175000, gathered: 180000, variance: 5000, actualProfit: 54000, rice: 7 })) throw new Error(`Server result was not persisted correctly: ${JSON.stringify(persistedServerResult)}`);
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await page.getByText(/Item volumes, collections, and variance for/i).waitFor();
  await page.getByText(/5,000/).first().waitFor();
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await page.getByText(/5,000/).first().waitFor();

  await page.getByRole('button', { name: 'Audit Log', exact: true }).click();
  await page.getByLabel('Search audit log').fill('assessment');
  await page.getByRole('table').getByText('CREATE_ASSESSMENT', { exact: true }).waitFor();
  await page.getByLabel('Filter audit entity').selectOption('staff_assessment');
  await page.getByRole('table').getByText('FINALIZE_ASSESSMENT', { exact: true }).waitFor();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Starting day of week').selectOption('0');
  await page.getByRole('button', { name: 'Save Settings' }).click();
  await page.getByText(/Saved/i).waitFor();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  const sundayWeekLabel = await page.evaluate(() => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - start.getDay());
    const end = new Date(start); end.setDate(end.getDate() + 6);
    return `${start.getDate()} ${months[start.getMonth()]} – ${end.getDate()} ${months[end.getMonth()]} ${end.getFullYear()}`;
  });
  await page.getByText(sundayWeekLabel, { exact: true }).waitFor();

  console.log('E2E PASS: itemized performance, configurable rewards, staff period reports, audit filters, and configurable week start all completed.');
} finally {
  await browser.close();
}
