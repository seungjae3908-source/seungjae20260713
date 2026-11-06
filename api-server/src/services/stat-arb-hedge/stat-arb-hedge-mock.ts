/**
 * Scripted mock venue + in-memory stores for the hedge adapter tests.
 * Every fill produced here is SIMULATED: the adapter stamps `simulated: true`
 * on the pair and never reports these as live results.
 */
import {
  HedgeOrderDisconnectError, HedgeOrderTimeoutError,
  type HedgeAction, type HedgeAlert, type HedgeAlertPort, type HedgeClock, type HedgeConflictPort, type HedgeConflictSnapshot,
  type HedgeControlPort, type HedgeControlSnapshot, type HedgeExchangePort, type HedgeInstrumentRules, type HedgeLedgerMarketInput,
  type HedgeLedgerPort, type HedgeOrderRequest, type HedgeOrderSnapshot, type HedgePairState, type HedgePairStore,
  type HedgePositionSnapshot, type HedgeProduct, type HedgeQuoteCurrency, type HedgeVenue,
} from './stat-arb-hedge.types';

export type MockBehavior =
  | { kind: 'fill'; price: number; fee?: number }
  | { kind: 'partial'; price: number; fraction: number; fee?: number }
  | { kind: 'open_then_fill'; price: number; fee?: number; afterQueries: number }
  | { kind: 'reject'; reason: string }
  | { kind: 'timeout_not_placed' }
  | { kind: 'timeout_but_filled'; price: number; fee?: number }
  | { kind: 'disconnect_then_filled'; price: number; fee?: number }
  | { kind: 'disconnect_unknown' };

type MockOrder = { request: HedgeOrderRequest; snapshot: HedgeOrderSnapshot; pendingFillPrice: number | null; pendingFee: number; queriesLeft: number; queryThrows: boolean };

export class VirtualClock implements HedgeClock {
  constructor(private current = 1_700_000_000_000) {}
  nowMs(): number { return this.current; }
  async sleep(ms: number): Promise<void> { this.current += ms; }
  advance(ms: number): void { this.current += ms; }
}

export class MockExchange implements HedgeExchangePort {
  readonly kind = 'mock' as const;
  readonly orders = new Map<string, MockOrder>();
  readonly placed: HedgeOrderRequest[] = [];
  readonly script: MockBehavior[] = [];
  position: HedgePositionSnapshot = { quantity: 0, side: null, averagePrice: null, unrealizedPnl: null };
  available: Record<HedgeQuoteCurrency, number> = { KRW: 0, USDT: 0 };
  rules: HedgeInstrumentRules;
  fundingPaidUsdt: number | null | undefined = undefined;
  rulesThrow = false;

  constructor(readonly venue: HedgeVenue, rules: HedgeInstrumentRules, private readonly clock: VirtualClock) {
    this.rules = rules;
  }

  queue(...behaviors: MockBehavior[]): this { this.script.push(...behaviors); return this; }

  async instrumentRules(_symbol: string, _product: HedgeProduct): Promise<HedgeInstrumentRules> {
    if (this.rulesThrow) throw new Error('CONTRACT_FETCH_FAILED');
    return this.rules;
  }

  async readAvailable(quote: HedgeQuoteCurrency): Promise<number> { return this.available[quote]; }

  async readPosition(): Promise<HedgePositionSnapshot> { return this.position; }

  async readFundingPaidUsdt(): Promise<number | null> {
    if (this.fundingPaidUsdt === undefined) throw new Error('FUNDING_HISTORY_UNAVAILABLE');
    return this.fundingPaidUsdt;
  }

  private snap(status: HedgeOrderSnapshot['status'], id: string | null, filled: number, price: number | null, fee: number, reason: string | null, quote: HedgeQuoteCurrency): HedgeOrderSnapshot {
    return { status, exchangeOrderId: id, filledQuantity: filled, averagePrice: price, fee, feeCurrency: quote, reason, updatedAtMs: this.clock.nowMs() };
  }

  private applyPosition(request: HedgeOrderRequest, filled: number, price: number): void {
    if (request.product !== 'usdt_perp' || filled <= 0) return;
    const dir = request.side === 'short' || request.side === 'sell' ? -1 : 1;
    const current = (this.position.side === 'short' ? -1 : this.position.side === 'long' ? 1 : 0) * this.position.quantity;
    const next = Number((current + dir * filled).toFixed(12));
    this.position = { quantity: Math.abs(next), side: next < 0 ? 'short' : next > 0 ? 'long' : null, averagePrice: price, unrealizedPnl: 0 };
  }

  async placeOrder(request: HedgeOrderRequest): Promise<HedgeOrderSnapshot> {
    this.placed.push(request);
    if (this.orders.has(request.clientOrderId)) throw new Error('DUPLICATE_CLIENT_ORDER_ID');
    const behavior = this.script.shift() ?? { kind: 'fill', price: request.limitPrice ?? 0 } as MockBehavior;
    const quote: HedgeQuoteCurrency = request.product === 'spot' ? 'KRW' : 'USDT';
    const id = `${this.venue}-${this.orders.size + 1}`;
    const fee = 'fee' in behavior && behavior.fee != null ? behavior.fee : 0;
    const record = (snapshot: HedgeOrderSnapshot, extra: Partial<MockOrder> = {}) => {
      this.orders.set(request.clientOrderId, { request, snapshot, pendingFillPrice: null, pendingFee: 0, queriesLeft: 0, queryThrows: false, ...extra });
      return snapshot;
    };
    switch (behavior.kind) {
      case 'fill':
        this.applyPosition(request, request.quantity, behavior.price);
        return record(this.snap('FILLED', id, request.quantity, behavior.price, fee, null, quote));
      case 'partial': {
        const filled = Number((request.quantity * behavior.fraction).toFixed(12));
        this.applyPosition(request, filled, behavior.price);
        return record(this.snap('PARTIALLY_FILLED', id, filled, behavior.price, fee, null, quote));
      }
      case 'open_then_fill':
        return record(this.snap('OPEN', id, 0, null, 0, null, quote), { pendingFillPrice: behavior.price, pendingFee: fee, queriesLeft: behavior.afterQueries });
      case 'reject':
        return record(this.snap('REJECTED', id, 0, null, 0, behavior.reason, quote));
      case 'timeout_not_placed':
        throw new HedgeOrderTimeoutError();
      case 'timeout_but_filled':
        this.applyPosition(request, request.quantity, behavior.price);
        record(this.snap('FILLED', id, request.quantity, behavior.price, fee, null, quote));
        throw new HedgeOrderTimeoutError();
      case 'disconnect_then_filled':
        this.applyPosition(request, request.quantity, behavior.price);
        record(this.snap('FILLED', id, request.quantity, behavior.price, fee, null, quote));
        throw new HedgeOrderDisconnectError();
      case 'disconnect_unknown':
        record(this.snap('OPEN', id, 0, null, 0, null, quote), { queryThrows: true });
        throw new HedgeOrderDisconnectError();
      default:
        throw new Error('MOCK_BEHAVIOR_UNKNOWN');
    }
  }

  async queryOrder(clientOrderId: string): Promise<HedgeOrderSnapshot | null> {
    const order = this.orders.get(clientOrderId);
    if (!order) return null;
    if (order.queryThrows) throw new HedgeOrderDisconnectError('query failed');
    if (order.pendingFillPrice != null) {
      order.queriesLeft -= 1;
      if (order.queriesLeft <= 0) {
        this.applyPosition(order.request, order.request.quantity, order.pendingFillPrice);
        order.snapshot = this.snap('FILLED', order.snapshot.exchangeOrderId!, order.request.quantity, order.pendingFillPrice, order.pendingFee, null, order.snapshot.feeCurrency);
        order.pendingFillPrice = null;
      }
    }
    return order.snapshot;
  }

  async cancelOrder(clientOrderId: string): Promise<HedgeOrderSnapshot> {
    const order = this.orders.get(clientOrderId);
    if (!order) return this.snap('UNKNOWN', null, 0, null, 0, 'ORDER_NOT_FOUND', 'KRW');
    if (order.queryThrows) throw new HedgeOrderDisconnectError('cancel failed');
    if (order.snapshot.status === 'FILLED') return order.snapshot;
    order.snapshot = { ...order.snapshot, status: 'CANCELLED', updatedAtMs: this.clock.nowMs() };
    order.pendingFillPrice = null;
    return order.snapshot;
  }

  /** Simulate a venue-side fill that happened while we were down (for recovery tests). */
  settleOffline(clientOrderId: string, price: number, fee = 0): void {
    const order = this.orders.get(clientOrderId);
    if (!order) throw new Error('order not found');
    this.applyPosition(order.request, order.request.quantity - order.snapshot.filledQuantity, price);
    order.snapshot = this.snap('FILLED', order.snapshot.exchangeOrderId, order.request.quantity, price, fee, null, order.snapshot.feeCurrency);
    order.pendingFillPrice = null;
    order.queryThrows = false;
  }
}

export class InMemoryHedgePairStore implements HedgePairStore {
  readonly pairs = new Map<string, HedgePairState>();
  async load(pairId: string): Promise<HedgePairState | null> { return this.pairs.get(pairId) ?? null; }
  async save(state: HedgePairState): Promise<void> { this.pairs.set(state.pairId, structuredClone(state)); }
  async listOpen(userId: string): Promise<HedgePairState[]> {
    return [...this.pairs.values()].filter((p) => p.userId === userId && !['CLOSED', 'REJECTED', 'UNWOUND'].includes(p.phase)).map((p) => structuredClone(p));
  }
  async findBySignal(userId: string, signalId: string, action: HedgeAction): Promise<HedgePairState | null> {
    const hit = [...this.pairs.values()].find((p) => p.userId === userId && (action === 'ENTER' ? p.entrySignalId === signalId : p.exitSignalId === signalId));
    return hit ? structuredClone(hit) : null;
  }
}

export class StaticControlPort implements HedgeControlPort {
  constructor(public snapshot: HedgeControlSnapshot) {}
  async read(): Promise<HedgeControlSnapshot> { return this.snapshot; }
}

export class StaticLedgerPort implements HedgeLedgerPort {
  constructor(public spot: HedgeLedgerMarketInput, public futures: HedgeLedgerMarketInput) {}
  async read() { return { crypto_spot: this.spot, crypto_futures: this.futures }; }
}

export class StaticConflictPort implements HedgeConflictPort {
  readonly byKey = new Map<string, HedgeConflictSnapshot>();
  async read(_userId: string, venue: HedgeVenue, symbol: string): Promise<HedgeConflictSnapshot> {
    return this.byKey.get(`${venue}:${symbol}`) ?? { foreignPositionSide: null, foreignOpenOrders: 0, foreignStrategyIds: [] };
  }
}

export class RecordingAlertPort implements HedgeAlertPort {
  readonly sent: HedgeAlert[] = [];
  async send(alert: HedgeAlert): Promise<void> { this.sent.push(alert); }
}
