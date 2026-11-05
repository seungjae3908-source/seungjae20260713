import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePaperPromotionTrades } from './paper-promotion-trades';

test('parses valid rows, counts malformed rows as excluded, rejects non-analysis payloads', () => {
  const ok = parsePaperPromotionTrades({ ok: true, result: { executionAuthority: 'NONE', closedPaperCycles: 4, excludedCostIncomplete: 1, generatedAt: '2026-10-18T00:00:00Z',
    trades: [{ symbol: 'BTC', netReturnPct: 1.2 }, { symbol: 'ETH', netReturnPct: -0.4 }, { symbol: '', netReturnPct: 1 }, { symbol: 'X', netReturnPct: Number.NaN }] } });
  assert.ok(ok);
  assert.equal(ok!.trades.length, 2);
  assert.equal(ok!.excludedCostIncomplete, 3);
  assert.equal(parsePaperPromotionTrades({ ok: true, result: { executionAuthority: 'FULL', trades: [] } }), null);
  assert.equal(parsePaperPromotionTrades({ ok: false }), null);
  assert.equal(parsePaperPromotionTrades(null), null);
  assert.equal(parsePaperPromotionTrades({ ok: true, result: { executionAuthority: 'NONE' } }), null);
});
