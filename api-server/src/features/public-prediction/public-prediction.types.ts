export type PredictionMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type PredictionStrategyFamily = 'SCALPING' | 'SWING';
export type PredictionDirection = 'UP' | 'DOWN' | 'SIDEWAYS';
export type ScalpingPredictionHorizon = '5m' | '15m' | '30m' | '1h';
export type SwingPredictionHorizon = '4h' | '1d' | '3d' | '5d';
export type PredictionHorizon = ScalpingPredictionHorizon | SwingPredictionHorizon;
export type PredictionRegime = 'BULL' | 'BEAR' | 'SIDEWAYS' | 'HIGH_VOLATILITY' | 'LOW_VOLATILITY' | 'UNKNOWN';
export type PredictionRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';

export type PredictionModelStatus =
  | 'RESEARCHING'
  | 'REJECTED'
  | 'OOS_VALIDATED'
  | 'WF_VALIDATED'
  | 'HOLDOUT_VALIDATED'
  | 'PREDICTION_CANDIDATE'
  | 'PAPER_PREDICTION_VALIDATED';

export type PredictionBlockCode =
  | 'INSUFFICIENT_DATA'
  | 'UNVERIFIED_MODEL'
  | 'STALE_MARKET_DATA'
  | 'LOW_REGIME_CONFIDENCE'
  | 'FEATURE_LEAKAGE';

export const PUBLIC_PREDICTION_SAFETY = Object.freeze({
  LIVE_ORDER_ALLOWED: false,
  PRIVATE_TRADING_API_ALLOWED: false,
  REAL_ORDER_COUNT: 0,
  REAL_CANCEL_COUNT: 0,
  AUTO_TRADING_ENABLED: false,
} as const);

export interface PredictionMetricSet {
  directionAccuracy: number | null;
  balancedAccuracy: number | null;
  precision: number | null;
  recall: number | null;
  brierScore: number | null;
  calibrationError: number | null;
  expectedReturn: number | null;
  tradingExpectancy: number | null;
  profitFactor: number | null;
  maxDrawdown: number | null;
  sampleSize: number;
}

export interface PredictionStressSummary {
  stable: boolean;
  scenarios: number;
  sensitivity: number | null;
  provenance: string;
}

export interface ConfidencePolicy {
  formulaVersion: string;
  weights: {
    calibration: number;
    oosStability: number;
    walkForwardStability: number;
    regimeAgreement: number;
    dataQuality: number;
    uncertaintyPenalty: number;
    costSensitivityPenalty: number;
  };
}

export interface FrozenPredictionCandidate {
  predictionModelId: string;
  predictionModelVersion: string;
  strategyFamily: PredictionStrategyFamily;
  parameterHash: string;
  featureHash: string;
  datasetDigest: string;
  researchCodeSha: string;
  market: PredictionMarket;
  symbolGroup: string;
  timeframe: string;
  predictionHorizon: PredictionHorizon;
  trainingWindow: { start: string; end: string };
  developmentMetrics: PredictionMetricSet;
  oosMetrics: PredictionMetricSet;
  walkForwardMetrics: PredictionMetricSet;
  holdoutMetrics: PredictionMetricSet;
  costStress: PredictionStressSummary;
  regimeStress: PredictionStressSummary;
  confidencePolicy: ConfidencePolicy;
  minimumDataQuality: number;
  minimumRegimeConfidence: number;
  status: PredictionModelStatus;
}

export interface TimestampedFeature {
  family: 'PRICE_ACTION' | 'TREND' | 'MOMENTUM' | 'VOLATILITY' | 'VOLUME_LIQUIDITY' | 'MARKET_STRUCTURE' | 'REGIME' | 'DERIVATIVES';
  name: string;
  timestamp: string;
  value: number | string | boolean | null;
}

export interface PublicMarketSnapshot {
  observedAt: string;
  stale: boolean;
  dataQuality: number;
  regime: PredictionRegime;
  regimeConfidence: number;
}

export interface PredictionProbabilities {
  UP: number;
  DOWN: number;
  SIDEWAYS: number;
}

export interface PredictionConfidenceInputs {
  calibration: number;
  oosStability: number;
  walkForwardStability: number;
  regimeAgreement: number;
  dataQuality: number;
  uncertainty: number;
  costSensitivity: number;
}

export interface PredictionConfidenceProvenance {
  formulaVersion: string;
  weights: ConfidencePolicy['weights'];
  inputs: PredictionConfidenceInputs;
  normalizedScore: number;
}

export interface CreatePredictionInput {
  predictionId: string;
  timestamp: string;
  symbol: string;
  market: PredictionMarket;
  timeframe: string;
  horizon: PredictionHorizon;
  candidate: FrozenPredictionCandidate;
  marketSnapshot: PublicMarketSnapshot;
  featureCutoffTimestamp: string;
  featuresDigest: string;
  features: TimestampedFeature[];
  probabilities: PredictionProbabilities;
  confidenceInputs: PredictionConfidenceInputs;
  expectedReturn: number;
  expectedRange: { low: number; high: number };
  expectedVolatility: number;
  riskLevel: PredictionRiskLevel;
}

export interface PublicPredictionRecord {
  predictionId: string;
  timestamp: string;
  featureCutoffTimestamp: string;
  symbol: string;
  market: PredictionMarket;
  timeframe: string;
  horizon: PredictionHorizon;
  modelId: string;
  modelVersion: string;
  researchCodeSha: string;
  parameterHash: string;
  featureHash: string;
  datasetDigest: string;
  featuresDigest: string;
  probabilities: PredictionProbabilities;
  confidence: number;
  confidenceProvenance: PredictionConfidenceProvenance;
  regime: PredictionRegime;
  expectedReturn: number;
  expectedRange: { low: number; high: number };
  expectedVolatility: number;
  riskLevel: PredictionRiskLevel;
  safety: typeof PUBLIC_PREDICTION_SAFETY;
}

export interface SimulatedTradingOutcome {
  mode: 'PAPER' | 'SHADOW';
  return: number;
  profitFactorContribution: number | null;
  maxAdverseExcursion: number | null;
  fillModel?: string;
}

export interface PredictionOutcomeEvent {
  outcomeEventId: string;
  predictionId: string;
  observedAt: string;
  actualReturn: number;
  actualDirection: PredictionDirection;
  correct: boolean;
  paperOutcome: SimulatedTradingOutcome | null;
  shadowOutcome: SimulatedTradingOutcome | null;
}

export type PredictionAttempt =
  | { ok: true; prediction: PublicPredictionRecord }
  | { ok: false; code: PredictionBlockCode; reason: string };
