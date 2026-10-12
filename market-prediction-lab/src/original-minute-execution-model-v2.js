/** Offline modeled fills only. No provider, historical-fill or OOS authority. */
export const ORIGINAL_MINUTE_EXECUTION_MODEL_V2 = 'GAP_OPEN_STOP_FIRST_CLOSE_MTM_V2';
const VALID_MARKETS = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']);
const COST_RATE_FIELDS = ['entryFeeRate', 'exitFeeRate', 'spreadRate',
  'slippageRate', 'latencyRate', 'taxRate', 'fundingRatePerSession'];
const validRate = x => typeof x === 'number' && Number.isFinite(x)
  && x >= 0 && x < 0.2;
const validPositive = x => typeof x === 'number' && Number.isFinite(x) && x > 0;

export function originalMinuteExitFillV2(bar, side, entryPrice, strategy) {
  if (!['LONG', 'SHORT'].includes(side) || !validPositive(entryPrice)
    || !bar || typeof bar !== 'object' || Array.isArray(bar)
    || ![bar.open, bar.high, bar.low, bar.close].every(validPositive)
    || !Number.isSafeInteger(bar.startMs) || bar.startMs < 0
    || !Number.isSafeInteger(bar.endMs) || bar.endMs <= bar.startMs
    || bar.high < Math.max(bar.open, bar.close, bar.low)
    || bar.low > Math.min(bar.open, bar.close, bar.high)
    || !strategy || typeof strategy !== 'object' || Array.isArray(strategy)
    || !validPositive(strategy.stopPercent)
    || !validPositive(strategy.targetPercent)
    || (side === 'LONG' && strategy.stopPercent >= 100)
    || (side === 'SHORT' && strategy.targetPercent >= 100)) {
    throw new TypeError('ORIGINAL_MINUTE_FILL_INPUT_INVALID');
  }
  const long = side === 'LONG';
  const stop = entryPrice * (long ? 100 - strategy.stopPercent : 100 + strategy.stopPercent) / 100;
  const target = entryPrice * (long ? 100 + strategy.targetPercent : 100 - strategy.targetPercent) / 100;
  // The opening print precedes every intrabar extreme. A gap through a stop
  // cannot fill at a better, untraded stop price. A pre-existing target limit
  // crossed at the open takes that modeled opening price, not a later stop.
  if (long ? bar.open <= stop : bar.open >= stop)
    return { price: bar.open, reason: 'gap_stop_open', atMs: bar.startMs };
  if (long ? bar.open >= target : bar.open <= target)
    return { price: bar.open, reason: 'gap_target_open', atMs: bar.startMs };
  if (long ? bar.low <= stop : bar.high >= stop)
    return { price: stop, reason: 'stop_first', atMs: bar.endMs };
  if (long ? bar.high >= target : bar.low <= target)
    return { price: target, reason: 'target', atMs: bar.endMs };
  return null;
}

export function originalMinuteLiquidationV2(position, price, costs, market) {
  // Reject malformed or favorable negative cost inputs even when a caller
  // bypasses the private replay's policy normalizer. A bad side must never
  // silently become SHORT, and missing futures funding cannot masquerade
  // as an observed zero-cost trade.
  if (!position || typeof position !== 'object' || Array.isArray(position)
    || !['LONG', 'SHORT'].includes(position.side)
    || !validPositive(position.entryPrice)
    || !validPositive(position.quantity)
    || !validPositive(price)
    || !VALID_MARKETS.has(market)
    || !costs || typeof costs !== 'object' || Array.isArray(costs)
    || COST_RATE_FIELDS.some(key => !validRate(costs[key]))
    || (market !== 'CRYPTO_FUTURES' && costs.fundingRatePerSession !== 0))
    throw new TypeError('ORIGINAL_MINUTE_LIQUIDATION_INPUT_INVALID');
  const spread = costs.spreadRate / 2;
  const out = price * (position.side === 'LONG' ? 1 - spread : 1 + spread);
  const notional = position.entryPrice * position.quantity;
  const gross = (out - position.entryPrice) * position.quantity * (position.side === 'LONG' ? 1 : -1);
  const entryCost = notional * (costs.entryFeeRate + costs.slippageRate + costs.latencyRate);
  const exitCost = out * position.quantity * (costs.exitFeeRate + costs.slippageRate + costs.latencyRate + costs.taxRate);
  const funding = market === 'CRYPTO_FUTURES' ? notional * costs.fundingRatePerSession : 0;
  const net = gross - entryCost - exitCost - funding;
  const cost = entryCost + exitCost + funding + (position.entryPrice + out) * position.quantity * spread;
  if (![out, gross, net, cost].every(Number.isFinite)) throw new TypeError('ORIGINAL_MINUTE_LIQUIDATION_NONFINITE');
  return { out, net, cost };
}

export function recordOriginalMinuteEquityV2(state, total) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || !validPositive(state.peak)
    || !Number.isFinite(state.maxDrawdownPercent)
    || state.maxDrawdownPercent < 0
    || !Number.isFinite(total))
    throw new TypeError('ORIGINAL_MINUTE_EQUITY_STATE_INVALID');
  state.peak = Math.max(state.peak, total);
  state.maxDrawdownPercent = Math.max(state.maxDrawdownPercent,
    state.peak > 0 ? 100 * (state.peak - total) / state.peak : 0);
}
