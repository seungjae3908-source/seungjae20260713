import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FORMULA_AI_LIVE_EXCEPTION_POLICY_VERSION,
  evaluateFormulaAiLiveException, evaluateFormulaAiPaperException,
} from './formula-ai-live-exception.service';
import { evaluateTradingPlan, normalizeTradingPolicy } from './trade-automation-risk.service';
import type { TradingPlanInput } from './trade-automation.types';

const HEX64 = 'a'.repeat(64);

function policy() {
  return normalizeTradingPolicy({
    mode: 'automatic',
    automaticEnabled: true,
    emergencyStopped: false,
    newEntriesStopped: false,
    marketEnabled: {
      domestic_stock: true,
      us_stock: true,
      crypto_spot: true,
      crypto_futures: true,
    },
    stockBrokerByMarket: { domestic_stock: 'kiwoom', us_stock: 'kiwoom' },
    exchangeEnabled: { bitget: true, upbit: true, kiwoom: true, toss: true },
    enabledAssets: { bitget: [], upbit: [], kiwoom: [], toss: [] },
    enabledStrategies: [],
    totalCapitalKrw: 500_000,
    maxOrderKrw: 50_000,
    maxInstrumentKrw: 500_000,
    maxAssetClassKrw: {
      domestic_stock: 500_000,
      us_stock: 500_000,
      crypto_spot: 500_000,
      crypto_futures: 500_000,
    },
    dailyLossLimitPercent: 5,
    weeklyLossLimitPercent: 10,
    maxAssetPercent: 30,
    maxOpenPositions: 5,
    maxDailyOrders: 100,
    maxConsecutiveLosses: 5,
    bitgetLeverage: 7,
    riskOptimizationEnabled: true,
    pilotStage: 'validated',
    riskPerTradePercent: { bitget: 0.5, upbit: 0.5, kiwoom: 0.5, toss: 0.5 },
    totalDailyLossLimitPercent: 1,
    minExpectedValueR: 0.15,
    minStrategySampleSize: 50,
    minProfitFactor: 1.2,
    maxStrategyDrawdownPercent: 15,
    maxEstimatedSlippagePercent: 0.25,
    maxAverageSpreadPercent: 0.15,
    maxCorrelatedExposurePercent: 40,
    maxEconomicsAgeHours: 24,
  });
}

function reasons(strategyId: string) {
  return [
    'CANONICAL_PAPER_HANDOFF',
    'STRATEGY_RULE_PACK:' + strategyId,
    'STRATEGY_RULE_PACK_GATE:PAPER_CANDIDATE',
    'AI_REVIEW_DECISION:PASS',
    'AI_REVIEW_LIVE_ELIGIBLE:PASS_ONLY_ELIGIBLE',
    'AI_REVIEW_EVIDENCE:' + HEX64,
    'AI_REVIEW_EXPIRES:' + new Date(Date.now() + 60_000).toISOString(),
  ];
}

function base(strategyId: string): Omit<TradingPlanInput, 'exchange' | 'market' | 'side'> {
  const now = new Date().toISOString();
  return {
    accountMode: 'live',
    stockBroker: null,
    stockExchange: null,
    strategyId,
    signalId: 'formula-ai-rehearsal:' + strategyId,
    symbol: 'TEST',
    orderType: 'market',
    quantity: 1,
    quoteAmount: null,
    limitPrice: 100_000,
    estimatedKrw: 50_000,
    stopPrice: 99_000,
    targetPrices: [103_000],
    splitRatios: [100],
    leverage: null,
    marginMode: null,
    reduceOnly: false,
    invalidateAction: 'hold',
    signalReasons: reasons(strategyId),
    marketSnapshot: {
      observedAt: now,
      riskObservedAt: now,
      dataDelayMs: 0,
      oneMinuteMovePercent: 0,
      spreadPercent: 0.05,
      orderbookGapPercent: 0.05,
      halted: false,
      availableBalance: 500_000,
      accountValueKrw: 500_000,
      dailyPnlPercent: 0,
      weeklyPnlPercent: 0,
      assetExposurePercent: 0,
      accountExposureKrw: 0,
      instrumentExposureKrw: 0,
      strategyExposureKrw: 0,
      assetClassExposureKrw: 0,
      openRiskKrw: 0,
      openPositionCount: 0,
      dailyOrderCount: 0,
      consecutiveLosses: 0,
      currentPrice: 100_000,
      plannedPrice: 100_000,
      marketStatus: 'OPEN',
      availableLiquidityKrw: 500_000,
      estimatedSlippagePercent: 0.05,
      estimatedFeePercent: 0.05,
      correlatedExposurePercent: 0,
      signalState: 'entry_ready',
      signalObservedAt: now,
    },
    entryPrice: 100_000,
    entryZoneLow: 99_900,
    entryZoneHigh: 100_100,
    estimatedSlippagePercent: 0.05,
    averageSpreadPercent: 0.05,
    economics: {
      sampleSize: 100,
      winProbability: 0.6,
      averageWinR: 2,
      averageLossR: 1,
      estimatedCostsR: 0.05,
      profitFactor: 2,
      maxDrawdownPercent: 5,
      marketRegime: 'bull',
      calibratedAt: now,
    },
  };
}

function krPlan(): TradingPlanInput {
  return {
    ...base('KR_PRESSURE_BREAKOUT_V1'),
    exchange: 'kiwoom',
    stockBroker: 'kiwoom',
    market: 'KR',
    side: 'buy',
    symbol: '005930',
  };
}

function usPlan(): TradingPlanInput {
  return {
    ...base('US_STOCKS_IN_PLAY_ORB_RETEST_V1'),
    exchange: 'kiwoom',
    stockBroker: 'kiwoom',
    stockExchange: 'NASDAQ',
    market: 'US',
    side: 'buy',
    symbol: 'AAPL',
  };
}

function spotPlan(): TradingPlanInput {
  return {
    ...base('CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1'),
    exchange: 'upbit',
    market: 'KRW',
    side: 'buy',
    symbol: 'BTC',
    quantity: null,
    quoteAmount: 50_000,
  };
}

function futuresPlan(side: 'long' | 'short'): TradingPlanInput {
  return {
    ...base('CRYPTO_FUTURES_FLOW_TREND_WAVE_V1'),
    exchange: 'bitget',
    market: 'USDT-FUTURES',
    side,
    symbol: 'BTCUSDT',
    leverage: 7,
    marginMode: 'isolated',
  };
}

test('formula+AI exception bypasses research promotion but preserves operational risk gates across all four markets', () => {
  const currentPolicy = policy();
  for (const plan of [krPlan(), usPlan(), spotPlan(), futuresPlan('long'), futuresPlan('short')]) {
    const exception = evaluateFormulaAiLiveException(plan);
    assert.equal(exception.policyVersion, FORMULA_AI_LIVE_EXCEPTION_POLICY_VERSION);
    assert.equal(exception.allowed, true, plan.strategyId + ':' + exception.blockers.join(','));
    assert.equal(exception.researchPromotionBypassed, true);
    assert.deepEqual(exception.bypassedResearchGates, [
      'OOS', 'WALK_FORWARD', 'FULL_COST', 'STRATEGY_HEALTH', 'PROFITABILITY_ATTESTATION', 'PROMOTION',
    ]);
    const risk = evaluateTradingPlan(plan, currentPolicy, {
      emergencyStopped: false,
      serverLiveEnabled: true,
    });
    assert.equal(risk.allowed, true, plan.strategyId + ':' + risk.blockCodes.join(','));
    assert.equal(risk.blockCodes.includes('SERVER_PROFITABILITY_ATTESTATION_REQUIRED'), false);
    assert.ok(risk.warnings.includes('FORMULA_AI_LIVE_EXCEPTION_V1:RESEARCH_PROMOTION_BYPASSED'));
  }
});

test('dedicated formula-ai pilot stage allows only a valid formula+AI live exception', () => {
  const exceptionPolicy = normalizeTradingPolicy({
    ...policy(),
    pilotStage: 'formula-ai-exception',
  });
  const allowed = evaluateTradingPlan(spotPlan(), exceptionPolicy, {
    emergencyStopped: false,
    serverLiveEnabled: true,
  });
  assert.equal(allowed.blockCodes.includes('PILOT_LIVE_DISABLED'), false);
  assert.equal(allowed.blockCodes.includes('PILOT_FORMULA_AI_EXCEPTION_REQUIRED'), false);
  assert.equal(allowed.allowed, true, allowed.blockCodes.join(','));

  const missingAi = spotPlan();
  missingAi.signalReasons = missingAi.signalReasons.filter((reason) => reason !== 'AI_REVIEW_DECISION:PASS');
  const blocked = evaluateTradingPlan(missingAi, exceptionPolicy, {
    emergencyStopped: false,
    serverLiveEnabled: true,
  });
  assert.ok(blocked.blockCodes.includes('PILOT_FORMULA_AI_EXCEPTION_REQUIRED'));
});

test('formula+AI exception bypasses historical economics while operational risk remains required', () => {
  const currentPolicy = normalizeTradingPolicy({
    ...policy(),
    pilotStage: 'formula-ai-exception',
  });
  const plan = spotPlan();
  plan.economics = null;
  const allowed = evaluateTradingPlan(plan, currentPolicy, {
    emergencyStopped: false,
    serverLiveEnabled: true,
  });
  assert.equal(allowed.blockCodes.includes('ECONOMICS_REQUIRED'), false);
  assert.equal(allowed.blockCodes.includes('PROFIT_FACTOR_REQUIRED'), false);
  assert.equal(allowed.blockCodes.includes('STRATEGY_DRAWDOWN_REQUIRED'), false);
  assert.equal(allowed.allowed, true, allowed.blockCodes.join(','));

  const noSpread = spotPlan();
  noSpread.economics = null;
  noSpread.averageSpreadPercent = null;
  const blocked = evaluateTradingPlan(noSpread, currentPolicy, {
    emergencyStopped: false,
    serverLiveEnabled: true,
  });
  assert.ok(blocked.blockCodes.includes('AVERAGE_SPREAD_REQUIRED'));
});

test('exception fails closed when AI PASS identity is missing', () => {
  const plan = spotPlan();
  plan.signalReasons = plan.signalReasons.filter((reason) => reason !== 'AI_REVIEW_DECISION:PASS');
  const exception = evaluateFormulaAiLiveException(plan);
  assert.equal(exception.allowed, false);
  assert.ok(exception.blockers.includes('FORMULA_AI_EXCEPTION_AI_PASS_REQUIRED'));
});

test('exception never bypasses isolated margin, leverage, or cash-market direction policy', () => {
  const futures = futuresPlan('long');
  futures.marginMode = 'crossed';
  assert.equal(evaluateFormulaAiLiveException(futures).allowed, false);

  const overLeverage = futuresPlan('long');
  overLeverage.leverage = 8 as never;
  assert.equal(evaluateFormulaAiLiveException(overLeverage).allowed, false);

  const spot = spotPlan();
  spot.side = 'sell';
  assert.equal(evaluateFormulaAiLiveException(spot).allowed, false);
});

test('authorized formula+AI Paper candidate bypasses only research economics, preserving live false', () => {
  const paper = { ...spotPlan(), accountMode: 'paper' as const, economics: null };
  const status = evaluateFormulaAiPaperException(paper);
  assert.equal(status.allowed, true, status.blockers.join(','));
  assert.equal(status.researchPromotionBypassed, true);
  const prepared = normalizeTradingPolicy({ ...policy(), pilotStage: 'formula-ai-exception' });
  const simulated = evaluateTradingPlan(paper, prepared, {
    emergencyStopped: false, serverLiveEnabled: false,
  });
  assert.equal(simulated.allowed, true, simulated.blockCodes.join(','));
  assert.ok(simulated.warnings.includes('FORMULA_AI_PAPER_EXCEPTION_V1:RESEARCH_PROMOTION_BYPASSED'));
  assert.equal(simulated.blockCodes.includes('ECONOMICS_REQUIRED'), false);
  const stale = { ...paper, signalReasons: paper.signalReasons.filter(
    (reason) => reason !== 'AI_REVIEW_DECISION:PASS',
  ) };
  const blocked = evaluateTradingPlan(stale, prepared, {
    emergencyStopped: false, serverLiveEnabled: false,
  });
  assert.ok(blocked.blockCodes.includes('ECONOMICS_REQUIRED'));
  assert.equal(evaluateFormulaAiPaperException(spotPlan()).allowed, false);
});

test('formula+AI Paper exception cannot bypass spread, daily loss, stop, or liquidity gates', () => {
  const prepared = normalizeTradingPolicy({ ...policy(), pilotStage: 'formula-ai-exception' });
  const paper = { ...spotPlan(), accountMode: 'paper' as const, economics: null };
  const badCost = { ...paper, averageSpreadPercent: null };
  assert.ok(evaluateTradingPlan(badCost, prepared, {
    emergencyStopped: false, serverLiveEnabled: false,
  }).blockCodes.includes('AVERAGE_SPREAD_REQUIRED'));
  const stopped = { ...paper,
    marketSnapshot: { ...paper.marketSnapshot, dailyPnlPercent: -5.1 },
  };
  assert.ok(evaluateTradingPlan(stopped, prepared, {
    emergencyStopped: false, serverLiveEnabled: false,
  }).blockCodes.includes('DAILY_LOSS_LIMIT'));
  const noStop = { ...paper, stopPrice: 0 };
  assert.ok(evaluateTradingPlan(noStop, prepared, {
    emergencyStopped: false, serverLiveEnabled: false,
  }).blockCodes.includes('EXIT_PLAN_REQUIRED'));
});

test('Paper-only exploratory trading keeps required cost/risk checks without inventing profitability', () => {
  const p = normalizeTradingPolicy({ ...policy(), pilotStage:'validated' });
  const trade: TradingPlanInput = {
    ...spotPlan(), accountMode:'paper', economics:null,
    signalReasons:['CANONICAL_PAPER_HANDOFF'],
  };
  const simulated = evaluateTradingPlan(trade,p,{
    emergencyStopped:false,serverLiveEnabled:false,
  });
  assert.equal(simulated.blockCodes.includes('ECONOMICS_REQUIRED'),false);
  assert.ok(simulated.warnings.includes('PAPER_RESEARCH_ONLY_NO_PROFITABILITY_EVIDENCE'));
  assert.equal(simulated.allowed,true,simulated.blockCodes.join(','));

  const spread = {
    ...trade,averageSpreadPercent:null,
  };
  assert.ok(evaluateTradingPlan(spread,p,{
    emergencyStopped:false,serverLiveEnabled:false,
  }).blockCodes.includes('AVERAGE_SPREAD_REQUIRED'));

  const live:TradingPlanInput = { ...trade,accountMode:'live' };
  const notLive = evaluateTradingPlan(live,p,{
    emergencyStopped:false,serverLiveEnabled:true,
  });
  assert.ok(notLive.blockCodes.includes('SERVER_PROFITABILITY_ATTESTATION_REQUIRED'));
  assert.equal(notLive.warnings.includes('PAPER_RESEARCH_ONLY_NO_PROFITABILITY_EVIDENCE'),false);
});
