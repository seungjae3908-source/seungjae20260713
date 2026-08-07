import type { TradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import type { TradingOrder, TradingPlan } from './trade-automation.types';

type ReconciliationOutcome = {
  order: TradingOrder;
  resolved: boolean;
  querySent: boolean;
  authenticationRequests: number;
  statusQueries: number;
};

function paperOrMock(plan: TradingPlan) {
  return plan.accountMode === 'paper' || plan.accountMode === 'mock';
}

function simulatedFillPrice(plan: TradingPlan) {
  if (plan.limitPrice != null && Number.isFinite(plan.limitPrice) && plan.limitPrice > 0) return plan.limitPrice;
  if (plan.quantity && plan.quantity > 0 && plan.quoteAmount && plan.quoteAmount > 0) {
    return plan.quoteAmount / plan.quantity;
  }
  if (plan.marketSnapshot.currentPrice != null
    && Number.isFinite(plan.marketSnapshot.currentPrice)
    && plan.marketSnapshot.currentPrice > 0) {
    return plan.marketSnapshot.currentPrice;
  }
  return null;
}

export class TradeExecutionCoordinator {
  private automation: TradeAutomationService;

  constructor(private repository: TradingRepository) {
    this.automation = new TradeAutomationService(repository);
  }

  private async currentOrder(userId: string, order: TradingOrder) {
    const persisted = await this.repository.getOrder(userId, order.id);
    if (persisted) Object.assign(order, persisted);
    return order;
  }

  async execute(userId: string, plan: TradingPlan, order: TradingOrder) {
    const current = await this.currentOrder(userId, order);
    if (current.state !== 'SUBMITTED') return current;

    if (!paperOrMock(plan)) {
      return this.automation.transition(current, 'REJECTED', 'LIVE_EXECUTION_DISABLED_BY_RUNTIME_AIRGAP', {
        errorCode: 'LIVE_EXECUTION_DISABLED',
        accountMode: plan.accountMode,
        exchangeRequestSent: false,
        privateApiRequestSent: false,
      });
    }

    if (await this.automation.executionBlockedByEmergencyStop(userId)) {
      return this.automation.transition(current, 'REJECTED', 'EMERGENCY_STOP_ACTIVE', {
        errorCode: 'EMERGENCY_STOP_ACTIVE',
        exchangeRequestSent: false,
        privateApiRequestSent: false,
      });
    }

    const accepted = await this.automation.transition(current, 'ACCEPTED', 'PAPER_MOCK_BROKER_ACCEPTED', {
      accountMode: plan.accountMode,
      adapter: 'local-paper-mock',
      exchangeRequestSent: false,
      privateApiRequestSent: false,
    });
    return this.automation.transition(accepted, 'FILLED', 'PAPER_MOCK_BROKER_FILLED', {
      exchangeOrderId: `paper-${accepted.clientOrderId}`,
      filledQuantity: plan.quantity ?? 0,
      averageFillPrice: simulatedFillPrice(plan),
      accountMode: plan.accountMode,
      adapter: 'local-paper-mock',
      exchangeRequestSent: false,
      privateApiRequestSent: false,
    });
  }

  async cancel(userId: string, plan: TradingPlan, order: TradingOrder) {
    const current = await this.currentOrder(userId, order);
    if (['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(current.state)) return current;

    if (!paperOrMock(plan)) {
      if (current.state === 'SUBMITTED' || current.state === 'ACCEPTED') {
        return this.automation.transition(current, 'REJECTED', 'LIVE_CANCEL_DISABLED_BY_RUNTIME_AIRGAP', {
          errorCode: 'LIVE_EXECUTION_DISABLED',
          exchangeRequestSent: false,
          privateApiRequestSent: false,
        });
      }
      if (current.state !== 'RECOVERY_REQUIRED') {
        return this.automation.transition(current, 'RECOVERY_REQUIRED', 'LIVE_CANCEL_DISABLED_BY_RUNTIME_AIRGAP', {
          errorCode: 'LIVE_EXECUTION_DISABLED',
          filledQuantity: current.filledQuantity,
          exchangeRequestSent: false,
          privateApiRequestSent: false,
        });
      }
      return current;
    }

    const cancelRequested = current.state === 'CANCEL_REQUESTED'
      ? current
      : await this.automation.transition(current, 'CANCEL_REQUESTED', 'PAPER_MOCK_CANCEL_REQUESTED', {
        filledQuantity: current.filledQuantity,
        exchangeRequestSent: false,
        privateApiRequestSent: false,
      });
    return this.automation.transition(cancelRequested, 'CANCELED', 'PAPER_MOCK_BROKER_CANCELED', {
      filledQuantity: cancelRequested.filledQuantity,
      accountMode: plan.accountMode,
      adapter: 'local-paper-mock',
      exchangeRequestSent: false,
      privateApiRequestSent: false,
    });
  }

  async reconcileOrder(userId: string, plan: TradingPlan, order: TradingOrder): Promise<ReconciliationOutcome> {
    const current = await this.currentOrder(userId, order);
    if (current.state !== 'RECOVERY_REQUIRED') {
      return {
        order: current,
        resolved: true,
        querySent: false,
        authenticationRequests: 0,
        statusQueries: 0,
      };
    }

    if (!paperOrMock(plan)) {
      return {
        order: current,
        resolved: false,
        querySent: false,
        authenticationRequests: 0,
        statusQueries: 0,
      };
    }

    const events = (await this.repository.listEvents(userId))
      .filter((event) => event.orderId === current.id && event.toState === 'RECOVERY_REQUIRED')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const priorState = events[0]?.fromState ?? null;
    const requestedQuantity = Number(current.requestedQuantity ?? 0);
    let toState: 'ACCEPTED' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' = 'ACCEPTED';
    if (priorState === 'CANCEL_REQUESTED') toState = 'CANCELED';
    else if (requestedQuantity > 0 && current.filledQuantity >= requestedQuantity) toState = 'FILLED';
    else if (current.filledQuantity > 0 || priorState === 'PARTIALLY_FILLED') toState = 'PARTIALLY_FILLED';

    const reconciled = await this.automation.transition(
      current,
      toState,
      'PAPER_MOCK_RECOVERY_LOCAL_RECONCILED',
      {
        priorState,
        filledQuantity: current.filledQuantity,
        averageFillPrice: current.averageFillPrice,
        accountMode: plan.accountMode,
        adapter: 'local-paper-mock',
        exchangeRequestSent: false,
        privateApiRequestSent: false,
      },
    );
    return {
      order: reconciled,
      resolved: true,
      querySent: false,
      authenticationRequests: 0,
      statusQueries: 0,
    };
  }

  async reconcileRecoverableOrders(userId: string) {
    await this.automation.recoverOpenOrders(userId);
    const recoverable = (await this.repository.listOrders(userId))
      .filter((order) => order.state === 'RECOVERY_REQUIRED');
    const results: ReconciliationOutcome[] = [];
    for (const order of recoverable) {
      const plan = await this.repository.getPlan(userId, order.planId);
      if (!plan) {
        results.push({
          order,
          resolved: false,
          querySent: false,
          authenticationRequests: 0,
          statusQueries: 0,
        });
        continue;
      }
      results.push(await this.reconcileOrder(userId, plan, order));
    }
    return {
      orders: results.map((result) => result.order),
      resolved: results.filter((result) => result.resolved).length,
      unresolved: results.filter((result) => !result.resolved).length,
      queriesSent: 0,
      authenticationRequests: 0,
      statusQueries: 0,
    };
  }
}
