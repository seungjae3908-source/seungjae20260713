/**
 * Live entry guard for the signal order window (owner rules, 2026-10-15).
 *
 * 1. Price at/through the stop (이탈가)          → blocked, signal invalid.
 * 2. Price better than the entry zone            → limit prices move to the current price.
 * 3. Price inside the entry zone                 → allowed.
 * 4. Price worse than the zone, reward/risk ≥ 1  → allowed, unfilled tranches wait.
 * 5. Reward/risk below 1 (chasing)               → blocked.
 * 6. No price or a quote older than 30 seconds   → blocked until refreshed.
 *
 * reward/risk = distance to target 1 ÷ distance to the stop, from the current
 * price. Presentation and pre-check only: the server must repeat the check at
 * submit time. This module never places an order.
 */

export type EntryGuardDirection = 'BUY' | 'LONG' | 'SHORT';

export type EntryGuardState =
  | 'NO_PRICE'
  | 'STALE'
  | 'PLAN_INVALID'
  | 'INVALIDATED'
  | 'BETTER_THAN_ZONE'
  | 'IN_ZONE'
  | 'ABOVE_ZONE_WAIT'
  | 'CHASE_BLOCKED';

export type EntryGuardInput = {
  direction: EntryGuardDirection;
  price: number | null | undefined;
  priceAgeMs: number | null | undefined;
  entryZone: { from: number; to: number } | null | undefined;
  stopLoss: number | null | undefined;
  targets: Array<number | null | undefined>;
  budget?: number | null;
  weights?: readonly number[];
};

export type EntryTranche = {
  label: '1차' | '2차' | '3차';
  planPrice: number;
  orderPrice: number;
  weight: number;
  amount: number | null;
  fillsNow: boolean;
};

export type EntryGuardResult = {
  state: EntryGuardState;
  allowed: boolean;
  tone: 'ok' | 'warn' | 'block';
  message: string;
  rewardRisk: number | null;
  tranches: EntryTranche[];
  maxLossAmount: number | null;
  averageEntry: number | null;
};

export const ENTRY_GUARD_MAX_PRICE_AGE_MS = 30_000;
export const ENTRY_GUARD_MIN_REWARD_RISK = 1;
export const ENTRY_SPLIT_WEIGHTS = Object.freeze([0.3, 0.3, 0.4]);

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function round(value: number, digits = 8): number {
  return Number(value.toFixed(digits));
}

/** Reward/risk from `price`: distance to target ÷ distance to stop (in the trade's favour). */
export function rewardRiskFrom(price: number, target: number, stop: number, short: boolean): number | null {
  const reward = short ? price - target : target - price;
  const risk = short ? stop - price : price - stop;
  if (!(risk > 0)) return null;
  return reward / risk;
}

export function evaluateEntryGuard(input: EntryGuardInput): EntryGuardResult {
  const short = input.direction === 'SHORT';
  const from = positive(input.entryZone?.from);
  const to = positive(input.entryZone?.to);
  const stop = positive(input.stopLoss);
  const target = positive(input.targets?.[0]);
  const weights = input.weights && input.weights.length === 3 ? input.weights : ENTRY_SPLIT_WEIGHTS;
  const budget = positive(input.budget ?? null);
  const empty = (state: EntryGuardState, message: string): EntryGuardResult => ({
    state, allowed: false, tone: 'block', message, rewardRisk: null, tranches: [], maxLossAmount: null, averageEntry: null,
  });

  if (from == null || to == null || stop == null || target == null) {
    return empty('PLAN_INVALID', '진입·손절·목표 가격이 모두 있어야 주문할 수 있어요.');
  }
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  // Plan sanity: stop on the losing side of the whole zone, target on the winning side.
  if (short ? !(stop > high && target < low) : !(stop < low && target > high)) {
    return empty('PLAN_INVALID', '가격 계획이 맞지 않아요(손절·목표 위치 오류). 주문을 막았어요.');
  }
  // Best fill last: BUY/LONG fills from the top of the zone down, SHORT from the bottom up.
  const planPrices = short ? [low, (low + high) / 2, high] : [high, (low + high) / 2, low];

  const price = positive(input.price ?? null);
  if (price == null) return { ...empty('NO_PRICE', '현재가를 불러오는 중이에요.'), tranches: buildTranches(planPrices, null, weights, budget, short) };
  const age = typeof input.priceAgeMs === 'number' && Number.isFinite(input.priceAgeMs) ? input.priceAgeMs : Number.POSITIVE_INFINITY;
  if (age > ENTRY_GUARD_MAX_PRICE_AGE_MS) {
    return { ...empty('STALE', '현재가가 30초 넘게 갱신되지 않았어요. 갱신되면 다시 열려요.'), tranches: buildTranches(planPrices, null, weights, budget, short) };
  }

  const invalidated = short ? price >= stop : price <= stop;
  if (invalidated) {
    return {
      ...empty('INVALIDATED', '이탈가(손절가)에 닿아 신호가 무효예요. 구매를 막았어요.'),
      tranches: buildTranches(planPrices, null, weights, budget, short),
    };
  }

  const rewardRisk = rewardRiskFrom(price, target, stop, short);
  const better = short ? price > high : price < low;
  const inZone = price >= low && price <= high;
  const tranches = buildTranches(planPrices, price, weights, budget, short);
  const { maxLossAmount, averageEntry } = lossAndAverage(tranches, stop, short);
  const base = { rewardRisk: rewardRisk == null ? null : round(rewardRisk, 2), tranches, maxLossAmount, averageEntry };

  if (rewardRisk == null || rewardRisk < ENTRY_GUARD_MIN_REWARD_RISK) {
    return { ...base, state: 'CHASE_BLOCKED', allowed: false, tone: 'block',
      message: `너무 ${short ? '내려' : '올라'}왔어요. 지금 사면 손익비가 ${rewardRisk == null ? '계산 불가' : `1 : ${rewardRisk.toFixed(2)}`}라 구매를 막았어요.` };
  }
  if (better) {
    return { ...base, state: 'BETTER_THAN_ZONE', allowed: true, tone: 'ok',
      message: '계획보다 좋은 가격이에요. 지정가를 지금 가격으로 자동 조정했어요.' };
  }
  if (inZone) {
    return { ...base, state: 'IN_ZONE', allowed: true, tone: 'ok', message: '진입 구간 안이에요. 주문할 수 있어요.' };
  }
  const away = short ? (low - price) / low : (price - high) / high;
  return { ...base, state: 'ABOVE_ZONE_WAIT', allowed: true, tone: 'warn',
    message: `진입 구간보다 ${(away * 100).toFixed(1)}% ${short ? '아래' : '위'}예요. 주문은 계획 가격에 걸어두고, 가격이 오면 체결돼요.` };
}

function buildTranches(planPrices: number[], price: number | null, weights: readonly number[], budget: number | null, short: boolean): EntryTranche[] {
  const labels = ['1차', '2차', '3차'] as const;
  return planPrices.map((planPrice, index) => {
    // A limit order at a worse-than-market price would fill instantly at market;
    // move it to the current price so the plan shows what will really happen.
    const fillsNow = price != null && (short ? price >= planPrice : price <= planPrice);
    const orderPrice = fillsNow && price != null ? price : planPrice;
    return {
      label: labels[index],
      planPrice: round(planPrice),
      orderPrice: round(orderPrice),
      weight: weights[index],
      amount: budget == null ? null : Math.round(budget * weights[index]),
      fillsNow,
    };
  });
}

function lossAndAverage(tranches: EntryTranche[], stop: number, short: boolean): { maxLossAmount: number | null; averageEntry: number | null } {
  if (tranches.some((row) => row.amount == null)) return { maxLossAmount: null, averageEntry: null };
  let loss = 0; let quantity = 0; let spent = 0;
  for (const row of tranches) {
    const amount = Number(row.amount);
    const q = amount / row.orderPrice;
    quantity += q; spent += amount;
    loss += q * (short ? stop - row.orderPrice : row.orderPrice - stop);
  }
  return { maxLossAmount: Math.max(0, Math.round(loss)), averageEntry: quantity > 0 ? round(spent / quantity, 6) : null };
}

/** Poll interval for the live price: crypto 2s, stocks 5s. */
export function livePricePollMs(market: string): number {
  return market === 'UPBIT' || market === 'BITGET' ? 2_000 : 5_000;
}
