/**
 * Owner's manual real-order ticket identity (no strategy, owner decides the size).
 *
 * Manual ticket plans skip the automatic-strategy gates that need research
 * evidence (economics, profitability attestation, pilot stage, per-trade risk
 * budget) and the policy amount/exposure caps. Account protection stays:
 * live gate and market switch, loss limits, emergency stop, open-position count,
 * spread/slippage/fast-move/liquidity, leverage, isolated margin, liquidation
 * distance and the exchange's own balance checks.
 */
export const MANUAL_ORDER_STRATEGY_ID = 'manual-order-ticket-v1';
export const MANUAL_ORDER_TICKET_REASON = 'MANUAL_ORDER_TICKET';

export function isManualOwnerOrder(plan: {
  accountMode: string;
  strategyId: string;
  signalReasons: readonly string[];
  executionMode?: string;
}): boolean {
  return plan.accountMode === 'live'
    && plan.strategyId === MANUAL_ORDER_STRATEGY_ID
    && plan.signalReasons.includes(MANUAL_ORDER_TICKET_REASON)
    && plan.executionMode !== 'automatic';
}

/** Policy amount and exposure caps that do not apply to the owner's manual orders. */
export const MANUAL_OWNER_EXEMPT_AMOUNT_CODES = Object.freeze([
  'MAX_ORDER_AMOUNT',
  'PROJECTED_ASSET_EXPOSURE_LIMIT',
  'ASSET_EXPOSURE_LIMIT',
  'ACCOUNT_EXPOSURE_LIMIT',
  'INSTRUMENT_AMOUNT_LIMIT',
  'STRATEGY_EXPOSURE_LIMIT',
  'ASSET_CLASS_AMOUNT_LIMIT',
  'OPEN_RISK_LIMIT',
  'LIVE_FIRST_WEEK_ORDER_CAP',
] as const);
