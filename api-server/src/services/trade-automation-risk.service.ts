import { evaluateTradingOptimization } from './trade-automation-optimization.service';
import { isRiskReducingExitPlan } from './live-connection-verification.service';
import {
  DEFAULT_TRADING_POLICY,
  PRODUCTION_ADMIN_MAX_BITGET_LEVERAGE,
  PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW,
  PRODUCTION_MEMBER_MAX_BITGET_LEVERAGE,
  PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW,
  PRODUCTION_MIN_BITGET_LEVERAGE,
  type BitgetLeverage,
  type TradingAssetClass,
  type TradingMarketSnapshot,
  type TradingPlanInput,
  type TradingPolicy,
  type TradingRiskDecision,
} from './trade-automation.types';
import { normalizeSplitRatios, TradeSplitOrderPlanError } from './trade-split-order-planner.service';
import { benchmarkDrawdownBlocksLong, isNewCryptoLongEntry } from './crypto-benchmark-regime.service';

const MAX_DATA_DELAY_MS = 5_000;
const MAX_SNAPSHOT_AGE_MS = 30_000;
const MAX_SNAPSHOT_FUTURE_SKEW_MS = 5_000;
const MAX_ONE_MINUTE_MOVE_PERCENT = 5;
const MAX_SPREAD_PERCENT = 1;
const MAX_ORDERBOOK_GAP_PERCENT = 2;
const MIN_LIQUIDATION_DISTANCE_PERCENT = 5;
const UPBIT_MINIMUM_KRW = 5_000;

type ExtendedRiskSnapshot = TradingMarketSnapshot & {
  accountExposureKrw?: number | null;
  strategyExposureKrw?: number | null;
  openRiskKrw?: number | null;
};

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function add(values: string[], code: string) {
  if (!values.includes(code)) values.push(code);
}
function normalizedList(value: unknown, maximum: number) {
  return Array.isArray(value)
    ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, maximum)
    : [];
}
function assetClassForPlan(plan: TradingPlanInput): TradingAssetClass {
  if (plan.exchange === 'bitget') return 'crypto_futures';
  if (plan.exchange === 'upbit') return 'crypto_spot';
  if (plan.market.toUpperCase() === 'US') return 'us_stock';
  return 'domestic_stock';
}
function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}
function planReferencePrice(plan: TradingPlanInput) {
  const candidates = [
    plan.marketSnapshot.currentPrice,
    plan.marketSnapshot.plannedPrice,
    plan.entryPrice,
    plan.limitPrice,
    plan.quoteAmount != null && plan.quantity != null && plan.quantity > 0
      ? plan.quoteAmount / plan.quantity
      : null,
  ];
  return candidates.find((value): value is number => finitePositive(value)) ?? null;
}
function plannedOpenRiskKrw(plan: TradingPlanInput) {
  const reference = planReferencePrice(plan);
  if (reference == null || !finitePositive(plan.stopPrice)) return null;
  return plan.estimatedKrw * Math.abs(reference - plan.stopPrice) / reference;
}

export function normalizeTradingPolicy(
  value: Partial<TradingPolicy> | null | undefined,
  requestedMaximumSingleEntryKrw: number = PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW,
): TradingPolicy {
  const input = value ?? {};
  const maximumSingleEntryKrw = requestedMaximumSingleEntryKrw === PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW
    ? PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW
    : PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW;
  const maximumBitgetLeverage = maximumSingleEntryKrw === PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW
    ? PRODUCTION_ADMIN_MAX_BITGET_LEVERAGE
    : PRODUCTION_MEMBER_MAX_BITGET_LEVERAGE;
  const leverage = input.bitgetLeverage == null
    ? DEFAULT_TRADING_POLICY.bitgetLeverage
    : Number(input.bitgetLeverage);
  if (!Number.isInteger(leverage) || leverage < PRODUCTION_MIN_BITGET_LEVERAGE || leverage > PRODUCTION_ADMIN_MAX_BITGET_LEVERAGE) {
    throw new Error('BITGET_LEVERAGE_POLICY_INVALID');
  }
  const pilotStage = input.pilotStage === 'limited-50'
    || input.pilotStage === 'validated'
    || input.pilotStage === 'formula-ai-exception'
    ? input.pilotStage : 'approval-20';
  const totalCapitalKrw = clampNumber(input.totalCapitalKrw, 10_000, 10_000_000_000, DEFAULT_TRADING_POLICY.totalCapitalKrw);
  const maxOrderKrw = clampNumber(
    input.maxOrderKrw,
    5_000,
    Math.min(maximumSingleEntryKrw, totalCapitalKrw),
    Math.min(maximumSingleEntryKrw, totalCapitalKrw),
  );
  const maxInstrumentKrw = clampNumber(input.maxInstrumentKrw, 5_000, totalCapitalKrw, Math.min(maxOrderKrw, totalCapitalKrw));
  const classLimits = input.maxAssetClassKrw;
  const maxAssetClassKrw: Record<TradingAssetClass, number> = {
    domestic_stock: clampNumber(classLimits?.domestic_stock, 5_000, totalCapitalKrw, totalCapitalKrw),
    us_stock: clampNumber(classLimits?.us_stock, 5_000, totalCapitalKrw, totalCapitalKrw),
    crypto_spot: clampNumber(classLimits?.crypto_spot, 5_000, totalCapitalKrw, totalCapitalKrw),
    crypto_futures: clampNumber(classLimits?.crypto_futures, 5_000, totalCapitalKrw, totalCapitalKrw),
  };
  const marketEnabled: Record<TradingAssetClass, boolean> = {
    domestic_stock: input.marketEnabled?.domestic_stock ?? DEFAULT_TRADING_POLICY.marketEnabled.domestic_stock,
    us_stock: input.marketEnabled?.us_stock ?? DEFAULT_TRADING_POLICY.marketEnabled.us_stock,
    crypto_spot: input.marketEnabled?.crypto_spot ?? DEFAULT_TRADING_POLICY.marketEnabled.crypto_spot,
    crypto_futures: input.marketEnabled?.crypto_futures ?? DEFAULT_TRADING_POLICY.marketEnabled.crypto_futures,
  };
  const stockBrokerByMarket = {
    domestic_stock: input.stockBrokerByMarket?.domestic_stock === 'toss' ? 'toss' as const : 'kiwoom' as const,
    // Production execution policy is fixed: US stock orders are Kiwoom-only.
    // Normalize legacy/user-supplied Toss selections closed instead of carrying
    // an unsupported route into the automatic worker.
    us_stock: 'kiwoom' as const,
  };
  return {
    mode: input.mode === 'automatic' ? 'automatic' : 'approval',
    automaticEnabled: input.automaticEnabled === true,
    emergencyStopped: input.emergencyStopped === true,
    newEntriesStopped: input.newEntriesStopped === true,
    marketEnabled,
    stockBrokerByMarket,
    exchangeEnabled: {
      bitget: input.exchangeEnabled?.bitget ?? DEFAULT_TRADING_POLICY.exchangeEnabled.bitget,
      upbit: input.exchangeEnabled?.upbit ?? DEFAULT_TRADING_POLICY.exchangeEnabled.upbit,
      kiwoom: input.exchangeEnabled?.kiwoom ?? DEFAULT_TRADING_POLICY.exchangeEnabled.kiwoom,
      toss: input.exchangeEnabled?.toss ?? DEFAULT_TRADING_POLICY.exchangeEnabled.toss,
    },
    enabledAssets: {
      bitget: normalizedList(input.enabledAssets?.bitget, 100).map((item) => item.toUpperCase()),
      upbit: normalizedList(input.enabledAssets?.upbit, 100).map((item) => item.toUpperCase().replace(/^KRW-/, '')),
      kiwoom: normalizedList(input.enabledAssets?.kiwoom, 100).map((item) => item.toUpperCase()),
      toss: normalizedList(input.enabledAssets?.toss, 100).map((item) => item.toUpperCase()),
    },
    enabledStrategies: normalizedList(input.enabledStrategies, 30),
    totalCapitalKrw,
    maxOrderKrw,
    maxInstrumentKrw,
    maxAssetClassKrw,
    dailyLossLimitPercent: clampNumber(input.dailyLossLimitPercent, 0.1, 5, DEFAULT_TRADING_POLICY.dailyLossLimitPercent),
    weeklyLossLimitPercent: clampNumber(input.weeklyLossLimitPercent, 0.1, 25, DEFAULT_TRADING_POLICY.weeklyLossLimitPercent),
    maxAssetPercent: clampNumber(input.maxAssetPercent, 1, 30, DEFAULT_TRADING_POLICY.maxAssetPercent),
    maxOpenPositions: Math.round(clampNumber(input.maxOpenPositions, 1, 50, DEFAULT_TRADING_POLICY.maxOpenPositions)),
    maxDailyOrders: Number(input.maxDailyOrders) === 0
      ? 0
      : Math.round(clampNumber(input.maxDailyOrders, 1, 100, 0)),
    maxConsecutiveLosses: Math.round(clampNumber(input.maxConsecutiveLosses, 1, 20, DEFAULT_TRADING_POLICY.maxConsecutiveLosses)),
    // Stored policies from before role-scoped leverage are read fail-closed.
    // Administrator 4x-7x values remain exact; member values above 3x are
    // reduced to the member ceiling before any Paper or Live worker sees them.
    bitgetLeverage: Math.min(leverage, maximumBitgetLeverage) as BitgetLeverage,
    riskOptimizationEnabled: input.riskOptimizationEnabled !== false,
    pilotStage,
    riskPerTradePercent: {
      bitget: clampNumber(input.riskPerTradePercent?.bitget, 0.01, 1, DEFAULT_TRADING_POLICY.riskPerTradePercent.bitget),
      upbit: clampNumber(input.riskPerTradePercent?.upbit, 0.01, 1, DEFAULT_TRADING_POLICY.riskPerTradePercent.upbit),
      kiwoom: clampNumber(input.riskPerTradePercent?.kiwoom, 0.01, 1, DEFAULT_TRADING_POLICY.riskPerTradePercent.kiwoom),
      toss: clampNumber(input.riskPerTradePercent?.toss, 0.01, 1, DEFAULT_TRADING_POLICY.riskPerTradePercent.toss),
    },
    totalDailyLossLimitPercent: clampNumber(input.totalDailyLossLimitPercent, 0.1, 2, DEFAULT_TRADING_POLICY.totalDailyLossLimitPercent),
    minExpectedValueR: clampNumber(input.minExpectedValueR, 0, 2, DEFAULT_TRADING_POLICY.minExpectedValueR),
    minStrategySampleSize: Math.round(clampNumber(input.minStrategySampleSize, 20, 10_000, DEFAULT_TRADING_POLICY.minStrategySampleSize)),
    minProfitFactor: clampNumber(input.minProfitFactor, 1, 5, DEFAULT_TRADING_POLICY.minProfitFactor),
    maxStrategyDrawdownPercent: clampNumber(input.maxStrategyDrawdownPercent, 1, 50, DEFAULT_TRADING_POLICY.maxStrategyDrawdownPercent),
    maxEstimatedSlippagePercent: clampNumber(input.maxEstimatedSlippagePercent, 0.01, 2, DEFAULT_TRADING_POLICY.maxEstimatedSlippagePercent),
    maxAverageSpreadPercent: clampNumber(input.maxAverageSpreadPercent, 0.01, 2, DEFAULT_TRADING_POLICY.maxAverageSpreadPercent),
    maxCorrelatedExposurePercent: clampNumber(input.maxCorrelatedExposurePercent, 1, 100, DEFAULT_TRADING_POLICY.maxCorrelatedExposurePercent),
    maxEconomicsAgeHours: clampNumber(input.maxEconomicsAgeHours, 1, 168, DEFAULT_TRADING_POLICY.maxEconomicsAgeHours),
  };
}

export function upbitKrwPriceStep(price: number) {
  if (price >= 1_000_000) return 1_000;
  if (price >= 500_000) return 500;
  if (price >= 100_000) return 100;
  if (price >= 50_000) return 50;
  if (price >= 10_000) return 10;
  if (price >= 5_000) return 5;
  if (price >= 1_000) return 1;
  if (price >= 100) return 1;
  if (price >= 10) return 0.1;
  if (price >= 1) return 0.01;
  if (price >= 0.1) return 0.001;
  if (price >= 0.01) return 0.0001;
  if (price >= 0.001) return 0.00001;
  if (price >= 0.0001) return 0.000001;
  if (price >= 0.00001) return 0.0000001;
  return 0.00000001;
}
export function isAlignedToStep(value: number, step: number) {
  const units = value / step;
  return Math.abs(units - Math.round(units)) < 1e-8;
}

export function evaluateTradingPlan(
  plan: TradingPlanInput,
  policy: TradingPolicy,
  options: { emergencyStopped: boolean; serverLiveEnabled: boolean },
): TradingRiskDecision {
  const blockCodes: string[] = [];
  const warnings: string[] = [];
  const snapshot = plan.marketSnapshot as ExtendedRiskSnapshot;
  const riskReducing = isRiskReducingExitPlan(plan);
  if (plan.reduceOnly === true && !riskReducing) add(blockCodes, 'REDUCE_ONLY_SIDE_INVALID');

  if (options.emergencyStopped && !riskReducing) add(blockCodes, 'EMERGENCY_STOP_ACTIVE');
  if (policy.newEntriesStopped && !riskReducing) add(blockCodes, 'NEW_ENTRIES_STOPPED');
  if (!finitePositive(plan.estimatedKrw) || (!riskReducing && plan.estimatedKrw > policy.maxOrderKrw)) add(blockCodes, 'MAX_ORDER_AMOUNT');
  if (!riskReducing && snapshot.dailyPnlPercent <= -policy.dailyLossLimitPercent) add(blockCodes, 'DAILY_LOSS_LIMIT');
  if (!riskReducing && Number.isFinite(snapshot.weeklyPnlPercent) && Number(snapshot.weeklyPnlPercent) <= -policy.weeklyLossLimitPercent) add(blockCodes, 'WEEKLY_LOSS_LIMIT');
  if (!riskReducing && snapshot.assetExposurePercent > policy.maxAssetPercent) add(blockCodes, 'ASSET_EXPOSURE_LIMIT');
  const capitalBase = Math.max(1, Math.min(policy.totalCapitalKrw, snapshot.accountValueKrw || policy.totalCapitalKrw));
  if (!riskReducing && snapshot.assetExposurePercent + (plan.estimatedKrw / capitalBase) * 100 > policy.maxAssetPercent) add(blockCodes, 'PROJECTED_ASSET_EXPOSURE_LIMIT');

  const accountExposureKrw = finiteNonNegative(snapshot.accountExposureKrw) ? snapshot.accountExposureKrw : null;
  if (!riskReducing && accountExposureKrw != null && accountExposureKrw + plan.estimatedKrw > capitalBase) add(blockCodes, 'ACCOUNT_EXPOSURE_LIMIT');
  const instrumentExposureKrw = finiteNonNegative(snapshot.instrumentExposureKrw) ? snapshot.instrumentExposureKrw : 0;
  if (!riskReducing && instrumentExposureKrw + plan.estimatedKrw > policy.maxInstrumentKrw) add(blockCodes, 'INSTRUMENT_AMOUNT_LIMIT');
  const strategyExposureKrw = finiteNonNegative(snapshot.strategyExposureKrw) ? snapshot.strategyExposureKrw : null;
  const strategyLimitKrw = capitalBase * policy.maxAssetPercent / 100;
  if (!riskReducing && strategyExposureKrw != null && strategyExposureKrw + plan.estimatedKrw > strategyLimitKrw) add(blockCodes, 'STRATEGY_EXPOSURE_LIMIT');
  const assetClass = assetClassForPlan(plan);
  const classExposure = finiteNonNegative(snapshot.assetClassExposureKrw) ? snapshot.assetClassExposureKrw : 0;
  if (!riskReducing && classExposure + plan.estimatedKrw > policy.maxAssetClassKrw[assetClass]) add(blockCodes, 'ASSET_CLASS_AMOUNT_LIMIT');
  // Per-market base funds must fit inside the total base fund; two enabled
  // live markets may never be allocated the same KRW.
  for (const code of marketCapitalEntryBlockCodes(plan, policy, { riskReducing })) add(blockCodes, code);

  const openRiskKrw = finiteNonNegative(snapshot.openRiskKrw) ? snapshot.openRiskKrw : null;
  const thisPlanRiskKrw = plannedOpenRiskKrw(plan);
  const openRiskLimitKrw = capitalBase * policy.totalDailyLossLimitPercent / 100;
  if (!riskReducing && openRiskKrw != null && thisPlanRiskKrw != null && openRiskKrw + thisPlanRiskKrw > openRiskLimitKrw) add(blockCodes, 'OPEN_RISK_LIMIT');

  if (!riskReducing && snapshot.openPositionCount >= policy.maxOpenPositions) add(blockCodes, 'OPEN_POSITION_LIMIT');
  if (!riskReducing && policy.maxDailyOrders > 0
    && snapshot.dailyOrderCount >= policy.maxDailyOrders) add(blockCodes, 'DAILY_ORDER_LIMIT');
  if (!riskReducing && snapshot.consecutiveLosses >= policy.maxConsecutiveLosses) add(blockCodes, 'CONSECUTIVE_LOSS_LIMIT');
  if (snapshot.halted) add(blockCodes, 'MARKET_HALTED');
  // BTC가 24시간 고점 대비 급락 중이면 코인 신규 롱/매수 진입만 차단 (청산·숏은 허용)
  if (isNewCryptoLongEntry(plan, riskReducing) && benchmarkDrawdownBlocksLong(snapshot.benchmarkDrawdownPercent)) {
    add(blockCodes, 'BENCHMARK_DRAWDOWN_LONG_BLOCKED');
  }

  const nowMs = Date.now();
  const observedAtMs = Date.parse(snapshot.observedAt);
  const declaredDelayMs = Number(snapshot.dataDelayMs);
  if (!Number.isFinite(observedAtMs)) {
    add(blockCodes, 'MARKET_SNAPSHOT_TIMESTAMP_INVALID');
    add(blockCodes, 'MARKET_SNAPSHOT_STALE');
    add(blockCodes, 'MARKET_DATA_DELAYED');
  } else {
    const snapshotAgeMs = nowMs - observedAtMs;
    if (snapshotAgeMs < -MAX_SNAPSHOT_FUTURE_SKEW_MS) {
      add(blockCodes, 'MARKET_SNAPSHOT_FROM_FUTURE');
      add(blockCodes, 'MARKET_DATA_DELAYED');
    } else {
      if (snapshotAgeMs > MAX_SNAPSHOT_AGE_MS) {
        add(blockCodes, 'MARKET_SNAPSHOT_STALE');
        add(blockCodes, 'MARKET_DATA_DELAYED');
      }
      if (!Number.isFinite(declaredDelayMs) || declaredDelayMs < 0 || declaredDelayMs > MAX_DATA_DELAY_MS) add(blockCodes, 'MARKET_DATA_DELAYED');
    }
  }
  if (!riskReducing && Math.abs(snapshot.oneMinuteMovePercent) >= MAX_ONE_MINUTE_MOVE_PERCENT) {
    add(blockCodes, 'FAST_MOVE_DETECTED');
    add(blockCodes, 'ONE_MINUTE_VOLATILITY');
  }
  if (!riskReducing && snapshot.spreadPercent > MAX_SPREAD_PERCENT) add(blockCodes, 'SPREAD_TOO_WIDE');
  if (!riskReducing && snapshot.orderbookGapPercent > MAX_ORDERBOOK_GAP_PERCENT) add(blockCodes, 'ORDERBOOK_GAP');
  if (!riskReducing && finiteNonNegative(snapshot.estimatedSlippagePercent)
    && snapshot.estimatedSlippagePercent > policy.maxEstimatedSlippagePercent) add(blockCodes, 'ESTIMATED_SLIPPAGE_LIMIT');
  if (!riskReducing && finiteNonNegative(plan.averageSpreadPercent)
    && plan.averageSpreadPercent > policy.maxAverageSpreadPercent) add(blockCodes, 'AVERAGE_SPREAD_LIMIT');
  if (!riskReducing && finiteNonNegative(snapshot.correlatedExposurePercent)
    && snapshot.correlatedExposurePercent > policy.maxCorrelatedExposurePercent) add(blockCodes, 'CORRELATED_EXPOSURE_LIMIT');
  if (!riskReducing && finiteNonNegative(snapshot.availableLiquidityKrw)
    && snapshot.availableLiquidityKrw < plan.estimatedKrw) add(blockCodes, 'LIQUIDITY_LIMIT');
  if (!plan.strategyId.trim() || !plan.signalId.trim()) add(blockCodes, 'SIGNAL_ID_REQUIRED');

  if (policy.mode === 'automatic' && policy.automaticEnabled && !riskReducing) {
    const assetClass = assetClassForPlan(plan);
    if (!policy.marketEnabled[assetClass]) add(blockCodes, 'MARKET_NOT_ENABLED');
    if (assetClass === 'domestic_stock' || assetClass === 'us_stock') {
      const selectedBroker = policy.stockBrokerByMarket?.[assetClass] ?? 'kiwoom';
      const planBroker = plan.stockBroker ?? (plan.exchange === 'toss' ? 'toss' : 'kiwoom');
      if (planBroker !== selectedBroker) add(blockCodes, 'STOCK_BROKER_MISMATCH');
      if (plan.exchange !== planBroker) add(blockCodes, 'STOCK_EXECUTION_PROVIDER_MISMATCH');
    } else if (plan.stockBroker != null) {
      add(blockCodes, 'STOCK_BROKER_NOT_APPLICABLE');
    }
    if (!policy.exchangeEnabled[plan.exchange]) add(blockCodes, 'EXCHANGE_NOT_ENABLED');
    const normalizedSymbol = plan.exchange === 'upbit' ? plan.symbol.toUpperCase().replace(/^KRW-/, '') : plan.symbol.toUpperCase();
    if (policy.enabledAssets[plan.exchange].length > 0 && !policy.enabledAssets[plan.exchange].includes(normalizedSymbol)) add(blockCodes, 'ASSET_NOT_ENABLED');
    // A blank list is NOT a wildcard for automatic Paper or Live plans.
    // Require an explicit server-stored allowlist even when a caller bypasses
    // the member background Worker and invokes the canonical order API.
    if (policy.enabledStrategies.length === 0 || !policy.enabledStrategies.includes(plan.strategyId)) {
      add(blockCodes, 'STRATEGY_NOT_ENABLED');
    }
    if (plan.accountMode !== 'paper' && plan.accountMode !== 'live' && !plan.economics) add(blockCodes, 'AUTOMATIC_ECONOMICS_REQUIRED');
  }
  if (plan.accountMode === 'live' && !options.serverLiveEnabled) add(blockCodes, 'LIVE_EXECUTION_DISABLED');

  if (plan.exchange === 'bitget') {
    if (!['long', 'short', 'buy', 'sell'].includes(plan.side)) add(blockCodes, 'BITGET_SIDE_INVALID');
    if (!Number.isInteger(plan.leverage) || (plan.leverage ?? 0) < PRODUCTION_MIN_BITGET_LEVERAGE || (plan.leverage ?? 0) > PRODUCTION_ADMIN_MAX_BITGET_LEVERAGE) add(blockCodes, 'BITGET_LEVERAGE_LIMIT');
    if (Number.isInteger(plan.leverage) && (plan.leverage ?? 0) > policy.bitgetLeverage) add(blockCodes, 'BITGET_LEVERAGE_POLICY_LIMIT');
    if (plan.marginMode !== 'isolated') add(blockCodes, 'BITGET_ISOLATED_MARGIN_REQUIRED');
    if (snapshot.existingPositionSide && snapshot.existingPositionSide !== plan.side && !riskReducing) add(blockCodes, 'BITGET_OPPOSITE_POSITION_DUPLICATE');
    const requiredMargin = plan.estimatedKrw / Math.max(1, plan.leverage ?? 1);
    if (!riskReducing && snapshot.availableBalance < requiredMargin) add(blockCodes, 'INSUFFICIENT_MARGIN');
    if (!riskReducing && finitePositive(snapshot.liquidationDistancePercent) && snapshot.liquidationDistancePercent <= MIN_LIQUIDATION_DISTANCE_PERCENT) add(blockCodes, 'BITGET_LIQUIDATION_RISK');
  }
  if (plan.exchange !== 'bitget' && (plan.leverage != null || plan.marginMode != null)) {
    // Upbit spot and KR/US stock plans are 1x cash trades. A leverage or margin
    // field arriving from any client, config or request body is rejected here
    // (Paper and Live alike) before the spot/stock live capability guards.
    add(blockCodes, 'LEVERAGE_NOT_APPLICABLE_SPOT_OR_STOCK');
  }
  if (plan.exchange === 'upbit') {
    if (plan.market !== 'KRW' || (plan.side !== 'buy' && plan.side !== 'sell')) add(blockCodes, 'UPBIT_SPOT_ONLY');
    if (plan.side === 'short') add(blockCodes, 'UPBIT_SHORT_NOT_SUPPORTED');
    if (plan.estimatedKrw < UPBIT_MINIMUM_KRW) add(blockCodes, 'UPBIT_MINIMUM_ORDER');
    if (plan.orderType === 'market' && plan.side === 'buy' && !finitePositive(plan.quoteAmount)) add(blockCodes, 'UPBIT_MARKET_BUY_AMOUNT_REQUIRED');
    if (plan.orderType === 'market' && plan.side === 'sell' && !finitePositive(plan.quantity)) add(blockCodes, 'UPBIT_MARKET_SELL_QUANTITY_REQUIRED');
    if (plan.orderType === 'limit' && finitePositive(plan.limitPrice) && !isAlignedToStep(plan.limitPrice, upbitKrwPriceStep(plan.limitPrice))) add(blockCodes, 'UPBIT_PRICE_TICK');
  }
  if (plan.exchange === 'kiwoom') {
    const stockMarketAllowed = plan.market === 'KR' || plan.market === 'US';
    if (!stockMarketAllowed || (plan.side !== 'buy' && plan.side !== 'sell')) add(blockCodes, 'STOCK_MARKET_NOT_SUPPORTED');
    if (!Number.isSafeInteger(plan.quantity) || Number(plan.quantity) <= 0) add(blockCodes, 'KIWOOM_QUANTITY_INVALID');
    if (plan.market === 'US' && !['NASDAQ', 'NYSE', 'AMEX'].includes(String(plan.stockExchange ?? ''))) {
      add(blockCodes, 'KIWOOM_US_EXCHANGE_REQUIRED');
    }
  }
  if (plan.exchange === 'toss') {
    const stockMarketAllowed = plan.market === 'KR' || plan.market === 'US';
    if (!stockMarketAllowed || (plan.side !== 'buy' && plan.side !== 'sell')) add(blockCodes, 'STOCK_MARKET_NOT_SUPPORTED');
    if (plan.market === 'KR' && (!Number.isSafeInteger(plan.quantity) || Number(plan.quantity) <= 0)) {
      add(blockCodes, 'TOSS_KR_QUANTITY_INVALID');
    }
    if (plan.market === 'US' && plan.quantity != null && !finitePositive(plan.quantity)) add(blockCodes, 'TOSS_US_QUANTITY_INVALID');
    if (plan.quoteAmount != null && (plan.market !== 'US' || plan.side !== 'buy' || plan.orderType !== 'market')) {
      add(blockCodes, 'TOSS_AMOUNT_ORDER_US_MARKET_BUY_ONLY');
    }
    if (plan.quantity == null && plan.quoteAmount == null) add(blockCodes, 'TOSS_QUANTITY_OR_AMOUNT_REQUIRED');
    if (plan.quantity != null && plan.quoteAmount != null) add(blockCodes, 'TOSS_QUANTITY_OR_AMOUNT_EXCLUSIVE');
  }
  if (!riskReducing && snapshot.availableBalance < plan.estimatedKrw && plan.exchange !== 'bitget') add(blockCodes, 'INSUFFICIENT_BALANCE');
  try {
    normalizeSplitRatios(plan.splitRatios);
  } catch (error) {
    if (error instanceof TradeSplitOrderPlanError) add(blockCodes, error.code);
    else add(blockCodes, 'TRADE_SPLIT_RATIO_INVALID');
  }
  if (!riskReducing && (plan.targetPrices.length === 0 || !finitePositive(plan.stopPrice))) add(blockCodes, 'EXIT_PLAN_REQUIRED');
  if (plan.invalidateAction === 'close') warnings.push('조건 무효화 시 청산은 위험관리 재검사 후에만 실행됩니다.');

  const hasOptimizationContext = !riskReducing && (plan.accountMode === 'live'
    || plan.economics != null || plan.entryPrice != null || plan.entryZoneLow != null
    || plan.entryZoneHigh != null || plan.estimatedSlippagePercent != null || plan.averageSpreadPercent != null);
  const optimization = hasOptimizationContext ? evaluateTradingOptimization(plan, policy) : undefined;
  if (optimization) {
    for (const code of optimization.blockCodes) add(blockCodes, code);
    for (const warning of optimization.warnings) if (!warnings.includes(warning)) warnings.push(warning);
  }
  return { allowed: blockCodes.length === 0, blockCodes, warnings, optimization };
}

// ---------------------------------------------------------------------------
/**
 * Per-market capital ledger (pure projections, no I/O).
 *
 * The owner's rule: every market runs on its OWN base fund (for example
 * Bitget futures 1,000,000 KRW + Upbit spot 1,000,000 KRW = 2,000,000 KRW
 * total). The sum of the per-market allocations may never exceed the total
 * base fund, a market may only spend what its own ledger shows as available,
 * reserve capital is never moved into a market automatically, and an
 * unexplained difference between the exchange balance and the ledger blocks
 * NEW entries until a person resolves it. Nothing here places, cancels or
 * amends an order; callers feed these block codes into the risk decision.
 */

export const MARKET_LEDGER_CLASSES: readonly TradingAssetClass[] = Object.freeze([
  'domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures',
]);

export const MARKET_LEDGER_DEFAULT_DRIFT_TOLERANCE_KRW = 1_000 as const;

export type MarketCapitalAllocationRow = Readonly<{
  market: TradingAssetClass;
  enabled: boolean;
  allocatedKrw: number;
}>;

export type MarketCapitalAllocation = Readonly<{
  totalCapitalKrw: number;
  markets: readonly MarketCapitalAllocationRow[];
  enabledAllocatedKrw: number;
  overAllocatedKrw: number;
  /** SHARED_POOL: no per-market base funds are declared (every enabled
   * market's cap equals the total), so the markets draw on one shared pool
   * and only the account-level exposure limit separates them. This is the
   * stored default and is REPORTED, not blocked. CONSISTENT / OVER_ALLOCATED
   * apply once per-market base funds are declared below the total. */
  status: 'SHARED_POOL' | 'CONSISTENT' | 'OVER_ALLOCATED';
  blockCodes: readonly string[];
}>;

function ledgerNonNegative(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Each enabled market's allocation is its asset-class cap. Allocations of
 * enabled markets must fit inside the total base fund; otherwise two markets
 * would be spending the same KRW. */
export function buildMarketCapitalAllocation(policy: TradingPolicy): MarketCapitalAllocation {
  const totalCapitalKrw = ledgerNonNegative(policy.totalCapitalKrw) ?? 0;
  const markets = MARKET_LEDGER_CLASSES.map((market) => Object.freeze({
    market,
    enabled: policy.marketEnabled[market] === true,
    allocatedKrw: Math.min(ledgerNonNegative(policy.maxAssetClassKrw[market]) ?? 0, totalCapitalKrw),
  }));
  const enabled = markets.filter((row) => row.enabled);
  const enabledAllocatedKrw = enabled.reduce((sum, row) => sum + row.allocatedKrw, 0);
  const overAllocatedKrw = Math.max(0, enabledAllocatedKrw - totalCapitalKrw);
  const declaresMarketFunds = enabled.length > 0 && enabled.every((row) => row.allocatedKrw < totalCapitalKrw);
  const status: MarketCapitalAllocation['status'] = !declaresMarketFunds ? 'SHARED_POOL'
    : overAllocatedKrw > 0 ? 'OVER_ALLOCATED' : 'CONSISTENT';
  return Object.freeze({
    totalCapitalKrw,
    markets: Object.freeze(markets),
    enabledAllocatedKrw,
    overAllocatedKrw,
    status,
    blockCodes: Object.freeze(status === 'OVER_ALLOCATED' ? ['MARKET_CAPITAL_OVER_ALLOCATED'] : []),
  });
}

export type MarketLedgerProjectionInput = Readonly<{
  market: TradingAssetClass;
  allocatedKrw: number;
  /** KRW locked by this market's own open (unfilled) orders. */
  openOrderReservedKrw: number;
  /** Margin/cost already committed to open positions of this market. */
  positionMarginKrw: number;
  /** Realized PnL of closed trades. null = not yet proven (never assumed 0). */
  realizedPnlKrw: number | null;
  /** Fees/funding/slippage actually charged. null = unknown (never assumed 0). */
  costsKrw: number | null;
  /** What the exchange itself reports as available, in KRW. null = not read. */
  exchangeAvailableKrw: number | null;
  driftToleranceKrw?: number;
}>;

export type MarketLedgerProjection = Readonly<{
  market: TradingAssetClass;
  allocatedKrw: number;
  openOrderReservedKrw: number;
  positionMarginKrw: number;
  realizedPnlKrw: number | null;
  costsKrw: number | null;
  /** Ledger view of spendable KRW: allocation + realized − costs − reserved − margin. */
  availableKrw: number;
  exchangeAvailableKrw: number | null;
  driftKrw: number | null;
  driftStatus: 'UNVERIFIED' | 'WITHIN_TOLERANCE' | 'DRIFT_UNRESOLVED';
  blockCodes: readonly string[];
}>;

export function projectMarketLedger(input: MarketLedgerProjectionInput): MarketLedgerProjection {
  const allocatedKrw = ledgerNonNegative(input.allocatedKrw) ?? 0;
  const openOrderReservedKrw = ledgerNonNegative(input.openOrderReservedKrw) ?? 0;
  const positionMarginKrw = ledgerNonNegative(input.positionMarginKrw) ?? 0;
  const realizedPnlKrw = Number.isFinite(Number(input.realizedPnlKrw)) && input.realizedPnlKrw != null
    ? Number(input.realizedPnlKrw) : null;
  const costsKrw = input.costsKrw == null ? null : ledgerNonNegative(input.costsKrw);
  const blockCodes: string[] = [];
  // Unknown realized PnL / costs are treated as the most conservative value
  // for availability (0 profit, 0 further credit) but flagged, never silently 0.
  if (input.realizedPnlKrw != null && realizedPnlKrw == null) blockCodes.push('MARKET_LEDGER_REALIZED_PNL_INVALID');
  if (input.costsKrw != null && costsKrw == null) blockCodes.push('MARKET_LEDGER_COSTS_INVALID');
  const availableKrw = Math.max(0,
    allocatedKrw + Math.min(0, realizedPnlKrw ?? 0) + Math.max(0, realizedPnlKrw ?? 0)
    - (costsKrw ?? 0) - openOrderReservedKrw - positionMarginKrw);
  const exchangeAvailableKrw = input.exchangeAvailableKrw == null ? null : ledgerNonNegative(input.exchangeAvailableKrw);
  const tolerance = ledgerNonNegative(input.driftToleranceKrw) ?? MARKET_LEDGER_DEFAULT_DRIFT_TOLERANCE_KRW;
  let driftKrw: number | null = null;
  let driftStatus: MarketLedgerProjection['driftStatus'] = 'UNVERIFIED';
  if (exchangeAvailableKrw != null) {
    // The exchange may hold MORE than this market's allocation (shared
    // account, reserve capital). Only a SHORTFALL against the ledger is drift.
    driftKrw = exchangeAvailableKrw - availableKrw;
    driftStatus = driftKrw < -tolerance ? 'DRIFT_UNRESOLVED' : 'WITHIN_TOLERANCE';
  }
  if (driftStatus === 'DRIFT_UNRESOLVED') blockCodes.push('MARKET_LEDGER_EXCHANGE_DRIFT_UNRESOLVED');
  return Object.freeze({
    market: input.market,
    allocatedKrw,
    openOrderReservedKrw,
    positionMarginKrw,
    realizedPnlKrw,
    costsKrw,
    availableKrw,
    exchangeAvailableKrw,
    driftKrw,
    driftStatus,
    blockCodes: Object.freeze(blockCodes),
  });
}

export type AllowedEntryInput = Readonly<{
  /** Member 500,000 / administrator 1,000,000 KRW per single order. */
  roleCapKrw: number;
  /** Saved policy maxOrderKrw (already clamped to the role cap). */
  policyMaxOrderKrw: number;
  /** This market's ledger allocation. */
  marketAllocatedKrw: number;
  /** This market's ledger availability after reservations/margin. */
  ledgerAvailableKrw: number;
  /** The exchange's own available balance in KRW, null when not read. */
  exchangeAvailableKrw: number | null;
  exchangeMinimumKrw: number | null;
  exchangeMaximumKrw: number | null;
}>;

export type AllowedEntryDecision = Readonly<{
  allowedKrw: number;
  bindingLimit: 'ROLE_CAP' | 'POLICY_MAX_ORDER' | 'MARKET_ALLOCATION' | 'LEDGER_AVAILABLE'
    | 'EXCHANGE_AVAILABLE' | 'EXCHANGE_MAXIMUM' | 'NONE';
  blockCodes: readonly string[];
}>;

/** The final permitted single-entry size is the STRICTEST of every limit.
 * A requested size above it is rejected by the server, never trimmed up. */
export function finalAllowedEntryKrw(input: AllowedEntryInput): AllowedEntryDecision {
  const candidates: Array<[AllowedEntryDecision['bindingLimit'], number | null]> = [
    ['ROLE_CAP', ledgerNonNegative(input.roleCapKrw)],
    ['POLICY_MAX_ORDER', ledgerNonNegative(input.policyMaxOrderKrw)],
    ['MARKET_ALLOCATION', ledgerNonNegative(input.marketAllocatedKrw)],
    ['LEDGER_AVAILABLE', ledgerNonNegative(input.ledgerAvailableKrw)],
    ['EXCHANGE_AVAILABLE', input.exchangeAvailableKrw == null ? null : ledgerNonNegative(input.exchangeAvailableKrw)],
    ['EXCHANGE_MAXIMUM', input.exchangeMaximumKrw == null ? null : ledgerNonNegative(input.exchangeMaximumKrw)],
  ];
  let allowedKrw = Number.POSITIVE_INFINITY;
  let bindingLimit: AllowedEntryDecision['bindingLimit'] = 'NONE';
  for (const [name, value] of candidates) {
    if (value == null) continue;
    if (value < allowedKrw) { allowedKrw = value; bindingLimit = name; }
  }
  if (!Number.isFinite(allowedKrw)) allowedKrw = 0;
  const blockCodes: string[] = [];
  const minimum = input.exchangeMinimumKrw == null ? null : ledgerNonNegative(input.exchangeMinimumKrw);
  if (minimum != null && allowedKrw < minimum) blockCodes.push('ALLOWED_ENTRY_BELOW_EXCHANGE_MINIMUM');
  if (allowedKrw <= 0) blockCodes.push('ALLOWED_ENTRY_ZERO');
  return Object.freeze({ allowedKrw, bindingLimit, blockCodes: Object.freeze(blockCodes) });
}

export function requestedEntryExceedsAllowed(requestedKrw: number, decision: AllowedEntryDecision): boolean {
  const requested = Number(requestedKrw);
  return !Number.isFinite(requested) || requested <= 0 || requested > decision.allowedKrw + 1e-9;
}

/** Block codes for a plan that would open or add exposure on a live account.
 * Risk-reducing exits are never blocked by allocation bookkeeping. */
export function marketCapitalEntryBlockCodes(
  plan: Pick<TradingPlanInput, 'accountMode'>,
  policy: TradingPolicy,
  options: { riskReducing: boolean },
): readonly string[] {
  if (options.riskReducing || plan.accountMode !== 'live') return Object.freeze([]);
  return buildMarketCapitalAllocation(policy).blockCodes;
}
