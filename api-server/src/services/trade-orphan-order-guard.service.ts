import type { TradingExchange, TradingOrder } from './trade-automation.types';

export type PendingExchangeOrderRef = {
  clientOrderId: string | null;
  exchangeOrderId: string | null;
};

const PENDING_OWNER_STATES = new Set([
  'ACCEPTED',
  'PARTIALLY_FILLED',
  'CANCEL_REQUESTED',
  'RECOVERY_REQUIRED',
]);

const UPBIT_SINGLE_PAGE_LIMIT = 100;

function text(value: string | null | undefined) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function canOwnPendingExchangeOrder(order: TradingOrder) {
  if (PENDING_OWNER_STATES.has(order.state)) return true;
  return order.state === 'SUBMITTED' && Boolean(text(order.submissionStartedAt));
}

export function assertNoOrphanExchangeOrders(
  exchange: TradingExchange,
  pendingOrders: PendingExchangeOrderRef[],
  localOrders: TradingOrder[],
): void {
  if (exchange === 'upbit' && pendingOrders.length >= UPBIT_SINGLE_PAGE_LIMIT) {
    throw new Error('UPBIT_OPEN_ORDER_SCAN_INCOMPLETE');
  }

  const activeLocalOrders = localOrders.filter((order) => order.exchange === exchange && canOwnPendingExchangeOrder(order));
  const knownClientOrderIds = new Set(activeLocalOrders.map((order) => text(order.clientOrderId)).filter(Boolean));
  const knownExchangeOrderIds = new Set(activeLocalOrders.map((order) => text(order.exchangeOrderId)).filter(Boolean));

  for (const pending of pendingOrders) {
    const clientOrderId = text(pending.clientOrderId);
    const exchangeOrderId = text(pending.exchangeOrderId);
    if (!clientOrderId && !exchangeOrderId) throw new Error('EXCHANGE_PENDING_ORDER_IDENTITY_UNKNOWN');
    if ((clientOrderId && knownClientOrderIds.has(clientOrderId))
      || (exchangeOrderId && knownExchangeOrderIds.has(exchangeOrderId))) {
      continue;
    }
    throw new Error('ORPHAN_EXCHANGE_ORDER_DETECTED');
  }
}
