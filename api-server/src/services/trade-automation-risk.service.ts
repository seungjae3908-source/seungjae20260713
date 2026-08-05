import { evaluateTradingOptimization } from './trade-automation-optimization.service';
import {
  DEFAULT_TRADING_POLICY,
  type TradingPlanInput,
  type TradingPolicy,
  type TradingRiskDecision,
} from './trade-automation.types';

const MAX_DATA_DELAY_MS = 5_000;
const MAX_SNAPSHOT_AGE_MS = 30_000;
const MAX_SNAPSHOT_FUTURE_SKEW_MS = 5_000;
const MAX_ONE_MINUTE_MOVE_PERCENT = 5;
const MAX_SPREAD_PERCENT = 1;
const MAX_ORDERBOOK_GAP_PERCENT = 2;
const MIN_LIQUIDATION_DISTANCE_PERCENT = 5;
const UPBIT_MINIMUM_KRW = 5_000;

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function add(values: string[], code: string) {
  if (!values.includes(code)) values.push(code);
}

function normalizedList(value: unknown, maximum: number) {
  return Array.isArray(value)
    ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, maximum)
    : [];
}

export function normalizeTradingPolicy(value: Partial<TradingPolicy> | null | undefined): TradingPolicy {
  const input = value ?? {};
  const leverage = Number(input.bitgetLeverage);
  const pilotStage = input.pilotStage === 'limited-50' || input.pilotStage === 'validated'
    ? input.pilotStage : 'approval-20';
  return {
    mode: input.mode === 'automatic' ? 'automatic' : 'approval',
    automaticEnabled: input.automaticEnabled === true,
    emergencyStopped: input.emergencyStopped === true,
    exchangeEnabled: {
      bitget: input.exchangeEnabled?.bitget === true,
      upbit: input.exchangeEnabled?.upbit === true,
      kiwoom: input.exchangeEnabled?.kiwoom === true,
    },
    enabledAssets: {
      bitget: normalizedList(input.enabledAssets?.bitget, 100).map((item) => item.toUpperCase()),
      upbit: normalizedList(input.enabledAssets?.upbit, 100).map((item) => item.toUpperCase().replace(/^KRW-/, '')),
      kiwoom: normalizedList(input.enabledAssets?.kiwoom, 100).map((item) => item.toUpperCase()),
    },
    enabledStrategies: normalizedList(input.enabledStrategies, 30),
    totalCapitalKrw: clampNumber(input.totalCapitalKrw, 10_000, 10_000_000_000, DEFAULT_TRADING_POLICY.totalCapitalKrw),
    maxOrderKrw: clampNumber(input.maxOrderKrw, 5_000, 1_000_000, DEFAULT_TRADING_POLICY.maxOrderKrw),
    dailyLossLimitPercent: clampNumber(input.dailyLossLimitPercent, 0.1, 5, DEFAULT_TRADING_POLICY.dailyLossLimitPercent),
    maxAssetPercent: clampNumber(input.maxAssetPercent, 1, 30, DEFAULT_TRADING_POLICY.maxAssetPercent),
    maxOpenPositions: Math.round(clampNumber(input.maxOpenPositions, 1, 50, DEFAULT_TRADING_POLICY.maxOpenPositions)),
    maxDailyOrders: Math.round(clampNumber(input.maxDailyOrders, 1, 100, DEFAULT_TRADING_POLICY.maxDailyOrders)),
    maxConsecutiveLosses: Math.round(clampNumber(input.maxConsecutiveLosses, 1, 20, DEFAULT_TRADING_POLICY.maxConsecutiveLosses)),
    bitgetLeverage: leverage === 3 ? 3 : 2,
    riskOptimizationEnabled: input.riskOptimizationEnabled !== false,
    pilotStage,
    riskPerTradePercent: {
      bitget: clampNumber(input.riskPerTradePercent?.bitget, 0.01, 1, DEFAULT_TRADING_POLICY.riskPerTradePercent.bitget),
      upbit: clampNumber(input.riskPerTradePercent?.upbit, 0.01, 1, DEFAULT_TRADING_POLICY.riskPerTradePercent.upbit),
      kiwoom: clampNumber(input.riskPerTradePercent?.kiwoom, 0.01, 1, DEFAULT_TRADING_POLICY.riskPerTradePercent.kiwoom),
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

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
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
  const snapshot = plan.marketSnapshot;

  if (options.emergencyStopped) add(blockCodes, 'EMERGENCY_STOP_ACTIVE');
  if (!finitePositive(plan.estimatedKrw) || plan.estimatedKrw > policy.maxOrderKrw) add(blockCodes, 'MAX_ORDER_AMOUNT');
  if (snapshot.dailyPnlPercent <= -policy.dailyLossLimitPercent) add(blockCodes, 'DAILY_LOSS_LIMIT');
  if (snapshot.assetExposurePercent > policy.maxAssetPercent) add(blockCodes, 'ASSET_EXPOSURE_LIMIT');
  const capitalBase = Math.max(1, Math.min(policy.totalCapitalKrw, snapshot.accountValueKrw || policy.totalCapitalKrw));
  const projectedExposurePercent = snapshot.assetExposurePercent + (plan.estimatedKrw / capitalBase) * 100;
  if (projectedExposurePercent > policy.maxAssetPercent) add(blockCodes, 'PROJECTED_ASSET_EXPOSURE_LIMIT');
  if (snapshot.openPositionCount >= policy.maxOpenPositions) add(blockCodes, 'OPEN_POSITION_LIMIT');
  if (snapshot.dailyOrderCount >= policy.maxDailyOrders) add(blockCodes, 'DAILY_ORDER_LIMIT');
  if (snapshot.consecutiveLosses >= policy.maxConsecutiveLosses) add(blockCodes, 'CONSECUTIVE_LOSS_LIMIT');
  if (snapshot.halted) add(blockCodes, 'MARKET_HALTED');

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
      if (snapshotAgeMs > MAX_SNAPSHOT_AGE_MS) add(blockCodes, 'MARKET_SNAPSHOT_STALE');
      const effectiveDelayMs = Math.max(
        Number.isFinite(declaredDelayMs) && declaredDelayMs >= 0 ? declaredDelayMs : Number.MAX_SAFE_INTEGER,
        Math.max(0, snapshotAgeMs),
      );
      if (effectiveDelayMs > MAX_DATA_DELAY_MS) add(blockCodes, 'MARKET_DATA_DELAYED');
    }
  }

  if (Math.abs(snapshot.oneMinuteMovePercent) >= MAX_ONE_MINUTE_MOVE_PERCENT) add(blockCodes, 'ONE_MINUTE_VOLATILITY');
  if (snapshot.spreadPercent > MAX_SPREAD_PERCENT) add(blockCodes, 'SPREAD_TOO_WIDE');
  if (snapshot.orderbookGapPercent > MAX_ORDERBOOK_GAP_PERCENT) add(blockCodes, 'ORDERBOOK_GAP');
  if (!plan.strategyId.trim() || !plan.signalId.trim()) add(blockCodes, 'SIGNAL_ID_REQUIRED');

  if (policy.mode === 'automatic') {
    if (!policy.automaticEnabled) add(blockCodes, 'AUTOMATIC_MODE_NOT_CONFIRMED');
    if (!policy.exchangeEnabled[plan.exchange]) add(blockCodes, 'EXCHANGE_NOT_ENABLED');
    const normalizedSymbol = plan.exchange === 'upbit'
      ? plan.symbol.toUpperCase().replace(/^KRW-/, '') : plan.symbol.toUpperCase();
    if (!policy.enabledAssets[plan.exchange].includes(normalizedSymbol)) add(blockCodes, 'ASSET_NOT_ENABLED');
    if (!policy.enabledStrategies.includes(plan.strategyId)) add(blockCodes, 'STRATEGY_NOT_ENABLED');
  }

  if (plan.accountMode === 'live' && !options.serverLiveEnabled) add(blockCodes, 'LIVE_EXECUTION_DISABLED');

  if (plan.exchange === 'bitget') {
    if (!['long', 'short', 'buy', 'sell'].includes(plan.side)) add(blockCodes, 'BITGET_SIDE_INVALID');
    if (plan.leverage !== 1 && plan.leverage !== 2 && plan.leverage !== 3) add(blockCodes, 'BITGET_LEVERAGE_LIMIT');
    if ((plan.leverage ?? 0) > 3) add(blockCodes, 'BITGET_LEVERAGE_LIMIT');
    if (plan.marginMode !== 'crossed' && plan.marginMode !== 'isolated') add(blockCodes, 'BITGET_MARGIN_MODE_REQUIRED');
    if (snapshot.existingPositionSide && snapshot.existingPositionSide !== plan.side && !plan.reduceOnly) {
      add(blockCodes, 'BITGET_OPPOSITE_POSITION_DUPLICATE');
    }
    const requiredMargin = plan.estimatedKrw / Math.max(1, plan.leverage ?? 1);
    if (snapshot.availableBalance < requiredMargin) add(blockCodes, 'INSUFFICIENT_MARGIN');
    if (finitePositive(snapshot.liquidationDistancePercent)
      && snapshot.liquidationDistancePercent <= MIN_LIQUIDATION_DISTANCE_PERCENT) {
      add(blockCodes, 'BITGET_LIQUIDATION_RISK');
    }
  }

  if (plan.exchange === 'upbit') {
    if (plan.market !== 'KRW' || (plan.side !== 'buy' && plan.side !== 'sell')) add(blockCodes, 'UPBIT_SPOT_ONLY');
    if (plan.side === 'short') add(blockCodes, 'UPBIT_SHORT_NOT_SUPPORTED');
    if (plan.estimatedKrw < UPBIT_MINIMUM_KRW) add(blockCodes, 'UPBIT_MINIMUM_ORDER');
    if (plan.orderType === 'market' && plan.side === 'buy' && !finitePositive(plan.quoteAmount)) add(blockCodes, 'UPBIT_MARKET_BUY_AMOUNT_REQUIRED');
    if (plan.orderType === 'market' && plan.side === 'sell' && !finitePositive(plan.quantity)) add(blockCodes, 'UPBIT_MARKET_SELL_QUANTITY_REQUIRED');
    if (plan.orderType === 'limit' && finitePositive(plan.limitPrice) && !isAlignedToStep(plan.limitPrice, upbitKrwPriceStep(plan.limitPrice))) {
      add(blockCodes, 'UPBIT_PRICE_TICK');
    }
  }

  if (plan.exchange === 'kiwoom') {
    if (plan.market !== 'KR' || (plan.side !== 'buy' && plan.side !== 'sell')) add(blockCodes, 'KIWOOM_DOMESTIC_ONLY');
    if (!Number.isSafeInteger(plan.quantity) || Number(plan.quantity) <= 0) add(blockCodes, 'KIWOOM_QUANTITY_INVALID');
    if (plan.accountMode !== 'mock' && plan.accountMode !== 'live' && plan.accountMode !== 'paper') add(blockCodes, 'KIWOOM_ACCOUNT_MODE_INVALID');
  }

  if (snapshot.availableBalance < plan.estimatedKrw && plan.exchange !== 'bitget') add(blockCodes, 'INSUFFICIENT_BALANCE');
  if (plan.splitRatios.length === 0 || Math.abs(plan.splitRatios.reduce((sum, value) => sum + value, 0) - 100) > 0.01) {
    add(blockCodes, 'SPLIT_RATIO_INVALID');
  }
  if (plan.targetPrices.length === 0 || !finitePositive(plan.stopPrice)) add(blockCodes, 'EXIT_PLAN_REQUIRED');
  if (plan.invalidateAction === 'close') warnings.push('조건 무효화 시 청산은 위험관리 재검사 후에만 실행됩니다.');

  const hasOptimizationContext = plan.accountMode === 'live'
    || plan.economics != null
    || plan.signalState != null
    || plan.signalExpiresAt != null
    || plan.entryPrice != null
    || plan.entryZoneLow != null
    || plan.entryZoneHigh != null
    || plan.estimatedSlippagePercent != null
    || plan.averageSpreadPercent != null;
  const optimization = hasOptimizationContext ? evaluateTradingOptimization(plan, policy) : undefined;
  if (optimization) {
    for (const code of optimization.blockCodes) add(blockCodes, code);
    for (const warning of optimization.warnings) if (!warnings.includes(warning)) warnings.push(warning);
  }

  return { allowed: blockCodes.length === 0, blockCodes, warnings, optimization };
}
