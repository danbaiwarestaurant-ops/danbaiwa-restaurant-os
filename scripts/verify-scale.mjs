import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const origin = process.env.SCALE_QA_URL || 'http://127.0.0.1:5183';
const records = Number(process.env.SCALE_QA_RECORDS || 1000000);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [], prints = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.text().startsWith('QA progress')) console.log(m.text()); });
await context.route('http://127.0.0.1:9100/**', async route => {
  if (route.request().method() === 'POST') prints.push({ at: Date.now(), id: route.request().postDataJSON().ticketId });
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ success: true, version: 4 }) });
});
async function waitFor(fn, arg = null, timeout = 30000) {
  const until = Date.now() + timeout;
  while (!await page.evaluate(fn, arg)) { if (Date.now() > until) throw new Error('Timed out: ' + fn); await new Promise(r => setTimeout(r, 25)); }
}
try {
  await page.goto(origin);
  assert.equal(await page.evaluate(async () => (await import('/src/services/supabase/supabaseClient.ts')).isSupabaseConfigured), false);
  await page.getByRole('button', { name: 'Create Account', exact: true }).click();
  for (const [i, value] of ['Scale Owner', 'scale@example.test', 'ScaleTest!234', '9876'].entries()) await page.locator('form input').nth(i).fill(value);
  await page.getByRole('button', { name: /create account & log in/i }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  await page.evaluate(async () => {
    const auth = (await import('/src/store/useAuthStore.ts')).useAuthStore;
    await auth.getState().createStaffMember('Scale Cashier', 'scale-cashier', '2468', 'cashier');
    await auth.getState().logoutUser();
    const result = await auth.getState().loginUser('scale-cashier', '2468');
    if (!result) throw new Error('Cashier login rejected');
    await import('/src/services/db/dexieSchema.ts');
    await import('/src/services/db/IndexedDbService.ts');
    await import('/src/store/useTicketStore.ts');
    await import('/src/store/useShiftStore.ts');
    await import('/src/services/print/PrintAdapter.ts');
  });
  await waitFor(async () => (await import('/src/store/useShiftStore.ts')).useShiftStore.getState().currentShift?.id);
  await context.setOffline(true);
  const seeded = await page.evaluate(async records => {
    const { db } = await import('/src/services/db/dexieSchema.ts');
    const { dbService } = await import('/src/services/db/IndexedDbService.ts');
    const shift = (await import('/src/store/useShiftStore.ts')).useShiftStore.getState().currentShift;
    const baseSummary = await dbService.getShiftSummary(shift);
    const basePending = (await dbService.countUnsyncedOutbox(false)).total;
    const stamp = new Date().toISOString();
    const start = performance.now();
    for (let offset = 0; offset < records; offset += 1000) {
      const rows = Array.from({ length: Math.min(1000, records - offset) }, (_, i) => ({
        id: 'SCALE-' + String(offset + i).padStart(8, '0'), localSeq: offset + i + 1,
        cashierId: shift.cashierId, shiftId: shift.id, locationId: 'LOC01', deviceId: 'DEV01',
        amount: 500, currency: 'N', status: 'paid', tender: 'cash', createdAt: stamp, qrPayload: 'q'
      }));
      // Fixture construction uses native transactions so the benchmark measures the
      // production foreground paths, rather than the test-data generator. Counters
      // and summaries are seeded atomically; their mutation logic has unit coverage.
      await new Promise((resolve, reject) => {
        const tx = db.backendDB().transaction(['tickets', 'outbox', 'queueCounters', 'shiftSummaries'], 'readwrite');
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
        for (const row of rows) {
          tx.objectStore('tickets').add(row);
          tx.objectStore('outbox').add({ id: 'Q-' + row.id, tableName: 'tickets', action: 'INSERT', payload: row, createdAt: stamp, status: 'pending', retryCount: 0, readyAt: '' });
        }
        tx.objectStore('queueCounters').put({ key: 'outbox', pending: basePending + offset + rows.length, failed: 0, stuck: 0 });
        tx.objectStore('shiftSummaries').put({ ...baseSummary, ticketCount: offset + rows.length,
          revenue: (offset + rows.length) * 500, cash: (offset + rows.length) * 500 });
      });
      if (offset % 10000 === 0) console.info('QA progress: seeded ' + (offset + rows.length));
    }
    return { basePending, shiftId: shift.id, cashierId: shift.cashierId, seedMs: Math.round(performance.now() - start) };
  }, records);
  const metrics = await page.evaluate(async ({ records, seeded }) => {
    const { dbService } = await import('/src/services/db/IndexedDbService.ts');
    const store = (await import('/src/store/useTicketStore.ts')).useTicketStore;
    let start = performance.now();
    const counts = await dbService.countUnsyncedOutbox(false);
    const countMs = performance.now() - start;
    start = performance.now();
    await store.getState().loadTickets(seeded.cashierId);
    const hydrateMs = performance.now() - start;
    const pendingPageStart = performance.now();
    const page = await dbService.getPendingOutbox(200);
    const pendingPageMs = performance.now() - pendingPageStart;
    const saleTimes = [];
    for (let i = 0; i < 10; i++) {
      start = performance.now();
      const sale = await store.getState().createAndPrintTicket(200, seeded.cashierId);
      if (!sale.success) throw new Error(sale.message);
      saleTimes.push(Math.round(performance.now() - start));
    }
    await store.getState().refreshShiftSummary();
    return { counts, countMs: Math.round(countMs), hydrateMs: Math.round(hydrateMs), pendingPageMs: Math.round(pendingPageMs), pageSize: page.length, cacheSize: store.getState().tickets.length, summary: store.getState().shiftSummary, saleTimes };
  }, { records, seeded });
  assert.equal(metrics.counts.total, records + seeded.basePending);
  assert.equal(metrics.pageSize, 200);
  assert.equal(metrics.cacheSize, 200);
  assert.equal(metrics.summary.ticketCount, records + 10);
  assert.equal(metrics.summary.cash, records * 500 + 2000);
  assert(metrics.countMs < 250, 'Queue status stalled: ' + JSON.stringify(metrics));
  assert(metrics.hydrateMs < 2000, 'Till loaded lifetime history');
  assert(Math.max(...metrics.saleTimes) < 1000, 'Sale stalled behind accumulated records');
  await waitFor(() => document.querySelectorAll('body').length > 0);
  await new Promise((resolve, reject) => { const until = Date.now() + 10000; const check = () => prints.length === 10 ? resolve() : Date.now() > until ? reject(new Error('Prints timed out: ' + prints.length)) : setTimeout(check, 25); check(); });
  assert.equal(new Set(prints.map(p => p.id)).size, 10);
  await context.setOffline(false);
  await page.reload();
  await waitFor(async () => (await import('/src/store/useTicketStore.ts')).useTicketStore.getState().tickets.length === 200);
  await waitFor(async count => (await import('/src/store/useTicketStore.ts')).useTicketStore.getState().shiftSummary?.ticketCount === count, records + 10);
  const restored = await page.evaluate(async () => ({
    total: await (await import('/src/services/db/dexieSchema.ts')).db.tickets.count(),
    shiftId: (await import('/src/store/useShiftStore.ts')).useShiftStore.getState().currentShift?.id,
    count: (await import('/src/store/useTicketStore.ts')).useTicketStore.getState().shiftSummary?.ticketCount,
  }));
  assert.deepEqual(restored, { total: records + 10, shiftId: seeded.shiftId, count: records + 10 });
  assert.deepEqual(errors, []);
  const report = { records, ...metrics, seedMs: seeded.seedMs, printRequests: prints.length, restored };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/scale-qa.json', JSON.stringify(report, null, 2));
  console.log('PASS:', report);
} finally { await browser.close(); }
