import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TradingPlan } from './trade-automation.types';

// Domain-separated from credential encryption. No new deployment secret and
// no client-supplied flag can mint this server-owned, order-bound authority.
function key() {
  const master = Buffer.from((process.env.TRADING_CREDENTIAL_MASTER_KEY ?? '').trim(), 'base64');
  if (master.length !== 32) throw new Error('MANUAL_ORDER_SERVER_AUTHORITY_UNAVAILABLE');
  return createHmac('sha256', master).update('manual-chart-order-authority-v1').digest();
}
function payload(plan: TradingPlan) {
  return JSON.stringify([
    'manual-chart-v1', plan.id, plan.userId, plan.idempotencyKey,
    plan.executionMode, plan.exchange, plan.accountMode, plan.strategyId, plan.signalId,
    plan.symbol, plan.market, plan.side, plan.orderType, plan.quantity ?? null,
    plan.quoteAmount ?? null, plan.limitPrice ?? null, plan.estimatedKrw,
    plan.stopPrice, plan.targetPrices, plan.splitRatios, plan.leverage ?? null,
    plan.marginMode ?? null, plan.reduceOnly === true, plan.stockBroker ?? null,
    plan.stockExchange ?? null, plan.invalidateAction ?? null,
    plan.createdAt, plan.approvalExpiresAt,
  ]);
}
function eligible(plan: TradingPlan) {
  return plan.executionMode === 'manual' && plan.accountMode === 'live'
    && plan.strategyId === 'manual-chart' && plan.orderType === 'limit'
    && /^manual-chart:[0-9a-f-]{36}$/i.test(plan.signalId);
}
export function signManualOrderAuthority(plan: TradingPlan) {
  if (!eligible(plan)) throw new Error('MANUAL_ORDER_ORIGIN_INVALID');
  return createHmac('sha256', key()).update(payload(plan)).digest('hex');
}
export function hasServerManualOrderAuthority(plan: TradingPlan) {
  if (!eligible(plan) || !/^[0-9a-f]{64}$/.test(plan.manualOrderAuthority ?? '')) return false;
  try {
    return timingSafeEqual(Buffer.from(plan.manualOrderAuthority!, 'hex'), Buffer.from(signManualOrderAuthority(plan), 'hex'));
  } catch { return false; }
}
