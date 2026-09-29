export type ScannerProfileMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type ScannerProfileHorizon = 'SCALP' | 'SWING' | 'POSITION';
export type ScannerProfileRegime = 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS' | 'HIGH_VOL' | 'LOW_VOL';
export type ScannerDirectionPolicy = 'LONG_ONLY' | 'LONG_SHORT';
export type ScannerCalibrationPolicy = 'OOS_CALIBRATION_REQUIRED';

export interface ScannerStrategyProfile {
  readonly id: string;
  readonly version: string;
  readonly market: ScannerProfileMarket;
  readonly horizon: ScannerProfileHorizon;
  readonly primaryTimeframe: string;
  readonly confirmationTimeframes: readonly string[];
  readonly indicators: readonly string[];
  readonly indicatorWeights: Readonly<Record<string, number>>;
  readonly candlePatterns: readonly string[];
  readonly chartPatterns: readonly string[];
  readonly volatilityPolicy: string;
  readonly volumePolicy: string;
  readonly trendPolicy: string;
  readonly marketRegimePolicy: string;
  readonly liquidityPolicy: string;
  readonly riskPolicy: string;
  readonly scannerConditions: readonly string[];
  readonly executionAuthority: 'NONE';
}

export interface ScannerProfileEvidenceContract {
  readonly id: string;
  readonly version: 'scanner-profile-evidence-v1';
  readonly strategyProfileId: string;
  readonly market: ScannerProfileMarket;
  readonly horizon: ScannerProfileHorizon;
  readonly requiredEvidence: readonly string[];
  readonly requiredCostComponents: readonly string[];
  readonly directionPolicy: ScannerDirectionPolicy;
  readonly calibrationPolicy: ScannerCalibrationPolicy;
  readonly executionAuthority: 'NONE';
}

function freezeProfile(profile: ScannerStrategyProfile): ScannerStrategyProfile {
  Object.freeze(profile.indicators);
  Object.freeze(profile.indicatorWeights);
  Object.freeze(profile.candlePatterns);
  Object.freeze(profile.chartPatterns);
  Object.freeze(profile.confirmationTimeframes);
  Object.freeze(profile.scannerConditions);
  return Object.freeze(profile);
}

function freezeEvidenceContract(contract: ScannerProfileEvidenceContract): ScannerProfileEvidenceContract {
  Object.freeze(contract.requiredEvidence);
  Object.freeze(contract.requiredCostComponents);
  return Object.freeze(contract);
}

const VERSION = 'signal-profile-v1';
const EVIDENCE_CONTRACT_VERSION = 'scanner-profile-evidence-v1' as const;
const CALIBRATION_POLICY: ScannerCalibrationPolicy = 'OOS_CALIBRATION_REQUIRED';

const BASE = {
  SCALP: {
    indicators: ['EMA12', 'EMA26', 'VWAP', 'RSI14', 'MACD', 'ATR14', 'REL_VOLUME_20'],
    indicatorWeights: { trend: 18, momentum: 20, volume: 18, liquidity: 16, volatility: 12, regime: 10, risk: 6 },
    candlePatterns: ['momentum_breakout', 'rejection'],
    chartPatterns: ['range_breakout', 'pullback'],
    volatilityPolicy: 'ATR-normalized intraday expansion with extreme-volatility guard',
    volumePolicy: 'relative-volume and trading-value confirmation',
    trendPolicy: 'fast EMA/VWAP alignment with higher-timeframe confirmation',
    marketRegimePolicy: 'prefer aligned trend; permit mean reversion only in bounded sideways regime',
    liquidityPolicy: 'strict spread and trading-value filter',
    riskPolicy: 'tight risk budget; Risk Engine remains authoritative',
    scannerConditions: ['trend_alignment', 'volume_spike', 'breakout', 'pullback'],
  },
  SWING: {
    indicators: ['EMA20', 'EMA60', 'SMA60', 'RSI14', 'MACD', 'ADX14', 'ATR14', 'REL_VOLUME_20'],
    indicatorWeights: { trend: 25, momentum: 16, volume: 12, liquidity: 8, volatility: 10, regime: 19, risk: 10 },
    candlePatterns: ['breakout_confirmation', 'pullback_reversal'],
    chartPatterns: ['trend_continuation', 'support_resistance_break'],
    volatilityPolicy: 'ATR-normalized swing range with volatility-regime guard',
    volumePolicy: 'breakout/pullback volume confirmation',
    trendPolicy: 'multi-timeframe medium-trend alignment',
    marketRegimePolicy: 'trend/regime agreement required for strong signals',
    liquidityPolicy: 'minimum tradability and spread quality',
    riskPolicy: 'moderate risk budget; Risk Engine remains authoritative',
    scannerConditions: ['trend_alignment', 'volume_spike', 'breakout', 'pullback'],
  },
  POSITION: {
    indicators: ['EMA20', 'EMA60', 'SMA60', 'SMA120', 'RSI14', 'MACD', 'ADX14', 'ATR14', 'OBV'],
    indicatorWeights: { trend: 31, momentum: 11, volume: 9, liquidity: 6, volatility: 8, regime: 23, risk: 12 },
    candlePatterns: ['weekly_structure_confirmation', 'long_horizon_reversal'],
    chartPatterns: ['major_trend', 'base_breakout', 'support_resistance_structure'],
    volatilityPolicy: 'long-horizon ATR regime; reject unstable volatility transitions',
    volumePolicy: 'sustained accumulation/distribution confirmation',
    trendPolicy: 'slow-trend and structure alignment across multiple timeframes',
    marketRegimePolicy: 'regime stability is required; sideways signals are down-weighted',
    liquidityPolicy: 'minimum durable liquidity filter',
    riskPolicy: 'position risk budget; Risk Engine remains authoritative',
    scannerConditions: ['trend_alignment', 'breakout', 'pullback'],
  },
} as const;

const TIMEFRAMES: Record<ScannerProfileMarket, Record<ScannerProfileHorizon, { primary: string; confirm: readonly string[] }>> = {
  KR_STOCK: {
    SCALP: { primary: '5m', confirm: ['15m', '60m'] },
    SWING: { primary: '60m', confirm: ['4H', '1D'] },
    POSITION: { primary: '1D', confirm: ['4H', '1D'] },
  },
  US_STOCK: {
    SCALP: { primary: '5m', confirm: ['15m', '60m'] },
    SWING: { primary: '60m', confirm: ['4H', '1D'] },
    POSITION: { primary: '1D', confirm: ['4H', '1D'] },
  },
  CRYPTO_SPOT: {
    SCALP: { primary: '15m', confirm: ['60m'] },
    SWING: { primary: '4H', confirm: ['60m', '1D'] },
    POSITION: { primary: '4H', confirm: ['1D'] },
  },
  CRYPTO_FUTURES: {
    SCALP: { primary: '5m', confirm: ['15m', '60m'] },
    SWING: { primary: '60m', confirm: ['4H'] },
    POSITION: { primary: '4H', confirm: ['1D'] },
  },
};

function marketOverrides(market: ScannerProfileMarket, horizon: ScannerProfileHorizon): Partial<ScannerStrategyProfile> {
  if (market === 'KR_STOCK') {
    return {
      liquidityPolicy: horizon === 'SCALP' ? 'KR trading-value and spread gate with session liquidity awareness' : 'KR trading-value and tradability gate',
      scannerConditions: horizon === 'SCALP'
        ? ['volume_spike', 'transaction_value', 'ma_breakout', 'rsi', 'macd']
        : ['ma_breakout', 'volume_spike', 'ai_score'],
    };
  }
  if (market === 'US_STOCK') {
    return {
      liquidityPolicy: horizon === 'SCALP' ? 'US spread, dollar-volume and session liquidity gate' : 'US dollar-volume and tradability gate',
      scannerConditions: horizon === 'SCALP'
        ? ['volume_spike', 'transaction_value', 'ma_breakout', 'rsi', 'macd']
        : ['ma_breakout', 'volume_spike', 'ai_score'],
    };
  }
  if (market === 'CRYPTO_FUTURES') {
    return {
      riskPolicy: 'futures leverage-aware risk budget; liquidation and Risk Engine guards remain authoritative',
      scannerConditions: horizon === 'SCALP'
        ? ['trend_alignment', 'volume_spike', 'breakout', 'pullback', 'williams_atr']
        : ['trend_alignment', 'volume_spike', 'breakout', 'pullback'],
    };
  }
  return {
    riskPolicy: 'spot no-leverage risk budget; Risk Engine remains authoritative',
    scannerConditions: horizon === 'SCALP'
      ? ['trend_alignment', 'volume_spike', 'breakout', 'pullback', 'williams_atr']
      : ['trend_alignment', 'volume_spike', 'breakout', 'pullback'],
  };
}

function buildProfile(market: ScannerProfileMarket, horizon: ScannerProfileHorizon): ScannerStrategyProfile {
  const tf = TIMEFRAMES[market][horizon];
  const base = BASE[horizon];
  const override = marketOverrides(market, horizon);
  return freezeProfile({
    id: `${market}_${horizon}_V1`,
    version: VERSION,
    market,
    horizon,
    primaryTimeframe: tf.primary,
    confirmationTimeframes: [...tf.confirm],
    indicators: [...base.indicators],
    indicatorWeights: { ...base.indicatorWeights },
    candlePatterns: [...base.candlePatterns],
    chartPatterns: [...base.chartPatterns],
    volatilityPolicy: base.volatilityPolicy,
    volumePolicy: base.volumePolicy,
    trendPolicy: base.trendPolicy,
    marketRegimePolicy: base.marketRegimePolicy,
    liquidityPolicy: override.liquidityPolicy ?? base.liquidityPolicy,
    riskPolicy: override.riskPolicy ?? base.riskPolicy,
    scannerConditions: override.scannerConditions ? [...override.scannerConditions] : [...base.scannerConditions],
    executionAuthority: 'NONE',
  });
}

const MARKETS: readonly ScannerProfileMarket[] = ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'];
const HORIZONS: readonly ScannerProfileHorizon[] = ['SCALP', 'SWING', 'POSITION'];
const PROFILES = new Map<string, ScannerStrategyProfile>();
for (const market of MARKETS) {
  for (const horizon of HORIZONS) {
    const profile = buildProfile(market, horizon);
    PROFILES.set(`${market}:${horizon}`, profile);
  }
}

export function getScannerStrategyProfile(market: ScannerProfileMarket, horizon: ScannerProfileHorizon): ScannerStrategyProfile {
  const profile = PROFILES.get(`${market}:${horizon}`);
  if (!profile) throw new Error(`Unknown scanner strategy profile: ${market}/${horizon}`);
  return profile;
}

export function listScannerStrategyProfiles(): readonly ScannerStrategyProfile[] {
  return Object.freeze([...PROFILES.values()]);
}

function requiredEvidenceFor(market: ScannerProfileMarket, horizon: ScannerProfileHorizon): string[] {
  const weekly = horizon === 'POSITION' ? ['weekly_candles'] : [];
  if (market === 'KR_STOCK' || market === 'US_STOCK') {
    return ['candles', 'quote', 'freshness', 'liquidity', 'session', 'listing_status', ...weekly];
  }
  if (market === 'CRYPTO_FUTURES') {
    return [
      'candles',
      'mark_price',
      'index_price',
      'freshness',
      'liquidity',
      'funding_rate',
      'open_interest',
      'basis',
      'liquidation_risk',
      ...weekly,
    ];
  }
  return ['candles', 'quote', 'freshness', 'liquidity', 'spot_market_status', ...weekly];
}

function requiredCostsFor(market: ScannerProfileMarket): string[] {
  const executionCosts = ['commission', 'spread', 'slippage', 'latency', 'liquidity_impact', 'partial_fill_impact'];
  if (market === 'KR_STOCK' || market === 'US_STOCK') return [...executionCosts, 'tax'];
  if (market === 'CRYPTO_FUTURES') return [...executionCosts, 'funding'];
  return executionCosts;
}

function buildEvidenceContract(
  market: ScannerProfileMarket,
  horizon: ScannerProfileHorizon,
): ScannerProfileEvidenceContract {
  const strategyProfile = getScannerStrategyProfile(market, horizon);
  return freezeEvidenceContract({
    id: `${market}_${horizon}_EVIDENCE_V1`,
    version: EVIDENCE_CONTRACT_VERSION,
    strategyProfileId: strategyProfile.id,
    market,
    horizon,
    requiredEvidence: requiredEvidenceFor(market, horizon),
    requiredCostComponents: requiredCostsFor(market),
    directionPolicy: market === 'CRYPTO_FUTURES' ? 'LONG_SHORT' : 'LONG_ONLY',
    calibrationPolicy: CALIBRATION_POLICY,
    executionAuthority: 'NONE',
  });
}

const EVIDENCE_CONTRACTS = new Map<string, ScannerProfileEvidenceContract>();
for (const market of MARKETS) {
  for (const horizon of HORIZONS) {
    EVIDENCE_CONTRACTS.set(`${market}:${horizon}`, buildEvidenceContract(market, horizon));
  }
}

export function getScannerProfileEvidenceContract(
  market: ScannerProfileMarket,
  horizon: ScannerProfileHorizon,
): ScannerProfileEvidenceContract {
  const contract = EVIDENCE_CONTRACTS.get(`${market}:${horizon}`);
  if (!contract) throw new Error(`Unknown scanner profile evidence contract: ${market}/${horizon}`);
  return contract;
}

export function listScannerProfileEvidenceContracts(): readonly ScannerProfileEvidenceContract[] {
  return Object.freeze([...EVIDENCE_CONTRACTS.values()]);
}

export function scannerModeToHorizon(mode: 'scalping' | 'swing' | 'position'): ScannerProfileHorizon {
  if (mode === 'scalping') return 'SCALP';
  if (mode === 'swing') return 'SWING';
  return 'POSITION';
}

export type ScannerProfileEvidenceStatus = 'READY' | 'MISSING' | 'STALE' | 'BLOCKED_DATA' | 'NOT_READY' | 'INVALID';
export type ScannerProfileValidationDirection = 'LONG' | 'SHORT' | null;
export type ScannerProfileCalibrationSplit = 'OOS' | 'TRAIN' | 'VALIDATION' | 'HELD_OUT' | null;

export interface ScannerProfileEvidenceObservation {
  readonly status: ScannerProfileEvidenceStatus;
  readonly provenance: string | null;
}

export interface ScannerProfileCostEvidence extends ScannerProfileEvidenceObservation {
  readonly value: number | null;
  readonly measured: boolean;
}

export interface ScannerProfileCalibrationEvidence {
  readonly status: ScannerProfileEvidenceStatus;
  readonly split: ScannerProfileCalibrationSplit;
  readonly heldOut: boolean;
  readonly provenance: string | null;
  readonly strategyProfileId: string | null;
  readonly strategyVersion: string | null;
  readonly market: ScannerProfileMarket | null;
  readonly horizon: ScannerProfileHorizon | null;
}

export interface ScannerProfileEvidenceValidationInput {
  readonly market: ScannerProfileMarket;
  readonly horizon: ScannerProfileHorizon;
  readonly strategyProfileId: string | null;
  readonly strategyVersion: string | null;
  readonly direction: ScannerProfileValidationDirection;
  readonly evidence: Readonly<Record<string, ScannerProfileEvidenceObservation | null | undefined>>;
  readonly costs: Readonly<Record<string, ScannerProfileCostEvidence | null | undefined>>;
  readonly calibration: ScannerProfileCalibrationEvidence | null;
}

export interface ScannerProfileEvidenceValidationResult {
  readonly status: 'READY' | 'NOT_READY';
  readonly ready: boolean;
  readonly reasons: readonly string[];
  readonly contractId: string;
  readonly strategyProfileId: string;
  readonly executionAuthority: 'NONE';
}

function hasProvenance(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function evidenceReady(value: ScannerProfileEvidenceObservation | null | undefined): boolean {
  return value?.status === 'READY' && hasProvenance(value.provenance);
}

function uniqueReasons(reasons: string[]): readonly string[] {
  return Object.freeze([...new Set(reasons)]);
}

export function validateScannerProfileEvidence(
  input: ScannerProfileEvidenceValidationInput,
): ScannerProfileEvidenceValidationResult {
  const profile = getScannerStrategyProfile(input.market, input.horizon);
  const contract = getScannerProfileEvidenceContract(input.market, input.horizon);
  const reasons: string[] = [];

  if (input.strategyProfileId !== profile.id) reasons.push('STRATEGY_PROFILE_ID_MISMATCH');
  if (input.strategyVersion !== profile.version) reasons.push('STRATEGY_PROFILE_VERSION_MISMATCH');
  if (contract.strategyProfileId !== profile.id) reasons.push('EVIDENCE_CONTRACT_PROFILE_MISMATCH');

  if (input.direction == null) {
    reasons.push('DIRECTION_MISSING');
  } else if (contract.directionPolicy === 'LONG_ONLY' && input.direction !== 'LONG') {
    reasons.push('DIRECTION_NOT_ALLOWED');
  }

  for (const key of contract.requiredEvidence) {
    const value = input.evidence[key];
    if (!evidenceReady(value)) reasons.push(`EVIDENCE_NOT_READY:${key}`);
  }

  const calibration = input.calibration;
  if (!calibration || calibration.status !== 'READY') {
    reasons.push('OOS_CALIBRATION_NOT_READY');
  } else {
    if (calibration.split !== 'OOS' || calibration.heldOut !== true) {
      reasons.push('OOS_HELD_OUT_EVIDENCE_REQUIRED');
    }
    if (!hasProvenance(calibration.provenance)) reasons.push('OOS_CALIBRATION_PROVENANCE_MISSING');
    if (calibration.strategyProfileId !== profile.id) reasons.push('OOS_STRATEGY_PROFILE_ID_MISMATCH');
    if (calibration.strategyVersion !== profile.version) reasons.push('OOS_STRATEGY_VERSION_MISMATCH');
    if (calibration.market !== profile.market) reasons.push('OOS_MARKET_MISMATCH');
    if (calibration.horizon !== profile.horizon) reasons.push('OOS_HORIZON_MISMATCH');
  }

  for (const key of contract.requiredCostComponents) {
    const value = input.costs[key];
    if (!evidenceReady(value)) {
      reasons.push(`COST_NOT_READY:${key}`);
      continue;
    }
    if (value?.value == null || !Number.isFinite(value.value) || value.value < 0) {
      reasons.push(`COST_VALUE_INVALID:${key}`);
      continue;
    }
    if (value.value === 0 && value.measured !== true) {
      reasons.push(`COST_ZERO_REQUIRES_MEASUREMENT:${key}`);
    }
  }

  const unique = uniqueReasons(reasons);
  return Object.freeze({
    status: unique.length === 0 ? 'READY' : 'NOT_READY',
    ready: unique.length === 0,
    reasons: unique,
    contractId: contract.id,
    strategyProfileId: profile.id,
    executionAuthority: 'NONE',
  });
}
