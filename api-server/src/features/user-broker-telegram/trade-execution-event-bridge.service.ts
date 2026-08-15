import type { TradingRepository } from '../../services/trade-automation.repository';
import { executionEventFromTradingOrder, UserBrokerTelegramService } from './user-broker-telegram.service';
import type { MemberTier } from '../../../../packages/member-access/src/index.js';

export type TradeExecutionEventBridgeResult = {
  scanned: number;
  mapped: number;
  inserted: number;
  deliveryQueued: number;
  missingReferences: number;
  privateApiRequests: 0;
  ordersSubmitted: 0;
  ordersCancelled: 0;
};

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

  async syncUser(userId: string, membership: MemberTier = 'admin'): Promise<TradeExecutionEventBridgeResult> {
    const transitions = await this.tradingRepository.listEvents(userId);
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
      privateApiRequests: 0,
      ordersSubmitted: 0,
      ordersCancelled: 0,
    };
  }
}
