import type { TradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import type { TradingOrder } from './trade-automation.types';

type ExchangePayload = Record<string, unknown>;

export type ExchangeOrderSnapshot = {
  state: 'ACCEPTED' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED';
  exchangeOrderId: string | null;
  filledQuantity: number;
  averageFillPrice: number | null;
};

function record(value: unknown): ExchangePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('EXCHANGE_ORDER_SNAPSHOT_INVALID');
  return value as ExchangePayload;
}

function nonNegative(value: unknown, code: string) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) throw new Error(code);
  return number;
}

function positiveOrNull(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function parseBitgetOrderSnapshot(value: unknown): ExchangeOrderSnapshot {
  const payload = record(value);
  const state = String(payload.state ?? '').toLowerCase();
  const mapped = state === 'live' ? 'ACCEPTED'
    : state === 'partially_filled' ? 'PARTIALLY_FILLED'
      : state === 'filled' ? 'FILLED'
        : ['canceled', 'cancelled'].includes(state) ? 'CANCELED' : null;
  if (!mapped) throw new Error('BITGET_ORDER_STATE_UNSUPPORTED');
  return {
    state: mapped,
    exchangeOrderId: payload.orderId ? String(payload.orderId) : null,
    filledQuantity: nonNegative(payload.baseVolume, 'BITGET_FILLED_QUANTITY_INVALID'),
    averageFillPrice: positiveOrNull(payload.priceAvg),
  };
}

export function parseUpbitOrderSnapshot(value: unknown): ExchangeOrderSnapshot {
  const payload = record(value);
  const state = String(payload.state ?? '').toLowerCase();
  const filledQuantity = nonNegative(payload.executed_volume, 'UPBIT_FILLED_QUANTITY_INVALID');
  const mapped = ['wait', 'watch'].includes(state)
    ? (filledQuantity > 0 ? 'PARTIALLY_FILLED' : 'ACCEPTED')
    : state === 'done' ? 'FILLED'
      : state === 'cancel' ? 'CANCELED' : null;
  if (!mapped) throw new Error('UPBIT_ORDER_STATE_UNSUPPORTED');
  const executedFunds = positiveOrNull(payload.executed_funds);
  return {
    state: mapped,
    exchangeOrderId: payload.uuid ? String(payload.uuid) : null,
    filledQuantity,
    averageFillPrice: positiveOrNull(payload.avg_price)
      ?? (executedFunds && filledQuantity > 0 ? executedFunds / filledQuantity : null),
  };
}

export class TradeReconciliationService {
  private automation: TradeAutomationService;

  constructor(private repository: TradingRepository) {
    this.automation = new TradeAutomationService(repository);
  }

  async applySnapshot(order: TradingOrder, snapshot: ExchangeOrderSnapshot) {
    if (snapshot.filledQuantity + 1e-12 < order.filledQuantity) {
      throw new Error('RECONCILIATION_FILLED_QUANTITY_REGRESSION');
    }
    if (order.requestedQuantity != null && snapshot.filledQuantity > order.requestedQuantity + 1e-12) {
      throw new Error('RECONCILIATION_FILLED_QUANTITY_EXCEEDED');
    }
    const metadata = {
      exchangeOrderId: snapshot.exchangeOrderId ?? order.exchangeOrderId ?? undefined,
      filledQuantity: snapshot.filledQuantity,
      averageFillPrice: snapshot.averageFillPrice ?? undefined,
      reconciliation: true,
    };

    if (snapshot.state === 'CANCELED') {
      if (order.state !== 'CANCEL_REQUESTED' && order.state !== 'RECOVERY_REQUIRED') {
        await this.automation.transition(order, 'CANCEL_REQUESTED', 'RECONCILIATION_OBSERVED_EXTERNAL_CANCEL', metadata);
      }
      return this.automation.transition(order, 'CANCELED', 'RECONCILIATION_CONFIRMED_CANCELED', metadata);
    }
    if (snapshot.state === 'ACCEPTED') {
      if (order.state === 'ACCEPTED' || order.state === 'PARTIALLY_FILLED' || order.state === 'CANCEL_REQUESTED') return order;
      return this.automation.transition(order, 'ACCEPTED', 'RECONCILIATION_CONFIRMED_ACCEPTED', metadata);
    }
    return this.automation.transition(order, snapshot.state, `RECONCILIATION_CONFIRMED_${snapshot.state}`, metadata);
  }
}
