import type { TradingPlanInput } from './trade-automation.types';

/** Client inputs are order intentions only. Account, FX and risk evidence are server-owned. */
export function parseChartManualOrder(body: unknown, maximumLeverage: number, options: { krwPerNativeCurrency?: number; quantityStep?: number } = {}): TradingPlanInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('MANUAL_ORDER_INVALID');
  const input = body as Record<string, unknown>;
  const market = String(input.market ?? '').toUpperCase();
  const exchange = String(input.exchange ?? '').toLowerCase() as TradingPlanInput['exchange'];
  const side = String(input.side ?? '').toLowerCase() as TradingPlanInput['side'];
  const rawSymbol = String(input.symbol ?? '').toUpperCase().trim();
  const requestId = String(input.requestId ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('MANUAL_ORDER_REQUEST_ID_REQUIRED');
  if (!['KR', 'US', 'UPBIT', 'BITGET'].includes(market)) throw new Error('MANUAL_ORDER_MARKET_INVALID');
  if ((market === 'UPBIT' && exchange !== 'upbit') || (market === 'BITGET' && exchange !== 'bitget') || (['KR', 'US'].includes(market) && !['toss', 'kiwoom'].includes(exchange))) throw new Error('MANUAL_ORDER_PROVIDER_MISMATCH');
  if (market === 'US' && exchange !== 'kiwoom') throw new Error('MANUAL_ORDER_PROVIDER_MISMATCH');
  if (!(market === 'BITGET' ? ['long', 'short'] : ['buy', 'sell']).includes(side)) throw new Error('MANUAL_ORDER_SIDE_INVALID');
  if (!(market === 'KR' ? /^\d{6}$/ : market === 'UPBIT' ? /^(KRW-)?[A-Z0-9]{2,16}$/ : /^[A-Z][A-Z0-9.-]{0,23}$/).test(rawSymbol)) throw new Error('MANUAL_ORDER_SYMBOL_INVALID');
  const orderType = String(input.orderType ?? 'limit');
  if (!['limit', 'market'].includes(orderType)) throw new Error('MANUAL_ORDER_TYPE_INVALID');
  // Market order routing is not approved until native sizing/price protection is verified.
  // Never silently send a limit order when a human selected market.
  if (orderType === 'market') throw new Error('MANUAL_ORDER_MARKET_VERIFICATION_REQUIRED');
  const sizeMode = String(input.sizeMode ?? 'quantity');
  if (!['quantity', 'amount'].includes(sizeMode)) throw new Error('MANUAL_ORDER_SIZE_MODE_INVALID');
  const nativeCurrency = market === 'US' ? 'USD' : market === 'BITGET' ? 'USDT' : 'KRW';
  const inputCurrency = String(input.inputCurrency ?? nativeCurrency);
  if (inputCurrency !== nativeCurrency && inputCurrency !== 'KRW') throw new Error('MANUAL_ORDER_CURRENCY_INVALID');
  const divisor = inputCurrency === 'KRW' && nativeCurrency !== 'KRW' ? Number(options.krwPerNativeCurrency) : 1;
  if (!Number.isFinite(divisor) || divisor <= 0) throw new Error('MANUAL_ORDER_FRESH_FX_REQUIRED');
  const price = Number(input.limitPrice) / divisor;
  const rawQuantity = sizeMode === 'quantity' ? Number(input.quantity) : (Number(input.amount) / divisor) / price;
  // Floor budget-based sizing; never round up beyond the user's entered amount.
  const step = market === 'KR' || (market === 'US' && exchange === 'kiwoom') ? 1 : market === 'BITGET' ? options.quantityStep : 1e-8;
  if (sizeMode === 'amount' && (!Number.isFinite(step) || Number(step) <= 0)) throw new Error('MANUAL_ORDER_QUANTITY_RULES_REQUIRED');
  let quantity = sizeMode === 'amount' ? Number((Math.floor(rawQuantity / step!) * step!).toPrecision(15)) : rawQuantity;
  if (sizeMode === 'amount' && quantity * price > Number(input.amount) / divisor) quantity = Number((quantity - step!).toPrecision(15));
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity * price)) throw new Error('MANUAL_ORDER_AMOUNT_INVALID');
  if (market === 'KR' && !Number.isSafeInteger(quantity)) throw new Error('MANUAL_ORDER_WHOLE_SHARES_REQUIRED');
  const leverage = market === 'BITGET' ? Number(input.leverage) : null;
  if (market === 'BITGET' && (!Number.isInteger(leverage) || leverage! < 2 || leverage! > Math.min(7, maximumLeverage))) throw new Error('MANUAL_ORDER_LEVERAGE_LIMIT');
  const reduceOnly = market === 'BITGET' ? input.reduceOnly === true : side === 'sell';
  const stop = Number(input.stopPrice) / divisor; const target = Number(input.targetPrice) / divisor;
  if (!reduceOnly && (!Number.isFinite(stop) || stop <= 0 || !Number.isFinite(target) || target <= 0 || ((side === 'short') ? !(target < price && price < stop) : !(stop < price && price < target)))) throw new Error('MANUAL_ORDER_EXIT_PLAN_REQUIRED');
  const stockExchange = ['KR', 'US'].includes(market) ? String(input.stockExchange ?? (market === 'KR' ? 'KRX' : '')).toUpperCase() as TradingPlanInput['stockExchange'] : null;
  if (market === 'US' && exchange === 'kiwoom' && !['NASDAQ', 'NYSE', 'AMEX'].includes(stockExchange ?? '')) throw new Error('MANUAL_ORDER_STOCK_EXCHANGE_REQUIRED');
  if (stockExchange && !['KRX', 'NXT', 'SOR', 'NASDAQ', 'NYSE', 'AMEX'].includes(stockExchange)) throw new Error('MANUAL_ORDER_STOCK_EXCHANGE_INVALID');
  return {
    exchange, market: market === 'UPBIT' ? 'KRW' : market === 'BITGET' ? 'USDT-FUTURES' : market,
    symbol: market === 'UPBIT' ? `KRW-${rawSymbol.replace(/^KRW-/, '')}` : rawSymbol,
    accountMode: 'live', side, orderType: 'limit', quantity, limitPrice: price, estimatedKrw: Number.NaN,
    strategyId: 'manual-chart', signalId: `manual-chart:${requestId}`, signalReasons: ['사용자 지정가 주문'],
    stopPrice: reduceOnly ? price : stop, targetPrices: reduceOnly ? [] : [target], splitRatios: [100],
    leverage, marginMode: market === 'BITGET' ? 'isolated' : null, reduceOnly,
    stockBroker: ['KR', 'US'].includes(market) ? exchange as 'toss' | 'kiwoom' : null, stockExchange,
    // Unknown evidence cannot authorize a plan. previewLiveRiskSnapshot must replace it.
    marketSnapshot: { observedAt: '', dataDelayMs: Number.NaN, oneMinuteMovePercent: Number.NaN, spreadPercent: Number.NaN,
      orderbookGapPercent: Number.NaN, halted: true, availableBalance: Number.NaN, accountValueKrw: Number.NaN,
      dailyPnlPercent: Number.NaN, assetExposurePercent: Number.NaN, openPositionCount: Number.NaN, dailyOrderCount: Number.NaN, consecutiveLosses: Number.NaN, marketStatus: 'UNKNOWN' },
  };
}
