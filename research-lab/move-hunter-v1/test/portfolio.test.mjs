import test from 'node:test';
import assert from 'node:assert/strict';
import { replayLongCashRunnerPortfolio } from '../src/portfolio.mjs';

function candles(start = 1_700_000_000_000, count = 80, drift = 0.002) {
  const rows = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const close = open * (1 + drift);
    rows.push({
      ts: start + i * 60_000,
      open,
      high: Math.max(open, close) * 1.004,
      low: Math.min(open, close) * 0.996,
      close,
      volume: 1000,
    });
    price = close;
  }
  return rows;
}

test('portfolio enforces one open position per symbol and remains cash bounded', () => {
  const a = candles();
  const signal = a[34].ts;
  const candidates = [
    { id: 'A-1', symbol: 'A', signalTimestamp: signal, priorityScore: 2, theme: { primary: 'T1' } },
    { id: 'A-2', symbol: 'A', signalTimestamp: signal, priorityScore: 1, theme: { primary: 'T1' } },
  ];
  const result = replayLongCashRunnerPortfolio({
    candidates,
    candlesBySymbol: { A: a },
    initialCapital: 1_000_000,
    costs: { feeBps: 15 },
  });
  assert.equal(result.schemaVersion, 'move-hunter-long-cash-portfolio-replay/v1');
  assert.equal(result.rejectionCounts.ACCEPTED, 1);
  assert.equal(result.rejectionCounts.SYMBOL_ALREADY_OPEN, 1);
  assert.ok(result.minCash >= -1e-9);
  assert.ok(result.maxGrossObserved <= 1.000001);
  assert.equal(result.assumptions.sameBarExitDoesNotFundSameOpenEntry, true);
});

test('portfolio rejects short candidates until a futures margin adapter exists', () => {
  const a = candles();
  const result = replayLongCashRunnerPortfolio({
    candidates: [{ id: 'S', symbol: 'A', signalTimestamp: a[34].ts, direction: 'SHORT' }],
    candlesBySymbol: { A: a },
  });
  assert.equal(result.tradeCount, 0);
  assert.equal(result.rejectionCounts.SHORT_REQUIRES_FUTURES_MARGIN_ADAPTER, 1);
  assert.equal(result.assumptions.marginTrading, false);
  assert.equal(result.profitabilityClaimAllowed, false);
});

test('portfolio preserves risk and exposure caps in its disclosed assumptions', () => {
  const a = candles();
  const b = candles(1_700_000_000_000, 80, 0.0018);
  const result = replayLongCashRunnerPortfolio({
    candidates: [
      { id: 'A', symbol: 'A', signalTimestamp: a[34].ts, priorityScore: 3, theme: { primary: 'T1' } },
      { id: 'B', symbol: 'B', signalTimestamp: b[34].ts, priorityScore: 2, theme: { primary: 'T2' } },
    ],
    candlesBySymbol: { A: a, B: b },
    initialCapital: 1_000_000,
    riskFraction: 0.005,
    aggregateInitialRiskCap: 0.02,
    maxPositions: 5,
    symbolExposureCap: 0.20,
    themeExposureCap: 0.40,
    maxGrossExposure: 1,
  });
  assert.equal(result.assumptions.riskFraction, 0.005);
  assert.equal(result.assumptions.aggregateInitialRiskCap, 0.02);
  assert.equal(result.assumptions.maxPositions, 5);
  assert.equal(result.assumptions.symbolExposureCap, 0.20);
  assert.equal(result.assumptions.themeExposureCap, 0.40);
  assert.equal(result.assumptions.maxGrossExposure, 1);
});


test('portfolio applies indicator invalidation on next bar open', () => {
  const a = candles();
  const signal = a[34].ts;
  const invalidTs = a[37].ts;
  const result = replayLongCashRunnerPortfolio({
    candidates: [{ id: 'A', symbol: 'A', signalTimestamp: signal, priorityScore: 1, theme: { primary: 'T1' } }],
    candlesBySymbol: { A: a },
    runnerControlBySymbol: {
      A: {
        [String(invalidTs)]: { state: 'INVALID', trailAtrMult: 1.5, exitNextOpen: true },
      },
    },
    indicatorExitEnabled: true,
    initialCapital: 1_000_000,
    costs: { feeBps: 15 },
  });
  assert.equal(result.tradeCount, 1);
  assert.equal(result.ledger[0].exitReason, 'INDICATOR_INVALID_NEXT_OPEN');
  assert.equal(result.ledger[0].exitTs, a[38].ts);
  assert.equal(result.assumptions.indicatorAdaptiveRunnerSupported, true);
});
