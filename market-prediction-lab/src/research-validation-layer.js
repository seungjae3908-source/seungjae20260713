import { createHash } from "node:crypto";
import {
  ResearchContractError,
  calculateSignalExcursion,
  calculateTradeResult,
  createPurgedWalkForwardFolds,
} from "./research-governance.js";
import { stableStringify } from "./data-quality.js";

export const STRATEGY_PROMOTION_PIPELINE = Object.freeze([
  "strategy",
  "historical_backtest",
  "out_of_sample",
  "walk_forward",
  "replay",
  "paper",
  "shadow",
  "approval_live",
]);

export const AI_MENTOR_SECTION_ORDER = Object.freeze([
  "marketSituation",
  "assetTrend",
  "technicalAnalysis",
  "volumeLiquidity",
  "supportResistance",
  "positiveFactors",
  "negativeFactors",
  "risks",
  "bearScenario",
  "baseScenario",
  "bullScenario",
  "invalidationCondition",
  "responsePlan",
]);

const GUARANTEE_PATTERNS = Object.freeze([
  /수익\s*보장/iu,
  /원금\s*보장/iu,
  /무조건\s*(오른|상승|수익|번)/iu,
  /반드시\s*(오른|상승|수익|번)/iu,
  /100\s*%\s*(수익|상승|확실|보장)/iu,
  /guaranteed?\s+(profit|return)/iu,
  /risk[- ]?free\s+(profit|return)/iu,
  /certain\s+profit/iu,
]);

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ResearchContractError("NON_FINITE_NUMBER", `${label} must be finite`, { label, value });
  }
  return value;
}

function positive(value, label) {
  finite(value, label);
  if (!(value > 0)) throw new ResearchContractError("NON_POSITIVE_NUMBER", `${label} must be greater than zero`, { label, value });
  return value;
}

function rate(value, label) {
  finite(value, label);
  if (value < 0 || value >= 1) throw new ResearchContractError("INVALID_RATE", `${label} must be between 0 and 1`, { label, value });
  return value;
}

function readonlyClone(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(readonlyClone));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, readonlyClone(nested)])));
  }
  return value;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sampleStd(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function maximumConsecutiveLosses(trades) {
  let current = 0;
  let maximum = 0;
  for (const trade of trades) {
    if (trade.netPnl < 0) {
      current += 1;
      maximum = Math.max(maximum, current);
    } else {
      current = 0;
    }
  }
  return maximum;
}

function drawdownStats(trades, initialCapital) {
  let equity = initialCapital;
  let peak = initialCapital;
  let maximumDrawdown = 0;
  let maximumDrawdownPercent = 0;
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    const drawdown = peak - equity;
    const drawdownPercent = peak > 0 ? drawdown / peak : 0;
    maximumDrawdown = Math.max(maximumDrawdown, drawdown);
    maximumDrawdownPercent = Math.max(maximumDrawdownPercent, drawdownPercent);
  }
  return Object.freeze({
    finalCapital: equity,
    maximumDrawdown,
    maximumDrawdownPercent,
  });
}

function summarizePerformanceGroup(trades, initialCapital) {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const netPnl = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  const drawdown = drawdownStats(trades, initialCapital);
  const tradeReturns = trades.map((trade) => {
    if (Number.isFinite(trade.netReturnOnMargin)) return trade.netReturnOnMargin;
    const denominator = Number.isFinite(trade.entryNotional) && trade.entryNotional > 0 ? trade.entryNotional : initialCapital;
    return denominator > 0 ? trade.netPnl / denominator : 0;
  });
  const std = sampleStd(tradeReturns);
  const entryNotional = trades.reduce((sum, trade) => sum + (Number.isFinite(trade.entryNotional) ? Math.abs(trade.entryNotional) : 0), 0);
  const feeCost = trades.reduce((sum, trade) => sum + (trade.costs?.entryFee ?? 0) + (trade.costs?.exitFee ?? 0) + (trade.costs?.tax ?? 0) + (trade.costs?.funding ?? 0), 0);
  const slippageCost = trades.reduce((sum, trade) => sum + (trade.costs?.slippage ?? 0), 0);
  const spreadCost = trades.reduce((sum, trade) => sum + (trade.costs?.spread ?? 0), 0);
  const latencyCost = trades.reduce((sum, trade) => sum + (trade.costs?.latency ?? 0), 0);
  return Object.freeze({
    sampleCount: trades.length,
    totalReturn: initialCapital > 0 ? netPnl / initialCapital : 0,
    netPnl,
    expectancy: trades.length ? netPnl / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    maximumDrawdown: drawdown.maximumDrawdown,
    maximumDrawdownPercent: drawdown.maximumDrawdownPercent,
    tradeSharpe: std > 0 ? mean(tradeReturns) / std * Math.sqrt(tradeReturns.length) : null,
    winRate: trades.length ? wins.length / trades.length : 0,
    averageWin: mean(wins.map((trade) => trade.netPnl)),
    averageLoss: Math.abs(mean(losses.map((trade) => trade.netPnl))),
    maximumConsecutiveLosses: maximumConsecutiveLosses(trades),
    turnover: initialCapital > 0 ? entryNotional / initialCapital : 0,
    feeCost,
    slippageCost,
    spreadCost,
    latencyCost,
    totalExecutionCost: feeCost + slippageCost + spreadCost + latencyCost,
    finalCapital: drawdown.finalCapital,
  });
}

function groupBy(trades, selector, initialCapital) {
  const groups = new Map();
  for (const trade of trades) {
    const key = String(selector(trade) ?? "unknown");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return Object.freeze(Object.fromEntries([...groups.entries()].map(([key, rows]) => [key, summarizePerformanceGroup(rows, initialCapital)])));
}

export function assessHistoricalDataset({
  candles,
  asOf,
  expectedIntervalMs,
  universe,
  universeSnapshotAt,
  universeIncludesDelisted = false,
  maximumMissingRatio = 0.01,
}) {
  if (!Array.isArray(candles) || candles.length === 0) throw new ResearchContractError("EMPTY_CANDLES", "historical candles are required");
  if (!Array.isArray(universe) || universe.length === 0) throw new ResearchContractError("EMPTY_UNIVERSE", "historical universe is required");
  if (!Number.isInteger(asOf) || asOf <= 0) throw new ResearchContractError("INVALID_AS_OF", "asOf must be a positive integer");
  if (!Number.isInteger(universeSnapshotAt) || universeSnapshotAt <= 0 || universeSnapshotAt > asOf) {
    throw new ResearchContractError("INVALID_UNIVERSE_SNAPSHOT", "universeSnapshotAt must not be in the future");
  }
  positive(expectedIntervalMs, "expectedIntervalMs");
  rate(maximumMissingRatio, "maximumMissingRatio");

  const universeSymbols = new Set();
  for (const [index, member] of universe.entries()) {
    if (!member || typeof member.symbol !== "string" || member.symbol.length === 0) {
      throw new ResearchContractError("INVALID_UNIVERSE_MEMBER", `universe[${index}] is invalid`);
    }
    if (universeSymbols.has(member.symbol)) throw new ResearchContractError("DUPLICATE_UNIVERSE_MEMBER", `duplicate universe symbol: ${member.symbol}`);
    universeSymbols.add(member.symbol);
    if (member.delistedAt !== undefined && member.delistedAt !== null && (!Number.isInteger(member.delistedAt) || member.delistedAt <= 0)) {
      throw new ResearchContractError("INVALID_DELISTED_AT", `universe[${index}].delistedAt is invalid`);
    }
  }

  const seen = new Set();
  const bySymbol = new Map();
  const blockedReasons = [];
  for (const [index, candle] of candles.entries()) {
    if (!candle || typeof candle.symbol !== "string" || !universeSymbols.has(candle.symbol)) {
      throw new ResearchContractError("SYMBOL_OUTSIDE_UNIVERSE", `candles[${index}] symbol is not represented in the historical universe`);
    }
    if (!Number.isInteger(candle.timestamp) || candle.timestamp <= 0 || candle.timestamp > asOf) {
      throw new ResearchContractError("LOOKAHEAD_CANDLE", `candles[${index}] timestamp is invalid or in the future`);
    }
    if (candle.isClosed === false) throw new ResearchContractError("OPEN_CANDLE", `candles[${index}] is not closed`);
    if (candle.observedAt !== undefined && (!Number.isInteger(candle.observedAt) || candle.observedAt < candle.timestamp || candle.observedAt > asOf)) {
      throw new ResearchContractError("INVALID_OBSERVED_AT", `candles[${index}].observedAt is invalid`);
    }
    for (const field of ["open", "high", "low", "close"]) positive(candle[field], `candles[${index}].${field}`);
    const key = `${candle.symbol}:${candle.timestamp}`;
    if (seen.has(key)) throw new ResearchContractError("DUPLICATE_EVENT", `duplicate candle event: ${key}`);
    seen.add(key);
    if (!bySymbol.has(candle.symbol)) bySymbol.set(candle.symbol, []);
    bySymbol.get(candle.symbol).push(candle);
  }

  let expected = 0;
  let observed = 0;
  const missingBySymbol = {};
  for (const [symbol, rows] of bySymbol.entries()) {
    rows.sort((left, right) => left.timestamp - right.timestamp);
    const first = rows[0].timestamp;
    const last = rows.at(-1).timestamp;
    const slots = Math.floor((last - first) / expectedIntervalMs) + 1;
    expected += slots;
    observed += rows.length;
    let missing = 0;
    for (let index = 1; index < rows.length; index += 1) {
      const delta = rows[index].timestamp - rows[index - 1].timestamp;
      if (delta > expectedIntervalMs) missing += Math.max(0, Math.round(delta / expectedIntervalMs) - 1);
      if (delta < expectedIntervalMs) blockedReasons.push(`${symbol}:irregular_interval`);
    }
    missingBySymbol[symbol] = missing;
  }
  const missingRatio = expected > 0 ? Math.max(0, expected - observed) / expected : 0;
  if (missingRatio > maximumMissingRatio) blockedReasons.push("missing_data_ratio_exceeded");
  if (!universeIncludesDelisted) blockedReasons.push("survivorship_guard_missing_delisted_universe");

  return Object.freeze({
    eligible: blockedReasons.length === 0,
    blockedReasons: Object.freeze([...new Set(blockedReasons)]),
    candleCount: candles.length,
    symbolCount: bySymbol.size,
    missingRatio,
    missingBySymbol: Object.freeze(missingBySymbol),
    safeguards: Object.freeze({
      lookaheadBlocked: true,
      duplicateEventsBlocked: true,
      closedCandlesOnly: true,
      universeSnapshotAt,
      survivorshipProtected: universeIncludesDelisted,
      delistedUniverseRequired: true,
    }),
  });
}

export function calculateExecutionAwareTrade(input) {
  const spreadRate = rate(input.spreadRate ?? 0, "spreadRate");
  const latencyBars = input.latencyBars ?? 0;
  const latencyDriftRate = rate(input.latencyDriftRate ?? 0, "latencyDriftRate");
  if (!Number.isInteger(latencyBars) || latencyBars < 0 || latencyBars > 100) {
    throw new ResearchContractError("INVALID_LATENCY_BARS", "latencyBars must be an integer between 0 and 100");
  }
  const direction = input.action === "SHORT" ? -1 : input.action === "BUY" || input.action === "LONG" ? 1 : 0;
  if (direction === 0) throw new ResearchContractError("INVALID_ENTRY_ACTION", "action must be BUY, LONG or SHORT");
  const entryPrice = positive(input.entryPrice, "entryPrice");
  const exitPrice = positive(input.exitPrice, "exitPrice");
  const quantity = positive(input.quantity, "quantity");
  const latencyRate = Math.min(0.99, latencyBars * latencyDriftRate);

  const spreadEntry = entryPrice * (direction > 0 ? 1 + spreadRate / 2 : 1 - spreadRate / 2);
  const spreadExit = exitPrice * (direction > 0 ? 1 - spreadRate / 2 : 1 + spreadRate / 2);
  const latencyEntry = spreadEntry * (direction > 0 ? 1 + latencyRate : 1 - latencyRate);
  const latencyExit = spreadExit * (direction > 0 ? 1 - latencyRate : 1 + latencyRate);

  const rawGross = direction * (exitPrice - entryPrice) * quantity;
  const spreadGross = direction * (spreadExit - spreadEntry) * quantity;
  const latencyGross = direction * (latencyExit - latencyEntry) * quantity;
  const spreadCost = Math.max(0, rawGross - spreadGross);
  const latencyCost = Math.max(0, spreadGross - latencyGross);
  const result = calculateTradeResult({ ...input, entryPrice: latencyEntry, exitPrice: latencyExit });
  const baseCosts = result.costs;
  return Object.freeze({
    ...result,
    requestedEntryPrice: entryPrice,
    requestedExitPrice: exitPrice,
    preExecutionGrossPnl: rawGross,
    executionModel: Object.freeze({ spreadRate, latencyBars, latencyDriftRate, latencyRate, slippageRate: input.slippageRate ?? 0 }),
    costs: Object.freeze({
      ...baseCosts,
      spread: spreadCost,
      latency: latencyCost,
      total: baseCosts.total + spreadCost + latencyCost,
    }),
  });
}

export function summarizeResearchPerformance(trades, { initialCapital }) {
  positive(initialCapital, "initialCapital");
  if (!Array.isArray(trades)) throw new ResearchContractError("INVALID_TRADES", "trades must be an array");
  for (const [index, trade] of trades.entries()) {
    finite(trade?.netPnl, `trades[${index}].netPnl`);
    if (typeof trade.market !== "string" || typeof trade.strategy !== "string" || typeof trade.timeframe !== "string" || typeof trade.regime !== "string") {
      throw new ResearchContractError("MISSING_SEGMENT_DIMENSION", `trades[${index}] is missing market, strategy, timeframe or regime`);
    }
  }
  return Object.freeze({
    overall: summarizePerformanceGroup(trades, initialCapital),
    byMarket: groupBy(trades, (trade) => trade.market, initialCapital),
    byStrategy: groupBy(trades, (trade) => trade.strategy, initialCapital),
    byTimeframe: groupBy(trades, (trade) => trade.timeframe, initialCapital),
    byRegime: groupBy(trades, (trade) => trade.regime, initialCapital),
  });
}

export function buildValidationFolds(records, options) {
  const folds = createPurgedWalkForwardFolds(records, options);
  return Object.freeze(folds.map((fold) => Object.freeze({
    fold: fold.fold,
    historicalBacktest: fold.train,
    outOfSample: fold.validation,
    walkForwardTest: fold.test,
    leakFree: fold.validation[0].anchorTimestamp > fold.report.maxTrainFuture
      && fold.test[0].anchorTimestamp > fold.report.maxValidationFuture,
    report: fold.report,
  })));
}

export function evaluatePromotionPipeline({ strategyId, stages }) {
  if (typeof strategyId !== "string" || strategyId.length === 0) throw new ResearchContractError("INVALID_STRATEGY_ID", "strategyId is required");
  if (!stages || typeof stages !== "object") throw new ResearchContractError("INVALID_STAGES", "stages are required");
  const required = STRATEGY_PROMOTION_PIPELINE.slice(0, -1);
  const completedStages = [];
  let blockedAt = null;
  for (const stage of required) {
    if (stages[stage]?.passed === true) completedStages.push(stage);
    else {
      blockedAt = stage;
      break;
    }
  }
  const promotionCandidate = blockedAt === null;
  return Object.freeze({
    strategyId,
    completedStages: Object.freeze(completedStages),
    status: promotionCandidate ? "promotion_candidate" : "research_hold",
    blockedAt,
    nextStage: promotionCandidate ? "approval_live" : blockedAt,
    automaticLivePromotion: false,
    liveApproved: false,
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
  });
}

function shadowRecordId(input) {
  return createHash("sha256").update(stableStringify({
    signalId: input.signalId,
    strategy: input.strategy,
    asset: input.asset,
    timestamp: input.timestamp,
  })).digest("hex");
}

export function createShadowTradeRecord(input) {
  if (!input || typeof input !== "object") throw new ResearchContractError("INVALID_SHADOW_INPUT", "shadow input is required");
  for (const field of ["signalId", "strategy", "asset", "market"]) {
    if (typeof input[field] !== "string" || input[field].length === 0) throw new ResearchContractError("INVALID_SHADOW_FIELD", `${field} is required`);
  }
  if (!Number.isInteger(input.timestamp) || input.timestamp <= 0) throw new ResearchContractError("INVALID_SHADOW_TIMESTAMP", "timestamp must be positive");
  if (!input.entryPlan || typeof input.entryPlan !== "object") throw new ResearchContractError("INVALID_ENTRY_PLAN", "entryPlan is required");
  positive(input.entryPlan.entryPrice, "entryPlan.entryPrice");
  positive(input.entryPlan.quantity, "entryPlan.quantity");
  if (!new Set(["BUY", "LONG", "SHORT"]).has(input.entryPlan.action)) throw new ResearchContractError("INVALID_ENTRY_ACTION", "entryPlan.action must be BUY, LONG or SHORT");
  positive(input.stop, "stop");
  if (!Array.isArray(input.targets) || input.targets.length === 0) throw new ResearchContractError("INVALID_TARGETS", "at least one target is required");
  input.targets.forEach((target, index) => positive(target, `targets[${index}]`));
  if (typeof input.invalidation !== "string" || input.invalidation.length === 0) throw new ResearchContractError("INVALID_INVALIDATION", "invalidation is required");
  if (!input.feesSlippageModel || typeof input.feesSlippageModel !== "object") throw new ResearchContractError("INVALID_COST_MODEL", "feesSlippageModel is required");

  return Object.freeze({
    schemaVersion: 1,
    id: shadowRecordId(input),
    status: "tracking",
    signalId: input.signalId,
    strategy: input.strategy,
    asset: input.asset,
    market: input.market,
    timeframe: input.timeframe ?? null,
    timestamp: input.timestamp,
    dataTimestamp: input.dataTimestamp ?? input.timestamp,
    entryPlan: readonlyClone(input.entryPlan),
    stop: input.stop,
    targets: Object.freeze([...input.targets]),
    invalidation: input.invalidation,
    feesSlippageModel: readonlyClone(input.feesSlippageModel),
    subsequentMarketResult: null,
    hypotheticalPnl: null,
    mae: null,
    mfe: null,
    orderSubmitted: false,
    privateAccountRequested: false,
  });
}

export function upsertShadowTradeLedger(state, record, { expectedVersion } = {}) {
  const current = state && typeof state === "object" ? state : { version: 0, records: [] };
  const version = Number.isInteger(current.version) ? current.version : 0;
  if (expectedVersion !== undefined && expectedVersion !== version) {
    throw new ResearchContractError("SHADOW_LEDGER_VERSION_CONFLICT", "shadow ledger changed before this write", { expectedVersion, actualVersion: version });
  }
  const records = Array.isArray(current.records) ? [...current.records] : [];
  const index = records.findIndex((item) => item.id === record.id);
  if (index >= 0) {
    if (stableStringify(records[index]) !== stableStringify(record)) {
      throw new ResearchContractError("SHADOW_DUPLICATE_CONFLICT", `conflicting duplicate shadow event: ${record.id}`);
    }
    return Object.freeze({ version, records: Object.freeze(records), duplicate: true });
  }
  records.push(record);
  records.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
  return Object.freeze({ version: version + 1, records: Object.freeze(records), duplicate: false });
}

export function settleShadowTradeRecord(record, { futureCandles, exitPrice, exitTimestamp, marketResult = null }) {
  if (!record || record.status !== "tracking") throw new ResearchContractError("INVALID_SHADOW_RECORD", "tracking shadow record is required");
  positive(exitPrice, "exitPrice");
  if (!Number.isInteger(exitTimestamp) || exitTimestamp <= record.timestamp) throw new ResearchContractError("INVALID_EXIT_TIMESTAMP", "exitTimestamp must follow the signal");
  if (!Array.isArray(futureCandles) || futureCandles.length === 0) throw new ResearchContractError("EMPTY_FUTURE_PATH", "futureCandles are required");
  let previous = record.timestamp;
  for (const [index, candle] of futureCandles.entries()) {
    if (!Number.isInteger(candle?.timestamp) || candle.timestamp <= previous || candle.timestamp > exitTimestamp) {
      throw new ResearchContractError("NON_DETERMINISTIC_REPLAY", `futureCandles[${index}] are not strictly ordered inside the replay window`);
    }
    previous = candle.timestamp;
  }
  const excursion = calculateSignalExcursion({
    action: record.entryPlan.action,
    entryPrice: record.entryPlan.entryPrice,
    candles: futureCandles,
  });
  const costs = record.feesSlippageModel;
  const trade = calculateExecutionAwareTrade({
    market: record.market,
    action: record.entryPlan.action,
    entryPrice: record.entryPlan.entryPrice,
    exitPrice,
    quantity: record.entryPlan.quantity,
    leverage: record.entryPlan.leverage ?? 1,
    entryFeeRate: costs.entryFeeRate ?? 0,
    exitFeeRate: costs.exitFeeRate ?? 0,
    slippageRate: costs.slippageRate ?? 0,
    spreadRate: costs.spreadRate ?? 0,
    latencyBars: costs.latencyBars ?? 0,
    latencyDriftRate: costs.latencyDriftRate ?? 0,
    taxRate: costs.taxRate ?? 0,
    fundingRates: costs.fundingRates ?? [],
  });
  return Object.freeze({
    ...record,
    status: "settled",
    evaluatedAt: exitTimestamp,
    subsequentMarketResult: readonlyClone(marketResult ?? { exitPrice, exitTimestamp }),
    hypotheticalPnl: trade.netPnl,
    mae: excursion.maximumAdverseExcursion,
    mfe: excursion.maximumFavorableExcursion,
    execution: trade,
    orderSubmitted: false,
    privateAccountRequested: false,
  });
}

export function evaluatePortfolioAdditionalBuy(input) {
  if (!input || typeof input !== "object") throw new ResearchContractError("INVALID_PORTFOLIO_INPUT", "portfolio input is required");
  const portfolioEquity = positive(input.portfolio?.equity, "portfolio.equity");
  const currentExposure = finite(input.portfolio?.totalExposure ?? 0, "portfolio.totalExposure");
  const currentSymbolExposure = finite(input.portfolio?.symbolExposure ?? 0, "portfolio.symbolExposure");
  const amount = positive(input.proposal?.amount, "proposal.amount");
  const price = positive(input.proposal?.price, "proposal.price");
  const stop = positive(input.proposal?.stop, "proposal.stop");
  const target1 = positive(input.proposal?.target1, "proposal.target1");
  const target2 = positive(input.proposal?.target2, "proposal.target2");
  if (!(stop < price)) throw new ResearchContractError("INVALID_STOP", "long additional-buy stop must be below proposal price");
  if (!(target1 > price && target2 >= target1)) throw new ResearchContractError("INVALID_TARGET", "targets must be above proposal price and ordered");

  const correlation = finite(input.risk?.correlation ?? 0, "risk.correlation");
  const maxCorrelation = finite(input.risk?.maxCorrelation ?? 0.8, "risk.maxCorrelation");
  const maxPortfolioExposure = positive(input.risk?.maxPortfolioExposure, "risk.maxPortfolioExposure");
  const maxSymbolExposure = positive(input.risk?.maxSymbolExposure, "risk.maxSymbolExposure");
  const reasons = [];
  if (input.risk?.invalidationTriggered === true) reasons.push("invalidation_triggered");
  if (input.risk?.thesisValid === false) reasons.push("thesis_invalid");
  if (input.risk?.dataStale === true) reasons.push("stale_market_data");
  if (input.risk?.partialMarketData === true) reasons.push("partial_market_data");
  if (input.risk?.liquidityOk === false) reasons.push("insufficient_liquidity");
  if (currentExposure + amount > maxPortfolioExposure) reasons.push("portfolio_exposure_limit");
  if (currentSymbolExposure + amount > maxSymbolExposure) reasons.push("symbol_exposure_limit");

  const currentQuantity = finite(input.currentPosition?.quantity ?? 0, "currentPosition.quantity");
  const currentAveragePrice = currentQuantity > 0 ? positive(input.currentPosition?.averagePrice, "currentPosition.averagePrice") : 0;
  const currentPrice = input.currentPosition?.currentPrice === undefined ? price : positive(input.currentPosition.currentPrice, "currentPosition.currentPrice");
  const averagingDown = currentQuantity > 0 && currentPrice < currentAveragePrice && price <= currentPrice;
  const conditionalReasons = [];
  if (averagingDown) conditionalReasons.push("loss_alone_never_justifies_averaging_down");
  if (Math.abs(correlation) > maxCorrelation) conditionalReasons.push("correlation_requires_review");

  const prohibited = reasons.length > 0;
  const classification = prohibited
    ? "additional_buy_prohibited"
    : conditionalReasons.length > 0
      ? "conditional_additional_buy"
      : "additional_buy_allowed";
  const additionalQuantity = amount / price;
  const totalQuantity = currentQuantity + additionalQuantity;
  const expectedAveragePrice = totalQuantity > 0
    ? (currentQuantity * currentAveragePrice + additionalQuantity * price) / totalQuantity
    : price;
  const maximumAdditionalLoss = additionalQuantity * Math.max(0, price - stop);

  return Object.freeze({
    classification,
    reasons: Object.freeze(reasons),
    conditionalReasons: Object.freeze(conditionalReasons),
    calculationsAvailable: !prohibited,
    additionalAmount: !prohibited ? amount : null,
    additionalQuantity: !prohibited ? additionalQuantity : null,
    expectedAveragePrice: !prohibited ? expectedAveragePrice : null,
    stop: !prohibited ? stop : null,
    target1: !prohibited ? target1 : null,
    target2: !prohibited ? target2 : null,
    maximumAdditionalLoss: !prohibited ? maximumAdditionalLoss : null,
    totalExposure: !prohibited ? currentExposure + amount : null,
    totalExposureRatio: !prohibited ? (currentExposure + amount) / portfolioEquity : null,
    symbolExposure: !prohibited ? currentSymbolExposure + amount : null,
    correlation,
  });
}

export function assertAiMentorLanguageSafe(sections) {
  for (const [key, value] of Object.entries(sections ?? {})) {
    const text = Array.isArray(value) ? value.join(" ") : String(value ?? "");
    if (GUARANTEE_PATTERNS.some((pattern) => pattern.test(text))) {
      throw new ResearchContractError("PROFIT_GUARANTEE_LANGUAGE", `AI mentor section ${key} contains prohibited guarantee language`, { key });
    }
  }
  return true;
}

export function createAiMentorAnalysis({
  sections,
  dataTimestamp,
  generatedAt,
  staleAfterMs,
  insufficientData = false,
  partialMarketData = false,
}) {
  if (!sections || typeof sections !== "object") throw new ResearchContractError("INVALID_MENTOR_SECTIONS", "AI mentor sections are required");
  if (!Number.isInteger(dataTimestamp) || dataTimestamp <= 0) throw new ResearchContractError("INVALID_DATA_TIMESTAMP", "dataTimestamp must be positive");
  if (!Number.isInteger(generatedAt) || generatedAt < dataTimestamp) throw new ResearchContractError("INVALID_GENERATED_AT", "generatedAt must be at or after dataTimestamp");
  positive(staleAfterMs, "staleAfterMs");
  const missingSections = AI_MENTOR_SECTION_ORDER.filter((key) => sections[key] === undefined || sections[key] === null || String(sections[key]).trim().length === 0);
  assertAiMentorLanguageSafe(sections);
  const stale = generatedAt - dataTimestamp > staleAfterMs;
  return Object.freeze({
    schemaVersion: 1,
    sectionOrder: AI_MENTOR_SECTION_ORDER,
    sections: readonlyClone(Object.fromEntries(AI_MENTOR_SECTION_ORDER.map((key) => [key, sections[key] ?? null]))),
    dataTimestamp,
    stale,
    analysisGeneratedAt: generatedAt,
    insufficientData: insufficientData || partialMarketData || missingSections.length > 0,
    partialMarketData,
    missingSections: Object.freeze(missingSections),
    profitGuaranteeLanguageAllowed: false,
  });
}