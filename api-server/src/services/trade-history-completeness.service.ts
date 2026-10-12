/** Internal provenance: only a fully traversed, stable repository read may
 * bypass the legacy 200/500 truncation boundary. Not serializable by a client. */
const completeHistories = new WeakSet<readonly unknown[]>();
export function completeTradingHistory<T>(rows: T[]): T[] {
  completeHistories.add(rows);
  return rows;
}
export function tradingHistoryComplete(rows: readonly unknown[], legacyLimit: number): boolean {
  return rows.length < legacyLimit || completeHistories.has(rows);
}

type Row = { id: string; updated_at: string; payload: unknown };
type Snapshot = { count: number; lastUpdatedAt: string | null };
export async function readCompleteTradingHistory<T>(input: {
  snapshot(): Promise<Snapshot>;
  page(afterId: string | null, pageSize: number): Promise<Row[]>;
  project(value: unknown): T;
}): Promise<T[]> {
  const before = await input.snapshot();
  const maximumRows = 100_000;
  if (!Number.isSafeInteger(before.count) || before.count < 0 || before.count > maximumRows) {
    throw new Error('TRADE_HISTORY_BOUND_EXCEEDED');
  }
  const traverse = async () => {
    const rows: Row[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const page = await input.page(cursor, 500);
      for (const row of page) {
        if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id)
          || !row.updated_at || row.payload == null) throw new Error('TRADE_HISTORY_CURSOR_INVALID');
        seen.add(row.id);
        cursor = row.id;
        rows.push(row);
        if (rows.length > before.count || rows.length > maximumRows) throw new Error('TRADE_HISTORY_CHANGED_DURING_READ');
      }
      if (page.length < 500) break;
    }
    return rows;
  };
  const rows = await traverse();
  // A count/max-time watermark alone can miss a backdated payload transition.
  // Recheck the bounded traversal and reject any content drift; no blind retry.
  const confirmation = await traverse();
  const after = await input.snapshot();
  if (rows.length !== before.count || after.count !== before.count
    || after.lastUpdatedAt !== before.lastUpdatedAt
    || JSON.stringify(rows) !== JSON.stringify(confirmation)) throw new Error('TRADE_HISTORY_CHANGED_DURING_READ');
  // Preserve previous newest-first consumer ordering; cursor itself is immutable
  // id, not updated_at, so a transition cannot silently skip an older position.
  rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
  return completeTradingHistory(rows.map((row) => input.project(row.payload)));
}
