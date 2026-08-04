import type {
  TradingEconomics,
  TradingOptimizationAssessment,
  TradingPlanInput,
  TradingPolicy,
} from './trade-automation.types';

const ACTIONABLE_SIGNAL_STATES = new Set(['confirmed']);
const TERMINAL_SIGNAL_STATES = new Set(['invalid', 'expired']);
const INITIAL_FUTURES_SYMBOLS = new Set(['BTC', 'BTCUSDT', 'ETH', 'ETHUSDT']);

function add(values: string[], code: string) {
  if (!values.includes(code)) values.push(code);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function finitePositive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function hardGate(plan: TradingPlanInput, policy: TradingPolicy) {
  return plan.accountMode === 'live' || policy.mode === 'automatic';
}

function normalizedSymbol(plan: TradingPlanInput) {
  return plan.symbol.toUpperCase().replace(/^KRW-/, '').replace(/[-_/]/g, '');
}

export function calculateExpectedValueR(economics: TradingEconomics) {
  if (!finite(economics.winProbability)
    || economics.winProbability < 0
    || economics.winProbability > 1
    || !finitePositive(economics.averageWinR)
    || !finitePositive(economics.averageLossR)
    || !finite(economics.estimatedCostsR)
    || economics.estimatedCostsR < 0) {
    return null;
  }
  return economics.winProbability * economics.averageWinR
    - (1 - economics.winProbability) * economics.averageLossR
    - economics.estimatedCostsR;
}

export function resolvePlanEntryPrice(plan: TradingPlanInput) {
  const candidates = [plan.entryPrice, plan.limitPrice, plan.marketSnapshot.currentPrice];
  return candidates.find(finitePositive) ?? null;
}

export function calculateRiskSizedOrderLimitKrw(plan: TradingPlanInput, policy: TradingPolicy) {
  const entryPrice = resolvePlanEntryPrice(plan);
  if (!entryPrice || !finitePositive(plan.stopPrice)) {
    return { entryPrice, stopDistancePercent: null, riskBudgetKrw: null, maximumOrderKrw: null };
  }
  const isLong = plan.side === 'buy' || plan.side === 'long';
  const correctDirection = isLong ? plan.stopPrice < entryPrice : plan.stopPrice > entryPrice;
  if (!correctDirection) {
    return { entryPrice, stopDistancePercent: -1, riskBudgetKrw: null, maximumOrderKrw: null };
  }
  const stopDistancePercent = Math.abs(entryPrice - plan.stopPrice) / entryPrice * 100;
  if (!finitePositive(stopDistancePercent)) {
    return { entryPrice, stopDistancePercent: null, riskBudgetKrw: null, maximumOrderKrw: null };
  }
  const baseCapital = Math.max(1, Math.min(
    policy.totalCapitalKrw,
    finitePositive(plan.marketSnapshot.accountValueKrw)
      ? plan.marketSnapshot.accountValueKrw
      : policy.totalCapitalKrw,
  ));
  const pilotMultiplier = policy.pilotStage === 'approval-20' ? 0.5 : 1;
  const effectiveRiskPercent = policy.riskPerTradePercent[plan.exchange] * pilotMultiplier;
  const riskBudgetKrw = baseCapital * effectiveRiskPercent / 100;
  const maximumOrderKrw = riskBudgetKrw / (stopDistancePercent / 100);
  return { entryPrice, stopDistancePercent, riskBudgetKrw, maximumOrderKrw };
}

export function evaluateTradingOptimization(
  plan: TradingPlanInput,
  policy: TradingPolicy,
  now = Date.now(),
): TradingOptimizationAssessment {
  const blockCodes: string[] = [];
  const warnings: string[] = [];
  const strict = hardGate(plan, policy);
  const economics = plan.economics ?? null;
  const expectedValueR = economics ? calculateExpectedValueR(economics) : null;
  const sizing = calculateRiskSizedOrderLimitKrw(plan, policy);

  if (!policy.riskOptimizationEnabled) {
    if (plan.accountMode === 'live') add(blockCodes, 'LIVE_RISK_OPTIMIZATION_REQUIRED');
    else warnings.push('수익 최적화 위험검사가 꺼져 있어 Paper 검증만 허용됩니다.');
  }

  if (plan.marketSnapshot.dailyPnlPercent <= -policy.totalDailyLossLimitPercent) {
    add(blockCodes, 'TOTAL_DAILY_LOSS_LIMIT');
  }
  if (finite(plan.marketSnapshot.correlatedExposurePercent)
    && plan.marketSnapshot.correlatedExposurePercent > policy.maxCorrelatedExposurePercent) {
    add(blockCodes, 'CORRELATED_EXPOSURE_LIMIT');
  }

  if (plan.signalState) {
    if (TERMINAL_SIGNAL_STATES.has(plan.signalState)) add(blockCodes, 'SIGNAL_INVALID_OR_EXPIRED');
    else if (!ACTIONABLE_SIGNAL_STATES.has(plan.signalState)) {
      if (strict) add(blockCodes, 'SIGNAL_NOT_CONFIRMED');
      else warnings.push('신호가 확정 상태가 아니므로 승인 전 재확인이 필요합니다.');
    }
  } else if (strict) {
    add(blockCodes, 'SIGNAL_STATE_REQUIRED');
  }

  if (plan.signalExpiresAt) {
    const expiry = Date.parse(plan.signalExpiresAt);
    if (!Number.isFinite(expiry) || expiry <= now) add(blockCodes, 'SIGNAL_EXPIRED');
  } else if (strict) {
    add(blockCodes, 'SIGNAL_EXPIRY_REQUIRED');
  }

  const currentPrice = plan.marketSnapshot.currentPrice;
  if (finitePositive(currentPrice) && finitePositive(plan.entryZoneLow) && finitePositive(plan.entryZoneHigh)) {
    const low = Math.min(plan.entryZoneLow, plan.entryZoneHigh);
    const high = Math.max(plan.entryZoneLow, plan.entryZoneHigh);
    if (currentPrice < low || currentPrice > high) add(blockCodes, 'ENTRY_ZONE_LEFT');
  } else if (strict) {
    add(blockCodes, 'ENTRY_ZONE_REQUIRED');
  }

  const spread = finite(plan.averageSpreadPercent)
    ? plan.averageSpreadPercent
    : plan.marketSnapshot.spreadPercent;
  if (spread > policy.maxAverageSpreadPercent) {
    if (strict) add(blockCodes, 'AVERAGE_SPREAD_TOO_WIDE');
    else warnings.push('평균 스프레드가 보수적 기준을 초과합니다.');
  }
  if (finite(plan.estimatedSlippagePercent)) {
    if (plan.estimatedSlippagePercent > policy.maxEstimatedSlippagePercent) {
      add(blockCodes, 'ESTIMATED_SLIPPAGE_TOO_HIGH');
    }
  } else if (strict) {
    add(blockCodes, 'ESTIMATED_SLIPPAGE_REQUIRED');
  }

  if (!economics) {
    if (strict) add(blockCodes, 'ECONOMICS_REQUIRED');
    else warnings.push('비용 후 기대값 자료가 없어 승인형 Paper 검증만 권장됩니다.');
  } else {
    if (!Number.isSafeInteger(economics.sampleSize) || economics.sampleSize < 0) {
      add(blockCodes, 'ECONOMICS_SAMPLE_INVALID');
    } else if (economics.sampleSize < policy.minStrategySampleSize) {
      if (strict) add(blockCodes, 'INSUFFICIENT_STRATEGY_SAMPLE');
      else warnings.push(`전략 표본이 ${policy.minStrategySampleSize}건 미만입니다.`);
    }
    if (expectedValueR === null) add(blockCodes, 'ECONOMICS_INVALID');
    else if (expectedValueR < policy.minExpectedValueR) add(blockCodes, 'EXPECTED_VALUE_TOO_LOW');
    if (finite(economics.profitFactor) && economics.profitFactor < policy.minProfitFactor) {
      if (strict) add(blockCodes, 'PROFIT_FACTOR_TOO_LOW');
      else warnings.push('Profit Factor가 보수적 기준보다 낮습니다.');
    }
    if (finite(economics.maxDrawdownPercent)
      && economics.maxDrawdownPercent > policy.maxStrategyDrawdownPercent) {
      add(blockCodes, 'STRATEGY_DRAWDOWN_TOO_HIGH');
    }
    const calibratedAt = Date.parse(economics.calibratedAt);
    if (!Number.isFinite(calibratedAt) || Math.abs(now - calibratedAt) > policy.maxEconomicsAgeHours * 60 * 60_000) {
      if (strict) add(blockCodes, 'ECONOMICS_STALE');
      else warnings.push('전략 기대값 보정 자료가 오래되었습니다.');
    }
  }

  if (sizing.stopDistancePercent === -1) add(blockCodes, 'STOP_DIRECTION_INVALID');
  else if (sizing.maximumOrderKrw === null) {
    if (strict) add(blockCodes, 'ENTRY_PRICE_REQUIRED_FOR_RISK_SIZING');
  } else if (plan.estimatedKrw > Math.min(policy.maxOrderKrw, sizing.maximumOrderKrw)) {
    add(blockCodes, 'RISK_BUDGET_EXCEEDED');
  }

  if (plan.accountMode === 'live' && policy.pilotStage === 'approval-20') {
    if (policy.mode !== 'approval') add(blockCodes, 'PILOT_APPROVAL_REQUIRED');
    if (plan.exchange === 'bitget') {
      if (plan.leverage !== 1) add(blockCodes, 'PILOT_FUTURES_ONE_X_ONLY');
      if (!INITIAL_FUTURES_SYMBOLS.has(normalizedSymbol(plan))) add(blockCodes, 'PILOT_FUTURES_ASSET_LIMIT');
    }
  }
  if (plan.accountMode === 'live' && policy.mode === 'automatic'
    && policy.pilotStage !== 'validated') {
    add(blockCodes, 'AUTOMATIC_LIVE_REQUIRES_VALIDATED_STAGE');
  }

  return {
    allowed: blockCodes.length === 0,
    blockCodes,
    warnings,
    expectedValueR,
    riskBudgetKrw: sizing.riskBudgetKrw,
    maximumOrderKrw: sizing.maximumOrderKrw,
    stopDistancePercent: sizing.stopDistancePercent === -1 ? null : sizing.stopDistancePercent,
    pilotStage: policy.pilotStage,
  };
}
