import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_MENTOR_SECTION_ORDER,
  STRATEGY_PROMOTION_PIPELINE,
  assessHistoricalDataset,
  buildValidationFolds,
  calculateExecutionAwareTrade,
  createAiMentorAnalysis,
  createShadowTradeRecord,
  evaluatePortfolioAdditionalBuy,
  evaluatePromotionPipeline,
  settleShadowTradeRecord,
  summarizeResearchPerformance,
  upsertShadowTradeLedger,
} from "../src/research-validation-layer.js";

const baseUniverse = Object.freeze([
  Object.freeze({ symbol: "AAA", listedAt: 1 }),
  Object.freeze({ symbol: "BBB", listedAt: 1, delistedAt: 9_000 }),
]);

function candle(symbol, timestamp, close = 100) {
  return Object.freeze({
    symbol,
    timestamp,
    observedAt: timestamp,
    isClosed: true,
    open: close,
    high: close + 2,
    low: close - 2,
    close,
  });
}

function mentorSections() {
  return Object.fromEntries(AI_MENTOR_SECTION_ORDER.map((key) => [key, `${key} 분석` ]));
}

function portfolioInput(overrides = {}) {
  return {
    portfolio: { equity: 10_000, totalExposure: 2_000, symbolExposure: 800, ...(overrides.portfolio ?? {}) },
    currentPosition: { quantity: 10, averagePrice: 100, currentPrice: 110, ...(overrides.currentPosition ?? {}) },
    proposal: { amount: 500, price: 108, stop: 100, target1: 120, target2: 130, ...(overrides.proposal ?? {}) },
    risk: {
      correlation: 0.3,
      maxCorrelation: 0.8,
      maxPortfolioExposure: 5_000,
      maxSymbolExposure: 2_000,
      thesisValid: true,
      dataStale: false,
      partialMarketData: false,
      liquidityOk: true,
      invalidationTriggered: false,
      ...(overrides.risk ?? {}),
    },
  };
}

test("strategy promotion pipeline is ordered and live approval stays outside automatic promotion", () => {
  assert.deepEqual(STRATEGY_PROMOTION_PIPELINE, [
    "strategy",
    "historical_backtest",
    "out_of_sample",
    "walk_forward",
    "replay",
    "paper",
    "shadow",
    "approval_live",
  ]);
  const stages = Object.fromEntries(STRATEGY_PROMOTION_PIPELINE.slice(0, -1).map((stage) => [stage, { passed: true }]));
  const candidate = evaluatePromotionPipeline({ strategyId: "mean-reversion-v3", stages });
  assert.equal(candidate.status, "promotion_candidate");
  assert.equal(candidate.nextStage, "approval_live");
  assert.equal(candidate.automaticLivePromotion, false);
  assert.equal(candidate.liveApproved, false);
  assert.equal(candidate.liveOrderAllowed, false);
  assert.equal(candidate.privateAccountRequestAllowed, false);

  const held = evaluatePromotionPipeline({
    strategyId: "mean-reversion-v3",
    stages: { ...stages, paper: { passed: false } },
  });
  assert.equal(held.status, "research_hold");
  assert.equal(held.blockedAt, "paper");
});

test("historical dataset safeguard blocks lookahead, duplicates, missing data and absent survivorship protection", () => {
  const complete = [
    candle("AAA", 1_000), candle("AAA", 2_000), candle("AAA", 3_000),
    candle("BBB", 1_000), candle("BBB", 2_000), candle("BBB", 3_000),
  ];
  const healthy = assessHistoricalDataset({
    candles: complete,
    asOf: 4_000,
    expectedIntervalMs: 1_000,
    universe: baseUniverse,
    universeSnapshotAt: 1_000,
    universeIncludesDelisted: true,
    maximumMissingRatio: 0,
  });
  assert.equal(healthy.eligible, true);
  assert.equal(healthy.safeguards.lookaheadBlocked, true);
  assert.equal(healthy.safeguards.duplicateEventsBlocked, true);
  assert.equal(healthy.safeguards.survivorshipProtected, true);

  const missing = assessHistoricalDataset({
    candles: [candle("AAA", 1_000), candle("AAA", 3_000)],
    asOf: 4_000,
    expectedIntervalMs: 1_000,
    universe: [{ symbol: "AAA" }],
    universeSnapshotAt: 1_000,
    universeIncludesDelisted: true,
    maximumMissingRatio: 0.1,
  });
  assert.equal(missing.eligible, false);
  assert.ok(missing.missingRatio > 0.1);
  assert.ok(missing.blockedReasons.includes("missing_data_ratio_exceeded"));

  const survivorshipUnsafe = assessHistoricalDataset({
    candles: complete,
    asOf: 4_000,
    expectedIntervalMs: 1_000,
    universe: baseUniverse,
    universeSnapshotAt: 1_000,
    universeIncludesDelisted: false,
    maximumMissingRatio: 0,
  });
  assert.equal(survivorshipUnsafe.eligible, false);
  assert.ok(survivorshipUnsafe.blockedReasons.includes("survivorship_guard_missing_delisted_universe"));

  assert.throws(() => assessHistoricalDataset({
    candles: [candle("AAA", 1_000), candle("AAA", 5_000)],
    asOf: 4_000,
    expectedIntervalMs: 1_000,
    universe: [{ symbol: "AAA" }],
    universeSnapshotAt: 1_000,
    universeIncludesDelisted: true,
  }), (error) => error?.code === "LOOKAHEAD_CANDLE");

  assert.throws(() => assessHistoricalDataset({
    candles: [candle("AAA", 1_000), candle("AAA", 1_000)],
    asOf: 4_000,
    expectedIntervalMs: 1_000,
    universe: [{ symbol: "AAA" }],
    universeSnapshotAt: 1_000,
    universeIncludesDelisted: true,
  }), (error) => error?.code === "DUPLICATE_EVENT");
});

test("purged split is deterministic and removes train-validation-test label overlap", () => {
  const records = Array.from({ length: 100 }, (_, index) => ({
    id: index,
    anchorTimestamp: index * 10,
    futureEndTimestamp: index * 10 + 15,
  }));
  const options = { trainSize: 24, validationSize: 8, testSize: 8, stepSize: 8, embargoMs: 5 };
  const first = buildValidationFolds(records, options);
  const second = buildValidationFolds([...records].reverse(), options);
  assert.deepEqual(first, second);
  assert.ok(first.length > 1);
  for (const fold of first) {
    assert.equal(fold.leakFree, true);
    assert.ok(fold.outOfSample[0].anchorTimestamp > fold.report.maxTrainFuture);
    assert.ok(fold.walkForwardTest[0].anchorTimestamp > fold.report.maxValidationFuture);
  }
});

test("execution model charges fees, slippage, spread and latency before reporting hypothetical PnL", () => {
  const result = calculateExecutionAwareTrade({
    market: "KR_STOCK",
    action: "BUY",
    entryPrice: 100,
    exitPrice: 110,
    quantity: 10,
    leverage: 1,
    entryFeeRate: 0.001,
    exitFeeRate: 0.001,
    taxRate: 0.002,
    slippageRate: 0.001,
    spreadRate: 0.002,
    latencyBars: 2,
    latencyDriftRate: 0.001,
  });
  assert.ok(result.preExecutionGrossPnl > result.netPnl);
  assert.ok(result.costs.entryFee > 0);
  assert.ok(result.costs.exitFee > 0);
  assert.ok(result.costs.slippage > 0);
  assert.ok(result.costs.spread > 0);
  assert.ok(result.costs.latency > 0);
  assert.ok(result.costs.total > result.costs.entryFee + result.costs.exitFee);
  assert.equal(result.executionModel.latencyBars, 2);
});

test("performance summary never relies on win rate alone and segments by market strategy timeframe and regime", () => {
  const trades = [
    { netPnl: 100, entryNotional: 1_000, netReturnOnMargin: 0.10, market: "KR_STOCK", strategy: "s1", timeframe: "1h", regime: "bull", costs: { entryFee: 1, exitFee: 1, slippage: 2, spread: 1, latency: 1 } },
    { netPnl: -50, entryNotional: 1_000, netReturnOnMargin: -0.05, market: "KR_STOCK", strategy: "s1", timeframe: "1h", regime: "range", costs: { entryFee: 1, exitFee: 1, slippage: 2, spread: 1, latency: 1 } },
    { netPnl: -25, entryNotional: 1_000, netReturnOnMargin: -0.025, market: "CRYPTO_SPOT", strategy: "s2", timeframe: "15m", regime: "range", costs: { entryFee: 1, exitFee: 1, slippage: 2, spread: 1, latency: 1 } },
    { netPnl: 75, entryNotional: 1_000, netReturnOnMargin: 0.075, market: "CRYPTO_SPOT", strategy: "s2", timeframe: "15m", regime: "bull", costs: { entryFee: 1, exitFee: 1, slippage: 2, spread: 1, latency: 1 } },
  ];
  const summary = summarizeResearchPerformance(trades, { initialCapital: 10_000 });
  assert.equal(summary.overall.sampleCount, 4);
  assert.equal(summary.overall.totalReturn, 0.01);
  assert.equal(summary.overall.expectancy, 25);
  assert.equal(summary.overall.winRate, 0.5);
  assert.equal(summary.overall.averageWin, 87.5);
  assert.equal(summary.overall.averageLoss, 37.5);
  assert.equal(summary.overall.maximumConsecutiveLosses, 2);
  assert.equal(summary.overall.turnover, 0.4);
  assert.ok(summary.overall.profitFactor > 2);
  assert.ok(summary.overall.maximumDrawdown > 0);
  assert.ok(Number.isFinite(summary.overall.tradeSharpe));
  assert.ok(summary.overall.feeCost > 0);
  assert.ok(summary.overall.slippageCost > 0);
  assert.ok(summary.overall.spreadCost > 0);
  assert.ok(summary.overall.latencyCost > 0);
  assert.deepEqual(Object.keys(summary.byMarket).sort(), ["CRYPTO_SPOT", "KR_STOCK"]);
  assert.deepEqual(Object.keys(summary.byStrategy).sort(), ["s1", "s2"]);
  assert.deepEqual(Object.keys(summary.byTimeframe).sort(), ["15m", "1h"]);
  assert.deepEqual(Object.keys(summary.byRegime).sort(), ["bull", "range"]);
});

test("shadow records are deterministic, account-isolated and settle PnL MAE MFE without orders", () => {
  const record = createShadowTradeRecord({
    signalId: "signal-123",
    strategy: "breakout-v2",
    asset: "005930",
    market: "KR_STOCK",
    timeframe: "15m",
    timestamp: 1_000,
    entryPlan: { action: "BUY", entryPrice: 100, quantity: 10, leverage: 1 },
    stop: 95,
    targets: [110, 120],
    invalidation: "15m close below 95",
    feesSlippageModel: { entryFeeRate: 0.001, exitFeeRate: 0.001, taxRate: 0.002, slippageRate: 0.001, spreadRate: 0.001, latencyBars: 1, latencyDriftRate: 0.001 },
  });
  assert.equal(record.orderSubmitted, false);
  assert.equal(record.privateAccountRequested, false);

  const futureCandles = [
    { timestamp: 1_100, high: 106, low: 97, close: 104 },
    { timestamp: 1_200, high: 112, low: 94, close: 109 },
  ];
  const first = settleShadowTradeRecord(record, { futureCandles, exitPrice: 109, exitTimestamp: 1_300, marketResult: { reason: "replay_end" } });
  const second = settleShadowTradeRecord(record, { futureCandles: [...futureCandles], exitPrice: 109, exitTimestamp: 1_300, marketResult: { reason: "replay_end" } });
  assert.deepEqual(first, second);
  assert.equal(first.status, "settled");
  assert.ok(first.hypotheticalPnl > 0);
  assert.ok(first.mae < 0);
  assert.ok(first.mfe > 0);
  assert.equal(first.orderSubmitted, false);
  assert.equal(first.privateAccountRequested, false);
  assert.equal(first.execution.costs.total > 0, true);
});

test("shadow ledger is duplicate-idempotent and rejects conflicting duplicates and stale race writes", () => {
  const input = {
    signalId: "same-signal",
    strategy: "s1",
    asset: "BTCUSDT",
    market: "CRYPTO_FUTURES",
    timestamp: 5_000,
    entryPlan: { action: "LONG", entryPrice: 100, quantity: 1, leverage: 2 },
    stop: 95,
    targets: [110],
    invalidation: "close below stop",
    feesSlippageModel: { entryFeeRate: 0.001, exitFeeRate: 0.001, fundingRates: [0], slippageRate: 0.001 },
  };
  const record = createShadowTradeRecord(input);
  const written = upsertShadowTradeLedger({ version: 0, records: [] }, record, { expectedVersion: 0 });
  assert.equal(written.version, 1);
  assert.equal(written.duplicate, false);
  const duplicate = upsertShadowTradeLedger(written, record, { expectedVersion: 1 });
  assert.equal(duplicate.version, 1);
  assert.equal(duplicate.duplicate, true);

  const conflict = createShadowTradeRecord({ ...input, stop: 94 });
  assert.equal(conflict.id, record.id);
  assert.throws(() => upsertShadowTradeLedger(written, conflict, { expectedVersion: 1 }), (error) => error?.code === "SHADOW_DUPLICATE_CONFLICT");
  assert.throws(() => upsertShadowTradeLedger(written, createShadowTradeRecord({ ...input, signalId: "new-signal" }), { expectedVersion: 0 }), (error) => error?.code === "SHADOW_LEDGER_VERSION_CONFLICT");
});

test("portfolio loss does not become automatic averaging-down advice", () => {
  const conditional = evaluatePortfolioAdditionalBuy(portfolioInput({
    currentPosition: { quantity: 10, averagePrice: 100, currentPrice: 90 },
    proposal: { price: 90, amount: 500, stop: 84, target1: 100, target2: 108 },
  }));
  assert.equal(conditional.classification, "conditional_additional_buy");
  assert.ok(conditional.conditionalReasons.includes("loss_alone_never_justifies_averaging_down"));
  assert.equal(conditional.calculationsAvailable, true);

  const prohibited = evaluatePortfolioAdditionalBuy(portfolioInput({ risk: { dataStale: true } }));
  assert.equal(prohibited.classification, "additional_buy_prohibited");
  assert.ok(prohibited.reasons.includes("stale_market_data"));
  assert.equal(prohibited.calculationsAvailable, false);
  assert.equal(prohibited.expectedAveragePrice, null);

  const partial = evaluatePortfolioAdditionalBuy(portfolioInput({ risk: { partialMarketData: true } }));
  assert.equal(partial.classification, "additional_buy_prohibited");
  assert.ok(partial.reasons.includes("partial_market_data"));
});

test("portfolio allowed case calculates amount average stop targets loss exposure and correlation", () => {
  const allowed = evaluatePortfolioAdditionalBuy(portfolioInput());
  assert.equal(allowed.classification, "additional_buy_allowed");
  assert.equal(allowed.additionalAmount, 500);
  assert.ok(allowed.additionalQuantity > 0);
  assert.ok(allowed.expectedAveragePrice > 100 && allowed.expectedAveragePrice < 108);
  assert.equal(allowed.stop, 100);
  assert.equal(allowed.target1, 120);
  assert.equal(allowed.target2, 130);
  assert.ok(allowed.maximumAdditionalLoss > 0);
  assert.equal(allowed.totalExposure, 2_500);
  assert.equal(allowed.totalExposureRatio, 0.25);
  assert.equal(allowed.symbolExposure, 1_300);
  assert.equal(allowed.correlation, 0.3);
});

test("empty portfolio is handled without inventing an existing average price", () => {
  const empty = evaluatePortfolioAdditionalBuy(portfolioInput({
    portfolio: { totalExposure: 0, symbolExposure: 0 },
    currentPosition: { quantity: 0, averagePrice: undefined, currentPrice: 108 },
  }));
  assert.equal(empty.classification, "additional_buy_allowed");
  assert.equal(empty.expectedAveragePrice, 108);
  assert.equal(empty.symbolExposure, 500);
});

test("AI mentor enforces section order, timestamps, stale and insufficient-data metadata", () => {
  const sections = mentorSections();
  const analysis = createAiMentorAnalysis({
    sections,
    dataTimestamp: 1_000,
    generatedAt: 2_000,
    staleAfterMs: 500,
    insufficientData: false,
    partialMarketData: false,
  });
  assert.deepEqual(analysis.sectionOrder, AI_MENTOR_SECTION_ORDER);
  assert.equal(analysis.dataTimestamp, 1_000);
  assert.equal(analysis.analysisGeneratedAt, 2_000);
  assert.equal(analysis.stale, true);
  assert.equal(analysis.insufficientData, false);
  assert.equal(analysis.profitGuaranteeLanguageAllowed, false);

  const partial = createAiMentorAnalysis({
    sections,
    dataTimestamp: 1_000,
    generatedAt: 1_100,
    staleAfterMs: 500,
    partialMarketData: true,
  });
  assert.equal(partial.stale, false);
  assert.equal(partial.insufficientData, true);
  assert.equal(partial.partialMarketData, true);
});

test("AI mentor rejects profit-guarantee wording and flags missing sections", () => {
  const unsafe = mentorSections();
  unsafe.bullScenario = "이 조건이면 수익 보장";
  assert.throws(() => createAiMentorAnalysis({
    sections: unsafe,
    dataTimestamp: 1_000,
    generatedAt: 1_100,
    staleAfterMs: 500,
  }), (error) => error?.code === "PROFIT_GUARANTEE_LANGUAGE");

  const incomplete = mentorSections();
  delete incomplete.volumeLiquidity;
  const analysis = createAiMentorAnalysis({
    sections: incomplete,
    dataTimestamp: 1_000,
    generatedAt: 1_100,
    staleAfterMs: 500,
  });
  assert.equal(analysis.insufficientData, true);
  assert.ok(analysis.missingSections.includes("volumeLiquidity"));
});
