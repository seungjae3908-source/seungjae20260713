import type { ScannerTimeframe } from '@/lib/signal-scanner';
import type { FrontendScannerMarket } from '@/lib/signal-scanner-url';

export type UnifiedScannerStrategyMode = 'scalping' | 'swing' | 'position';

export interface ScannerUiProfile {
  market: FrontendScannerMarket;
  strategyMode: UnifiedScannerStrategyMode;
  timeframe: ScannerTimeframe;
  conditions: readonly string[];
  indicators: readonly string[];
  profileVersion: string;
}

const VERSION = 'signal-profile-v1';

const PROFILE_MAP: Record<FrontendScannerMarket, Record<UnifiedScannerStrategyMode, Omit<ScannerUiProfile, 'market' | 'strategyMode'>>> = {
  KR_STOCK: {
    scalping: { timeframe: '5m', conditions: ['volume_spike', 'transaction_value', 'ma_breakout', 'rsi', 'macd'], indicators: ['EMA12', 'EMA26', 'VWAP', 'RSI14', 'MACD', 'ATR14'], profileVersion: VERSION },
    swing: { timeframe: '4H', conditions: ['ma_breakout', 'volume_spike', 'ai_score'], indicators: ['EMA20', 'EMA60', 'RSI14', 'MACD', 'ADX14', 'ATR14'], profileVersion: VERSION },
    position: { timeframe: '1D', conditions: ['ma_breakout', 'volume_spike', 'ai_score'], indicators: ['EMA20', 'EMA60', 'SMA120', 'ADX14', 'ATR14', 'OBV'], profileVersion: VERSION },
  },
  US_STOCK: {
    scalping: { timeframe: '5m', conditions: ['volume_spike', 'transaction_value', 'ma_breakout', 'rsi', 'macd'], indicators: ['EMA12', 'EMA26', 'VWAP', 'RSI14', 'MACD', 'ATR14'], profileVersion: VERSION },
    swing: { timeframe: '4H', conditions: ['ma_breakout', 'volume_spike', 'ai_score'], indicators: ['EMA20', 'EMA60', 'RSI14', 'MACD', 'ADX14', 'ATR14'], profileVersion: VERSION },
    position: { timeframe: '1D', conditions: ['ma_breakout', 'volume_spike', 'ai_score'], indicators: ['EMA20', 'EMA60', 'SMA120', 'ADX14', 'ATR14', 'OBV'], profileVersion: VERSION },
  },
  CRYPTO_SPOT: {
    scalping: { timeframe: '5m', conditions: ['trend_alignment', 'volume_spike', 'breakout', 'pullback', 'williams_atr'], indicators: ['EMA12', 'EMA26', 'VWAP', 'RSI14', 'MACD', 'ATR14'], profileVersion: VERSION },
    swing: { timeframe: '4H', conditions: ['trend_alignment', 'volume_spike', 'breakout', 'pullback'], indicators: ['EMA20', 'EMA60', 'RSI14', 'MACD', 'ADX14', 'ATR14'], profileVersion: VERSION },
    position: { timeframe: '1D', conditions: ['trend_alignment', 'breakout', 'pullback'], indicators: ['EMA20', 'EMA60', 'SMA120', 'ADX14', 'ATR14', 'OBV'], profileVersion: VERSION },
  },
  CRYPTO_FUTURES: {
    scalping: { timeframe: '5m', conditions: ['trend_alignment', 'volume_spike', 'breakout', 'pullback', 'williams_atr'], indicators: ['EMA12', 'EMA26', 'VWAP', 'RSI14', 'MACD', 'ATR14'], profileVersion: VERSION },
    swing: { timeframe: '4H', conditions: ['trend_alignment', 'volume_spike', 'breakout', 'pullback'], indicators: ['EMA20', 'EMA60', 'RSI14', 'MACD', 'ADX14', 'ATR14'], profileVersion: VERSION },
    position: { timeframe: '1D', conditions: ['trend_alignment', 'breakout', 'pullback'], indicators: ['EMA20', 'EMA60', 'SMA120', 'ADX14', 'ATR14', 'OBV'], profileVersion: VERSION },
  },
};

export function getScannerUiProfile(market: FrontendScannerMarket, strategyMode: UnifiedScannerStrategyMode): ScannerUiProfile {
  const profile = PROFILE_MAP[market][strategyMode];
  return {
    market,
    strategyMode,
    timeframe: profile.timeframe,
    conditions: [...profile.conditions],
    indicators: [...profile.indicators],
    profileVersion: profile.profileVersion,
  };
}

export const SCANNER_STRATEGY_OPTIONS: readonly { value: UnifiedScannerStrategyMode; label: string; description: string }[] = Object.freeze([
  { value: 'scalping', label: '단타', description: '짧은 구간의 모멘텀·돌파·되돌림을 자동 조합합니다.' },
  { value: 'swing', label: '스윙', description: '수 시간~수일 추세를 다중 시간봉으로 확인합니다.' },
  { value: 'position', label: '중장기', description: '수일~수주 구조·추세·시장 국면을 중심으로 평가합니다.' },
]);