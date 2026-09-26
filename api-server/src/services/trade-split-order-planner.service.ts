import { createHash } from 'node:crypto';
import type { TradingOrderLeg, TradingPlan } from './trade-automation.types';

const RATIO_EPSILON = 1e-9;
const QUANTITY_DECIMALS = 8;
const QUOTE_DECIMALS = 2;

export class TradeSplitOrderPlanError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'TradeSplitOrderPlanError';
  }
}

function finitePositive(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function floorTo(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.floor((value + Number.EPSILON) * factor) / factor;
}

function fixed(value: number, decimals: number) {
  return Number(value.toFixed(decimals));
}

function deterministicId(value: string) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeSplitRatios(splitRatios: number[]) {
  if (!Array.isArray(splitRatios) || splitRatios.length === 0) {
    throw new TradeSplitOrderPlanError('TRADE_SPLIT_RATIOS_REQUIRED');
  }
  if (splitRatios.length > 20) {
    throw new TradeSplitOrderPlanError('TRADE_SPLIT_TOO_MANY_LEGS');
  }
  if (splitRatios.some((ratio) => !Number.isFinite(ratio) || ratio <= 0)) {
    throw new TradeSplitOrderPlanError('TRADE_SPLIT_RATIO_INVALID');
  }

  const total = splitRatios.reduce((sum, ratio) => sum + ratio, 0);
  const scale = Math.abs(total - 1) <= RATIO_EPSILON
    ? 1
    : Math.abs(total - 100) <= RATIO_EPSILON
      ? 100
      : null;
  if (scale === null) {
    throw new TradeSplitOrderPlanError('TRADE_SPLIT_RATIO_TOTAL_INVALID');
  }

  const normalized = splitRatios.map((ratio) => ratio / scale);
  const normalizedTotal = normalized.reduce((sum, ratio) => sum + ratio, 0);
  normalized[normalized.length - 1] += 1 - normalizedTotal;
  return normalized;
}

function allocateTotal(total: number, ratios: number[], decimals: number) {
  const allocations: number[] = [];
  let allocated = 0;
  ratios.forEach((ratio, index) => {
    const amount = index === ratios.length - 1
      ? fixed(total - allocated, decimals)
      : floorTo(total * ratio, decimals);
    if (!finitePositive(amount)) {
      throw new TradeSplitOrderPlanError('TRADE_SPLIT_LEG_BELOW_MINIMUM');
    }
    allocations.push(amount);
    allocated = fixed(allocated + amount, decimals);
  });
  const sum = fixed(allocations.reduce((value, amount) => value + amount, 0), decimals);
  if (sum !== fixed(total, decimals) || sum > total + (1 / (10 ** decimals))) {
    throw new TradeSplitOrderPlanError('TRADE_SPLIT_ALLOCATION_EXCEEDS_PARENT');
  }
  return allocations;
}

export function buildEntrySplitLegs(plan: TradingPlan): TradingOrderLeg[] {
  const ratios = normalizeSplitRatios(plan.splitRatios);
  const version = Number.isInteger(plan.version) && Number(plan.version) >= 0 ? Number(plan.version) : 0;
  const quantityTotal = finitePositive(plan.quantity) ? fixed(Number(plan.quantity), QUANTITY_DECIMALS) : null;
  const quoteTotal = finitePositive(plan.quoteAmount) ? fixed(Number(plan.quoteAmount), QUOTE_DECIMALS) : null;
  if (quantityTotal === null && quoteTotal === null) {
    throw new TradeSplitOrderPlanError('TRADE_SPLIT_PARENT_SIZE_REQUIRED');
  }

  const quantities = quantityTotal === null ? ratios.map(() => null) : allocateTotal(quantityTotal, ratios, QUANTITY_DECIMALS);
  const quoteAmounts = quoteTotal === null ? ratios.map(() => null) : allocateTotal(quoteTotal, ratios, QUOTE_DECIMALS);

  return ratios.map((_, index) => {
    const sequenceNo = index + 1;
    const legKey = `entry-${String(sequenceNo).padStart(2, '0')}`;
    const identity = `${plan.userId}:${plan.id}:${version}:${legKey}`;
    return {
      id: deterministicId(`leg:${identity}`),
      planId: plan.id,
      legKey,
      legType: 'ENTRY',
      sequenceNo,
      idempotencyKey: createHash('sha256').update(`submit:${identity}`).digest('hex'),
      plannedQuantity: quantities[index],
      plannedQuoteAmount: quoteAmounts[index],
      plannedPrice: plan.limitPrice ?? null,
      filledQuantity: 0,
      state: 'PLANNED',
      version: 0,
    };
  });
}

export function assertSplitLegTotals(plan: TradingPlan, legs: TradingOrderLeg[]) {
  if (legs.length !== plan.splitRatios.length) {
    throw new TradeSplitOrderPlanError('TRADE_SPLIT_LEG_COUNT_MISMATCH');
  }
  const quantity = fixed(legs.reduce((sum, leg) => sum + (leg.plannedQuantity ?? 0), 0), QUANTITY_DECIMALS);
  const quote = fixed(legs.reduce((sum, leg) => sum + (leg.plannedQuoteAmount ?? 0), 0), QUOTE_DECIMALS);
  if (finitePositive(plan.quantity) && quantity > fixed(Number(plan.quantity), QUANTITY_DECIMALS)) {
    throw new TradeSplitOrderPlanError('TRADE_SPLIT_ALLOCATION_EXCEEDS_PARENT');
  }
  if (finitePositive(plan.quoteAmount) && quote > fixed(Number(plan.quoteAmount), QUOTE_DECIMALS)) {
    throw new TradeSplitOrderPlanError('TRADE_SPLIT_ALLOCATION_EXCEEDS_PARENT');
  }
}
