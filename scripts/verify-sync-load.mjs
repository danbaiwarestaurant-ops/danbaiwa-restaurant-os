import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// Supplemental transport stress test. Run a SEPARATE Vite server with
// VITE_SUPABASE_URL=https://sync.qa.invalid and VITE_SUPABASE_ANON_KEY=qa-test-key.
// Every API request is intercepted; no production credentials or service is used.
const origin = process.env.SYNC_QA_URL || 'http://127.0.0.1:5181';
const account = '00000000-0000-4000-8000-000000000001';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const cloud = new Map();
const RECORDS = Number(process.env.SYNC_QA_RECORDS || 20000);
const batches = [];
// Playwright's waitForFunction tests promise truthiness; evaluate async conditions
// explicitly so database/store checks really finish before assertions proceed.
async function waitFor(predicate, arg = null, options = {}) {
  const deadline = Date.now() + (options.timeout || 30000);
  while (!(await page.evaluate(predicate, arg))) {
    if (Date.now() > deadline) throw new Error('Async condition timed out: ' + predicate.toString().slice(0, 180));
    await new Promise(resolve => setTimeout(resolve, options.polling || 25));
  }
}
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', msg => { if (msg.text().startsWith('QA progress')) console.log(msg.text()); });
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin === origin) return route.continue();
  assert.equal(url.hostname, 'sync.qa.invalid', 'Unexpected external request: ' + url.origin);
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': 'Content-Range' };
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 200, headers });
  if (url.pathname === '/auth/v1/user') return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify({ id: account, email: 'sync-test@example.test', user_metadata: {} }) });
  if (url.pathname === '/rest/v1/tickets' && request.method() === 'POST') {
    const rows = request.postDataJSON();
    batches.push({ time: Date.now(), size: rows.length });
    for (const row of rows) { assert.equal(row.account_id, account); cloud.set(row.id, row); }
    // Realistic per-request latency, without coupling the test to internet quality.
    await new Promise(resolve => setTimeout(resolve, 30));
    return route.fulfill({ status: 201, contentType: 'application/json', headers, body: '[]' });
  }
  if (request.method() === 'GET' && url.pathname.startsWith('/rest/v1/')) {
    let rows = url.pathname.endsWith('/tickets') ? [...cloud.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : [];
    const after = url.searchParams.get('id');
    if (after?.startsWith('gt.')) rows = rows.filter(row => row.id > after.slice(3));
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 500);
    const result = rows.slice(offset, offset + limit);
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { ...headers, 'Content-Range': `${offset}-${offset + result.length - 1}/${rows.length}` }, body: JSON.stringify(result) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', headers, body: '[]' });
});

try {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create Account', exact: true }).waitFor();
  await page.evaluate(async ({ account }) => {
    const client = await import('/src/services/supabase/supabaseClient.ts');
    if (client.SUPABASE_URL !== 'https://sync.qa.invalid') throw new Error('Use the isolated QA cloud URL');
    const encode = value => btoa(JSON.stringify(value)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
    const jwt = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ sub: account, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' }) + '.test-signature';
    const { error } = await client.supabase.auth.setSession({ access_token: jwt, refresh_token: 'qa-refresh-token' });
    if (error) throw error;
  }, { account });
  await page.evaluate(async () => {
    await Promise.all(['/src/services/db/dexieSchema.ts', '/src/services/db/IndexedDbService.ts', '/src/store/useSyncStore.ts'].map(path => import(path)));
  });
  await context.setOffline(true);
  await page.evaluate(async ({ account, records }) => {
    const { db } = await import('/src/services/db/dexieSchema.ts');
    const { dbService } = await import('/src/services/db/IndexedDbService.ts');
    window.qaTimings = {};
    for (const name of ['getPendingOutbox', 'markOutboxSyncedMany', 'countUnsyncedOutbox']) {
      const original = dbService[name].bind(dbService);
      dbService[name] = async (...args) => {
        const start = performance.now();
        try { return await original(...args); }
        finally { (window.qaTimings[name] ||= []).push(Math.round(performance.now() - start)); }
      };
    }
    const stamp = new Date().toISOString();
    // Bounded setup transactions model how a till accumulated its backlog.
    const tickets = Array.from({ length: records }, (_, i) => ({ id: 'QA-' + String(i).padStart(6, '0'), localSeq: i + 1, cashierId: 'cashier', locationId: 'LOC01', deviceId: 'DEV01', accountId: account, amount: 500, currency: 'N', status: 'paid', tender: 'cash', createdAt: stamp, updatedAt: stamp, qrPayload: 'q' }));
    for (let offset = 0; offset < tickets.length; offset += 200) {
      const rows = tickets.slice(offset, offset + 200);
      if (offset % 2000 === 0) console.info('QA progress: seeded ' + offset);
      await db.transaction('rw', db.tickets, db.outbox, async () => {
        await db.tickets.bulkAdd(rows);
        await db.outbox.bulkAdd(rows.map(ticket => ({ id: crypto.randomUUID(), tableName: 'tickets', action: 'INSERT', payload: ticket, status: 'pending', retryCount: 0, createdAt: stamp })));
      });
    }
    const store = (await import('/src/store/useSyncStore.ts')).useSyncStore;
    window.qaCounts = [];
    store.subscribe(state => window.qaCounts.push(state.pendingCount));
    await store.getState().checkOutbox();
  }, { account, records: RECORDS });
  assert.equal(batches.length, 0);
  console.log('Prepared', RECORDS, 'offline records; restoring connectivity');
  const reconnected = Date.now();
  await context.setOffline(false);
  await waitFor(async () => (await import('/src/store/useSyncStore.ts')).useSyncStore.getState().isSyncing, null, { polling: 20 });
  // Keep taking sales while the backlog is actively uploading.
  const writeMs = await page.evaluate(async ({ account }) => {
    const { dbService } = await import('/src/services/db/IndexedDbService.ts');
    const start = performance.now();
    await dbService.saveTicket({ id: 'QA-MID-PUSH', accountId: account, locationId: 'LOC01', deviceId: 'DEV01', localSeq: 20001, amount: 800, cashierId: 'cashier', currency: 'N', status: 'paid', tender: 'cash', createdAt: new Date().toISOString(), qrPayload: 'q' });
    void (await import('/src/store/useSyncStore.ts')).useSyncStore.getState().triggerSyncWorker();
    return performance.now() - start;
  }, { account });
  await waitFor(async () => {
    const sync = (await import('/src/store/useSyncStore.ts')).useSyncStore.getState();
    return !sync.isSyncing && sync.pendingCount === 0;
  }, null, { polling: 250, timeout: 300000 });
  const ms = Date.now() - reconnected;
  const counts = await page.evaluate(() => window.qaCounts);

  assert.equal(cloud.size, RECORDS + 1);
  assert(batches.every(batch => batch.size <= 200));
  assert(batches.length <= Math.ceil((RECORDS + 1) / 200) + 2, 'Queue degraded into per-record requests');
  assert(batches[0].time - reconnected < 1500, 'Reconnect waited before sending the first batch');
  assert(writeMs < 1000, 'Ticket save blocked behind backlog processing');
  assert(counts.some(count => count > 0 && count < RECORDS), 'Badge did not report progress during upload');
  assert.equal(await page.evaluate(async () => (await import('/src/services/db/dexieSchema.ts')).db.tickets.count()), RECORDS + 1);
  assert.equal(await page.evaluate(async () => (await import('/src/services/db/dexieSchema.ts')).db.outbox.where('status').equals('pending').count()), 0);
  assert.deepEqual(errors, []);
  const report = { records: cloud.size, requests: batches.length, firstBatchMs: batches[0].time - reconnected, drainMs: ms, concurrentTicketSaveMs: Math.round(writeMs), networkLatencyPerBatchMs: 30 };
  report.databaseTimings = await page.evaluate(() => Object.fromEntries(Object.entries(window.qaTimings).map(([name, times]) => [name, { calls: times.length, totalMs: times.reduce((a, b) => a + b, 0), maxMs: Math.max(...times) }])));
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/sync-load.json', JSON.stringify(report, null, 2));
  console.log('PASS:', report);
} catch (error) {
  console.error('Sync diagnostic:', { delivered: cloud.size, requests: batches.length, firstBatch: batches[0], lastBatch: batches.at(-1), errors });
  console.error(await page.evaluate(async () => {
    const state = (await import('/src/store/useSyncStore.ts')).useSyncStore.getState();
    return { pending: state.pendingCount, syncing: state.isSyncing, connected: state.cloudConnected, error: state.cloudError, fault: state.queueFault, counts: window.qaCounts?.slice(-10), timings: window.qaTimings };
  }));
  throw error;
} finally { await browser.close(); }
