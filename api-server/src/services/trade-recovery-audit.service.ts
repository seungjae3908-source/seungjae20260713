import { randomUUID } from 'node:crypto';
import type { TradingRepository } from './trade-automation.repository';
import { withTradePlanLock } from './trade-automation.service';
import type { TradingOrder, TradingOrderEvent } from './trade-automation.types';

export async function recordRecoveryAttempt(
  repository: TradingRepository,
  order: TradingOrder,
  reason: string,
  errorCode: string | null,
  metadata: Record<string, unknown> = {},
) {
  return withTradePlanLock(order.userId, order.planId, async () => {
    const current = await repository.getOrder(order.userId, order.id) ?? structuredClone(order);
    if (current.state !== 'RECOVERY_REQUIRED') {
      Object.assign(order, current);
      return order;
    }

    current.retryCount += 1;
    current.lastErrorCode = errorCode;
    current.updatedAt = new Date().toISOString();
    await repository.saveOrder(current);

    const event: TradingOrderEvent = {
      id: randomUUID(),
      userId: current.userId,
      orderId: current.id,
      fromState: 'RECOVERY_REQUIRED',
      toState: 'RECOVERY_REQUIRED',
      reason,
      metadata: {
        ...metadata,
        retryCount: current.retryCount,
        errorCode,
        orderResubmitted: false,
        cancelSubmitted: false,
      },
      createdAt: new Date().toISOString(),
    };
    await repository.appendEvent(event);
    Object.assign(order, current);
    return order;
  });
}
