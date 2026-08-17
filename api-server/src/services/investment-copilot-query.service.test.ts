import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InvestmentCopilotQueryError,
  queryInvestmentCopilot,
} from './investment-copilot-query.service.ts';
import type { CopilotPortfolioSnapshot } from './investment-copilot-tools.service.ts';

const snapshot: CopilotPortfolioSnapshot = {
  status: 'PARTIAL',
  asOf: '2026-08-15T00:00:00.000Z',
  totalAssets: { normalizedKRW: 1_000_000, knownNormalizedKRW: 1_000_000 },
  cash: { totalKRW: null },
  valuationPnl: { normalizedKRW: 50_000, returnPercent: 5 },
  top5Concentration: { percent: 100 },
  riskClassification: { level: null, reason: 'CASH_AND_CRYPTO_EXPOSURE_UNAVAILABLE' },
  holdings: [
    { ticker: 'BTCUSDT', name: 'Bitcoin', market: 'CRYPTO_FUTURES', normalizedKRW: 600_000 },
    { ticker: '005930', name: '삼성전자', market: 'KR', normalizedKRW: 400_000 },
  ],
  missingSources: ['CASH:NOT_AVAILABLE'],
};

test('portfolio summary query dispatches the typed summary tool and preserves missing cash', () => {
  const result = queryInvestmentCopilot(snapshot, '내 포트폴리오 요약해줘');
  assert.equal(result.intent, 'PORTFOLIO_SUMMARY');
  assert.equal(result.request.tool, 'getPortfolioSummary');
  assert.equal(result.toolResult.data.cashKRW, null);
  assert.equal(result.toolResult.status, 'PARTIAL');
  assert.equal(result.assistantContext.dataQuality, 'PARTIAL');
  assert.equal(result.safety.externalAiCalled, false);
  assert.equal(result.safety.orderAuthority, 'none');
});

test('risk query dispatches deterministic concentration analysis', () => {
  const result = queryInvestmentCopilot(snapshot, '내 포트에서 가장 위험하고 비중이 큰 종목은?');
  assert.equal(result.intent, 'PORTFOLIO_RISK');
  assert.equal(result.request.tool, 'getPortfolioRisk');
  if (result.intent !== 'PORTFOLIO_RISK') assert.fail('risk intent expected');
  assert.equal(result.toolResult.data.largestKnownHolding?.ticker, 'BTCUSDT');
  assert.equal(result.toolResult.data.largestKnownHolding?.knownPortfolioPercent, 60);
  assert.equal(result.toolResult.data.valueAtRisk.status, 'NOT_AVAILABLE');
});

test('BTC 10% downside query dispatches pure what-if simulation without mutation', () => {
  const before = structuredClone(snapshot);
  const result = queryInvestmentCopilot(snapshot, 'BTC가 10% 떨어지면 어떻게 돼?');
  assert.equal(result.intent, 'PORTFOLIO_WHAT_IF');
  assert.equal(result.request.tool, 'runPortfolioWhatIf');
  if (result.intent !== 'PORTFOLIO_WHAT_IF') assert.fail('what-if intent expected');
  assert.deepEqual(result.request.arguments.shocks, [{ ticker: 'BTCUSDT', changePercent: -10 }]);
  assert.equal(result.toolResult.data.scenarioStatus, 'SIMULATED');
  assert.equal(result.toolResult.data.pnlImpact, -60_000);
  assert.equal(result.toolResult.data.equityAfter, 940_000);
  assert.equal(result.safety.simulationOnly, true);
  assert.equal(result.safety.exchangeRequestSent, false);
  assert.equal(result.safety.orderSubmitted, false);
  assert.equal(result.safety.privateTradingApiRequests, 0);
  assert.deepEqual(snapshot, before);
});

test('numeric KR ticker can be resolved without confusing the shock percentage', () => {
  const result = queryInvestmentCopilot(snapshot, '005930이 5% 하락하면 내 포트는?');
  assert.equal(result.intent, 'PORTFOLIO_WHAT_IF');
  if (result.intent !== 'PORTFOLIO_WHAT_IF') assert.fail('what-if intent expected');
  assert.deepEqual(result.request.arguments.shocks, [{ ticker: '005930', changePercent: -5 }]);
  assert.equal(result.toolResult.data.pnlImpact, -20_000);
});

test('unsupported or execution requests fail closed instead of choosing arbitrary tools', () => {
  assert.throws(
    () => queryInvestmentCopilot(snapshot, '내가 좋아할 만한 영화 추천해줘'),
    (cause) => cause instanceof InvestmentCopilotQueryError && cause.code === 'UNSUPPORTED_QUERY',
  );
  assert.throws(
    () => queryInvestmentCopilot(snapshot, 'BTC 실제 주문 실행해줘'),
    (cause) => cause instanceof InvestmentCopilotQueryError && cause.code === 'ACTION_NOT_ALLOWED' && cause.statusCode === 403,
  );
});
