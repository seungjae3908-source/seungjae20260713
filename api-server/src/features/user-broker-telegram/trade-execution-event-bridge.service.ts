import type { TradingRepository } from '../../services/trade-automation.repository';
import { executionEventFromTradingOrder, UserBrokerTelegramService } from './user-broker-telegram.service';
import type { MemberTier } from '../../../../packages/member-access/src/index.js';

export type TradeExecutionEventBridgeResult = {
  scanned: number;
  mapped: number;
  inserted: number;
  deliveryQueued: number;
  missingReferences: number;
  /** Only the caller-owned Paper order was scanned; never a user-wide history sweep. */
  scopedToOrder?: true;
  privateApiRequests: 0;
  ordersSubmitted: 0;
  ordersCancelled: 0;
};

/** Fail closed on ambiguous selectors and never broaden a targeted replay. */
export function parseExecutionSyncOrderId(body: unknown): string | null {
  if (body == null) return null;
  if (typeof body !== 'object' || Array.isArray(body)) throw new Error('EXECUTION_SYNC_REQUEST_INVALID');
  const entries = Object.entries(body);
  if (entries.length === 0) return null;
  if (entries.length !== 1 || entries[0]?.[0] !== 'orderId') throw new Error('EXECUTION_SYNC_REQUEST_INVALID');
  const value = entries[0]?.[1];
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('EXECUTION_SYNC_ORDER_ID_INVALID');
  }
  return value.toLowerCase();
}

/**
 * Read-only bridge from the canonical trade_order_events owner into the
 * per-user execution/portfolio/notification pipeline. It never calls an
 * exchange adapter and never mutates the canonical order state machine.
 */
export class TradeExecutionEventBridgeService {
  constructor(
    private readonly tradingRepository: TradingRepository,
    private readonly integrationService: UserBrokerTelegramService,
  ) {}

  async syncUser(
    userId: string,
    membership: MemberTier = 'pending',
    options: { orderId?: string } = {},
  ): Promise<TradeExecutionEventBridgeResult> {
    return this.syncInternal(userId, membership, options.orderId ?? null, false);
  }

  /** Server-owned worker only. The public syncUser route remains Paper-only. */
  async syncAutomaticOrder(
    userId: string,
    membership: MemberTier,
    orderId: string,
  ): Promise<TradeExecutionEventBridgeResult> {
    if (!orderId) throw new Error('EXECUTION_SYNC_ORDER_ID_INVALID');
    return this.syncInternal(userId, membership, orderId, true);
  }

  private async syncInternal(
    userId: string,
    membership: MemberTier,
    scopedOrderId: string | null,
    allowAutomaticLiveOrder: boolean,
  ): Promise<TradeExecutionEventBridgeResult> {
    if (scopedOrderId) {
      // Strictly resolve the authenticated user's OWN Paper order before fan-out.
      // This does not alter or hide historical immutable source-event conflicts.
      const ownedOrder = await this.tradingRepository.getOrder(userId, scopedOrderId);
      if (!ownedOrder || ownedOrder.userId !== userId || ownedOrder.id !== scopedOrderId) {
        throw new Error('EXECUTION_SYNC_TARGET_NOT_FOUND');
      }
      const ownedPlan = await this.tradingRepository.getPlan(userId, ownedOrder.planId);
      if (!ownedPlan || ownedPlan.userId !== userId || ownedPlan.id !== ownedOrder.planId) {
        throw new Error('EXECUTION_SYNC_TARGET_NOT_FOUND');
      }
      if (allowAutomaticLiveOrder) {
        if (ownedPlan.executionMode !== 'automatic'
          || (ownedPlan.accountMode !== 'paper' && ownedPlan.accountMode !== 'live')) {
          throw new Error('EXECUTION_SYNC_TARGET_AUTOMATIC_REQUIRED');
        }
      } else if (ownedPlan.accountMode !== 'paper') {
        throw new Error('EXECUTION_SYNC_TARGET_LIVE_FORBIDDEN');
      }
    }
    const transitions = scopedOrderId
      ? this.tradingRepository.listEventsForOrder
        ? await this.tradingRepository.listEventsForOrder(userId, scopedOrderId)
        : (await this.tradingRepository.listEvents(userId))
          .filter((event) => event.orderId === scopedOrderId && event.userId === userId)
      : await this.tradingRepository.listEvents(userId);
    // A repository adapter is not an authorization boundary by itself.
    if (scopedOrderId && transitions.some((event) =>
      event.orderId !== scopedOrderId || event.userId !== userId)) {
      throw new Error('EXECUTION_SYNC_TARGET_EVENT_SCOPE_MISMATCH');
    }
    if (scopedOrderId && transitions.length === 0) throw new Error('EXECUTION_SYNC_TARGET_EVENTS_MISSING');
    let mapped = 0;
    let inserted = 0;
    let deliveryQueued = 0;
    let missingReferences = 0;

    for (const transition of transitions) {
      const order = await this.tradingRepository.getOrder(userId, transition.orderId);
      if (!order) {
        missingReferences += 1;
        continue;
      }
      const plan = await this.tradingRepository.getPlan(userId, order.planId);
      if (!plan) {
        missingReferences += 1;
        continue;
      }

      // A historical Paper row can be stamped FILLED without ever carrying
      // an actual positive execution quantity or fill price. Preserve its
      // source evidence and report a reconciliation blocker; never project a
      // fake journal trade or send a false execution Telegram message.
      if (plan.accountMode === 'paper' && plan.executionMode === 'automatic'
        && ['FILLED', 'PARTIALLY_FILLED'].includes(transition.toState)
        && (typeof order.filledQuantity !== 'number'
          || !Number.isFinite(order.filledQuantity) || order.filledQuantity <= 0
          || typeof order.averageFillPrice !== 'number'
          || !Number.isFinite(order.averageFillPrice) || order.averageFillPrice <= 0)) {
        missingReferences += 1;
        continue;
      }

      // The order row may already be at a later state than this historical
      // transition. Map the event using the transition state while preserving
      // fill/account metadata from the canonical current row.
      const event = executionEventFromTradingOrder(
        transition,
        { ...order, state: transition.toState },
        plan,
        { executionMethod: plan.executionMode === 'automatic' ? 'AUTO_POLICY' : 'USER_APPROVED' },
      );
      if (!event) continue;
      mapped += 1;
      const result = await this.integrationService.recordEvent(event, new Date(), membership);
      if (result.inserted) inserted += 1;
      if (result.deliveryQueued) deliveryQueued += 1;
    }

    return {
      scanned: transitions.length,
      mapped,
      inserted,
      deliveryQueued,
      missingReferences,
      ...(scopedOrderId ? { scopedToOrder: true as const } : {}),
      privateApiRequests: 0,
      ordersSubmitted: 0,
      ordersCancelled: 0,
    };
  }
}
