import type { AnalysisMarket, AnalysisPricePlan } from './analysis-selection';

export type PositionAnalyticsPosition = {
  quantity: number | null;
  averageEntryPrice: number | null;
  currentPrice: number | null;
  unrealizedPnl: number | null;
  liquidationPrice: number | null;
  side: string | null;
};

export type AdditionalEntryProjection = {
  mode: 'NOTIONAL' | 'QUANTITY';
  additionalQuantity: number;
  projectedAverageEntryPrice: number;
};

export type PriceOutcomeProjection = {
  price: number;
  priceReturnPercent: number | null;
  pnlAmount: number | null;
  pnlSource: 'POSITION_QUANTITY' | 'PROVIDER_IMPLIED' | null;
};

export type PartialExitProjection = {
  percent: number;
  quantity: number | null;
  grossValue: number | null;
  pnlAmount: number | null;
  pnlSource: PriceOutcomeProjection['pnlSource'];
};

export type FeeEvidence = {
  entryFeePercent: number;
  exitFeePercent: number;
  source: 'USER_INPUT' | 'PROVIDER';
};

export type PositionGuidance = {
  state: 'UNAVAILABLE' | 'STOP_BREACHED' | 'PROFIT' | 'LOSS' | 'FLAT';
  headline: string;
  detail: string;
  averageDistancePercent: number | null;
  stopGapPercent: number | null;
  targetGapPercent: number | null;
  liquidationGapPercent: number | null;
  nearestTarget: number | null;
  stopPrice: number | null;
};

function finite(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function positive(value: number | null | undefined): number | null {
  const parsed = finite(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function absoluteQuantity(position: PositionAnalyticsPosition): number | null {
  const quantity = finite(position.quantity);
  return quantity != null && Math.abs(quantity) > 0 ? Math.abs(quantity) : null;
}

export function positionDirection(position: PositionAnalyticsPosition): 1 | -1 {
  return String(position.side ?? '').trim().toLowerCase() === 'short' ? -1 : 1;
}

export function positionCurrentPrice(
  position: PositionAnalyticsPosition,
  chartPrice: number | null,
): number | null {
  return positive(position.currentPrice) ?? positive(chartPrice);
}

export function projectedAverageEntry(input: {
  market: AnalysisMarket;
  position: PositionAnalyticsPosition;
  chartPrice: number | null;
  additionalValue: number | null;
  additionalPrice: number | null;
}): AdditionalEntryProjection | null {
  const average = positive(input.position.averageEntryPrice);
  const currentQuantity = absoluteQuantity(input.position);
  const price = positive(input.additionalPrice) ?? positionCurrentPrice(input.position, input.chartPrice);
  const additionalValue = positive(input.additionalValue);
  if (average == null || currentQuantity == null || price == null || additionalValue == null) return null;

  const mode: AdditionalEntryProjection['mode'] = input.market === 'BITGET' ? 'QUANTITY' : 'NOTIONAL';
  const additionalQuantity = mode === 'QUANTITY' ? additionalValue : additionalValue / price;
  if (!Number.isFinite(additionalQuantity) || additionalQuantity <= 0) return null;
  const projectedAverageEntryPrice = (
    (average * currentQuantity) + (price * additionalQuantity)
  ) / (currentQuantity + additionalQuantity);
  if (!Number.isFinite(projectedAverageEntryPrice) || projectedAverageEntryPrice <= 0) return null;
  return { mode, additionalQuantity, projectedAverageEntryPrice };
}

function bitgetPnlSensitivity(position: PositionAnalyticsPosition): number | null {
  const average = positive(position.averageEntryPrice);
  const current = positive(position.currentPrice);
  const pnl = finite(position.unrealizedPnl);
  if (average == null || current == null || pnl == null) return null;
  const directionalDelta = positionDirection(position) * (current - average);
  if (!Number.isFinite(directionalDelta) || Math.abs(directionalDelta) < 1e-9) return null;
  const sensitivity = pnl / directionalDelta;
  return Number.isFinite(sensitivity) && sensitivity > 0 ? sensitivity : null;
}

export function projectPriceOutcome(input: {
  market: AnalysisMarket;
  position: PositionAnalyticsPosition;
  chartPrice: number | null;
  price: number | null;
}): PriceOutcomeProjection | null {
  const average = positive(input.position.averageEntryPrice);
  const price = positive(input.price);
  if (average == null || price == null) return null;
  const direction = positionDirection(input.position);
  const priceReturnPercent = direction * ((price - average) / average) * 100;

  if (input.market === 'BITGET') {
    const sensitivity = bitgetPnlSensitivity(input.position);
    return {
      price,
      priceReturnPercent,
      pnlAmount: sensitivity == null ? null : sensitivity * direction * (price - average),
      pnlSource: sensitivity == null ? null : 'PROVIDER_IMPLIED',
    };
  }

  const quantity = absoluteQuantity(input.position);
  return {
    price,
    priceReturnPercent,
    pnlAmount: quantity == null ? null : direction * (price - average) * quantity,
    pnlSource: quantity == null ? null : 'POSITION_QUANTITY',
  };
}

export function projectPartialExit(input: {
  market: AnalysisMarket;
  position: PositionAnalyticsPosition;
  chartPrice: number | null;
  price: number | null;
  percent: number | null;
}): PartialExitProjection | null {
  const percent = finite(input.percent);
  const price = positive(input.price);
  if (percent == null || percent < 0 || percent > 100 || price == null) return null;
  const outcome = projectPriceOutcome({
    market: input.market,
    position: input.position,
    chartPrice: input.chartPrice,
    price,
  });
  if (!outcome) return null;
  const quantity = absoluteQuantity(input.position);
  const partialQuantity = quantity == null ? null : quantity * (percent / 100);
  return {
    percent,
    quantity: partialQuantity,
    grossValue: input.market === 'BITGET' || partialQuantity == null ? null : partialQuantity * price,
    pnlAmount: outcome.pnlAmount == null ? null : outcome.pnlAmount * (percent / 100),
    pnlSource: outcome.pnlSource,
  };
}

export function feeInclusiveBreakEvenPrice(
  position: PositionAnalyticsPosition,
  evidence: FeeEvidence | null,
): number | null {
  const average = positive(position.averageEntryPrice);
  if (average == null || !evidence) return null;
  const entryFeePercent = finite(evidence.entryFeePercent);
  const exitFeePercent = finite(evidence.exitFeePercent);
  if (
    entryFeePercent == null
    || exitFeePercent == null
    || entryFeePercent < 0
    || exitFeePercent < 0
    || entryFeePercent >= 100
    || exitFeePercent >= 100
  ) return null;
  const entryRate = entryFeePercent / 100;
  const exitRate = exitFeePercent / 100;
  const breakEven = positionDirection(position) === -1
    ? average * (1 - entryRate) / (1 + exitRate)
    : average * (1 + entryRate) / (1 - exitRate);
  return Number.isFinite(breakEven) && breakEven > 0 ? breakEven : null;
}

export function buildPositionGuidance(input: {
  position: PositionAnalyticsPosition;
  chartPrice: number | null;
  pricePlan?: AnalysisPricePlan;
}): PositionGuidance {
  const average = positive(input.position.averageEntryPrice);
  const current = positionCurrentPrice(input.position, input.chartPrice);
  if (average == null || current == null) {
    return {
      state: 'UNAVAILABLE',
      headline: '포지션 판단 근거 부족',
      detail: '평단 또는 현재 가격 근거가 없어 보유자 기준 판단을 만들지 않습니다.',
      averageDistancePercent: null,
      stopGapPercent: null,
      targetGapPercent: null,
      liquidationGapPercent: null,
      nearestTarget: null,
      stopPrice: null,
    };
  }

  const direction = positionDirection(input.position);
  const averageDistancePercent = direction * ((current - average) / average) * 100;
  const stopPrice = positive(input.pricePlan?.stopLoss) ?? positive(input.pricePlan?.invalidation);
  const stopGapPercent = stopPrice == null ? null : direction * ((current - stopPrice) / current) * 100;
  const stopBreached = stopPrice != null && direction * (current - stopPrice) <= 0;
  const nearestTarget = (input.pricePlan?.targets ?? [])
    .map((target) => positive(target))
    .filter((target): target is number => target != null && direction * (target - current) > 0)
    .sort((left, right) => direction * (left - right))[0] ?? null;
  const targetGapPercent = nearestTarget == null ? null : direction * ((nearestTarget - current) / current) * 100;
  const liquidation = positive(input.position.liquidationPrice);
  const liquidationGapPercent = liquidation == null
    ? null
    : direction * ((current - liquidation) / current) * 100;

  if (stopBreached) {
    return {
      state: 'STOP_BREACHED',
      headline: 'Scanner 손절/무효화 기준 이탈',
      detail: '현재 가격이 보유 포지션 기준 위험선 밖입니다. 추가 확대보다 기존 위험 기준 재확인이 우선입니다.',
      averageDistancePercent,
      stopGapPercent,
      targetGapPercent,
      liquidationGapPercent,
      nearestTarget,
      stopPrice,
    };
  }
  if (averageDistancePercent > 0.01) {
    return {
      state: 'PROFIT',
      headline: '평단 기준 수익 구간',
      detail: nearestTarget == null
        ? '현재 포지션은 평단 기준 수익 구간입니다. 다음 목표 가격 근거가 없으면 임의 목표를 만들지 않습니다.'
        : '현재 포지션은 평단 기준 수익 구간입니다. Scanner 목표와 위험선을 함께 보며 보유자 관점으로 판단합니다.',
      averageDistancePercent,
      stopGapPercent,
      targetGapPercent,
      liquidationGapPercent,
      nearestTarget,
      stopPrice,
    };
  }
  if (averageDistancePercent < -0.01) {
    return {
      state: 'LOSS',
      headline: '평단 기준 손실 구간',
      detail: '추가 진입 전 예상평단과 손절 도달 예상손익을 먼저 확인하도록 보유자 기준으로 안내합니다.',
      averageDistancePercent,
      stopGapPercent,
      targetGapPercent,
      liquidationGapPercent,
      nearestTarget,
      stopPrice,
    };
  }
  return {
    state: 'FLAT',
    headline: '평단 부근',
    detail: '현재 가격이 평단 부근입니다. 목표·손절 근거가 있을 때만 다음 가격 시나리오를 계산합니다.',
    averageDistancePercent,
    stopGapPercent,
    targetGapPercent,
    liquidationGapPercent,
    nearestTarget,
    stopPrice,
  };
}
