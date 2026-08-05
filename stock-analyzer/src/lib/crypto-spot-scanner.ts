export type CryptoSpotMarket = {
  market: string;
  symbol: string;
  koreanName: string;
  englishName: string;
  warning: boolean;
};

export type CryptoSpotTicker = {
  market: string;
  symbol: string;
  price: number | null;
  change: string;
  changeRate: number | null;
  changePercent: number | null;
  changePrice: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  tradingValue24h: number | null;
  timestamp: number | null;
};

export type CryptoSpotTrend = 'all' | 'gainers' | 'losers' | 'breakout' | 'pullback' | 'surge' | 'plunge';

export type CryptoSpotScannerFilters = {
  query: string;
  minimumTradingValueKrw: number;
  minimumVolume24h: number;
  minimumChangePercent: number;
  maximumChangePercent: number;
  minimumScore: number;
  maximumRiskScore: number;
  trend: CryptoSpotTrend;
  excludeWarnings: boolean;
  excludeStale: boolean;
};

export type CryptoSpotScanRow = CryptoSpotTicker & {
  name: string;
  warning: boolean;
  score: number;
  riskScore: number;
  dataState: 'ok' | 'stale' | 'unavailable';
  rangePosition: number | null;
  chaseRisk: boolean;
  liquidityPass: boolean;
  matched: string[];
  warnings: string[];
};

export const DEFAULT_CRYPTO_SPOT_FILTERS: CryptoSpotScannerFilters = {
  query: '',
  minimumTradingValueKrw: 1_000_000_000,
  minimumVolume24h: 0,
  minimumChangePercent: -100,
  maximumChangePercent: 100,
  minimumScore: 50,
  maximumRiskScore: 50,
  trend: 'all',
  excludeWarnings: true,
  excludeStale: true,
};

function finite(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function ageState(timestamp: number | null, now: number) {
  if (!Number.isFinite(Number(timestamp)) || Number(timestamp) <= 0) return 'unavailable' as const;
  return now - Number(timestamp) > 120_000 ? 'stale' as const : 'ok' as const;
}

function trendMatch(row: CryptoSpotScanRow, trend: CryptoSpotTrend) {
  const change = finite(row.changePercent);
  if (trend === 'gainers') return change > 0;
  if (trend === 'losers') return change < 0;
  if (trend === 'surge') return change >= 10;
  if (trend === 'plunge') return change <= -10;
  if (trend === 'breakout') return row.rangePosition != null && row.rangePosition >= 0.9 && change > 0;
  if (trend === 'pullback') return row.rangePosition != null && row.rangePosition >= 0.45 && row.rangePosition <= 0.75 && change > -5 && change < 8;
  return true;
}

export function scoreCryptoSpotTicker(
  ticker: CryptoSpotTicker,
  market: CryptoSpotMarket | undefined,
  now = Date.now(),
): CryptoSpotScanRow {
  const price = finite(ticker.price, 0);
  const changePercent = finite(ticker.changePercent, 0);
  const tradingValue = Math.max(0, finite(ticker.tradingValue24h, 0));
  const volume = Math.max(0, finite(ticker.volume24h, 0));
  const high = finite(ticker.high24h, 0);
  const low = finite(ticker.low24h, 0);
  const rangePosition = price > 0 && high > low ? clamp((price - low) / (high - low), 0, 1) : null;
  const dataState = ageState(ticker.timestamp, now);
  const warning = market?.warning === true;
  const chaseRisk = changePercent >= 12 || (rangePosition != null && rangePosition >= 0.97 && changePercent >= 7);
  const liquidityPass = tradingValue >= 1_000_000_000;

  const liquidityScore = tradingValue > 0 ? clamp((Math.log10(tradingValue) - 8) * 8, 0, 25) : 0;
  const volumeScore = volume > 0 ? clamp((Math.log10(volume) - 2) * 2.5, 0, 10) : 0;
  const momentumScore = changePercent > 0
    ? clamp(changePercent * 1.5, 0, 18)
    : clamp(changePercent * 0.8, -12, 0);
  const structureScore = rangePosition == null ? 0
    : rangePosition >= 0.9 && changePercent > 0 ? 12
      : rangePosition >= 0.45 && rangePosition <= 0.75 ? 7
        : rangePosition <= 0.15 && changePercent < 0 ? -5 : 2;

  let riskScore = 0;
  const warnings: string[] = [];
  if (dataState === 'stale') { riskScore += 45; warnings.push('시세 지연'); }
  if (dataState === 'unavailable') { riskScore += 70; warnings.push('기준시각 없음'); }
  if (warning) { riskScore += 45; warnings.push('Upbit 유의 종목'); }
  if (!liquidityPass) { riskScore += 25; warnings.push('거래대금 부족'); }
  if (chaseRisk) { riskScore += clamp(20 + Math.max(0, changePercent - 12) * 2, 20, 45); warnings.push('급등 추격 위험'); }
  if (changePercent <= -15) { riskScore += 25; warnings.push('급락 변동성'); }
  riskScore = Math.round(clamp(riskScore, 0, 100));

  const score = Math.round(clamp(
    40 + liquidityScore + volumeScore + momentumScore + structureScore - riskScore * 0.45,
    0,
    100,
  ));
  const matched: string[] = [];
  if (liquidityPass) matched.push('거래대금 충족');
  if (volume > 0) matched.push('거래량 확인');
  if (changePercent >= 10) matched.push('급등');
  else if (changePercent <= -10) matched.push('급락');
  else if (changePercent > 0) matched.push('상승');
  else if (changePercent < 0) matched.push('하락');
  if (rangePosition != null && rangePosition >= 0.9) matched.push('24시간 고가 돌파 근접');
  if (rangePosition != null && rangePosition >= 0.45 && rangePosition <= 0.75) matched.push('상승 후 눌림 구간');

  return {
    ...ticker,
    price: ticker.price,
    name: market?.koreanName || market?.englishName || ticker.symbol,
    warning,
    score,
    riskScore,
    dataState,
    rangePosition,
    chaseRisk,
    liquidityPass,
    matched,
    warnings,
  };
}

export function compareCryptoSpotRows(a: CryptoSpotScanRow, b: CryptoSpotScanRow) {
  return b.score - a.score
    || finite(b.tradingValue24h) - finite(a.tradingValue24h)
    || finite(b.volume24h) - finite(a.volume24h)
    || a.symbol.localeCompare(b.symbol);
}

export function scanCryptoSpotMarket(
  markets: CryptoSpotMarket[],
  tickers: CryptoSpotTicker[],
  filters: CryptoSpotScannerFilters,
  now = Date.now(),
) {
  const marketBySymbol = new Map(markets.map((market) => [market.symbol.toUpperCase(), market]));
  const unique = new Map<string, CryptoSpotTicker>();
  for (const ticker of tickers) {
    const symbol = String(ticker.symbol ?? '').trim().toUpperCase();
    if (!symbol || !String(ticker.market ?? '').startsWith('KRW-')) continue;
    const current = unique.get(symbol);
    if (!current || finite(ticker.timestamp) > finite(current.timestamp)) unique.set(symbol, { ...ticker, symbol });
  }
  const query = filters.query.trim().toLowerCase();
  const rows = [...unique.values()]
    .map((ticker) => scoreCryptoSpotTicker(ticker, marketBySymbol.get(ticker.symbol), now))
    .filter((row) => {
      const change = finite(row.changePercent);
      if (query && !`${row.symbol} ${row.name}`.toLowerCase().includes(query)) return false;
      if (filters.excludeWarnings && row.warning) return false;
      if (filters.excludeStale && row.dataState !== 'ok') return false;
      if (finite(row.tradingValue24h) < filters.minimumTradingValueKrw) return false;
      if (finite(row.volume24h) < filters.minimumVolume24h) return false;
      if (change < filters.minimumChangePercent || change > filters.maximumChangePercent) return false;
      if (row.score < filters.minimumScore || row.riskScore > filters.maximumRiskScore) return false;
      return trendMatch(row, filters.trend);
    })
    .sort(compareCryptoSpotRows);
  return {
    rows,
    scanned: unique.size,
    excludedCount: unique.size - rows.length,
    duplicateCount: tickers.length - unique.size,
    updatedAt: new Date(now).toISOString(),
  };
}
