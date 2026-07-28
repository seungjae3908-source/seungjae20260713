export type TradeStage = 1 | 2 | 3;

export interface StagedTradeAnalysisInput {
  confidenceScore: number;
  oppositeScore?: number | null;
  riskScore: number;
  dataCompleteness: number;
  volatilityPercent: number;
}

export interface StagedTradeAllocation {
  available: true;
  entryRatios: [number, number, number];
  exitRatios: [number, number, number];
  adjustedRiskScore: number;
  signalGap: number;
  riskBand: 'LOW' | 'MEDIUM' | 'HIGH';
  basis: string[];
}

export interface UnavailableStagedTradeAllocation {
  available: false;
  reason: string;
}

export type StagedTradeAllocationResult = StagedTradeAllocation | UnavailableStagedTradeAllocation;

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 실제 분석값이 모두 있을 때만 3단계 진입·청산 비율을 만든다.
 * 위험이 높을수록 첫 진입을 작게 하고, 강한 신호·충분한 데이터는 위험점수를 낮춘다.
 */
export function deriveStagedTradeAllocation(input: StagedTradeAnalysisInput): StagedTradeAllocationResult {
  const confidence = finite(input.confidenceScore);
  const opposite = input.oppositeScore == null ? null : finite(input.oppositeScore);
  const risk = finite(input.riskScore);
  const completeness = finite(input.dataCompleteness);
  const volatility = finite(input.volatilityPercent);

  if (confidence == null || risk == null || completeness == null || volatility == null) {
    return { available: false, reason: '신뢰도·위험도·데이터 충족도·변동성 분석값이 모두 필요합니다.' };
  }
  if (confidence < 0 || confidence > 100 || risk < 0 || risk > 100 || completeness < 0 || completeness > 100 || volatility < 0) {
    return { available: false, reason: '분석값의 범위가 올바르지 않습니다.' };
  }
  if (completeness < 55) {
    return { available: false, reason: `데이터 충족도 ${Math.round(completeness)}%로 분할 비율 산정 최소치 55%보다 낮습니다.` };
  }

  const signalGap = opposite == null
    ? Math.max(0, confidence - 50)
    : Math.max(0, confidence - clamp(opposite, 0, 100));
  const volatilityPenalty = Math.max(0, volatility - 2) * 5;
  const completenessPenalty = Math.max(0, 75 - completeness) * 0.35;
  const strengthDiscount = Math.max(0, signalGap - 10) * 0.18;
  const adjustedRiskScore = Math.round(clamp(risk + volatilityPenalty + completenessPenalty - strengthDiscount, 0, 100));

  let entryRatios: [number, number, number];
  let exitRatios: [number, number, number];
  let riskBand: StagedTradeAllocation['riskBand'];
  if (adjustedRiskScore >= 60) {
    riskBand = 'HIGH';
    entryRatios = [20, 30, 50];
    exitRatios = [50, 30, 20];
  } else if (adjustedRiskScore >= 35) {
    riskBand = 'MEDIUM';
    entryRatios = [30, 35, 35];
    exitRatios = [40, 35, 25];
  } else {
    riskBand = 'LOW';
    entryRatios = [45, 35, 20];
    exitRatios = [30, 35, 35];
  }

  return {
    available: true,
    entryRatios,
    exitRatios,
    adjustedRiskScore,
    signalGap: Math.round(signalGap),
    riskBand,
    basis: [
      `신뢰도 ${Math.round(confidence)}점`,
      opposite == null ? `기준점 대비 신호우위 ${Math.round(signalGap)}점` : `반대신호 대비 우위 ${Math.round(signalGap)}점`,
      `원 위험도 ${Math.round(risk)}점`,
      `ATR 변동성 ${volatility.toFixed(2)}%`,
      `데이터 충족도 ${Math.round(completeness)}%`,
      `조정 위험도 ${adjustedRiskScore}점`,
    ],
  };
}

export function stageAmount(totalAmount: number, ratios: [number, number, number], stage: TradeStage) {
  const total = finite(totalAmount);
  if (total == null || total <= 0) return 0;
  return total * (ratios[stage - 1] / 100);
}

export function parseTradeStage(value: unknown): TradeStage | null {
  const stage = Number(value);
  return stage === 1 || stage === 2 || stage === 3 ? stage : null;
}
