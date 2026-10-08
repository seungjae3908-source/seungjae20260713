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
    const scopedOrderId = options.orderId ?? null;
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
      if (ownedPlan.accountMode !== 'paper') throw new Error('EXECUTION_SYNC_TARGET_LIVE_FORBIDDEN');
    }
    const allTransitions = await this.tradingRepository.listEvents(userId);
    const transitions = scopedOrderId
      ? allTransitions.filter((event) => event.orderId === scopedOrderId && event.userId === userId)
      : allTransitions;
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
