export type AiChartV3Market = 'KR' | 'US' | 'UPBIT' | 'BITGET';
export type AiChartV3Decision = 'BUY' | 'LONG' | 'SHORT' | 'WATCH' | 'WAIT' | 'HOLD' | 'TAKE_PROFIT' | 'EXIT' | 'NO_TRADE';
export type AiChartV3Direction = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'WAIT';
export type AiChartV3DataQuality = 'FRESH' | 'DELAYED' | 'STALE' | 'PARTIAL' | 'UNAVAILABLE';
export type AiChartV3StrategyHealth = 'ACTIVE' | 'DEGRADED' | 'RESEARCH_ONLY' | 'DISABLED' | 'UNKNOWN';
export type AiChartV3EventRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
export type AiChartV3Regime =
  | 'STRONG_UPTREND'
  | 'UPTREND'
  | 'RANGE'
  | 'DOWNTREND'
  | 'STRONG_DOWNTREND'
  | 'BREAKOUT'
  | 'BREAKDOWN'
  | 'HIGH_VOLATILITY'
  | 'LOW_VOLATILITY'
  | 'PANIC'
  | 'LOW_LIQUIDITY'
  | 'INSUFFICIENT_DATA';

export type AiChartV3EvidenceIdentity = {
  market: AiChartV3Market;
  symbol: string;
  timeframe: string;
  strategyId: string;
};

export type AiChartV3EngineEvidence = {
  engine: 'TECHNICAL' | 'PATTERN' | 'MTF' | 'ORDER_FLOW' | 'REGIME' | 'NEWS_EVENT' | 'PERFORMANCE' | 'RISK' | 'FUTURES';
  direction: AiChartV3Direction;
  score: number | null;
  weight: number;
  available: boolean;
  reasons: string[];
};

export type AiChartV3CalibrationProvenance = {
  evidenceClass: 'CANONICAL' | 'TEST_ONLY' | 'FIXTURE' | 'SYNTHETIC';
  identity: AiChartV3EvidenceIdentity;
  datasetDigest: string;
  artifactDigest: string;
  costModelDigest: string;
  observedAt: string;
};

export type AiChartV3CalibrationEvidence = {
  sampleN: number;
  oosSampleN: number;
  holdoutSampleN: number;
  shadowSampleN: number;
  paperSampleN: number;
  calibratedProbability: number | null;
  averageWinPct: number | null;
  averageLossPct: number | null;
  profitFactor: number | null;
  feesPct: number;
  spreadPct: number;
  slippagePct: number;
  fundingPct: number;
  provenance: AiChartV3CalibrationProvenance;
};

export type AiChartV3DecisionInput = {
  identity: AiChartV3EvidenceIdentity;
  market: AiChartV3Market;
  dataQuality: AiChartV3DataQuality;
  regime: AiChartV3Regime;
  strategyHealth: AiChartV3StrategyHealth;
  eventRisk: AiChartV3EventRisk;
  higherTimeframeConflict: boolean;
  hasPosition: boolean;
  positionSide?: 'LONG' | 'SHORT';
  invalidated?: boolean;
  takeProfitReached?: boolean;
  evidence: AiChartV3EngineEvidence[];
  calibration: AiChartV3CalibrationEvidence | null;
  minimumSampleN?: number;
};

export type AiChartV3CalibrationResult = {
  state: 'READY' | 'MISSING_EVIDENCE' | 'INSUFFICIENT_SAMPLE' | 'INVALID_EVIDENCE';
  probability: number | null;
  costAdjustedEvPct: number | null;
  totalCostPct: number | null;
  sampleN: number | null;
};

export type AiChartV3DecisionResult = {
  decision: AiChartV3Decision;
  longScore: number | null;
  shortScore: number | null;
  calibratedProbability: number | null;
  costAdjustedEvPct: number | null;
  calibrationState: AiChartV3CalibrationResult['state'];
  reasons: string[];
};

export type AiChartV3RegimeInput = {
  sampleN: number;
  trendStrength: number | null;
  atrPercentile: number | null;
  volumePercentile: number | null;
  liquidityScore: number | null;
  benchmarkDirection: number | null;
  breakoutDirection?: 'UP' | 'DOWN' | null;
};

function clamp100(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function finite(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function validCount(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function inRange(value: number | null, minimum: number, maximum: number): value is number {
  return value != null && value >= minimum && value <= maximum;
}

function validDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value.trim());
}

function normalizedIdentityValue(value: string): string {
  return value.trim().toUpperCase();
}

function sameEvidenceIdentity(left: AiChartV3EvidenceIdentity, right: AiChartV3EvidenceIdentity): boolean {
  return left.market === right.market
    && normalizedIdentityValue(left.symbol) === normalizedIdentityValue(right.symbol)
    && normalizedIdentityValue(left.timeframe) === normalizedIdentityValue(right.timeframe)
    && left.strategyId.trim() === right.strategyId.trim();
}

function validCalibrationProvenance(
  provenance: AiChartV3CalibrationProvenance | null | undefined,
  expectedIdentity: AiChartV3EvidenceIdentity,
): boolean {
  if (!provenance || provenance.evidenceClass !== 'CANONICAL') return false;
  if (!sameEvidenceIdentity(provenance.identity, expectedIdentity)) return false;
  if (!validDigest(provenance.datasetDigest) || !validDigest(provenance.artifactDigest) || !validDigest(provenance.costModelDigest)) return false;
  const observedAt = Date.parse(provenance.observedAt);
  return Number.isFinite(observedAt) && observedAt > 0;
}

export function classifyAiChartV3Regime(input: AiChartV3RegimeInput): AiChartV3Regime {
  const trend = finite(input.trendStrength);
  const atr = finite(input.atrPercentile);
  const volume = finite(input.volumePercentile);
  const liquidity = finite(input.liquidityScore);
  const benchmark = finite(input.benchmarkDirection);
  if (
    !validCount(input.sampleN)
    || input.sampleN < 30
    || !inRange(trend, -100, 100)
    || !inRange(atr, 0, 100)
    || !inRange(volume, 0, 100)
    || !inRange(liquidity, 0, 100)
    || !inRange(benchmark, -100, 100)
  ) {
    return 'INSUFFICIENT_DATA';
  }
  if (liquidity < 20) return 'LOW_LIQUIDITY';
  if (atr >= 95 && trend <= -60 && benchmark <= -50) return 'PANIC';
  if (input.breakoutDirection === 'UP' && volume >= 70 && trend >= 25) return 'BREAKOUT';
  if (input.breakoutDirection === 'DOWN' && volume >= 70 && trend <= -25) return 'BREAKDOWN';
  if (atr >= 85) return 'HIGH_VOLATILITY';
  if (atr <= 15) return 'LOW_VOLATILITY';
  if (trend >= 70 && benchmark >= 0) return 'STRONG_UPTREND';
  if (trend >= 25) return 'UPTREND';
  if (trend <= -70 && benchmark <= 0) return 'STRONG_DOWNTREND';
  if (trend <= -25) return 'DOWNTREND';
  return 'RANGE';
}

export function calibrateAiChartV3Performance(
  evidence: AiChartV3CalibrationEvidence | null,
  expectedIdentity: AiChartV3EvidenceIdentity,
  minimumSampleN = 30,
): AiChartV3CalibrationResult {
  if (!evidence) {
    return { state: 'MISSING_EVIDENCE', probability: null, costAdjustedEvPct: null, totalCostPct: null, sampleN: null };
  }

  const safeMinimumSampleN = Number.isFinite(minimumSampleN) && minimumSampleN > 0
    ? Math.max(1, Math.floor(minimumSampleN))
    : 30;
  const counts = [
    evidence.sampleN,
    evidence.oosSampleN,
    evidence.holdoutSampleN,
    evidence.shadowSampleN,
    evidence.paperSampleN,
  ];
  if (counts.some((value) => !validCount(value))) {
    return { state: 'INVALID_EVIDENCE', probability: null, costAdjustedEvPct: null, totalCostPct: null, sampleN: null };
  }

  const sampleN = evidence.sampleN;
  if (!validCalibrationProvenance(evidence.provenance, expectedIdentity)) {
    return { state: 'INVALID_EVIDENCE', probability: null, costAdjustedEvPct: null, totalCostPct: null, sampleN };
  }

  const probability = finite(evidence.calibratedProbability);
  const averageWin = finite(evidence.averageWinPct);
  const averageLoss = finite(evidence.averageLossPct);
  const profitFactor = finite(evidence.profitFactor);
  const fees = finite(evidence.feesPct);
  const spread = finite(evidence.spreadPct);
  const slippage = finite(evidence.slippagePct);
  const funding = finite(evidence.fundingPct);

  if (
    fees == null
    || spread == null
    || slippage == null
    || funding == null
    || fees < 0
    || spread < 0
    || slippage < 0
    || (evidence.profitFactor != null && (profitFactor == null || profitFactor <= 0))
  ) {
    return { state: 'INVALID_EVIDENCE', probability: null, costAdjustedEvPct: null, totalCostPct: null, sampleN };
  }

  const totalCostPct = fees + spread + slippage + funding;
  if (sampleN < safeMinimumSampleN || evidence.oosSampleN <= 0 || evidence.holdoutSampleN <= 0 || probability == null) {
    return { state: 'INSUFFICIENT_SAMPLE', probability: null, costAdjustedEvPct: null, totalCostPct, sampleN };
  }
  if (probability < 0 || probability > 1 || averageWin == null || averageLoss == null || averageWin <= 0 || averageLoss >= 0) {
    return { state: 'INVALID_EVIDENCE', probability: null, costAdjustedEvPct: null, totalCostPct: null, sampleN };
  }

  const grossEv = probability * averageWin + (1 - probability) * averageLoss;
  const costAdjustedEvPct = grossEv - totalCostPct;
  if (!Number.isFinite(totalCostPct) || !Number.isFinite(costAdjustedEvPct)) {
    return { state: 'INVALID_EVIDENCE', probability: null, costAdjustedEvPct: null, totalCostPct: null, sampleN };
  }

  return {
    state: 'READY',
    probability,
    costAdjustedEvPct,
    totalCostPct,
    sampleN,
  };
}

function directionalScore(evidence: AiChartV3EngineEvidence[], direction: 'BULLISH' | 'BEARISH'): number | null {
  const available = evidence.filter((item) => item.available && item.score != null && Number.isFinite(item.score) && Number.isFinite(item.weight) && item.weight > 0);
  if (!available.length) return null;
  let numerator = 0;
  let denominator = 0;
  for (const item of available) {
    const score = clamp100(item.score as number);
    // Directional evidence is independent: weak/low bullish evidence must never be inverted into bearish evidence, or vice versa.
    const directional = item.direction === direction
      ? score
      : item.direction === 'NEUTRAL'
        ? 50
        : 0;
    numerator += directional * item.weight;
    denominator += item.weight;
  }
  return denominator > 0 ? Math.round((numerator / denominator) * 10) / 10 : null;
}

function regimeEntryConflict(regime: AiChartV3Regime, longDominant: boolean, shortDominant: boolean): boolean {
  if (longDominant && (regime === 'STRONG_DOWNTREND' || regime === 'BREAKDOWN' || regime === 'PANIC')) return true;
  if (shortDominant && (regime === 'STRONG_UPTREND' || regime === 'BREAKOUT')) return true;
  return false;
}

export function decideAiChartV3(input: AiChartV3DecisionInput): AiChartV3DecisionResult {
  const calibration = calibrateAiChartV3Performance(input.calibration, input.identity, input.minimumSampleN ?? 30);
  const longScore = directionalScore(input.evidence, 'BULLISH');
  const shortScore = directionalScore(input.evidence, 'BEARISH');
  const reasons: string[] = [];

  if (input.invalidated && input.hasPosition) {
    return { decision: 'EXIT', longScore, shortScore, calibratedProbability: calibration.probability, costAdjustedEvPct: calibration.costAdjustedEvPct, calibrationState: calibration.state, reasons: ['POSITION_INVALIDATED'] };
  }
  if (input.takeProfitReached && input.hasPosition) {
    return { decision: 'TAKE_PROFIT', longScore, shortScore, calibratedProbability: calibration.probability, costAdjustedEvPct: calibration.costAdjustedEvPct, calibrationState: calibration.state, reasons: ['TAKE_PROFIT_LEVEL_REACHED'] };
  }
  if (input.dataQuality === 'STALE' || input.dataQuality === 'PARTIAL' || input.dataQuality === 'UNAVAILABLE') {
    return { decision: input.hasPosition ? 'HOLD' : 'NO_TRADE', longScore, shortScore, calibratedProbability: null, costAdjustedEvPct: null, calibrationState: calibration.state, reasons: ['DATA_QUALITY_FAIL_CLOSED'] };
  }
  if (input.regime === 'INSUFFICIENT_DATA') {
    return { decision: input.hasPosition ? 'HOLD' : 'WAIT', longScore, shortScore, calibratedProbability: null, costAdjustedEvPct: null, calibrationState: calibration.state, reasons: ['REGIME_EVIDENCE_UNAVAILABLE'] };
  }
  if (input.regime === 'LOW_LIQUIDITY') {
    return { decision: input.hasPosition ? 'HOLD' : 'NO_TRADE', longScore, shortScore, calibratedProbability: null, costAdjustedEvPct: null, calibrationState: calibration.state, reasons: ['LOW_LIQUIDITY_FAIL_CLOSED'] };
  }
  if (input.strategyHealth === 'UNKNOWN') {
    return { decision: input.hasPosition ? 'HOLD' : 'WAIT', longScore, shortScore, calibratedProbability: null, costAdjustedEvPct: null, calibrationState: calibration.state, reasons: ['STRATEGY_HEALTH_UNAVAILABLE'] };
  }
  if (input.strategyHealth === 'DISABLED' || input.strategyHealth === 'RESEARCH_ONLY') {
    return { decision: input.hasPosition ? 'HOLD' : 'NO_TRADE', longScore, shortScore, calibratedProbability: calibration.probability, costAdjustedEvPct: calibration.costAdjustedEvPct, calibrationState: calibration.state, reasons: ['STRATEGY_NOT_ACTIVE'] };
  }
  if (input.eventRisk === 'UNKNOWN') {
    return { decision: input.hasPosition ? 'HOLD' : 'WAIT', longScore, shortScore, calibratedProbability: null, costAdjustedEvPct: null, calibrationState: calibration.state, reasons: ['EVENT_RISK_UNAVAILABLE'] };
  }

  const dominantLong = longScore != null && shortScore != null && longScore >= 70 && longScore - shortScore >= 10;
  const dominantShort = longScore != null && shortScore != null && shortScore >= 70 && shortScore - longScore >= 10;

  if (input.hasPosition) {
    if (input.positionSide === 'LONG' && dominantShort) return { decision: 'EXIT', longScore, shortScore, calibratedProbability: calibration.probability, costAdjustedEvPct: calibration.costAdjustedEvPct, calibrationState: calibration.state, reasons: ['STRONG_OPPOSING_EVIDENCE'] };
    if (input.positionSide === 'SHORT' && dominantLong) return { decision: 'EXIT', longScore, shortScore, calibratedProbability: calibration.probability, costAdjustedEvPct: calibration.costAdjustedEvPct, calibrationState: calibration.state, reasons: ['STRONG_OPPOSING_EVIDENCE'] };
    return { decision: 'HOLD', longScore, shortScore, calibratedProbability: calibration.probability, costAdjustedEvPct: calibration.costAdjustedEvPct, calibrationState: calibration.state, reasons: ['POSITION_ACTIVE'] };
  }

  const regimeConflict = regimeEntryConflict(input.regime, dominantLong, dominantShort);
  if (input.eventRisk === 'HIGH') reasons.push('EVENT_RISK_HIGH');
  if (input.higherTimeframeConflict) reasons.push('HIGHER_TIMEFRAME_CONFLICT');
  if (input.strategyHealth === 'DEGRADED') reasons.push('STRATEGY_DEGRADED');
  if (input.dataQuality === 'DELAYED') reasons.push('DATA_DELAYED');
  if (regimeConflict) reasons.push('REGIME_DIRECTION_CONFLICT');
  if (calibration.state === 'MISSING_EVIDENCE') reasons.push('PERFORMANCE_EVIDENCE_UNAVAILABLE');
  if (calibration.state === 'INSUFFICIENT_SAMPLE') reasons.push('INSUFFICIENT_SAMPLE');
  if (calibration.state === 'INVALID_EVIDENCE') reasons.push('INVALID_PERFORMANCE_EVIDENCE');
  if (calibration.state === 'READY' && (calibration.costAdjustedEvPct ?? 0) <= 0) reasons.push('NON_POSITIVE_COST_ADJUSTED_EV');

  const vetoEntry = input.eventRisk === 'HIGH'
    || input.higherTimeframeConflict
    || input.strategyHealth === 'DEGRADED'
    || input.dataQuality === 'DELAYED'
    || regimeConflict
    || calibration.state !== 'READY'
    || (calibration.costAdjustedEvPct ?? 0) <= 0;
  if (vetoEntry) {
    return { decision: dominantLong || dominantShort ? 'WATCH' : 'WAIT', longScore, shortScore, calibratedProbability: calibration.probability, costAdjustedEvPct: calibration.costAdjustedEvPct, calibrationState: calibration.state, reasons };
  }

  if (input.market === 'BITGET') {
    if (dominantLong) return { decision: 'LONG', longScore, shortScore, calibratedProbability: calibration.probability, costAdjustedEvPct: calibration.costAdjustedEvPct, calibrationState: calibration.state, reasons: ['INDEPENDENT_LONG_EVIDENCE'] };
    if (dominantShort) return { decision: 'SHORT', longScore, shortScore, calibratedProbability: calibration.probability, costAdjustedEvPct: calibration.costAdjustedEvPct, calibrationState: calibration.state, reasons: ['INDEPENDENT_SHORT_EVIDENCE'] };
    return { decision: 'WAIT', longScore, shortScore, calibratedProbability: calibration.probability, costAdjustedEvPct: calibration.costAdjustedEvPct, calibrationState: calibration.state, reasons: ['NO_DOMINANT_FUTURES_SIDE'] };
  }

  if (dominantLong) return { decision: 'BUY', longScore, shortScore, calibratedProbability: calibration.probability, costAdjustedEvPct: calibration.costAdjustedEvPct, calibrationState: calibration.state, reasons: ['CASH_MARKET_BUY_EVIDENCE'] };
  return { decision: dominantShort ? 'WATCH' : 'WAIT', longScore, shortScore, calibratedProbability: calibration.probability, costAdjustedEvPct: calibration.costAdjustedEvPct, calibrationState: calibration.state, reasons: [dominantShort ? 'CASH_MARKET_BEARISH_NO_SHORT_ENTRY' : 'NO_DOMINANT_CASH_ENTRY'] };
}
