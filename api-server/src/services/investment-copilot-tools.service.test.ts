import assert from 'node:assert/strict';
import test from 'node:test';
import { executeInvestmentTool, InvestmentToolValidationError, type CopilotPortfolioSnapshot } from './investment-copilot-tools.service.ts';
const snapshot: CopilotPortfolioSnapshot = { status: 'PARTIAL', asOf: '2026-08-15T00:00:00.000Z',
  totalAssets: { normalizedKRW: 1_000_000, knownNormalizedKRW: 1_000_000 }, cash: { totalKRW: null },
  valuationPnl: { normalizedKRW: 50_000, returnPercent: 5 }, top5Concentration: { percent: 100 },
  riskClassification: { level: null, reason: 'CASH_AND_CRYPTO_EXPOSURE_UNAVAILABLE' },
  holdings: [{ ticker: 'BTCUSDT', name: 'Bitcoin', market: 'CRYPTO_FUTURES', normalizedKRW: 600_000 },
    { ticker: '005930', name: '삼성전자', market: 'KR', normalizedKRW: 400_000 }], missingSources: ['CASH:NOT_AVAILABLE'] };
test('portfolio summary preserves unavailable cash and provenance instead of inventing zero', () => {
  const result = executeInvestmentTool(snapshot, { tool: 'getPortfolioSummary' });
  assert.equal(result.data.cashKRW, null); assert.equal(result.status, 'PARTIAL');
  assert.equal(result.evidence[0].dataset, 'canonical_portfolio_snapshot'); assert.equal(result.safety.orderAuthority, 'none');
});
test('portfolio risk identifies the largest known holding deterministically', () => {
  const result = executeInvestmentTool(snapshot, { tool: 'getPortfolioRisk' });
  assert.equal(result.data.largestKnownHolding?.ticker, 'BTCUSDT');
  assert.equal(result.data.largestKnownHolding?.knownPortfolioPercent, 60); assert.equal(result.data.riskLevel, null);
  assert.deepEqual(result.data.volatility, { status: 'INSUFFICIENT_SAMPLE', value: null });
  assert.deepEqual(result.data.valueAtRisk, { status: 'NOT_AVAILABLE', value: null });
  assert.deepEqual(result.data.conditionalValueAtRisk, { status: 'NOT_AVAILABLE', value: null });
});
test('BTC -10% what-if calculates impact without sending an order', () => {
  const before = structuredClone(snapshot);
  const result = executeInvestmentTool(snapshot, { tool: 'runPortfolioWhatIf', arguments: { shocks: [{ ticker: 'BTCUSDT', changePercent: -10 }] } });
  assert.equal(result.data.scenarioStatus, 'SIMULATED'); assert.equal(result.data.pnlImpact, -60_000);
  assert.equal(result.data.equityAfter, 940_000); assert.equal(result.safety.simulationOnly, true); assert.equal(result.safety.exchangeRequestSent, false);
  assert.equal(result.safety.readOnly, true); assert.equal(result.safety.orderAuthority, 'none'); assert.deepEqual(snapshot, before);
});
test('unknown holdings and malformed shocks fail closed', () => {
  const partial = executeInvestmentTool(snapshot, { tool: 'runPortfolioWhatIf', arguments: { shocks: [{ ticker: 'ETHUSDT', changePercent: -15 }] } });
  assert.equal(partial.data.scenarioStatus, 'PARTIAL_SIMULATION'); assert.equal(partial.data.pnlImpact, null); assert.equal(partial.data.equityAfter, null);
  assert.throws(() => executeInvestmentTool(snapshot, { tool: 'runPortfolioWhatIf', arguments: { shocks: [{ ticker: 'BTCUSDT', changePercent: -101 }] } }),
    (cause) => cause instanceof InvestmentToolValidationError && cause.code === 'INVALID_SHOCK');
});
