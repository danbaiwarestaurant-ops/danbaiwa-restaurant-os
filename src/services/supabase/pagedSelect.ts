/**
 * pagedSelect.ts
 *
 * Reads every row a query matches, rather than however many the API decides to hand back.
 *
 * PostgREST caps the size of any response at the project's "Max rows" setting (Supabase
 * ships that at 1000). The cap is silent: no error, no flag, no total — a plain
 * `.select()` over a table with 1100 rows simply returns 1000 of them and looks exactly
 * like a table with 1000 rows in it. Every caller here was written as if a select
 * returned the whole table, and both of them draw conclusions from what is *absent*:
 *
 *   * the backfill sweep (cloudBackfill.ts) diffs local ids against the cloud's and
 *     uploads the difference. Past the cap, the difference is "every local row the cap
 *     cut off" — so it re-queued the same overflow on every pass, for ever, and the
 *     count grew by one with each new ticket rung up. That is the backlog that never
 *     drains and the pending badge that ticks up and down without ever reaching zero.
 *   * the reconciliation pull (realtimeSync.ts) merges the cloud's rows into the local
 *     copy. Past the cap, a till simply never receives the rest of the account's
 *     history, and no amount of waiting fixes it.
 *
 * Paging by the number of rows actually returned — rather than by the page size asked
 * for — means the loop is correct whatever the project's cap is set to, including a cap
 * smaller than the page size. It stops on the first empty page, so the cost of reading a
 * table that fits comfortably under the cap is one extra, empty request.
 */

const PAGE_SIZE = 500;

/** Freeze the upper server timestamp before an ID-keyset history scan. A row
 * arriving behind an already-read ID must remain eligible for the NEXT pull;
 * otherwise a later arrival ahead of the cursor can move the watermark past it. */
export async function* selectSnapshotPages<T extends Record<string, any> = any>(
  build: () => any
): AsyncGenerator<T[]> {
  const { data, error } = await build().order('updated_at', { ascending: false }).range(0, 0);
  if (error) throw error;
  if (!data?.length) return;
  const upper = data[0].updated_at;
  if (!upper || !Number.isFinite(Date.parse(upper))) throw new Error('Cloud row has no valid server update timestamp.');
  yield* selectPages<T>(() => build().lte('updated_at', upper));
}

/** Streaming keyset pages: bounded memory and no growing SQL OFFSET. Advance by
 * the last UNIQUE key actually returned, including under a smaller server cap. */
export async function* selectPages<T extends Record<string, any> = any>(
  build: () => any, orderBy = 'id'
): AsyncGenerator<T[]> {
  let after: string | undefined;
  while (true) {
    let query = build();
    if (after !== undefined) query = query.gt(orderBy, after);
    const { data, error } = await query.order(orderBy, { ascending: true }).range(0, PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as T[];
    if (!page.length) return;
    const last = String(page[page.length - 1][orderBy]);
    if (!last || last === 'undefined' || (after !== undefined && last <= after)) throw new Error('Cloud pagination did not advance its unique key.');
    yield page;
    after = last;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/**
 * @param build  Returns a *fresh* filtered query (`supabase.from(t).select(...).eq(...)`).
 *               Called once per page, because a PostgREST builder is single-use.
 * @param orderBy  Column giving the pages a stable order. Must be unique, or rows can
 *                 shift between pages and be missed — `id` on every table here.
 */
export async function selectAllPages<T = any>(
  build: () => any,
  orderBy: string = 'id'
): Promise<{ data: T[] | null; error: any }> {
  const rows: T[] = [];
  let from = 0;

  for (;;) {
    const { data, error } = await build()
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) return { data: null, error };

    const page = (data ?? []) as T[];
    if (!page.length) return { data: rows, error: null };

    rows.push(...page);
    // Advance by what came back, not by what was asked for: a server whose cap is below
    // PAGE_SIZE returns short pages, and stepping over the gap would skip rows silently.
    from += page.length;
  }
}
