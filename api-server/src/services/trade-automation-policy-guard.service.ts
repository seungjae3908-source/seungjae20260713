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
 * Emergency/new-entry stops are sticky and require the dedicated confirmed resume route.
 */
export function enforceMemberTradingPolicy(
  candidate: TradingPolicy,
  current: TradingPolicy,
): TradingPolicy {
  const candidateClassLimits = candidate.maxAssetClassKrw ?? DEFAULT_TRADING_POLICY.maxAssetClassKrw;
  return {
    ...candidate,
    emergencyStopped: current.emergencyStopped || candidate.emergencyStopped,
    newEntriesStopped: current.newEntriesStopped === true || candidate.newEntriesStopped === true,
    riskOptimizationEnabled: true,
    pilotStage: current.pilotStage,
    maxInstrumentKrw: noMoreThan(
      candidate.maxInstrumentKrw ?? DEFAULT_TRADING_POLICY.maxInstrumentKrw,
      DEFAULT_TRADING_POLICY.maxInstrumentKrw,
    ),
    maxAssetClassKrw: {
      domestic_stock: noMoreThan(candidateClassLimits.domestic_stock, DEFAULT_TRADING_POLICY.maxAssetClassKrw.domestic_stock),
      us_stock: noMoreThan(candidateClassLimits.us_stock, DEFAULT_TRADING_POLICY.maxAssetClassKrw.us_stock),
      crypto_spot: noMoreThan(candidateClassLimits.crypto_spot, DEFAULT_TRADING_POLICY.maxAssetClassKrw.crypto_spot),
      crypto_futures: noMoreThan(candidateClassLimits.crypto_futures, DEFAULT_TRADING_POLICY.maxAssetClassKrw.crypto_futures),
    },
    weeklyLossLimitPercent: noMoreThan(
      candidate.weeklyLossLimitPercent ?? DEFAULT_TRADING_POLICY.weeklyLossLimitPercent,
      DEFAULT_TRADING_POLICY.weeklyLossLimitPercent,
    ),
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
    newEntriesStopped: false,
    exchangeEnabled: { bitget: false, upbit: false, kiwoom: false },
  };
}
