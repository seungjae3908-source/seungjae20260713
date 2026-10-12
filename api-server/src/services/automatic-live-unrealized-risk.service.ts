import type { AccountProvider, CanonicalAccountSnapshot } from '../features/account-readonly/account-readonly.contract';
import { assertAutomaticLiveSnapshotIsolation, type AutomaticLiveOwnedPosition } from './automatic-live-position-isolation.service';
import type { TradingOrder, TradingPlan } from './trade-automation.types';
import type { MemberAutoTradingMarketMark } from './member-auto-trading-market-mark.service';

const symbol = (value: string) => value.trim().toUpperCase().replace(/^KRW-/u, '');
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Upbit accounts do not report unrealized PnL. Use the actual canonical fill
 * cost, never the editable account average or a plan's proposed entry price. */
async function upbitOwnedPnl(input: {
  owned: AutomaticLiveOwnedPosition;
  orders: readonly TradingOrder[];
  nowMs: number;
  readMark: (plan: TradingPlan) => Promise<MemberAutoTradingMarketMark>;
}) {
  const { plan, remainingQuantity } = input.owned;
  if (plan.exchange !== 'upbit' || plan.market !== 'KRW' || plan.side !== 'buy' || plan.reduceOnly) {
    throw new Error('BACKGROUND_LIVE_PNL_COST_BASIS_EVIDENCE_REQUIRED');
  }
  const entries = input.orders.filter((order) => order.planId === plan.id
    && ['PARTIALLY_FILLED', 'FILLED'].includes(order.state));
  const order = entries[0];
  if (entries.length !== 1 || !order || order.userId !== plan.userId || order.exchange !== 'upbit'
    || !finite(order.averageFillPrice) || order.averageFillPrice <= 0
    || !finite(order.filledQuantity) || order.filledQuantity <= 0
    || !finite(remainingQuantity) || remainingQuantity <= 0 || remainingQuantity > order.filledQuantity + 1e-8) {
    throw new Error('BACKGROUND_LIVE_PNL_COST_BASIS_EVIDENCE_REQUIRED');
  }
  let fee = order.feeAmount;
  const paidKrw = (amount: unknown, currency: unknown) => finite(amount) && amount >= 0
    && (amount === 0 || currency === 'KRW');
  if (!paidKrw(fee, order.feeCurrency)) {
    const fills = order.fills;
    if (!fills?.length || fills.some((fill) => !paidKrw(fill.feeAmount, fill.feeCurrency)
      || !finite(fill.quantity) || fill.quantity <= 0 || !finite(fill.price) || fill.price <= 0)) {
      throw new Error('BACKGROUND_LIVE_PNL_FEE_EVIDENCE_REQUIRED');
    }
    const quantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
    const average = fills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0) / quantity;
    if (Math.abs(quantity - order.filledQuantity) > Math.max(1e-8, order.filledQuantity * 1e-6)
      || Math.abs(average - order.averageFillPrice) > Math.max(1e-8, order.averageFillPrice * 1e-6)) {
      throw new Error('BACKGROUND_LIVE_PNL_COST_BASIS_EVIDENCE_REQUIRED');
    }
    fee = fills.reduce((sum, fill) => sum + fill.feeAmount!, 0);
  }
  const mark = await input.readMark(plan);
  const observedAt = Date.parse(mark.observedAt);
  if (mark.market !== 'CRYPTO_SPOT' || symbol(mark.symbol) !== symbol(plan.symbol)
    || !finite(mark.price) || mark.price <= 0 || !mark.source?.trim()
    || !Number.isFinite(observedAt) || !finite(input.nowMs)
    || observedAt > input.nowMs + 5_000 || input.nowMs - observedAt > 30_000) {
    throw new Error('BACKGROUND_LIVE_PNL_MARK_EVIDENCE_REQUIRED');
  }
  return (mark.price - order.averageFillPrice) * remainingQuantity
    - fee! * remainingQuantity / order.filledQuantity;
}

/** Account-wide AUTO loss evidence, not just the provider for the next entry.
 * Existing manual holdings never contribute or acquire AUTO ownership here.
 * No order, cancellation, adoption, or authority-changing operation is exposed. */
export async function automaticLiveUnrealizedPnlKrw(input: {
  owned: readonly AutomaticLiveOwnedPosition[];
  maximumLeverage: number;
  snapshotFor: (provider: AccountProvider) => Promise<CanonicalAccountSnapshot>;
  krwPerQuoteFor: (plan: TradingPlan) => Promise<number>;
  orders?: readonly TradingOrder[];
  nowMs?: number;
  readMark?: (plan: TradingPlan) => Promise<MemberAutoTradingMarketMark>;
}) {
  const providers = [...new Set(input.owned.map((row) => row.plan.exchange))] as AccountProvider[];
  const snapshots = await Promise.all(providers.map(async (provider) => {
    const snapshot = await input.snapshotFor(provider);
    if (snapshot.provider !== provider) throw new Error('BACKGROUND_LIVE_ACCOUNT_PROVIDER_MISMATCH');
    return snapshot;
  }));
  let total = 0;
  for (const snapshot of snapshots) {
    const { automaticOwned } = assertAutomaticLiveSnapshotIsolation(snapshot, input.owned, input.maximumLeverage);
    for (const position of automaticOwned) {
      const matched = input.owned.find((row) => row.plan.exchange === snapshot.provider
        && symbol(row.plan.symbol) === symbol(position.symbol)
        && (!['toss', 'kiwoom'].includes(snapshot.provider)
          || row.plan.market.toUpperCase() === position.market.toUpperCase()));
      if (!matched) throw new Error('BACKGROUND_LIVE_CANONICAL_OWNERSHIP_AMBIGUOUS');
      let pnl = position.unrealizedPnl;
      if (!finite(pnl) && snapshot.provider === 'upbit' && input.orders && input.readMark && input.nowMs != null) {
        pnl = await upbitOwnedPnl({ owned: matched, orders: input.orders, readMark: input.readMark, nowMs: input.nowMs });
      }
      if (!finite(pnl)) throw new Error('BACKGROUND_LIVE_UNREALIZED_PNL_EVIDENCE_REQUIRED');
      const fx = await input.krwPerQuoteFor(matched.plan);
      if (!finite(fx) || fx <= 0) throw new Error('BACKGROUND_LIVE_PNL_FX_EVIDENCE_REQUIRED');
      total += pnl * fx;
      if (!finite(total)) throw new Error('BACKGROUND_LIVE_UNREALIZED_PNL_EVIDENCE_REQUIRED');
    }
  }
  return total;
}
