import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import { DEFAULT_TRADING_POLICY, type TradingPlanInput } from './trade-automation.types';
import { normalizeTradingPolicy } from './trade-automation-risk.service';

const USER_ID = '33333333-3333-3333-3333-333333333333';

function plan(signalId: string): TradingPlanInput {
  const observedAt = new Date().toISOString();
  return {
    exchange: 'upbit', accountMode: 'paper', strategyId: 'mi-test', signalId,
    symbol: 'KRW-BTC', market: 'KRW', side: 'buy', orderType: 'market', quantity: null,
    quoteAmount: 100_000, limitPrice: null, estimatedKrw: 100_000, stopPrice: 90_000,
    targetPrices: [110_000], splitRatios: [100], leverage: null, marginMode: null,
    reduceOnly: false, invalidateAction: 'hold', signalReasons: ['quant'],
    marketSnapshot: {
      observedAt, riskObservedAt: observedAt, dataDelayMs: 0, oneMinuteMovePercent: 0.2,
      spreadPercent: 0.05, orderbookGapPercent: 0.05, halted: false, availableBalance: 1_000_000,
      accountValueKrw: 5_000_000, dailyPnlPercent: 0, assetExposurePercent: 5,
      openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0,
      currentPrice: 100_000, plannedPrice: 100_000, marketStatus: 'OPEN',
      availableLiquidityKrw: 5_000_000, estimatedSlippagePercent: 0.05, estimatedFeePercent: 0.05,
      correlatedExposurePercent: 0, signalState: 'entry_ready', signalObservedAt: observedAt,
    },
  };
}

function sidecar(mode: 'PAPER_ONLY' | 'BLOCKED_RISK' | 'ELIGIBLE_FOR_PARENT_GATE', hardBlockReason: string | null = null) {
  return new Response(JSON.stringify({
    ok: true,
    serviceSha: 'mi-test-sha',
    result: {
      safety: {
        executionAuthority: 'NONE', privateTradingApiAllowed: false,
        realOrderAllowed: false, orderSubmissionAllowed: false,
      },
      scanner: {
        mode: 'SOFT_INTELLIGENCE_LAYER', adjustment: 3, intelligenceScore: 60,
        bullishScore: 60, bearishScore: 40, hardBlockReason, candidateDeletionAllowed: false,
      },
      autoTrading: {
        mode, orderAllowed: false, evidenceReady: mode === 'ELIGIBLE_FOR_PARENT_GATE',
        parentEligibilityReady: mode === 'ELIGIBLE_FOR_PARENT_GATE', hardBlockReason,
      },
      warnings: [],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function withFetchMock<T>(mock: typeof fetch, run: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('canonical trade plan creation blocks Market Intelligence BLOCKED_RISK with zero orders', async () => {
  await withFetchMock(async () => sidecar('BLOCKED_RISK', 'STALE_INTELLIGENCE_DATA'), async () => {
    const repository = new InMemoryTradingRepository();
    const service = new TradeAutomationService(repository);
    const result = await service.createPlan(USER_ID, plan('mi-block-create'), normalizeTradingPolicy(DEFAULT_TRADING_POLICY), false);
    assert.equal(result.plan, null);
    assert.ok(result.decision.blockCodes.includes('STALE_INTELLIGENCE_DATA'));
    assert.equal((await repository.listOrders(USER_ID)).length, 0);
  });
});

test('approval rechecks Market Intelligence and expires plan if risk turns blocked', async () => {
  let call = 0;
  await withFetchMock(async () => {
    call += 1;
    return call === 1 ? sidecar('PAPER_ONLY') : sidecar('BLOCKED_RISK', 'SPREAD_LIMIT_EXCEEDED');
  }, async () => {
    const repository = new InMemoryTradingRepository();
    const service = new TradeAutomationService(repository);
    const created = await service.createPlan(USER_ID, plan('mi-recheck'), normalizeTradingPolicy(DEFAULT_TRADING_POLICY), false);
    assert.ok(created.plan);
    await assert.rejects(
      () => service.approvePlan(USER_ID, created.plan!.id),
      /TRADE_PLAN_MARKET_INTELLIGENCE_FAILED:SPREAD_LIMIT_EXCEEDED/,
    );
    assert.equal((await repository.getPlan(USER_ID, created.plan!.id))?.state, 'EXPIRED');
    assert.equal((await repository.listOrders(USER_ID)).length, 0);
  });
});
