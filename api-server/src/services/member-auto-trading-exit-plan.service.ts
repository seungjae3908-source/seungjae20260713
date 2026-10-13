import type { TradingOrder, TradingPlan, TradingPlanInput } from './trade-automation.types';
import type { MemberAutoTradingFxQuote } from './member-auto-trading-fx.service';
import type { MemberAutoTradingMarketMark } from './member-auto-trading-market-mark.service';

export type MemberAutoTradingExitReason = 'STOP_LOSS' | 'TAKE_PROFIT' | 'TRAILING_TAKE_PROFIT';

export type MemberAutoTradingExitDecision = Readonly<{
  reason: MemberAutoTradingExitReason;
  quantity: number;
  targetIndex: number | null;
  triggerPrice: number;
}>;

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function longExposure(plan: TradingPlan) {
  return plan.side === 'buy' || plan.side === 'long';
}

function roundedQuantity(value: number) {
  return Number(value.toPrecision(15));
}

function floorToStep(value: number, step: number) {
  const units = Math.floor(value / step + 1e-9);
  return roundedQuantity(units * step);
}

/**
 * Builds a restart-safe exit decision from durable entry/exit progress.
 *
 * Intermediate targets reduce a cumulative equal share of the original fill.
 * The last target, stop, and trailing-profit triggers always close the tracked
 * remainder. If a partial leg cannot satisfy the venue's quantity/notional
 * constraints, taking the full remainder at the reached target is safer than
 * repeatedly submitting a predictably invalid child order.
 */
export function automaticExitDecision(input: {
  plan: TradingPlan;
  currentPrice: number;
  entryFilledQuantity: number;
  remainingQuantity: number;
  completedTargetIndexes?: readonly number[];
  entryAveragePrice?: number | null;
  quantityStep?: number | null;
  minimumQuantity?: number | null;
  minimumNotionalQuote?: number | null;
}): MemberAutoTradingExitDecision | null {
  const { plan, currentPrice } = input;
  if (!positive(currentPrice) || plan.reduceOnly
    || !positive(input.entryFilledQuantity) || !positive(input.remainingQuantity)) return null;
  const stop = positive(plan.stopPrice) ? plan.stopPrice : null;
  const long = longExposure(plan);
  if (stop && (long ? currentPrice <= stop : currentPrice >= stop)) {
    return { reason: 'STOP_LOSS', quantity: input.remainingQuantity, targetIndex: null, triggerPrice: stop };
  }

  const targets = plan.targetPrices
    .map((price, originalIndex) => ({ price, originalIndex }))
    .filter((row): row is { price: number; originalIndex: number } => positive(row.price))
    .sort((left, right) => long ? left.price - right.price : right.price - left.price);
  if (targets.length === 0) return null;
  const persistedCompleted = new Set((input.completedTargetIndexes ?? [])
    .filter((value) => Number.isSafeInteger(value) && value >= 0 && value < plan.targetPrices.length));
  // A fill at a later rung also proves every earlier price rung was crossed.
  // Normalize that cumulative fact here so a restart cannot revisit an older
  // target when the market jumped over more than one target at once.
  const highestCompletedStage = targets.reduce((highest, row, stage) => (
    persistedCompleted.has(row.originalIndex) ? Math.max(highest, stage) : highest
  ), -1);
  const completed = new Set(targets
    .slice(0, highestCompletedStage + 1)
    .map((row) => row.originalIndex));
  const crossed = targets.filter((row) => !completed.has(row.originalIndex)
    && (long ? currentPrice >= row.price : currentPrice <= row.price));
  if (crossed.length > 0) {
    const reached = crossed.at(-1)!;
    const stage = targets.findIndex((row) => row.originalIndex === reached.originalIndex);
    let quantity = input.remainingQuantity;
    if (stage < targets.length - 1 && positive(input.quantityStep)) {
      const alreadyExited = Math.max(0, input.entryFilledQuantity - input.remainingQuantity);
      const cumulative = floorToStep(
        input.entryFilledQuantity * (stage + 1) / targets.length,
        input.quantityStep,
      );
      const candidate = Math.min(input.remainingQuantity, roundedQuantity(cumulative - alreadyExited));
      const remainder = roundedQuantity(input.remainingQuantity - candidate);
      const minimumQuantity = positive(input.minimumQuantity) ? input.minimumQuantity : input.quantityStep;
      const minimumNotional = positive(input.minimumNotionalQuote) ? input.minimumNotionalQuote : null;
      const candidateValid = candidate >= minimumQuantity - 1e-12
        && (remainder <= 1e-12 || remainder >= minimumQuantity - 1e-12)
        && (minimumNotional == null || candidate * currentPrice >= minimumNotional - 1e-8)
        && (minimumNotional == null || remainder <= 1e-12
          || remainder * currentPrice >= minimumNotional - 1e-8);
      if (candidateValid && remainder > 1e-12) quantity = candidate;
    }
    return {
      reason: 'TAKE_PROFIT', quantity, targetIndex: reached.originalIndex, triggerPrice: reached.price,
    };
  }

  // A filled target permanently ratchets the remaining position's protection.
  // The first partial target protects at the actual entry fill; later targets
  // protect at the preceding achieved rung. No volatile in-memory high-water
  // mark is required, so a server restart cannot forget the trailing state.
  let achieved = 0;
  while (achieved < targets.length && completed.has(targets[achieved]!.originalIndex)) achieved += 1;
  if (achieved > 0 && achieved < targets.length) {
    const entry = positive(input.entryAveragePrice)
      ? input.entryAveragePrice
      : positive(plan.entryPrice) ? plan.entryPrice
        : positive(plan.limitPrice) ? plan.limitPrice
          : positive(plan.marketSnapshot.currentPrice) ? plan.marketSnapshot.currentPrice : null;
    const trailing = achieved === 1 ? entry : targets[achieved - 2]!.price;
    if (trailing && (long ? currentPrice <= trailing : currentPrice >= trailing)) {
      return {
        reason: 'TRAILING_TAKE_PROFIT', quantity: input.remainingQuantity,
        targetIndex: null, triggerPrice: trailing,
      };
    }
  }
  return null;
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
  targetIndex?: number | null;
  remainingQuantity?: number;
  /** Injection point for deterministic validation tests; worker uses its run-clock. */
  nowMs?: number;
}): TradingPlanInput {
  const { entryPlan, entryOrder, mark, fx, reason } = input;
  // This is a simulated/live *reducing exit*, never authority to close a
  // different owner's, plan's or exchange's position.
  if (entryPlan.reduceOnly || entryOrder.planId !== entryPlan.id
    || entryOrder.userId !== entryPlan.userId
    || entryOrder.exchange !== entryPlan.exchange
    || !['FILLED', 'PARTIALLY_FILLED'].includes(entryOrder.state)
    || !positive(entryOrder.filledQuantity)) {
    throw new Error('BACKGROUND_EXIT_CANONICAL_ENTRY_IDENTITY_REQUIRED');
  }
  const quantity = input.remainingQuantity ?? entryOrder.filledQuantity;
  if (!positive(quantity)) throw new Error('BACKGROUND_EXIT_FILLED_QUANTITY_REQUIRED');
  if (quantity > entryOrder.filledQuantity + Math.max(1e-9, entryOrder.filledQuantity * 1e-8)) {
    throw new Error('BACKGROUND_EXIT_OVERFILLED_QUANTITY_FORBIDDEN');
  }
  const usStock = ['NASDAQ', 'NYSE', 'AMEX'].includes(
    String(entryPlan.stockExchange ?? '').toUpperCase(),
  ) || ['US', 'USD', 'US_STOCK', 'NASDAQ', 'NYSE', 'AMEX']
    .includes(String(entryPlan.market).toUpperCase());
  const expectedMarket = entryPlan.exchange === 'upbit' ? 'CRYPTO_SPOT'
    : entryPlan.exchange === 'bitget' ? 'CRYPTO_FUTURES'
      : usStock ? 'US_STOCK' : 'KR_STOCK';
  if (!positive(mark.price) || mark.market !== expectedMarket) {
    throw new Error('BACKGROUND_EXIT_MARK_IDENTITY_MISMATCH');
  }
  const normalizedSymbol = (value: string) => value.trim().toUpperCase().replace(/^KRW-/u, '');
  if (!normalizedSymbol(mark.symbol) || normalizedSymbol(mark.symbol) !== normalizedSymbol(entryPlan.symbol)) {
    throw new Error('BACKGROUND_EXIT_MARK_SYMBOL_MISMATCH');
  }
  if (typeof mark.source !== 'string' || !mark.source.trim()) {
    throw new Error('BACKGROUND_EXIT_MARK_SOURCE_REQUIRED');
  }
  if (fx.market !== expectedMarket || fx.stale !== false
    || !positive(fx.krwPerQuoteCurrency)
    || typeof fx.source !== 'string' || !fx.source.trim()
    || !Number.isFinite(Date.parse(fx.observedAt))) {
    throw new Error('BACKGROUND_EXIT_FX_IDENTITY_MISMATCH');
  }
  const nativeKrw = expectedMarket === 'KR_STOCK' || expectedMarket === 'CRYPTO_SPOT';
  const expectedFxSource = nativeKrw ? 'NATIVE_KRW'
    : expectedMarket === 'US_STOCK' ? 'YAHOO:USDKRW=X' : 'UPBIT:KRW-USDT';
  if (fx.source !== expectedFxSource
    || (nativeKrw && fx.krwPerQuoteCurrency !== 1)) {
    throw new Error('BACKGROUND_EXIT_FX_SOURCE_UNVERIFIED');
  }
  // Public readers validate at acquisition. Recheck just before creating an
  // exit intent so delayed workers cannot submit based on stale/future quotes.
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(now) || now <= 0) throw new Error('BACKGROUND_EXIT_CLOCK_INVALID');
  const observedMs = Date.parse(mark.observedAt);
  if (!Number.isFinite(observedMs)) throw new Error('BACKGROUND_EXIT_MARK_TIMESTAMP_REQUIRED');
  const maxMarkAgeMs = expectedMarket === 'KR_STOCK' || expectedMarket === 'US_STOCK'
    ? 60_000 : 30_000;
  if (observedMs > now + 5_000 || now - observedMs > maxMarkAgeMs) {
    throw new Error('BACKGROUND_EXIT_MARK_NOT_FRESH');
  }
  const quoteAtMs = Date.parse(fx.observedAt);
  const maxFxAgeMs = expectedMarket === 'US_STOCK' ? 24 * 60 * 60_000
    : expectedMarket === 'CRYPTO_FUTURES' ? 10 * 60_000 : 5 * 60_000;
  if (quoteAtMs > now + 5_000 || now - quoteAtMs > maxFxAgeMs) {
    throw new Error('BACKGROUND_EXIT_FX_NOT_FRESH');
  }
  const estimatedKrw = quantity * mark.price * fx.krwPerQuoteCurrency;
  if (!positive(estimatedKrw)) throw new Error('BACKGROUND_EXIT_ORDER_KRW_INVALID');
  const delay = Math.max(0, now - observedMs);
  const targetIndex = input.targetIndex;
  if (targetIndex != null && (!Number.isSafeInteger(targetIndex)
    || targetIndex < 0 || targetIndex >= entryPlan.targetPrices.length
    || reason !== 'TAKE_PROFIT')) {
    throw new Error('BACKGROUND_EXIT_TARGET_INDEX_INVALID');
  }
  const exitStage = targetIndex == null ? reason : `${reason}:TARGET_${targetIndex}`;
  return {
    exchange: entryPlan.exchange,
    accountMode: entryPlan.accountMode,
    stockBroker: entryPlan.stockBroker ?? null,
    stockExchange: entryPlan.stockExchange ?? null,
    strategyId: entryPlan.strategyId,
    signalId: `${entryPlan.signalId}:auto-exit:${entryPlan.id}:${exitStage}:${mark.observedAt}`,
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
      ...(targetIndex == null ? [] : [`AUTO_EXIT_TARGET_INDEX:${targetIndex}`]),
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
