import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// Real signup/login/issuing UI with an isolated shared mock cloud. Never run
// against production: the app must be configured with https://sync.qa.invalid.
const origin = process.env.LIVE_SYNC_QA_URL || 'http://127.0.0.1:5183';
const account = '00000000-0000-4000-8000-000000000001';
const email = 'live-owner@example.test';
const cloud = new Map();
const sortedCloud = new Map();
let registered = false;
let qrRefusals = 0;
const legacyDevice = '00000000-0000-4000-8000-000000000002';
const errors = [];
let largeCatchUp;
let cloudCursor, cloudPageRequests = 0;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const owner = { id: account, email, role: 'authenticated', aud: 'authenticated', user_metadata: { role: 'admin', location_id: 'LOC01' }, identities: [{ id: account, provider: 'email' }] };
const session = (user = owner) => ({ access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.qa`, refresh_token: 'qa-refresh', expires_in: 3600, token_type: 'bearer', user });
const browser = await chromium.launch({ headless: true, ...(process.env.LIVE_SYNC_QA_BROWSER ? { channel: process.env.LIVE_SYNC_QA_BROWSER } : {}) });
const tillContext = await browser.newContext();
const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Lagos' });
async function setup(context) {
  // No live websocket is supplied, exercising the HTTP fallback independently.
  await context.routeWebSocket('wss://sync.qa.invalid/**', () => {});
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === origin) return route.continue();
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': 'Content-Range' };
    const send = (data, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.hostname === '127.0.0.1' && url.port === '9100') return send({ success: true, version: 4 });
    assert.equal(url.hostname, 'sync.qa.invalid', 'Unexpected external request');
    if (req.method() === 'OPTIONS') return send(null);
    if (url.pathname === '/auth/v1/signup') { registered = true; return send(session()); }
    if (url.pathname === '/auth/v1/token') return registered ? send(session()) : send({ msg: 'Invalid login credentials', code: 'invalid_credentials' }, 400);
    const token = req.headers().authorization?.replace(/^Bearer /, '');
    let authenticatedId = account;
    try { authenticatedId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub; } catch {}
    if (url.pathname === '/auth/v1/user') return send({ ...owner, id: authenticatedId });
    if (url.pathname.includes('/rpc/')) return send(url.pathname.endsWith('current_account_id') ? authenticatedId : null);
    const table = url.pathname.split('/').at(-1);
    if (table === 'tickets' && req.method() === 'GET' && url.searchParams.get('id')?.includes('LARGE-')) { cloudCursor = url.searchParams.get('id'); cloudPageRequests++; }
    if (table === 'account_devices') return url.searchParams.get('auth_user_id') === `eq.${legacyDevice}`
      ? send([{ account_id: account, status: 'active' }])
      : send({ code: 'PGRST205', message: 'QA enrolment unavailable' }, 404);
    const rows = cloud.get(table) || new Map(); cloud.set(table, rows);
    if (req.method() === 'POST') {
      const data = req.postDataJSON(), list = Array.isArray(data) ? data : [data];
      if (table === 'tickets' && list.some(row => !row.qr_payload)) {
        qrRefusals++;
        return send({ code: '23502', message: 'null value in column "qr_payload" of relation "tickets" violates not-null constraint' }, 400);
      }
      for (const row of list) rows.set(row.id || row.account_id, { ...row, updated_at: new Date().toISOString() });
      sortedCloud.clear();
      return send(null);
    }
    if (req.method() === 'GET') {
      const ordering = url.searchParams.get('order') || 'id.asc';
      const sortKey = table + ':' + ordering;
      let ordered = sortedCloud.get(sortKey);
      if (!ordered || ordered.size !== rows.size) {
        ordered = { size: rows.size, rows: [...rows.values()].sort((a, b) => {
          for (const term of ordering.split(',')) {
            const [key, direction] = term.split('.');
            const cmp = String(a[key]).localeCompare(String(b[key]));
            if (cmp) return direction === 'desc' ? -cmp : cmp;
          }
          return 0;
        }) };
        sortedCloud.set(sortKey, ordered);
      }
      const after = url.searchParams.get('id')?.replace(/^gt\./, '');
      let lo = 0, hi = ordered.rows.length;
      if (after) {
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (String(ordered.rows[mid].id) <= after) lo = mid + 1; else hi = mid; }
      }
      const result = [], conditions = [...url.searchParams], limit = Number(url.searchParams.get('limit') || 500);
      for (let i = lo; i < ordered.rows.length && result.length < limit; i++) {
        const row = ordered.rows[i];
        if (conditions.every(([key, condition]) => {
          if (condition.startsWith('eq.')) return String(row[key]) === condition.slice(3);
          if (condition.startsWith('lte.')) return String(row[key]) <= condition.slice(4);
          if (condition.startsWith('gte.')) return String(row[key]) >= condition.slice(4);
          if (condition.startsWith('gt.')) return String(row[key]) > condition.slice(3);
          return true;
        })) result.push(row);
      }
      return send(result);
    }
    return send(null);
  });
}
async function wait(page, predicate, arg = null) {
  const end = Date.now() + 120000;
  while (!await page.evaluate(predicate, arg)) {
    if (Date.now() > end) throw new Error('Condition timed out: ' + predicate.toString().slice(0, 200));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function nav(page, name) {
  const open = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await open.isVisible()) await open.click();
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
}
await setup(tillContext); await setup(phoneContext);
const till = await tillContext.newPage(), phone = await phoneContext.newPage();
for (const page of [till, phone]) { page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept()); }
try {
  await till.goto(origin);
  assert.equal(await till.evaluate(async () => (await import('/src/services/supabase/supabaseClient.ts')).SUPABASE_URL), 'https://sync.qa.invalid');
  await till.getByRole('button', { name: 'Create Account', exact: true }).click();
  for (const [i, val] of ['Live Owner', email, 'TestPassword!234', '9876'].entries()) await till.locator('form input').nth(i).fill(val);
  await till.getByRole('button', { name: /create account & log in/i }).click();
  await till.getByRole('checkbox').check(); await till.getByRole('button', { name: 'Continue', exact: true }).click();
  await till.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  await nav(till, 'Staff Management');
  await till.getByRole('tab', { name: /team & access/i }).click();
  const form = till.locator('form').filter({ hasText: 'Add Staff Member' });
  await form.getByPlaceholder('e.g. Sarah Connor').fill('Live Cashier');
  await form.locator('input[type=text]').nth(1).fill('live-cashier');
  await form.locator('select').selectOption('cashier');
  await form.getByPlaceholder('Custom PIN').fill('2468');
  await form.getByRole('button', { name: 'Create Account', exact: true }).click();
  await till.getByText('Live Cashier', { exact: true }).first().waitFor();
  await till.getByRole('button', { name: 'Account menu', exact: true }).click();
  await till.getByRole('menuitem', { name: 'Log Out', exact: true }).click();
  await till.locator('form input[type=password]').fill('2468');
  await till.getByRole('button', { name: /log in to terminal/i }).click();
  await till.getByRole('button', { name: 'Staff Meal', exact: true }).waitFor();
  await wait(till, async () => Boolean((await import('/src/store/useShiftStore.ts')).useShiftStore.getState().currentShift));
  const shift = await till.evaluate(async () => (await import('/src/store/useShiftStore.ts')).useShiftStore.getState().currentShift.id);
  await phone.goto(origin);
  await phone.locator('form input').nth(0).fill(email);
  await phone.locator('form input[type=password]').fill('9876');
  await phone.getByRole('button', { name: /log in to terminal/i }).click();
  await phone.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  await phoneContext.setOffline(true);
  await tillContext.setOffline(true);
  // Supplemental five-day backlog, alongside an actual new sale through the UI.
  await till.evaluate(async ({ account, legacyDevice }) => {
    const { db } = await import('/src/services/db/dexieSchema.ts');
    await db.config.put({ key: 'device_cloud_identity', value: { authUserId: legacyDevice, accountId: account, email: 'qa-till@example.test', password: 'test-only', enrolledAt: new Date().toISOString() } });
    const stamp = new Date(Date.now() - 5 * 86400000).toISOString();
    const rows = Array.from({ length: 210 }, (_, i) => ({ id: `OLD-${String(i).padStart(5, '0')}`, accountId: i < 203 ? legacyDevice : 'another-owner', locationId: 'LOC01', deviceId: 'OLD', localSeq: i, cashierId: 'historic', amount: 500, currency: 'N', status: 'paid', tender: 'cash', createdAt: stamp, updatedAt: stamp, qrPayload: 'old-qr' }));
    await db.transaction('rw', db.tickets, db.outbox, async () => {
      await db.tickets.bulkAdd(rows);
      await db.outbox.bulkAdd(rows.map(row => ({ id: crypto.randomUUID(), tableName: 'tickets', action: 'INSERT', payload: row, status: 'pending', retryCount: 8, lastError: 'Previous QR schema rejection', nextAttemptAt: new Date(Date.now() + 1800000).toISOString(), createdAt: stamp })));
    });
  }, { account, legacyDevice });
  await till.getByRole('button', { name: /500/ }).first().click();
  await wait(till, async () => (await import('/src/services/db/dexieSchema.ts')).db.tickets.count().then(n => n === 211));
  await tillContext.setOffline(false);
  await wait(till, async () => { const s = (await import('/src/store/useSyncStore.ts')).useSyncStore.getState(); return s.pendingCount === 7 && !s.isSyncing && s.queueFault?.reason.includes('another-owner'); });
  assert.equal(cloud.get('tickets').size, 204); assert.ok(qrRefusals > 0);
  const resumed = Date.now();
  await phoneContext.setOffline(false);
  await phone.evaluate(() => window.dispatchEvent(new Event('focus')));
  await wait(phone, async () => (await import('/src/store/useTicketStore.ts')).useTicketStore.getState().tickets.some(row => row.amount === 500 && !row.id.startsWith('OLD-')));
  const elapsed = Date.now() - resumed;
  const phoneState = await phone.evaluate(async () => ({ tickets: await (await import('/src/services/db/dexieSchema.ts')).db.tickets.count(), shift: (await import('/src/store/useShiftStore.ts')).useShiftStore.getState().currentShift, incoming: (await import('/src/store/useSyncStore.ts')).useSyncStore.getState().lastPulledAt }));
  assert.equal(phoneState.tickets, 204); assert.equal(phoneState.shift, null); assert.ok(phoneState.incoming);
  assert.equal(await till.evaluate(async () => (await import('/src/store/useShiftStore.ts')).useShiftStore.getState().currentShift.id), shift);
  await till.getByRole('button', { name: /Account Mismatch/ }).click();
  await till.getByRole('dialog', { name: 'Cloud sync details' }).getByText(/another-owner/).waitFor();
  await till.getByRole('button', { name: 'Close', exact: true }).click();
  await phone.getByRole('button', { name: /Cloud Checked|Cloud Live/ }).click();
  await phone.getByRole('dialog', { name: 'Cloud sync details' }).waitFor();
  await phone.getByText(/Last successful incoming check/).waitFor();
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('artifacts', { recursive: true });
  await phone.screenshot({ path: 'artifacts/live-sync-phone.png' });
  await phone.getByRole('button', { name: 'Close', exact: true }).click();
  if (process.env.LARGE_SYNC_QA === '1') {
    // Independently test the read path: all 150,000 rows already exist in cloud.
    // Retained account rejections stay on the till, not the receiving phone.
    await till.evaluate(async () => (await import('/src/services/db/realtimeSync.ts')).stopRealtimeSync());
    await phone.evaluate(async () => {
      (await import('/src/services/db/realtimeSync.ts')).stopRealtimeSync();
      const { db } = await import('/src/services/db/dexieSchema.ts');
      await db.config.delete('sync_watermarks');
      const { dbService } = await import('/src/services/db/IndexedDbService.ts');
      const original = dbService.getTicketsInPeriod.bind(dbService);
      window.periodReads = { calls: 0, rows: 0, milliseconds: 0 };
      const originalAdd = db.tickets.bulkAdd.bind(db.tickets);
      window.downloaded = 0;
      db.tickets.bulkAdd = async (...args) => { const result = await originalAdd(...args); window.downloaded += args[0].length; return result; };
      dbService.getTicketsInPeriod = async (...args) => {
        const start = performance.now(), rows = await original(...args);
        window.periodReads.calls++; window.periodReads.rows += rows.length;
        window.periodReads.milliseconds += performance.now() - start;
        return rows;
      };
    });
    await till.evaluate(async () => {
      const { db } = await import('/src/services/db/dexieSchema.ts');
      const stamp = new Date().toISOString();
      await db.outbox.bulkAdd(Array.from({ length: 193 }, (_, i) => ({ id: 'blocked-' + i, tableName: 'tickets', action: 'INSERT', payload: { id: 'other-record-' + i, accountId: 'another-owner' }, status: 'failed', retryCount: 8, lastError: 'Queued record belongs to another account', createdAt: stamp })));
    });
    console.log(JSON.stringify({ beforeLargeRead: await phone.evaluate(async () => ({ count: await (await import('/src/services/db/dexieSchema.ts')).db.tickets.count(), visibility: document.visibilityState })) }));
    const now = Date.now(), count = 150000;
    for (let i = 0; i < count; i++) {
      const stamp = new Date(now - 5 * 86400000 + Math.floor((i + 1) * 5 * 86400000 / count)).toISOString();
      const id = 'LARGE-' + String(i).padStart(7, '0');
      cloud.get('tickets').set(id, { id, account_id: account, location_id: 'LOC01', device_id: 'LOAD', local_seq: i, cashier_id: 'historic', amount: 100, currency: 'N', status: 'paid', tender: 'cash', created_at: stamp, updated_at: stamp, qr_payload: 'load-qr' });
    }
    const began = Date.now();
    await phone.evaluate(async () => {
      window.catchUpDone = false;
      (await import('/src/services/db/realtimeSync.ts')).runReconciliationPull({ recentFirst: true }).then(() => window.catchUpDone = true);
    });
    let newestRenderedMs = null, previousLog = 0;
    while (true) {
      const state = await phone.evaluate(async () => ({
        done: window.catchUpDone,
        newest: (await import('/src/store/useTicketStore.ts')).useTicketStore.getState().tickets.some(t => t.id === 'LARGE-0149999'),
        reads: window.periodReads, downloaded: window.downloaded
      }));
      const elapsed = Date.now() - began;
      if (state.newest && newestRenderedMs === null) newestRenderedMs = elapsed;
      if (elapsed - previousLog >= 5000) { console.log(JSON.stringify({ catchUpElapsedMs: elapsed, cloudCursor, cloudPageRequests, ...state })); previousLog = elapsed; }
      if (state.done) {
        state.count = await phone.evaluate(async () => (await import('/src/services/db/dexieSchema.ts')).db.tickets.count());
        assert.equal(state.count, count + 204);
        await phone.evaluate(async () => (await import('/src/store/useTicketStore.ts')).useTicketStore.getState().loadTickets());
        largeCatchUp = { cloudRecords: count, blockedOnTill: 200, localRecords: state.count, completeMs: elapsed, newestRenderedMs, reportReads: state.reads };
        console.log(JSON.stringify({ largeCatchUp })); break;
      }
      if (elapsed > 600000) throw new Error('150,000-record receiving-device catch-up exceeded ten minutes');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const allIds = await phone.evaluate(async () => (await import('/src/services/db/dexieSchema.ts')).db.tickets.orderBy('id').primaryKeys());
    assert.deepEqual(allIds, [...cloud.get('tickets').keys()].sort());
    assert.equal(await till.evaluate(async () => (await import('/src/services/db/IndexedDbService.ts')).dbService.countUnsyncedOutbox(false).then(s => s.total)), 200);
    assert.equal(await till.evaluate(async () => (await import('/src/store/useShiftStore.ts')).useShiftStore.getState().currentShift.id), shift);
    largeCatchUp.allCloudIdsVerified = true;
    largeCatchUp.cashierShiftPreserved = true;
    largeCatchUp.renderedReportRecords = await phone.evaluate(async () => (await import('/src/store/useTicketStore.ts')).useTicketStore.getState().tickets.length);
    assert.equal(largeCatchUp.renderedReportRecords, count + 204);
    assert.equal(await phone.evaluate(async () => (await import('/src/store/useTicketStore.ts')).useTicketStore.getState().tickets.reduce((total, row) => total + row.amount, 0)), count * 100 + 204 * 500);
    await nav(phone, 'Sales Record Book');
    await phone.getByText('#LARGE-0149999', { exact: true }).waitFor();
    const freshContext = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Lagos' });
    await setup(freshContext);
    const fresh = await freshContext.newPage();
    fresh.on('pageerror', e => errors.push(e.message));
    await fresh.goto(origin);
    await fresh.locator('form input').nth(0).fill(email);
    await fresh.locator('form input[type=password]').fill('9876');
    const loginBegan = Date.now();
    await fresh.getByRole('button', { name: /log in to terminal/i }).click();
    await fresh.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
    largeCatchUp.freshPhoneLoginMs = Date.now() - loginBegan;
    assert.equal(await fresh.evaluate(async () => (await import('/src/store/useSyncStore.ts')).useSyncStore.getState().isPulling), true);
    await wait(fresh, async () => (await import('/src/store/useTicketStore.ts')).useTicketStore.getState().tickets.some(row => row.id === 'LARGE-0149999'));
    largeCatchUp.freshPhoneNewestRenderedMs = Date.now() - loginBegan;
    await wait(fresh, async () => Boolean((await import('/src/store/useSyncStore.ts')).useSyncStore.getState().lastPulledAt));
    assert.equal(await fresh.evaluate(async () => (await import('/src/services/db/dexieSchema.ts')).db.tickets.count()), count + 204);
    largeCatchUp.freshPhoneFullyRecovered = true;
    assert.equal(await till.evaluate(async () => (await import('/src/store/useShiftStore.ts')).useShiftStore.getState().currentShift.id), shift);
    await writeFile('artifacts/large-sync-result.json', JSON.stringify(largeCatchUp, null, 2));
    console.log(JSON.stringify({ verifiedLargeCatchUp: largeCatchUp }));
    // This mode isolates download performance from the smaller reconnect scenario.
    assert.deepEqual(errors, []);
    process.exitCode = 0;
    await browser.close();
    process.exit(0);
  }
  // Reproduce the reported original-owner queue behind a wrong cloud login.
  // Hold the sender while the real cashier issues a second sale, then reconnect
  // the original account through its PIN without logging the cashier out.
  await till.evaluate(async () => {
    const { useSyncStore } = await import('/src/store/useSyncStore.ts');
    window.originalWorker = useSyncStore.getState().triggerSyncWorker;
    useSyncStore.setState({ triggerSyncWorker: async () => {} });
    (await import('/src/services/db/realtimeSync.ts')).stopRealtimeSync();
  });
  await till.getByRole('button', { name: /200/ }).first().click();
  await wait(till, async () => (await import('/src/services/db/dexieSchema.ts')).db.tickets.count().then(n => n === 212));
  await till.evaluate(async wrongSession => {
    const client = (await import('/src/services/supabase/supabaseClient.ts')).supabase;
    const { error } = await client.auth.setSession(wrongSession);
    if (error) throw error;
    const { useSyncStore } = await import('/src/store/useSyncStore.ts');
    useSyncStore.setState({ triggerSyncWorker: window.originalWorker });
    await useSyncStore.getState().forceSyncNow();
  }, session({ ...owner, id: 'wrong-login' }));
  await till.getByRole('button', { name: /Account Mismatch/ }).click();
  await till.getByRole('button', { name: `Reconnect ${email}`, exact: true }).click();
  await till.locator('input[type=password]').fill('9876');
  await till.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await till.getByText('Cloud Reconnected', { exact: true }).waitFor();
  await wait(till, async () => { const s = (await import('/src/store/useSyncStore.ts')).useSyncStore.getState(); return s.pendingCount === 7 && !s.isSyncing; });
  assert.equal(cloud.get('tickets').size, 205);
  assert.equal(await till.evaluate(async () => (await import('/src/store/useShiftStore.ts')).useShiftStore.getState().currentShift.id), shift);
  await till.getByText('Cloud Reconnected', { exact: true }).waitFor({ state: 'hidden' });
  await till.evaluate(async account => {
    const { db } = await import('/src/services/db/dexieSchema.ts');
    const original = await db.users.get(account);
    await db.users.put({ ...original, id: 'another-owner', accountId: 'another-owner', email: 'another-owner@example.test', username: 'another-owner@example.test', name: 'Another Owner' });
  }, account);
  await till.getByRole('button', { name: /Account Mismatch/ }).click();
  await till.getByRole('button', { name: 'Reconnect another-owner@example.test', exact: true }).click();
  await till.locator('input[type=password]').fill('9876');
  await till.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await till.getByText(/signed-in cashier belongs to a different account/i).waitFor();
  assert.equal(cloud.get('tickets').size, 205);
  assert.equal(await till.evaluate(async () => (await import('/src/services/db/accountScope.ts')).getAccountId()), account);
  assert.deepEqual(errors, []);
  const result = { recordsRecovered: 203, otherAccountRecordsRetained: 7, currentSaleVisibleOnPhone: true, phoneWakeToRenderedSaleMs: elapsed, cashierShiftPreserved: true, originalOwnerPinReconnectVerified: true, otherBusinessReconnectRefused: true, qrRefusalsRecovered: qrRefusals };
  await writeFile('artifacts/live-sync-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error, '\nTill:', (await till.locator('body').innerText()).slice(-3000), '\nPhone:', (await phone.locator('body').innerText()).slice(-3000));
  throw error;
} finally { await browser.close(); }
