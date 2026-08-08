import type { TradingRepository } from './trade-automation.repository';

const KILL_SWITCH_CODES = new Set([
  'MARKET_DATA_TIMESTAMP_UNAVAILABLE',
  'MARKET_DATA_FROM_FUTURE',
  'MARKET_DATA_STALE',
  'MARKET_DATA_DELAY_UNKNOWN',
  'MARKET_DATA_DELAY_INCONSISTENT',
  'MARKET_DATA_SOURCE_UNAVAILABLE',
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
}) {
  const reasons = killSwitchReasons(input.blockCodes);
  if (reasons.length === 0) return { tripped: false, reasons };
  await input.repository.setGlobalEmergencyStop(true, input.userId);
  return { tripped: true, reasons };
}
