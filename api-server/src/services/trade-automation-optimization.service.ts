import type {
  TradingOptimizationAssessment,
  TradingPlanInput,
  TradingPolicy,
} from './trade-automation.types';

const LIVE_ACTIONABLE_SIGNAL_STATES = new Set(['READY_FOR_APPROVAL']);
const TERMINAL_SIGNAL_STATES = new Set(['INVALIDATED', 'EXPIRED']);

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function add(values: string[], code: string) {
  if (!values.includes(code)) values.push(code);
}

function normalizedProbability(value: number) {
  if (!Number.isFinite(value)) return null;
  const normalized = value > 1 ? value / 100 : value;
  if (normalized <= 0 || normalized >= 1) return null;
  return normalized;
}

function expectedValueR(plan: TradingPlanInput) {
  const economics = plan.economics;
  if (!economics) return null;
  const winProbability = normalizedProbability(economics.winProbability);
  if (winProbability == null || !positive(economics.averageWinR)
    || !positive(economics.averageLossR) || !finite(economics.estimatedCostsR)) {
    return null;
  }
  return winProbability * economics.averageWinR
    - (1 - winProbability) * economics.averageLossR
    - Math.max(0, economics.estimatedCostsR);
}

function stopDistancePercent(plan: TradingPlanInput) {
  const price = positive(plan.entryPrice)
    ? plan.entryPrice
    : positive(plan.marketSnapshot.currentPrice)
      ? plan.marketSnapshot.currentPrice
      : positive(plan.limitPrice)
        ? plan.limitPrice
        : null;
  if (!price || !positive(plan.stopPrice)) return null;
  const distance = Math.abs(price - plan.stopPrice) / price * 100;
  return Number.isFinite(distance) && distance > 0 ? distance : null;
}

function riskBudget(policy: TradingPolicy, plan: TradingPlanInput, distancePercent: number | null) {
  if (distancePercent == null) return { riskBudgetKrw: null, maximumOrderKrw: null };
  const accountValue = positive(plan.marketSnapshot.accountValueKrw)
    ? plan.marketSnapshot.accountValueKrw : policy.totalCapitalKrw;
  const capitalBase = Math.max(1, Math.min(policy.totalCapitalKrw, accountValue));
  const riskBudgetKrw = capitalBase * policy.riskPerTradePercent[plan.exchange] / 100;
  const maximumOrderKrw = riskBudgetKrw / (distancePercent / 100);
  return { riskBudgetKrw, maximumOrderKrw };
}

export function evaluateTradingOptimization(
  plan: TradingPlanInput,
  policy: TradingPolicy,
  now = Date.now(),
): TradingOptimizationAssessment {
  const blockCodes: string[] = [];
  const warnings: string[] = [];
  const liveOrAutomatic = plan.accountMode === 'live' || policy.mode === 'automatic';
  const signalState = plan.signalState ?? null;
  const expiresAt = plan.signalExpiresAt ? Date.parse(plan.signalExpiresAt) : NaN;

  if (liveOrAutomatic) {
    if (!signalState) add(blockCodes, 'SIGNAL_STATE_REQUIRED');
    else if (TERMINAL_SIGNAL_STATES.has(signalState)) add(blockCodes, 'SIGNAL_INVALID_OR_EXPIRED');
    else if (!LIVE_ACTIONABLE_SIGNAL_STATES.has(signalState)) add(blockCodes, 'SIGNAL_NOT_ACTIONABLE');
    if (!Number.isFinite(expiresAt)) add(blockCodes, 'SIGNAL_EXPIRY_REQUIRED');
    else if (expiresAt <= now) add(blockCodes, 'SIGNAL_EXPIRED');
  } else if (signalState && TERMINAL_SIGNAL_STATES.has(signalState)) {
    add(blockCodes, 'SIGNAL_INVALID_OR_EXPIRED');
  }

  if (positive(plan.entryZoneLow) && positive(plan.entryZoneHigh)
    && plan.entryZoneLow > plan.entryZoneHigh) {
    add(blockCodes, 'ENTRY_ZONE_INVALID');
  }
  if (positive(plan.entryPrice) && positive(plan.entryZoneLow)
    && positive(plan.entryZoneHigh)
    && (plan.entryPrice < plan.entryZoneLow || plan.entryPrice > plan.entryZoneHigh)) {
    add(blockCodes, 'ENTRY_PRICE_OUTSIDE_ZONE');
  }

  const economics = plan.economics;
  const computedExpectedValueR = expectedValueR(plan);
  if (liveOrAutomatic) {
    if (!economics) {
      add(blockCodes, 'ECONOMICS_REQUIRED');
    } else {
      const calibratedAt = Date.parse(economics.calibratedAt);
      if (!Number.isFinite(calibratedAt)
        || now - calibratedAt > policy.maxEconomicsAgeHours * 60 * 60_000) {
        add(blockCodes, 'ECONOMICS_STALE');
      }
      if (economics.sampleSize < policy.minStrategySampleSize) add(blockCodes, 'STRATEGY_SAMPLE_TOO_SMALL');
      if (computedExpectedValueR == null) add(blockCodes, 'EXPECTED_VALUE_UNAVAILABLE');
      else if (computedExpectedValueR < policy.minExpectedValueR) add(blockCodes, 'EXPECTED_VALUE_TOO_LOW');
      if (positive(economics.profitFactor) && economics.profitFactor < policy.minProfitFactor) {
        add(blockCodes, 'PROFIT_FACTOR_TOO_LOW');
      }
      if (positive(economics.maxDrawdownPercent)
        && economics.maxDrawdownPercent > policy.maxStrategyDrawdownPercent) {
        add(blockCodes, 'STRATEGY_DRAWDOWN_TOO_HIGH');
      }
      if (economics.marketRegime === 'stress') add(blockCodes, 'MARKET_REGIME_STRESS');
      else if (economics.marketRegime === 'unknown') add(blockCodes, 'MARKET_REGIME_UNKNOWN');
    }
    if (!finite(plan.estimatedSlippagePercent)) add(blockCodes, 'SLIPPAGE_ESTIMATE_REQUIRED');
    else if (plan.estimatedSlippagePercent > policy.maxEstimatedSlippagePercent) add(blockCodes, 'SLIPPAGE_TOO_HIGH');
    if (!finite(plan.averageSpreadPercent)) add(blockCodes, 'AVERAGE_SPREAD_REQUIRED');
    else if (plan.averageSpreadPercent > policy.maxAverageSpreadPercent) add(blockCodes, 'AVERAGE_SPREAD_TOO_WIDE');
  } else if (!economics) {
    warnings.push('모의 주문에는 기대값 데이터가 없어도 실행할 수 있지만 실계좌 전환은 차단됩니다.');
  }

  const correlatedExposure = plan.marketSnapshot.correlatedExposurePercent;
  if (finite(correlatedExposure) && correlatedExposure > policy.maxCorrelatedExposurePercent) {
    add(blockCodes, 'CORRELATED_EXPOSURE_LIMIT');
  } else if (liveOrAutomatic && !finite(correlatedExposure)) {
    add(blockCodes, 'CORRELATED_EXPOSURE_REQUIRED');
  }

  const distancePercent = stopDistancePercent(plan);
  const budgets = riskBudget(policy, plan, distancePercent);
  if (liveOrAutomatic && distancePercent == null) add(blockCodes, 'STOP_DISTANCE_UNAVAILABLE');
  if (budgets.maximumOrderKrw != null && plan.estimatedKrw > budgets.maximumOrderKrw) {
    add(blockCodes, 'RISK_BUDGET_EXCEEDED');
  }
  const accountValue = positive(plan.marketSnapshot.accountValueKrw)
    ? plan.marketSnapshot.accountValueKrw : policy.totalCapitalKrw;
  const dailyLossKrw = Math.max(0, -plan.marketSnapshot.dailyPnlPercent / 100 * accountValue);
  const totalDailyLossBudgetKrw = accountValue * policy.totalDailyLossLimitPercent / 100;
  if (dailyLossKrw >= totalDailyLossBudgetKrw) add(blockCodes, 'TOTAL_DAILY_LOSS_BUDGET');

  const stageMaximum = policy.pilotStage === 'approval-20'
    ? 0 : policy.pilotStage === 'limited-50' ? 50_000 : policy.maxOrderKrw;
  if (plan.accountMode === 'live') {
    if (policy.pilotStage === 'approval-20') add(blockCodes, 'PILOT_LIVE_DISABLED');
    else if (plan.estimatedKrw > stageMaximum) add(blockCodes, 'PILOT_ORDER_LIMIT');
  }

  if (!policy.riskOptimizationEnabled) {
    add(blockCodes, 'RISK_OPTIMIZATION_DISABLED');
  }

  return {
    allowed: blockCodes.length === 0,
    blockCodes,
    warnings,
    expectedValueR: computedExpectedValueR,
    riskBudgetKrw: budgets.riskBudgetKrw,
    maximumOrderKrw: budgets.maximumOrderKrw,
    stopDistancePercent: distancePercent,
    pilotStage: policy.pilotStage,
  };
}
