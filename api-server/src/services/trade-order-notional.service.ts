import { quoteTimeEvidence } from '../providers/market-evidence';
import type { TradingMarketSnapshot, TradingPlan } from './trade-automation.types';

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

function decimal(value: number) {
  const [coefficient, exponent = '0'] = value.toString().split('e');
  const scale = (coefficient.split('.')[1]?.length ?? 0) - Number(exponent);
  const units = BigInt(coefficient.replace('.', ''));
  return scale < 0 ? { units: units * 10n ** BigInt(-scale), scale: 0 } : { units, scale };
}

/** Recheck live/mock order units against the approved ceiling; never resize an order or raise the ceiling.
 * Orderbook VWAP is a preflight observation, not a guarantee of the eventual execution price.
 * Unit contracts: https://docs.upbit.com/kr/reference/new-order
 * https://www.bitget.com/api-doc/classic/contract/trade/Place-Order */
export function checkExecutionNotional(plan: TradingPlan, snapshot: TradingMarketSnapshot, now: number) {
  const unavailable = (code = 'EXECUTION_NOTIONAL_UNAVAILABLE') => ({ notionalKrw: null, blockCodes: [code] });
  if (!positive(plan.estimatedKrw) || !['market', 'limit'].includes(plan.orderType)) return unavailable();
  let rate = 1;
  if (plan.exchange === 'bitget') {
    const fx = snapshot.currencyConversion;
    if (plan.market !== 'USDT-FUTURES' || fx?.pair !== 'USDT/KRW' || !positive(fx.krwRate)
      || typeof fx.source !== 'string' || !fx.source.trim() || !positive(now)
      || quoteTimeEvidence(fx.asOf, 'iso', now).freshness.status !== 'FRESH') return unavailable('EXECUTION_NOTIONAL_FX_UNAVAILABLE');
    rate = fx.krwRate;
  } else if (!(plan.exchange === 'upbit' && plan.market === 'KRW' || plan.exchange === 'kiwoom' && plan.market === 'KR')) {
    return unavailable('EXECUTION_NOTIONAL_CURRENCY_MISMATCH');
  }

  let factors: number[];
  // Upbit market buy sends a quote-currency total, and does not send quantity.
  if (plan.exchange === 'upbit' && plan.orderType === 'market' && plan.side === 'buy') {
    if (!positive(plan.quoteAmount)) return unavailable();
    factors = [plan.quoteAmount];
  } else {
    if (!positive(plan.quantity)) return unavailable();
    if (plan.orderType === 'limit') {
      if (!positive(plan.limitPrice)) return unavailable();
      factors = [plan.quantity, plan.limitPrice, rate];
    } else {
      if (!positive(snapshot.currentPrice) || !positive(snapshot.executionPrice)) return unavailable();
      // Keep the larger observed notional when the book differs from the quote.
      factors = [plan.quantity, Math.max(snapshot.currentPrice, snapshot.executionPrice), rate];
    }
  }
  const amount = factors.map(decimal).reduce((a, b) => ({ units: a.units * b.units, scale: a.scale + b.scale }));
  const notionalKrw = Number(`${amount.units}e-${amount.scale}`);
  if (!positive(notionalKrw)) return unavailable();
  const limit = decimal(plan.estimatedKrw);
  const exceeds = amount.units * 10n ** BigInt(limit.scale) > limit.units * 10n ** BigInt(amount.scale);
  return { notionalKrw, blockCodes: exceeds ? ['EXECUTION_NOTIONAL_EXCEEDS_APPROVAL'] : [] };
}
