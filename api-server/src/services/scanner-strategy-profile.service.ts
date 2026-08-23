export type ScannerProfileMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type ScannerProfileHorizon = 'SCALP' | 'SWING' | 'POSITION';
export type ScannerProfileRegime = 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS' | 'HIGH_VOL' | 'LOW_VOL';

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

function freezeProfile(profile: ScannerStrategyProfile): ScannerStrategyProfile {
  Object.freeze(profile.indicators);
  Object.freeze(profile.indicatorWeights);
  Object.freeze(profile.candlePatterns);
  Object.freeze(profile.chartPatterns);
  Object.freeze(profile.confirmationTimeframes);
  Object.freeze(profile.scannerConditions);
  return Object.freeze(profile);
}

const VERSION = 'signal-profile-v1';

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

export function scannerModeToHorizon(mode: 'scalping' | 'swing' | 'position'): ScannerProfileHorizon {
  if (mode === 'scalping') return 'SCALP';
  if (mode === 'swing') return 'SWING';
  return 'POSITION';
}
