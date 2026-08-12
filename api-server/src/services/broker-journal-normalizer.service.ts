import { maskBrokerAccountReference, type UnifiedTradeOrder } from './unified-trade-journal.service';

export type BrokerJournalNormalizationIssue = {
  provider: 'TOSS' | 'KIWOOM' | 'UPBIT' | 'BITGET';
  code: string;
  reference: string | null;
};

export type BrokerJournalNormalizationResult = {
  records: UnifiedTradeOrder[];
  issues: BrokerJournalNormalizationIssue[];
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function decimal(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function iso(value: unknown) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return new Date(value).toISOString();
  if (typeof value !== 'string' || !value.trim()) return null;
  if (/^\d{13}$/.test(value)) return new Date(Number(value)).toISOString();
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function technicalSnapshot(provider: 'UPBIT' | 'BITGET', executionKey: string): UnifiedTradeOrder['technicalSnapshot'] {
  return Object.freeze({
    snapshotId: `no-context:${provider}:${executionKey}`,
    contextSource: 'NO_PRE_TRADE_CONTEXT' as const,
    capturedAt: null,
    timeframe: null,
    price: null,
    rsi: null,
    macd: null,
    macdSignal: null,
    movingAverageFast: null,
    movingAverageSlow: null,
    support: null,
    resistance: null,
    volumeRatio: null,
    volatilityPercent: null,
    signalScore: null,
    marketRegime: null,
    marketStructure: null,
    signalReasons: Object.freeze([] as string[]),
  });
}

export function normalizeUpbitJournalOrders(
  payload: unknown,
  accountReference: string,
  observedAt = new Date().toISOString(),
): BrokerJournalNormalizationResult {
  const rows = Array.isArray(payload) ? payload : [];
  const records: UnifiedTradeOrder[] = [];
  const issues: BrokerJournalNormalizationIssue[] = [];
  for (const value of rows) {
    const order = object(value);
    const orderId = text(order?.uuid);
    const market = text(order?.market)?.toUpperCase() ?? null;
    const side = order?.side === 'bid' ? 'BUY' : order?.side === 'ask' ? 'SELL' : null;
    const orderedAt = iso(order?.created_at);
    const trades = Array.isArray(order?.trades) ? order.trades : [];
    if (!order || !orderId || !market?.startsWith('KRW-') || !side || !orderedAt) {
      issues.push({ provider: 'UPBIT', code: 'UPBIT_ORDER_CONTRACT_INVALID', reference: orderId });
      continue;
    }
    if (!trades.length) {
      if ((decimal(order.executed_volume) ?? 0) > 0) {
        issues.push({ provider: 'UPBIT', code: 'UPBIT_FILL_DETAILS_REQUIRED', reference: orderId });
      }
      continue;
    }
    const parsedTrades = trades.map((candidate) => {
      const trade = object(candidate);
      const fillId = text(trade?.uuid);
      const price = decimal(trade?.price);
      const quantity = decimal(trade?.volume);
      const funds = decimal(trade?.funds);
      const filledAt = iso(trade?.created_at);
      return trade && fillId && price != null && price > 0 && quantity != null && quantity > 0 && filledAt
        ? { fillId, price, quantity, funds: funds ?? price * quantity, filledAt }
        : null;
    });
    if (parsedTrades.some((trade) => trade == null)) {
      issues.push({ provider: 'UPBIT', code: 'UPBIT_FILL_CONTRACT_INVALID', reference: orderId });
      continue;
    }
    const validTrades = parsedTrades.filter((trade): trade is NonNullable<typeof trade> => trade != null);
    const paidFee = decimal(order.paid_fee) ?? 0;
    const totalFunds = validTrades.reduce((sum, trade) => sum + trade.funds, 0);
    for (const trade of validTrades) {
      const executionKey = `UPBIT:${orderId}:${trade.fillId}`;
      records.push({
        schemaVersion: 1,
        recordType: 'unified_trade_order',
        source: 'UPBIT_API',
        broker: 'UPBIT',
        accountIdMasked: maskBrokerAccountReference('UPBIT', accountReference),
        market: 'CRYPTO_SPOT',
        symbol: market,
        side,
        positionSide: 'LONG',
        positionEffect: side === 'BUY' ? 'OPEN' : 'CLOSE',
        clientOrderId: text(order.identifier),
        brokerOrderId: orderId,
        fillId: trade.fillId,
        executionKey,
        idempotencyBasis: 'broker-fill-id',
        orderedAt,
        filledAt: trade.filledAt,
        observedAt: iso(observedAt) ?? new Date().toISOString(),
        quantity: trade.quantity,
        filledQuantity: trade.quantity,
        remainingQuantity: 0,
        averageFillPrice: trade.price,
        fees: totalFunds > 0 ? paidFee * trade.funds / totalFunds : paidFee / validTrades.length,
        tax: 0,
        currency: 'KRW',
        status: 'FILLED',
        strategy: null,
        timeframe: null,
        stopLossPrice: null,
        targetPrice: null,
        ruleViolation: false,
        warnings: validTrades.length > 1 ? ['UPBIT_ORDER_FEE_ALLOCATED_PROPORTIONALLY'] : [],
        technicalSnapshot: technicalSnapshot('UPBIT', executionKey),
      });
    }
  }
  return { records, issues };
}

function bitgetDirection(order: Record<string, unknown>, fill: Record<string, unknown>) {
  const tradeSide = (text(order.tradeSide) ?? text(fill.tradeSide) ?? '').toLowerCase();
  const posSide = (text(order.posSide) ?? '').toLowerCase();
  const side = (text(fill.side) ?? text(order.side) ?? '').toLowerCase();
  const effect = tradeSide === 'open' || tradeSide.startsWith('open_')
    ? 'OPEN' as const
    : /(?:close|reduce|burst|delivery|offset)/.test(tradeSide)
      ? 'CLOSE' as const
      : null;
  const embeddedSide = tradeSide.includes('long') ? 'LONG' as const : tradeSide.includes('short') ? 'SHORT' as const : null;
  const positionSide = posSide === 'long' ? 'LONG' as const
    : posSide === 'short' ? 'SHORT' as const
      : embeddedSide ?? (effect === 'OPEN' ? side === 'buy' ? 'LONG' as const : side === 'sell' ? 'SHORT' as const : null : null);
  return { effect, positionSide, side: side === 'buy' ? 'BUY' as const : side === 'sell' ? 'SELL' as const : null };
}

export function normalizeBitgetJournalFills(
  ordersPayload: unknown,
  fillsPayload: unknown,
  accountReference: string,
  observedAt = new Date().toISOString(),
): BrokerJournalNormalizationResult {
  const orderData = object(object(ordersPayload)?.data);
  const fillData = object(object(fillsPayload)?.data);
  const orders = Array.isArray(orderData?.entrustedList) ? orderData.entrustedList : [];
  const fills = Array.isArray(fillData?.fillList) ? fillData.fillList : [];
  const byOrder = new Map<string, Record<string, unknown>>();
  for (const value of orders) {
    const order = object(value);
    const orderId = text(order?.orderId);
    if (order && orderId) byOrder.set(orderId, order);
  }
  const records: UnifiedTradeOrder[] = [];
  const issues: BrokerJournalNormalizationIssue[] = [];
  for (const value of fills) {
    const fill = object(value);
    const orderId = text(fill?.orderId);
    const fillId = text(fill?.tradeId);
    const order = orderId ? byOrder.get(orderId) : null;
    if (!fill || !orderId || !fillId || !order) {
      issues.push({ provider: 'BITGET', code: order ? 'BITGET_FILL_CONTRACT_INVALID' : 'BITGET_ORDER_METADATA_REQUIRED', reference: orderId ?? fillId });
      continue;
    }
    const symbol = text(fill.symbol)?.toUpperCase();
    const quantity = decimal(fill.baseVolume);
    const price = decimal(fill.price);
    const filledAt = iso(fill.cTime);
    const currency = text(fill.marginCoin)?.toUpperCase();
    const direction = bitgetDirection(order, fill);
    if (!symbol || quantity == null || quantity <= 0 || price == null || price <= 0 || !filledAt || currency !== 'USDT' || !direction.side) {
      issues.push({ provider: 'BITGET', code: 'BITGET_FILL_CONTRACT_INVALID', reference: fillId });
      continue;
    }
    if (!direction.effect || !direction.positionSide) {
      issues.push({ provider: 'BITGET', code: 'BITGET_POSITION_DIRECTION_UNRESOLVED', reference: fillId });
      continue;
    }
    const feeDetails = Array.isArray(fill.feeDetail) ? fill.feeDetail : [];
    const fees = feeDetails.reduce((sum, candidate) => {
      const fee = decimal(object(candidate)?.totalFee);
      if (fee != null) return sum + Math.abs(fee);
      const signed = Number(object(candidate)?.totalFee);
      return Number.isFinite(signed) ? sum + Math.abs(signed) : sum;
    }, 0);
    const executionKey = `BITGET:${orderId}:${fillId}`;
    records.push({
      schemaVersion: 1,
      recordType: 'unified_trade_order',
      source: 'BITGET_API',
      broker: 'BITGET',
      accountIdMasked: maskBrokerAccountReference('BITGET', accountReference),
      market: 'CRYPTO_FUTURES',
      symbol,
      side: direction.side,
      positionSide: direction.positionSide,
      positionEffect: direction.effect,
      clientOrderId: text(order.clientOid),
      brokerOrderId: orderId,
      fillId,
      executionKey,
      idempotencyBasis: 'broker-fill-id',
      orderedAt: iso(order.cTime) ?? filledAt,
      filledAt,
      observedAt: iso(observedAt) ?? new Date().toISOString(),
      quantity,
      filledQuantity: quantity,
      remainingQuantity: 0,
      averageFillPrice: price,
      fees,
      tax: 0,
      currency: 'USDT',
      status: 'FILLED',
      strategy: null,
      timeframe: null,
      stopLossPrice: decimal(order.presetStopLossPrice),
      targetPrice: decimal(order.presetStopSurplusPrice),
      ruleViolation: false,
      warnings: [],
      technicalSnapshot: technicalSnapshot('BITGET', executionKey),
    });
  }
  return { records, issues };
}
