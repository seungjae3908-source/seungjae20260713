import type { TradingRepository } from './trade-automation.repository';
import type { TradingOrder, TradingPlan, TradingPolicy } from './trade-automation.types';
import { canonicalAutomaticLivePositions } from './automatic-live-position-isolation.service';
import { completeTradingHistory } from './trade-history-completeness.service';
import { resolveRulePackPilotDynamicCapPolicy, rulePackPilotMarketForPlan } from './trade-rule-pack-pilot-capital.service';

export type AutomaticLiveBudgetCharge = {
  orderId: string; market: string; instrument: string; strategy: string;
  amountKrw: number; riskKrw: number;
};
/** Raw, single-MVCC database snapshot. It is never supplied by a browser. */
export type AutomaticLiveBudgetSnapshot = {
  policy: TradingPolicy | null; emergencyStopped: boolean;
  plans: TradingPlan[]; orders: TradingOrder[];
  holds: AutomaticLiveBudgetCharge[];
};
export type AutomaticLiveBudgetProjection = AutomaticLiveBudgetCharge & {
  userId: string; planId: string; expectedVersion: number;
  releases: string[]; baseCharges: AutomaticLiveBudgetCharge[];
  limits: { total: number; market: number; instrument: number; strategy: number;
    risk: number; positions: number; order: number };
};

export function automaticLiveBudgetRequired(plan: TradingPlan): boolean {
  return plan.accountMode === 'live' && !plan.reduceOnly
    && (plan.executionMode === 'automatic' || plan.signalReasons.includes('CANONICAL_LIVE_AUTO_HANDOFF'));
}
export function serverOwnedAutomaticLiveLedger(plan: TradingPlan): boolean {
  return plan.accountMode === 'live' && (plan.executionMode === 'automatic'
    || plan.signalReasons.includes('CANONICAL_LIVE_AUTO_HANDOFF')
    || plan.signalReasons.some((reason) => reason.startsWith('AUTO_EXIT_ENTRY_PLAN:')));
}
const positive = (value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value) && value > 0 && value <= 10_000_000_000;
const quantity = (value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value) && value > 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value) && value >= 0 && value <= 10_000_000_000;
const instrument = (plan: TradingPlan) => `${plan.exchange}:${plan.market.toUpperCase()}:${plan.symbol.trim().toUpperCase().replace(/^KRW-/u, '')}`;

function charge(plan: TradingPlan, orderId: string, fraction = 1): AutomaticLiveBudgetCharge {
  const reference = [plan.marketSnapshot.currentPrice, plan.marketSnapshot.plannedPrice,
    plan.entryPrice, plan.limitPrice].find(quantity);
  if (!positive(plan.estimatedKrw) || !quantity(reference) || !quantity(plan.stopPrice)
    || !nonnegative(fraction) || fraction > 1 || !plan.strategyId?.trim() || !plan.symbol?.trim()) {
    throw new Error('AUTOMATIC_LIVE_BUDGET_PRICE_OR_CAPITAL_INVALID');
  }
  return { orderId, market: rulePackPilotMarketForPlan(plan), instrument: instrument(plan),
    strategy: plan.strategyId, amountKrw: Math.ceil(plan.estimatedKrw * fraction * 100) / 100,
    riskKrw: Math.ceil(plan.estimatedKrw * fraction * Math.abs(reference - plan.stopPrice) / reference * 100) / 100 };
}

function assertSnapshot(snapshot: AutomaticLiveBudgetSnapshot, userId: string) {
  if (!snapshot || !Array.isArray(snapshot.plans) || !Array.isArray(snapshot.orders)
    || !Array.isArray(snapshot.holds) || typeof snapshot.emergencyStopped !== 'boolean'
    || snapshot.plans.length > 100_000 || snapshot.orders.length > 100_000 || snapshot.holds.length > 100_000) {
    throw new Error('AUTOMATIC_LIVE_BUDGET_SNAPSHOT_INVALID');
  }
  for (const rows of [snapshot.plans, snapshot.orders]) {
    if (rows.some((row) => !row?.id || row.userId !== userId)
      || new Set(rows.map((row) => row.id)).size !== rows.length) {
      throw new Error('AUTOMATIC_LIVE_BUDGET_USER_SCOPE_OR_HISTORY_INVALID');
    }
  }
  const ids = new Set<string>();
  for (const hold of snapshot.holds) {
    if (!hold?.orderId || ids.has(hold.orderId) || !positive(hold.amountKrw)
      || !nonnegative(hold.riskKrw) || !hold.market || !hold.instrument || !hold.strategy
      || !snapshot.orders.some((row) => row.id === hold.orderId)) {
      throw new Error('AUTOMATIC_LIVE_BUDGET_HOLD_INVALID');
    }
    ids.add(hold.orderId);
  }
}

/** Derive caps from the exact database snapshot, including real settlement-backed
 * compounding. Unknown outcomes retain their whole hold; elapsed time is NOT a
 * release reason. Manual holdings, Paper and Telegram never become AUTO assets. */
export async function projectAutomaticLiveBudget(
  snapshot: AutomaticLiveBudgetSnapshot, userId: string, orderId: string,
  normalizePolicy: (policy: TradingPolicy | null) => TradingPolicy,
): Promise<AutomaticLiveBudgetProjection> {
  assertSnapshot(snapshot, userId);
  const order = snapshot.orders.find((row) => row.id === orderId);
  const plan = snapshot.plans.find((row) => row.id === order?.planId);
  if (!order || !plan || !automaticLiveBudgetRequired(plan) || order.exchange !== plan.exchange
    || order.state !== 'SUBMITTED' || plan.state !== 'SUBMITTED'
    || !Number.isSafeInteger(order.version) || Number(order.version) < 0) {
    throw new Error('AUTOMATIC_LIVE_BUDGET_ENTRY_INVALID');
  }
  const policy = normalizePolicy(snapshot.policy);
  if (snapshot.emergencyStopped || policy.emergencyStopped || policy.newEntriesStopped
    || !policy.automaticEnabled || policy.mode !== 'automatic'
    || !policy.marketEnabled[rulePackPilotMarketForPlan(plan)] || !policy.exchangeEnabled[plan.exchange]
    || !policy.enabledStrategies.includes(plan.strategyId)) {
    throw new Error('AUTOMATIC_ENTRY_POLICY_REVOKED');
  }
  const plans = completeTradingHistory(snapshot.plans.slice());
  const orders = completeTradingHistory(snapshot.orders.slice());
  const owned = canonicalAutomaticLivePositions(plans, orders);
  // Only these three snapshot reads are used by the capital resolver. There is
  // deliberately no second network/ledger read while computing the projection.
  const ledger: Pick<TradingRepository, 'listPlans' | 'listOrders'> = {
    listPlans: async () => plans, listOrders: async () => orders,
  };
  const effective = await resolveRulePackPilotDynamicCapPolicy(ledger, userId, plan, policy);
  const releases: string[] = [];
  const heldIds = new Set(snapshot.holds.map((hold) => hold.orderId));
  const ownedByPlan = new Map(owned.map((row) => [row.plan.id, row]));
  for (const hold of snapshot.holds) {
    const heldOrder = orders.find((row) => row.id === hold.orderId)!;
    const heldPlan = plans.find((row) => row.id === heldOrder.planId);
    if (!heldPlan || !automaticLiveBudgetRequired(heldPlan)) throw new Error('AUTOMATIC_LIVE_BUDGET_HOLD_LINEAGE_INVALID');
    if (heldOrder.filledQuantity === 0 && heldOrder.state === 'REJECTED' && !heldOrder.submissionStartedAt) {
      releases.push(hold.orderId); // Local rejection before any financial POST.
    } else if (heldOrder.filledQuantity === 0 && heldOrder.state === 'CANCELED'
      && heldOrder.lastReconciledAt && Number.isFinite(Date.parse(heldOrder.lastReconciledAt))) {
      releases.push(hold.orderId); // Explicit broker terminal reconciliation.
    } else if (heldOrder.state === 'FILLED' && quantity(heldOrder.filledQuantity)
      && !ownedByPlan.has(heldPlan.id)) {
      // canonicalAutomaticLivePositions already checked exact parent lineage,
      // provider, symbol, quantities and duplicate fills. Additionally reject a
      // forged cash/futures exit direction before releasing capital.
      const exits = plans.filter((row) => row.accountMode === 'live' && row.reduceOnly
        && row.signalReasons.includes(`AUTO_EXIT_ENTRY_PLAN:${heldPlan.id}`));
      if (exits.some((row) => row.side !== (heldPlan.exchange === 'bitget'
        ? heldPlan.side === 'long' ? 'short' : 'long' : 'sell'))) {
        throw new Error('AUTOMATIC_LIVE_BUDGET_EXIT_DIRECTION_INVALID');
      }
      if (exits.length === 0) throw new Error('AUTOMATIC_LIVE_BUDGET_CLOSE_PROOF_REQUIRED');
      releases.push(hold.orderId);
    }
  }
  const baseCharges: AutomaticLiveBudgetCharge[] = [];
  for (const row of orders) {
    if (row.id === orderId || heldIds.has(row.id)) continue;
    const parent = plans.find((entry) => entry.id === row.planId);
    if (!parent || !automaticLiveBudgetRequired(parent)) continue;
    const position = ownedByPlan.get(parent.id);
    if (position) {
      if (!quantity(row.filledQuantity)) throw new Error('AUTOMATIC_LIVE_BUDGET_FILL_INVALID');
      // An older open position without a reservation is still charged. Never
      // release a pending remainder simply because one partial fill arrived.
      baseCharges.push(charge(parent, row.id, row.state === 'PARTIALLY_FILLED'
        ? 1 : position.remainingQuantity / row.filledQuantity));
    } else if (['ACCEPTED', 'RECOVERY_REQUIRED'].includes(row.state)
      || row.state === 'SUBMITTED' && (row.submissionStartedAt || row.executionClaimId)) {
      baseCharges.push(charge(parent, row.id));
    }
  }
  const limits = { total: effective.totalCapitalKrw,
    market: effective.maxAssetClassKrw[rulePackPilotMarketForPlan(plan)],
    instrument: Math.min(effective.maxInstrumentKrw, effective.totalCapitalKrw * effective.maxAssetPercent / 100),
    strategy: effective.totalCapitalKrw * effective.maxAssetPercent / 100,
    risk: effective.totalCapitalKrw * effective.totalDailyLossLimitPercent / 100,
    positions: effective.maxOpenPositions, order: effective.maxOrderKrw };
  if (Object.values(limits).some((value) => !positive(value)) || !Number.isSafeInteger(limits.positions)) {
    throw new Error('AUTOMATIC_LIVE_BUDGET_LIMITS_INVALID');
  }
  return { ...charge(plan, orderId), userId, planId: plan.id, expectedVersion: Number(order.version),
    releases, baseCharges, limits };
}

export function assertAutomaticLiveBudgetProjection(
  projection: AutomaticLiveBudgetProjection, holds: readonly AutomaticLiveBudgetCharge[],
) {
  const charges = [...projection.baseCharges,
    ...holds.filter((row) => row.orderId !== projection.orderId && !projection.releases.includes(row.orderId)), projection];
  const sum = (predicate: (row: AutomaticLiveBudgetCharge) => boolean, key: 'amountKrw' | 'riskKrw') =>
    charges.filter(predicate).reduce((total, row) => total + Math.round(row[key] * 100), 0) / 100;
  const checks: [boolean, string][] = [
    [projection.amountKrw <= projection.limits.order, 'ORDER'],
    [sum(() => true, 'amountKrw') <= projection.limits.total, 'TOTAL'],
    [sum((row) => row.market === projection.market, 'amountKrw') <= projection.limits.market, 'MARKET'],
    [sum((row) => row.instrument === projection.instrument, 'amountKrw') <= projection.limits.instrument, 'INSTRUMENT'],
    [charges.filter((row) => row.instrument === projection.instrument).length === 1, 'DUPLICATE_INSTRUMENT'],
    [sum((row) => row.strategy === projection.strategy, 'amountKrw') <= projection.limits.strategy, 'STRATEGY'],
    [sum(() => true, 'riskKrw') <= projection.limits.risk, 'RISK'],
    [charges.length <= projection.limits.positions, 'POSITIONS'],
  ];
  const failure = checks.find(([passed]) => !passed);
  if (failure) throw new Error(`AUTOMATIC_LIVE_BUDGET_${failure[1]}_EXCEEDED`);
}
