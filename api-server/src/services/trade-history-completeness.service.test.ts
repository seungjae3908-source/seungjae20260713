import test from 'node:test';
import assert from 'node:assert/strict';
import { readCompleteTradingHistory, tradingHistoryComplete } from './trade-history-completeness.service';

test('complete history traverses old 200/500 limits and retains old open positions', async () => {
  const rows = Array.from({ length: 1201 }, (_, n) => ({ id: String(n).padStart(8, '0'),
    updated_at: new Date(n * 1000).toISOString(), payload: { index: n } }));
  const afterIds: Array<string | null> = [];
  const result = await readCompleteTradingHistory({
    async snapshot() { return { count: rows.length, lastUpdatedAt: rows.at(-1)!.updated_at }; },
    async page(afterId, size) { afterIds.push(afterId); return rows.filter((r) => afterId == null || r.id > afterId).slice(0, size); },
    project: (v) => v as { index: number },
  });
  assert.equal(result.length, 1201);
  assert.equal(result.at(-1)!.index, 0);
  assert.equal(tradingHistoryComplete(result, 500), true);
  assert.equal(tradingHistoryComplete(JSON.parse(JSON.stringify(result)), 500), false, 'client JSON cannot certify completeness');
  assert.equal(afterIds.filter((id) => id === '00000999').length, 2);
});
test('history detects same-count backdated transitions and incomplete/duplicate pages without retry', async () => {
  let reads = 0;
  const snapshot = async () => ({ count: 1, lastUpdatedAt: '2026-10-12T00:00:00Z' });
  await assert.rejects(readCompleteTradingHistory({ snapshot,
    async page() { reads += 1; return [{ id: 'id', updated_at: '2026-10-12T00:00:00Z', payload: { version: reads } }]; },
    project: (v) => v,
  }), /CHANGED_DURING_READ/);
  assert.equal(reads, 2);
  await assert.rejects(readCompleteTradingHistory({ snapshot, async page() { return []; }, project: (v) => v }), /CHANGED_DURING_READ/);
  await assert.rejects(readCompleteTradingHistory({ snapshot: async () => ({ count: 2, lastUpdatedAt: null }),
    async page() { return [{ id: 'same', updated_at: 'now', payload: {} }, { id: 'same', updated_at: 'now', payload: {} }]; },
    project: (v) => v }), /CURSOR_INVALID/);
});

test('out-of-order, oversized and malformed-time pages cannot certify complete history', async () => {
  const row = (id: string, at = '2026-10-12T00:00:00Z') => ({ id, updated_at: at, payload: {} });
  for (const rows of [[row('b'), row('a')], [row('a', 'INVALID_TIMESTAMP')],
    Array.from({ length: 501 }, (_, index) => row(String(index).padStart(8, '0')))]) {
    let reads = 0;
    await assert.rejects(readCompleteTradingHistory({
      snapshot: async () => ({ count: rows.length, lastUpdatedAt: '2026-10-12T00:00:00Z' }),
      page: async () => { reads += 1; return rows; }, project: (value) => value,
    }), /TRADE_HISTORY_CURSOR_INVALID/);
    assert.equal(reads, 1, 'invalid traversal is rejected before confirmation, without retry');
  }
});
