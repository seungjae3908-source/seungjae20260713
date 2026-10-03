import type { TradingOrder, TradingPlan } from './trade-automation.types';
import type { TradingRepository } from './trade-automation.repository';
import { maskBrokerAccountReference } from './unified-trade-journal.service';

function marketForPlan(plan: TradingPlan) {
  if (plan.exchange === 'upbit') return 'CRYPTO_SPOT' as const;
  if (plan.exchange === 'bitget') return 'CRYPTO_FUTURES' as const;
  const explicitUs = ['NASDAQ', 'NYSE', 'AMEX'].includes(String(plan.stockExchange ?? '').toUpperCase())
    || /(?:^|[_-])(US|USD)(?:$|[_-])/i.test(String(plan.market ?? ''));
  return explicitUs ? 'US_STOCK' as const : 'KR_STOCK' as const;
}

function sourceForPlan(plan: TradingPlan) {
  if (plan.accountMode === 'paper') return 'APP_PAPER' as const;
  if (plan.accountMode === 'mock') return 'APP_SHADOW' as const;
  return plan.executionMode === 'automatic' ? 'APP_AUTO' as const : 'APP_MANUAL' as const;
}

function statusForOrder(order: TradingOrder) {
  if (order.state === 'FILLED') return 'FILLED' as const;
  if (order.state === 'PARTIALLY_FILLED') return 'PARTIALLY_FILLED' as const;
  if (order.state === 'CANCELED' || order.state === 'EXPIRED') return 'CANCELED' as const;
  if (order.state === 'REJECTED') return 'REJECTED' as const;
  if (['SUBMITTED', 'ACCEPTED', 'CANCEL_REQUESTED', 'RECOVERY_REQUIRED'].includes(order.state)) return 'OPEN' as const;
  return 'UNKNOWN' as const;
}

function currencyForPlan(plan: TradingPlan) {
  const market = marketForPlan(plan);
  if (market === 'KR_STOCK' || market === 'CRYPTO_SPOT') return 'KRW' as const;
  if (market === 'US_STOCK') return 'USD' as const;
  return 'USDT' as const;
}

function finitePositive(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function feeForOrder(order: TradingOrder) {
  if (typeof order.feeAmount === 'number' && Number.isFinite(order.feeAmount) && order.feeAmount >= 0) {
    return order.feeAmount;
  }
  const fills = Array.isArray(order.fills) ? order.fills : [];
  if (!fills.length || fills.some((fill) => fill.feeAmount == null || !Number.isFinite(fill.feeAmount) || Number(fill.feeAmount) < 0)) {
    return null;
  }
  return fills.reduce((sum, fill) => sum + Number(fill.feeAmount), 0);
}

export async function readTradeAutomationJournalPayloads(
  repository: TradingRepository,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const [orders, plans] = await Promise.all([repository.listOrders(userId), repository.listPlans(userId)]);
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  return orders.flatMap((order) => {
    const plan = planById.get(order.planId);
    const filledQuantity = finitePositive(order.filledQuantity);
    const averageFillPrice = finitePositive(order.averageFillPrice);
    if (!plan || filledQuantity == null || averageFillPrice == null) return [];

    const requestedQuantity = finitePositive(order.requestedQuantity) ?? filledQuantity;
    const remainingQuantity = typeof order.remainingQuantity === 'number' && Number.isFinite(order.remainingQuantity)
      ? Math.max(0, order.remainingQuantity)
      : Math.max(0, requestedQuantity - filledQuantity);
    const fills = Array.isArray(order.fills) ? order.fills : [];
    const lastFill = fills.length
      ? [...fills].sort((a, b) => a.filledAt.localeCompare(b.filledAt)).at(-1) ?? null
      : null;
    const filledAt = lastFill?.filledAt ?? order.updatedAt;
    const market = marketForPlan(plan);
    const broker = plan.exchange.toUpperCase();
    const side = plan.side === 'buy' || plan.side === 'long' ? 'BUY' : 'SELL';
    const positionEffect = plan.reduceOnly === true || (plan.exchange !== 'bitget' && plan.side === 'sell') ? 'CLOSE' : 'OPEN';
    const positionSide = plan.exchange === 'bitget' && plan.reduceOnly === true
      ? (side === 'SELL' ? 'LONG' : 'SHORT')
      : plan.side === 'short'
        ? 'SHORT'
        : 'LONG';

    return [{
      schemaVersion: 1,
      recordType: 'unified_trade_order',
      source: sourceForPlan(plan),
      broker,
      accountIdMasked: maskBrokerAccountReference(broker, userId),
      market,
      symbol: String(plan.symbol).toUpperCase(),
      side,
      positionSide,
      positionEffect,
      clientOrderId: order.clientOrderId,
      brokerOrderId: order.exchangeOrderId ?? order.id,
      fillId: fills.length === 1 ? fills[0]!.id : null,
      orderedAt: order.createdAt,
      filledAt,
      observedAt: order.updatedAt,
      quantity: requestedQuantity,
      filledQuantity,
      remainingQuantity,
      averageFillPrice,
      fees: feeForOrder(order),
      tax: null,
      currency: currencyForPlan(plan),
      status: statusForOrder(order),
      strategy: plan.strategyId,
      timeframe: null,
      stopLossPrice: Number.isFinite(plan.stopPrice) ? plan.stopPrice : null,
      targetPrice: Array.isArray(plan.targetPrices) && Number.isFinite(plan.targetPrices[0]) ? plan.targetPrices[0] : null,
      ruleViolation: false,
      warnings: [
        'APP_TRADE_AUTOMATION_LEDGER_PROJECTION',
        plan.accountMode === 'live'
          ? 'LIVE_APP_ORDER_FROM_CANONICAL_EXECUTION_LEDGER'
          : 'SIMULATED_APP_ORDER_FROM_CANONICAL_EXECUTION_LEDGER',
      ],
      technicalSnapshot: {
        snapshotId: `trade-plan:${plan.id}`,
        contextSource: 'PRE_TRADE_SNAPSHOT',
        capturedAt: plan.marketSnapshot?.observedAt ?? plan.createdAt,
        timeframe: null,
        price: plan.marketSnapshot?.currentPrice ?? plan.entryPrice ?? plan.limitPrice ?? null,
        rsi: null,
        macd: null,
        macdSignal: null,
        movingAverageFast: null,
        movingAverageSlow: null,
        support: null,
        resistance: null,
        volumeRatio: null,
        volatilityPercent: Math.abs(Number(plan.marketSnapshot?.oneMinuteMovePercent ?? 0)),
        signalScore: null,
        marketRegime: plan.economics?.marketRegime ?? null,
        marketStructure: null,
        signalReasons: Array.isArray(plan.signalReasons) ? plan.signalReasons : [],
      },
    }];
  });
}
