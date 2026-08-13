import type { AnalysisPricePlan, AnalysisTradeAction } from './analysis-selection';

export type AiChartRiskZoneKind = 'ENTRY' | 'CAUTION' | 'INVALIDATION';
export type AiChartRiskZoneState = 'READY' | 'UNAVAILABLE';

export type AiChartRiskZone = {
  kind: AiChartRiskZoneKind;
  state: AiChartRiskZoneState;
  from: number | null;
  to: number | null;
  source: 'PRICE_PLAN' | 'NONE';
  reasons: string[];
};

export type AiChartRiskZones = {
  entry: AiChartRiskZone;
  caution: AiChartRiskZone;
  invalidation: AiChartRiskZone;
};

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function unavailable(kind: AiChartRiskZoneKind, reason: string): AiChartRiskZone {
  return {
    kind,
    state: 'UNAVAILABLE',
    from: null,
    to: null,
    source: 'NONE',
    reasons: [reason],
  };
}

function ready(kind: AiChartRiskZoneKind, left: number, right: number, reasons: string[]): AiChartRiskZone {
  return {
    kind,
    state: 'READY',
    from: Math.min(left, right),
    to: Math.max(left, right),
    source: 'PRICE_PLAN',
    reasons,
  };
}

function directionalSide(action: AnalysisTradeAction | null | undefined): 'LONG' | 'SHORT' | null {
  if (action === 'BUY' || action === 'LONG') return 'LONG';
  if (action === 'SELL' || action === 'SHORT') return 'SHORT';
  return null;
}

export function buildEvidenceBackedRiskZones(
  plan: AnalysisPricePlan | null | undefined,
  action: AnalysisTradeAction | null | undefined,
): AiChartRiskZones {
  if (!plan) {
    return {
      entry: unavailable('ENTRY', '검증된 PricePlan이 없어 ENTRY ZONE을 만들지 않음'),
      caution: unavailable('CAUTION', '검증된 PricePlan이 없어 CAUTION ZONE을 만들지 않음'),
      invalidation: unavailable('INVALIDATION', '검증된 PricePlan이 없어 INVALIDATION ZONE을 만들지 않음'),
    };
  }

  const side = directionalSide(action);
  const rawFrom = positive(plan.entryZone?.from);
  const rawTo = positive(plan.entryZone?.to);
  const entryLow = rawFrom != null && rawTo != null ? Math.min(rawFrom, rawTo) : null;
  const entryHigh = rawFrom != null && rawTo != null ? Math.max(rawFrom, rawTo) : null;
  const stop = positive(plan.stopLoss);
  const invalidationLevel = positive(plan.invalidation);

  const entry = entryLow != null && entryHigh != null
    ? ready('ENTRY', entryLow, entryHigh, ['Scanner/Risk Engine PricePlan의 entryZone 경계를 그대로 사용'])
    : unavailable('ENTRY', 'PricePlan entryZone의 양쪽 경계가 모두 유효하지 않음');

  if (!side || entryLow == null || entryHigh == null) {
    return {
      entry,
      caution: unavailable('CAUTION', '방향과 유효한 entryZone이 모두 있어야 위험 측 경계를 검증할 수 있음'),
      invalidation: unavailable('INVALIDATION', '방향과 유효한 entryZone이 모두 있어야 invalidation 위치를 검증할 수 있음'),
    };
  }

  const riskEntryBoundary = side === 'LONG' ? entryLow : entryHigh;
  const stopOnRiskSide = stop != null && (side === 'LONG' ? stop < riskEntryBoundary : stop > riskEntryBoundary);
  const invalidationOnRiskSide = invalidationLevel != null
    && (side === 'LONG' ? invalidationLevel < riskEntryBoundary : invalidationLevel > riskEntryBoundary);

  const caution = stopOnRiskSide && stop != null
    ? ready('CAUTION', stop, riskEntryBoundary, [
      '새 가격을 계산하지 않고 PricePlan stopLoss와 entryZone 위험측 경계 사이만 표시',
    ])
    : unavailable('CAUTION', 'stopLoss가 entryZone의 올바른 위험측에 존재하지 않아 CAUTION ZONE을 만들지 않음');

  let invalidation = unavailable(
    'INVALIDATION',
    'invalidation이 entryZone의 올바른 위험측에 존재하지 않아 INVALIDATION ZONE을 만들지 않음',
  );
  if (invalidationOnRiskSide && invalidationLevel != null) {
    if (stopOnRiskSide && stop != null) {
      const fartherThanStop = side === 'LONG' ? invalidationLevel <= stop : invalidationLevel >= stop;
      invalidation = fartherThanStop
        ? ready('INVALIDATION', invalidationLevel, stop, [
          'PricePlan invalidation과 stopLoss의 기존 경계만 사용',
          'invalidation이 stopLoss보다 더 먼 위험측에 있는 계약을 확인',
        ])
        : ready('INVALIDATION', invalidationLevel, invalidationLevel, [
          'invalidation과 stopLoss 순서가 일반 위험 구조와 달라 임의 구간을 만들지 않고 invalidation 레벨만 표시',
        ]);
    } else {
      invalidation = ready('INVALIDATION', invalidationLevel, invalidationLevel, [
        '유효한 stopLoss가 없어 PricePlan invalidation 레벨만 표시',
      ]);
    }
  }

  return { entry, caution, invalidation };
}
