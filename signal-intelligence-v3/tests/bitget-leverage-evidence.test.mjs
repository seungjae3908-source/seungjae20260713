import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBitgetIndicativeLeverageEvidence,
  historicalAdverseEvidence,
  isolatedFirstTierLiquidationPrice,
} from '../src/bitget-leverage-evidence.mjs';

function candles(count = 160) {
  const start = Date.parse('2026-08-01T00:00:00Z');
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + Math.sin(index / 8) * 2 + index * 0.02;
    return { timestamp: start + index * 3600000, open: close - 0.2, high: close + 0.8, low: close - 0.8, close };
  });
}

test('isolated first-tier formula produces liquidation below long entry and above short entry', () => {
  const long = isolatedFirstTierLiquidationPrice({ entryPrice: 100, leverage: 5, mmr: 0.004, takerFeeRate: 0.0006, direction: 'LONG' });
  const short = isolatedFirstTierLiquidationPrice({ entryPrice: 100, leverage: 5, mmr: 0.004, takerFeeRate: 0.0006, direction: 'SHORT' });
  assert.ok(long > 0 && long < 100);
  assert.ok(short > 100);
});

test('historical adverse q95 uses closed forward windows and both directions', () => {
  const rows = candles();
  const long = historicalAdverseEvidence(rows, 'LONG', 12);
  const short = historicalAdverseEvidence(rows, 'SHORT', 12);
  assert.ok(long.sampleSize >= 100);
  assert.ok(long.maeQ95Pct > 0);
  assert.ok(short.maeQ95Pct > 0);
  assert.equal(long.method, 'CLOSED_1H_FORWARD_WINDOW_EMPIRICAL_Q95');
});

test('public builder uses first position tier, contract fee and closed candles only', async () => {
  const now = Date.parse('2026-08-17T00:00:00Z');
  const rows = candles(200).map((row) => [String(row.timestamp), String(row.open), String(row.high), String(row.low), String(row.close), '10', '1000']);
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    let data;
    if (path.endsWith('/query-position-lever')) {
      data = [
        { symbol: 'BTCUSDT', level: '1', startUnit: '0', endUnit: '50000', leverage: '20', keepMarginRate: '0.004' },
        { symbol: 'BTCUSDT', level: '2', startUnit: '50000', endUnit: '100000', leverage: '10', keepMarginRate: '0.01' },
      ];
    } else if (path.endsWith('/contracts')) {
      data = [{ symbol: 'BTCUSDT', symbolStatus: 'normal', takerFeeRate: '0.0006', minLever: '1', maxLever: '20' }];
    } else if (path.endsWith('/candles')) {
      data = rows;
    } else throw new Error('unexpected path');
    return new Response(JSON.stringify({ code: '00000', data }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const evidence = await buildBitgetIndicativeLeverageEvidence({
    symbol: 'BTCUSDT', direction: 'LONG', entryPrice: 100, stopDistancePct: 2,
    spreadPct: 0.05, slippagePct: 0.1, horizonBars: 12, nowMs: now,
  }, fetchImpl);
  assert.equal(evidence.evidence.positionTier, 1);
  assert.equal(evidence.evidence.firstTierMaxNotional, 50000);
  assert.equal(evidence.evidence.privateAccountStateUsed, false);
  assert.equal(evidence.evidence.executionAuthority, 'NONE');
  assert.ok(evidence.tiers.some((row) => row.leverage === 5));
  assert.ok(evidence.maeQ95Pct > 0);
});

test('builder fails closed if slippage evidence is absent', async () => {
  await assert.rejects(() => buildBitgetIndicativeLeverageEvidence({
    symbol: 'BTCUSDT', direction: 'LONG', entryPrice: 100, stopDistancePct: 2,
    spreadPct: 0.05,
  }), /LEVERAGE_MARKET_EVIDENCE_INCOMPLETE/);
});
