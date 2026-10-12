import { PRODUCTION_ADMIN_FOUR_MARKET_INITIAL_KRW, PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW,
  type TradingPolicy } from './trade-automation.types';
import { isFormulaAiLiveExceptionStrategyId } from './formula-ai-live-exception.service';
import { STRATEGY_RULE_PACKS } from './evidence-backed-auto-strategy-catalog.service';

export function administratorAutomaticLivePolicyBlockers(policy: TradingPolicy): string[] {
  const blockers: string[] = [];
  const markets = ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures'] as const;
  if (policy.totalCapitalKrw !== PRODUCTION_ADMIN_FOUR_MARKET_INITIAL_KRW
    || policy.maxOrderKrw !== PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW
    || markets.some((m) => policy.maxAssetClassKrw[m] !== PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW)) {
    blockers.push('ADMIN_FOUR_MARKET_BASELINE_DRIFT');
  }
  if (policy.dailyLossLimitPercent !== 3) blockers.push('DAILY_LOSS_POLICY_DRIFT');
  if (policy.maxDailyOrders !== 0) blockers.push('DAILY_ORDER_COUNT_POLICY_DRIFT');
  if (policy.pilotStage === 'limited-50') blockers.push('OLD_50000_PILOT_CAP');
  return blockers;
}

/** Pure projection of the owner's approved policy. No DB write, resume,
 * authority grant, model PASS, promotion metric or real order occurs here.
 * The existing protected policy-preparation workflow performs any save only
 * after proving all server AUTO execution switches are still OFF. */
export function approvedAdministratorAutomaticLivePolicy(current: TradingPolicy): TradingPolicy {
  if (current.emergencyStopped !== false || current.newEntriesStopped !== false) {
    throw new Error('PREACTIVATION_MEMBER_STOP_REQUIRES_OWNER_RESUME');
  }
  const strategies = current.enabledStrategies.length ? [...current.enabledStrategies]
    : STRATEGY_RULE_PACKS.map((row) => row.strategyId);
  if (!strategies.every(isFormulaAiLiveExceptionStrategyId)) {
    throw new Error('PREACTIVATION_UNKNOWN_STRATEGY_REQUIRES_EXECUTION_EVIDENCE');
  }
  if (!Number.isInteger(current.bitgetLeverage) || current.bitgetLeverage < 2 || current.bitgetLeverage > 7) {
    throw new Error('PREACTIVATION_ADMIN_LEVERAGE_INVALID');
  }
  return {
    ...structuredClone(current), mode: 'automatic', automaticEnabled: true,
    marketEnabled: { domestic_stock: true, us_stock: true, crypto_spot: true, crypto_futures: true },
    exchangeEnabled: { toss: true, kiwoom: true, upbit: true, bitget: true },
    stockBrokerByMarket: { domestic_stock: current.stockBrokerByMarket?.domestic_stock === 'toss' ? 'toss' : 'kiwoom',
      us_stock: 'kiwoom' },
    totalCapitalKrw: PRODUCTION_ADMIN_FOUR_MARKET_INITIAL_KRW,
    maxOrderKrw: PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW,
    maxInstrumentKrw: PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW,
    maxAssetClassKrw: { domestic_stock: PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW,
      us_stock: PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW, crypto_spot: PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW,
      crypto_futures: PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW },
    dailyLossLimitPercent: 3, maxDailyOrders: 0, riskOptimizationEnabled: true,
    // Discovery is independently capped at 500k by the canonical capital
    // guard. This does NOT invent the genuine formula + AI proof it requires.
    pilotStage: 'formula-ai-exception', enabledStrategies: strategies,
  };
}
