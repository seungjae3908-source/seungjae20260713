import { DEFAULT_TRADING_POLICY, type TradingPolicy } from './trade-automation.types';

function noMoreThan(value: number, ceiling: number) {
  return Math.min(value, ceiling);
}

function noLessThan(value: number, floor: number) {
  return Math.max(value, floor);
}

/**
 * Member-facing settings may make a policy stricter, but they cannot weaken the
 * baseline safety contract or advance the measured live-trading pilot stage.
 * Emergency stop is sticky and requires the dedicated confirmed resume route.
 */
export function enforceMemberTradingPolicy(
  candidate: TradingPolicy,
  current: TradingPolicy,
): TradingPolicy {
  return {
    ...candidate,
    emergencyStopped: current.emergencyStopped || candidate.emergencyStopped,
    riskOptimizationEnabled: true,
    pilotStage: current.pilotStage,
    riskPerTradePercent: {
      bitget: noMoreThan(candidate.riskPerTradePercent.bitget, DEFAULT_TRADING_POLICY.riskPerTradePercent.bitget),
      upbit: noMoreThan(candidate.riskPerTradePercent.upbit, DEFAULT_TRADING_POLICY.riskPerTradePercent.upbit),
      kiwoom: noMoreThan(candidate.riskPerTradePercent.kiwoom, DEFAULT_TRADING_POLICY.riskPerTradePercent.kiwoom),
    },
    totalDailyLossLimitPercent: noMoreThan(
      candidate.totalDailyLossLimitPercent,
      DEFAULT_TRADING_POLICY.totalDailyLossLimitPercent,
    ),
    minExpectedValueR: noLessThan(candidate.minExpectedValueR, DEFAULT_TRADING_POLICY.minExpectedValueR),
    minStrategySampleSize: Math.round(noLessThan(
      candidate.minStrategySampleSize,
      DEFAULT_TRADING_POLICY.minStrategySampleSize,
    )),
    minProfitFactor: noLessThan(candidate.minProfitFactor, DEFAULT_TRADING_POLICY.minProfitFactor),
    maxStrategyDrawdownPercent: noMoreThan(
      candidate.maxStrategyDrawdownPercent,
      DEFAULT_TRADING_POLICY.maxStrategyDrawdownPercent,
    ),
    maxEstimatedSlippagePercent: noMoreThan(
      candidate.maxEstimatedSlippagePercent,
      DEFAULT_TRADING_POLICY.maxEstimatedSlippagePercent,
    ),
    maxAverageSpreadPercent: noMoreThan(
      candidate.maxAverageSpreadPercent,
      DEFAULT_TRADING_POLICY.maxAverageSpreadPercent,
    ),
    maxCorrelatedExposurePercent: noMoreThan(
      candidate.maxCorrelatedExposurePercent,
      DEFAULT_TRADING_POLICY.maxCorrelatedExposurePercent,
    ),
    maxEconomicsAgeHours: noMoreThan(
      candidate.maxEconomicsAgeHours,
      DEFAULT_TRADING_POLICY.maxEconomicsAgeHours,
    ),
  };
}

export function resumeMemberTradingPolicy(current: TradingPolicy): TradingPolicy {
  return {
    ...current,
    mode: 'approval',
    automaticEnabled: false,
    emergencyStopped: false,
    exchangeEnabled: { bitget: false, upbit: false, kiwoom: false },
  };
}
