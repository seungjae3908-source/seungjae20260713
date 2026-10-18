import type { TradingRepository } from './trade-automation.repository';
import type { TradingAccountMode } from './trade-automation.types';
import { autoStopRunForLossLimit } from './trade-automation-run-control.service';

const KILL_SWITCH_CODES = new Set([
  'MARKET_DATA_TIMESTAMP_UNAVAILABLE',
  'MARKET_DATA_FROM_FUTURE',
  'MARKET_DATA_STALE',
  'MARKET_DATA_DELAY_UNKNOWN',
  'MARKET_DATA_DELAY_INCONSISTENT',
  'MARKET_DATA_SOURCE_UNAVAILABLE',
  'MARKET_SNAPSHOT_TIMESTAMP_INVALID',
  'MARKET_SNAPSHOT_STALE',
  'MARKET_SNAPSHOT_FROM_FUTURE',
  'MARKET_DATA_DELAYED',
  'RISK_EVIDENCE_STALE',
  'PROVIDER_CLOCK_OFFSET_TOO_LARGE',
  'MARKET_HALTED',
  'EXCHANGE_API_FAILURE',
  'EXCHANGE_NETWORK_ERROR',
  'EXCHANGE_TIMEOUT',
  'ACCOUNT_STATE_MISMATCH',
  'ACCOUNT_MODE_MISMATCH',
  'ORDER_STATE_UNKNOWN',
  'FAST_MOVE_DETECTED',
  'ONE_MINUTE_VOLATILITY',
  'DAILY_LOSS_LIMIT',
  'APPROVAL_PRICE_DRIFT_EXCEEDED',
  'EXECUTION_RECONCILIATION_FAILED',
  'RECOVERY_RECONCILIATION_FAILED',
]);

export function killSwitchReasons(blockCodes: readonly string[]) {
  return [...new Set(blockCodes.filter((code) => KILL_SWITCH_CODES.has(code)))];
}

export async function tripKillSwitchForRiskFailure(input: {
  repository: TradingRepository;
  userId: string;
  blockCodes: readonly string[];
  /**
   * The mode of the plan/order that failed. A simulated (paper/mock) failure never trips the
   * GLOBAL halt that also stops real-money orders: live paths detect their own failures.
   * Omitted = unknown = conservative (global halt as before).
   */
  accountMode?: TradingAccountMode | null;
}) {
  // A daily loss limit also auto-stops this member's 작동 state (recorded with
  // its reason). This never weakens the block itself: the order is still rejected.
  await autoStopRunForLossLimit(input.repository, input.userId, input.blockCodes);
  const reasons = killSwitchReasons(input.blockCodes);
  if (reasons.length === 0) return { tripped: false, reasons };
  // Simulated failures are data/exchange/state symptoms of the simulation itself. The account-level
  // DAILY_LOSS_LIMIT keeps its deliberate global effect (existing, tested product rule).
  if ((input.accountMode === 'paper' || input.accountMode === 'mock') && !reasons.includes('DAILY_LOSS_LIMIT')) {
    return { tripped: false, reasons, scopedOutSimulated: true as const };
  }
  await input.repository.setGlobalEmergencyStop(true, input.userId);
  return { tripped: true, reasons };
}
