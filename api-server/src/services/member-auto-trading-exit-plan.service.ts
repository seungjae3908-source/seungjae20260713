import type { TradingOrder, TradingPlan, TradingPlanInput } from './trade-automation.types';
import type { MemberAutoTradingFxQuote } from './member-auto-trading-fx.service';
import type { MemberAutoTradingMarketMark } from './member-auto-trading-market-mark.service';

export type MemberAutoTradingExitReason = 'STOP_LOSS' | 'TAKE_PROFIT';

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function longExposure(plan: TradingPlan) {
  return plan.side === 'buy' || plan.side === 'long';
}

export function automaticExitReason(
  plan: TradingPlan,
  currentPrice: number,
): MemberAutoTradingExitReason | null {
  if (!positive(currentPrice) || plan.reduceOnly) return null;
  const stop = positive(plan.stopPrice) ? plan.stopPrice : null;
  const targets = plan.targetPrices.filter(positive);
  if (!stop || targets.length === 0) return null;
  if (longExposure(plan)) {
    if (currentPrice <= stop) return 'STOP_LOSS';
    if (currentPrice >= Math.min(...targets)) return 'TAKE_PROFIT';
    return null;
  }
  if (currentPrice >= stop) return 'STOP_LOSS';
  if (currentPrice <= Math.max(...targets)) return 'TAKE_PROFIT';
  return null;
}

function exitSide(plan: TradingPlan): TradingPlanInput['side'] {
  if (plan.exchange === 'bitget') return longExposure(plan) ? 'short' : 'long';
  if (plan.side !== 'buy') throw new Error('BACKGROUND_EXIT_CASH_ENTRY_SIDE_INVALID');
  return 'sell';
}

export function buildAutomaticExitPlanInput(input: {
  entryPlan: TradingPlan;
  entryOrder: TradingOrder;
  mark: MemberAutoTradingMarketMark;
  fx: MemberAutoTradingFxQuote;
  reason: MemberAutoTradingExitReason;
  remainingQuantity?: number;
}): TradingPlanInput {
  const { entryPlan, entryOrder, mark, fx, reason } = input;
  const quantity = input.remainingQuantity ?? entryOrder.filledQuantity;
  if (!positive(quantity)) throw new Error('BACKGROUND_EXIT_FILLED_QUANTITY_REQUIRED');
  if (!positive(mark.price) || mark.market !== (
    entryPlan.exchange === 'upbit' ? 'CRYPTO_SPOT'
      : entryPlan.exchange === 'bitget' ? 'CRYPTO_FUTURES'
        : entryPlan.market === 'US' ? 'US_STOCK' : 'KR_STOCK'
  )) throw new Error('BACKGROUND_EXIT_MARK_IDENTITY_MISMATCH');
  const estimatedKrw = quantity * mark.price * fx.krwPerQuoteCurrency;
  if (!positive(estimatedKrw)) throw new Error('BACKGROUND_EXIT_ORDER_KRW_INVALID');
  const observedMs = Date.parse(mark.observedAt);
  if (!Number.isFinite(observedMs)) throw new Error('BACKGROUND_EXIT_MARK_TIMESTAMP_REQUIRED');
  const now = Date.now();
  const delay = Math.max(0, now - observedMs);
  return {
    exchange: entryPlan.exchange,
    accountMode: entryPlan.accountMode,
    stockBroker: entryPlan.stockBroker ?? null,
    stockExchange: entryPlan.stockExchange ?? null,
    strategyId: entryPlan.strategyId,
    signalId: `${entryPlan.signalId}:auto-exit:${entryPlan.id}:${reason}:${mark.observedAt}`,
    symbol: entryPlan.symbol,
    market: entryPlan.market,
    side: exitSide(entryPlan),
    orderType: 'market',
    quantity,
    quoteAmount: null,
    limitPrice: mark.price,
    estimatedKrw,
    stopPrice: mark.price,
    targetPrices: [],
    splitRatios: [100],
    leverage: entryPlan.leverage,
    marginMode: entryPlan.marginMode,
    reduceOnly: true,
    invalidateAction: 'hold',
    signalReasons: [
      'AUTO_EXIT',
      `AUTO_EXIT_ENTRY_PLAN:${entryPlan.id}`,
      `AUTO_EXIT_ENTRY_ORDER:${entryOrder.id}`,
      `AUTO_EXIT_REASON:${reason}`,
    ],
    marketSnapshot: {
      ...entryPlan.marketSnapshot,
      observedAt: mark.observedAt,
      riskObservedAt: mark.observedAt,
      dataDelayMs: delay,
      providerTimeOffsetMs: delay,
      source: mark.source,
      currentPrice: mark.price,
      plannedPrice: mark.price,
      marketStatus: 'OPEN',
      halted: false,
      oneMinuteMovePercent: 0,
      signalState: null,
      signalObservedAt: null,
    },
    entryPrice: null,
    entryZoneLow: null,
    entryZoneHigh: null,
    estimatedSlippagePercent: entryPlan.estimatedSlippagePercent,
    averageSpreadPercent: entryPlan.averageSpreadPercent,
    economics: null,
  };
}
