import type { AnalysisSelection } from './analysis-selection';

export type ScannerOrderDraftPreview = {
  budget: number;
  firstEntry: { price: number; ratio: 0.6; amount: number };
  secondEntry: { price: number; ratio: 0.4; amount: number };
  estimatedAverageEntry: number;
  target1: number | null;
  target2: number | null;
  stopLoss: number | null;
  estimatedMaxLossAmount: number | null;
  executionAuthority: 'NONE';
  orderSubmitted: false;
};

function finitePositive(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildScannerOrderDraftPreview(
  selection: AnalysisSelection,
  rawBudget: number,
): ScannerOrderDraftPreview | null {
  const budget = finitePositive(rawBudget);
  const zone = selection.pricePlan?.entryZone;
  if (budget == null || !zone) return null;
  const from = finitePositive(zone.from);
  const to = finitePositive(zone.to);
  if (from == null || to == null) return null;
  if (!['BUY', 'LONG', 'SHORT'].includes(String(selection.action))) return null;

  const firstPrice = selection.action === 'SHORT' ? Math.min(from, to) : Math.max(from, to);
  const secondPrice = selection.action === 'SHORT' ? Math.max(from, to) : Math.min(from, to);
  const firstAmount = money(budget * 0.6);
  const secondAmount = money(budget - firstAmount);
  const quantity = firstAmount / firstPrice + secondAmount / secondPrice;
  const estimatedAverageEntry = quantity > 0 ? budget / quantity : Number.NaN;
  if (!Number.isFinite(estimatedAverageEntry) || estimatedAverageEntry <= 0) return null;

  const stopLoss = finitePositive(selection.pricePlan?.stopLoss);
  const target1 = finitePositive(selection.pricePlan?.targets?.[0]);
  const target2 = finitePositive(selection.pricePlan?.targets?.[1]);
  let estimatedMaxLossAmount: number | null = null;
  if (stopLoss != null) {
    const lossRate = selection.action === 'SHORT'
      ? (stopLoss - estimatedAverageEntry) / estimatedAverageEntry
      : (estimatedAverageEntry - stopLoss) / estimatedAverageEntry;
    if (Number.isFinite(lossRate) && lossRate >= 0) estimatedMaxLossAmount = money(budget * lossRate);
  }

  return {
    budget: money(budget),
    firstEntry: { price: firstPrice, ratio: 0.6, amount: firstAmount },
    secondEntry: { price: secondPrice, ratio: 0.4, amount: secondAmount },
    estimatedAverageEntry: money(estimatedAverageEntry),
    target1,
    target2,
    stopLoss,
    estimatedMaxLossAmount,
    executionAuthority: 'NONE',
    orderSubmitted: false,
  };
}
