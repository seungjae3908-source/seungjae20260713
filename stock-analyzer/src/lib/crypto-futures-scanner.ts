export type CryptoFuturesTicker = {
  symbol: string;
  price: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  changeRate24h: number | null;
  changePercent24h: number | null;
  changePercent: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  tradingValue24h: number | null;
  fundingRate: number | null;
  fundingRatePercent: number | null;
  openInterest: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  timestamp: number | null;
};

export type CryptoFuturesCandle = {
  time: number | string | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  quoteVolume?: number | null;
};

export type FuturesDirectionFilter = 'ALL' | 'LONG' | 'SHORT' | 'WAIT';
export type FuturesTechnicalFilter = 'all' | 'volume' | 'breakout' | 'pullback' | 'rsiOversold' | 'rsiOverbought' | 'trend';

export type CryptoFuturesFilters = {
  query: string;
  minimumTradingValueUsdt: number;
  minimumVolume24h: number;
  minimumOpenInterest: number;
  minimumChangePercent: number;
  maximumChangePercent: number;
  minimumScore: number;
  maximumRiskScore: number;
  direction: FuturesDirectionFilter;
  technical: FuturesTechnicalFilter;
  excludeStale: boolean;
  excludeChaseRisk: boolean;
};

export type CryptoFuturesScanRow = CryptoFuturesTicker & {
  direction: 'LONG' | 'SHORT' | 'WAIT';
  score: number;
  longScore: number;
  shortScore: number;
  riskScore: number;
  dataState: 'ok' | 'stale' | 'unavailable';
  chaseRisk: boolean;
  spreadPercent: number | null;
  rsi: number | null;
  ma5: number | null;
  ma20: number | null;
  volumeRatio: number | null;
  breakout: boolean;
  pullback: boolean;
  matched: string[];
  warnings: string[];
};

export const DEFAULT_CRYPTO_FUTURES_FILTERS: CryptoFuturesFilters = {
  query: '',
  minimumTradingValueUsdt: 5_000_000,
  minimumVolume24h: 0,
  minimumOpenInterest: 0,
  minimumChangePercent: -100,
  maximumChangePercent: 100,
  minimumScore: 65,
  maximumRiskScore: 55,
  direction: 'ALL',
  technical: 'all',
  excludeStale: true,
  excludeChaseRisk: true,
};

function finite(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sma(values: number[], period: number) {
  return values.length >= period ? average(values.slice(-period)) : null;
}

function rsi(values: number[], period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  if (losses === 0) return 100;
  const relative = gains / losses;
  return 100 - 100 / (1 + relative);
}

function normalizeCandles(rows: CryptoFuturesCandle[]) {
  return rows
    .map((row) => ({
      time: finiteOrNull(row.time),
      open: finiteOrNull(row.open),
      high: finiteOrNull(row.high),
      low: finiteOrNull(row.low),
      close: finiteOrNull(row.close),
      volume: finiteOrNull(row.volume),
    }))
    .filter((row): row is { time: number; open: number; high: number; low: number; close: number; volume: number } =>
      row.time != null && row.open != null && row.high != null && row.low != null && row.close != null && row.volume != null)
    .sort((a, b) => a.time - b.time)
    .filter((row, index, source) => index === 0 || row.time !== source[index - 1].time);
}

function ageState(timestamp: number | null, now: number) {
  if (!Number.isFinite(Number(timestamp)) || Number(timestamp) <= 0) return 'unavailable' as const;
  return now - Number(timestamp) > 120_000 ? 'stale' as const : 'ok' as const;
}

function technicalMatches(row: CryptoFuturesScanRow, filter: FuturesTechnicalFilter) {
  if (filter === 'volume') return row.volumeRatio != null && row.volumeRatio >= 1.5;
  if (filter === 'breakout') return row.breakout;
  if (filter === 'pullback') return row.pullback;
  if (filter === 'rsiOversold') return row.rsi != null && row.rsi <= 35;
  if (filter === 'rsiOverbought') return row.rsi != null && row.rsi >= 65;
  if (filter === 'trend') return row.ma5 != null && row.ma20 != null && Math.abs(row.ma5 - row.ma20) / Math.max(row.ma20, 1) >= 0.005;
  return true;
}

export function scoreCryptoFuturesTicker(
  ticker: CryptoFuturesTicker,
  candlesInput: CryptoFuturesCandle[] = [],
  now = Date.now(),
): CryptoFuturesScanRow {
  const candles = normalizeCandles(candlesInput);
  const closes = candles.map((row) => row.close);
  const last = candles.at(-1);
  const change = finite(ticker.changePercent24h ?? ticker.changePercent, 0);
  const tradingValue = Math.max(0, finite(ticker.tradingValue24h, 0));
  const volume = Math.max(0, finite(ticker.volume24h, 0));
  const openInterest = Math.max(0, finite(ticker.openInterest, 0));
  const funding = finite(ticker.fundingRatePercent, finite(ticker.fundingRate, 0) * 100);
  const markPrice = finite(ticker.markPrice ?? ticker.price, 0);
  const bid = finite(ticker.bidPrice, 0);
  const ask = finite(ticker.askPrice, 0);
  const midpoint = bid > 0 && ask >= bid ? (bid + ask) / 2 : 0;
  const spreadPercent = midpoint > 0 ? (ask - bid) / midpoint * 100 : null;
  const dataState = ageState(ticker.timestamp, now);
  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const currentRsi = rsi(closes);
  const recentVolumes = candles.slice(-21, -1).map((row) => row.volume).filter((value) => value > 0);
  const averageVolume = average(recentVolumes);
  const volumeRatio = last && averageVolume && averageVolume > 0 ? last.volume / averageVolume : null;
  const prior = candles.slice(-21, -1);
  const priorHigh = prior.length ? Math.max(...prior.map((row) => row.high)) : null;
  const breakout = Boolean(last && priorHigh != null && last.close > priorHigh && (volumeRatio ?? 0) >= 1.2);
  const pullback = Boolean(last && ma20 != null && ma5 != null && ma5 > ma20 && Math.abs(last.close - ma20) / Math.max(ma20, 1) <= 0.02);
  const chaseRisk = Math.abs(change) >= 12 || (currentRsi != null && currentRsi >= 78);

  let longScore = 45;
  let shortScore = 45;
  longScore += clamp(change * 1.8, -20, 22);
  shortScore += clamp(-change * 1.8, -20, 22);
  if (ma5 != null && ma20 != null) {
    if (ma5 > ma20) longScore += 12;
    else if (ma5 < ma20) shortScore += 12;
  }
  if (currentRsi != null) {
    if (currentRsi <= 35) longScore += 8;
    if (currentRsi >= 65) shortScore += 8;
  }
  if (volumeRatio != null && volumeRatio >= 1.5) {
    if (change >= 0) longScore += 8;
    else shortScore += 8;
  }
  if (breakout) longScore += 12;
  if (pullback) longScore += 8;
  if (funding >= 0.08) shortScore += 6;
  if (funding <= -0.08) longScore += 6;
  const liquidityBonus = tradingValue > 0 ? clamp((Math.log10(tradingValue) - 5) * 5, 0, 15) : 0;
  longScore += liquidityBonus;
  shortScore += liquidityBonus;

  let riskScore = 0;
  const warnings: string[] = [];
  if (dataState === 'stale') { riskScore += 45; warnings.push('시세 지연'); }
  if (dataState === 'unavailable') { riskScore += 70; warnings.push('기준시각 없음'); }
  if (tradingValue < 5_000_000) { riskScore += 25; warnings.push('거래대금 부족'); }
  if (spreadPercent == null) { riskScore += 15; warnings.push('호가 스프레드 없음'); }
  else if (spreadPercent >= 0.3) { riskScore += 25; warnings.push('호가 스프레드 큼'); }
  if (chaseRisk) { riskScore += 30; warnings.push('급변 추격 위험'); }
  if (Math.abs(funding) >= 0.2) { riskScore += 20; warnings.push('펀딩 과열'); }
  if (!candles.length) { riskScore += 20; warnings.push('기술 캔들 부족'); }
  riskScore = Math.round(clamp(riskScore, 0, 100));
  longScore = Math.round(clamp(longScore - riskScore * 0.25, 0, 100));
  shortScore = Math.round(clamp(shortScore - riskScore * 0.25, 0, 100));
  const difference = longScore - shortScore;
  const direction = longScore >= 65 && difference >= 10 ? 'LONG'
    : shortScore >= 65 && difference <= -10 ? 'SHORT' : 'WAIT';
  const score = Math.max(longScore, shortScore);
  const matched: string[] = [];
  if (ma5 != null && ma20 != null) matched.push(ma5 > ma20 ? '상승 추세' : ma5 < ma20 ? '하락 추세' : '추세 중립');
  if (volumeRatio != null && volumeRatio >= 1.5) matched.push('거래량 증가');
  if (breakout) matched.push('거래량 동반 돌파');
  if (pullback) matched.push('상승 추세 눌림');
  if (currentRsi != null && currentRsi <= 35) matched.push('RSI 과매도');
  if (currentRsi != null && currentRsi >= 65) matched.push('RSI 과열');
  if (funding >= 0.08) matched.push('양(+) 펀딩 과열');
  if (funding <= -0.08) matched.push('음(-) 펀딩 과열');

  return {
    ...ticker,
    direction,
    score,
    longScore,
    shortScore,
    riskScore,
    dataState,
    chaseRisk,
    spreadPercent,
    rsi: currentRsi,
    ma5,
    ma20,
    volumeRatio,
    breakout,
    pullback,
    matched,
    warnings,
    markPrice: ticker.markPrice ?? ticker.price ?? markPrice,
  };
}

export function compareCryptoFuturesRows(a: CryptoFuturesScanRow, b: CryptoFuturesScanRow) {
  return b.score - a.score
    || finite(b.tradingValue24h) - finite(a.tradingValue24h)
    || finite(b.openInterest) - finite(a.openInterest)
    || a.symbol.localeCompare(b.symbol);
}

export function scanCryptoFuturesMarket(
  tickers: CryptoFuturesTicker[],
  candlesBySymbol: ReadonlyMap<string, CryptoFuturesCandle[]>,
  filters: CryptoFuturesFilters,
  now = Date.now(),
) {
  const unique = new Map<string, CryptoFuturesTicker>();
  for (const ticker of tickers) {
    const symbol = String(ticker.symbol ?? '').trim().toUpperCase();
    if (!symbol) continue;
    const current = unique.get(symbol);
    if (!current || finite(ticker.timestamp) > finite(current.timestamp)) unique.set(symbol, { ...ticker, symbol });
  }
  const query = filters.query.trim().toLowerCase();
  const rows = [...unique.values()]
    .map((ticker) => scoreCryptoFuturesTicker(ticker, candlesBySymbol.get(ticker.symbol) ?? [], now))
    .filter((row) => {
      const change = finite(row.changePercent24h ?? row.changePercent);
      if (query && !row.symbol.toLowerCase().includes(query)) return false;
      if (filters.excludeStale && row.dataState !== 'ok') return false;
      if (filters.excludeChaseRisk && row.chaseRisk) return false;
      if (finite(row.tradingValue24h) < filters.minimumTradingValueUsdt) return false;
      if (finite(row.volume24h) < filters.minimumVolume24h) return false;
      if (finite(row.openInterest) < filters.minimumOpenInterest) return false;
      if (change < filters.minimumChangePercent || change > filters.maximumChangePercent) return false;
      if (row.score < filters.minimumScore || row.riskScore > filters.maximumRiskScore) return false;
      if (filters.direction !== 'ALL' && row.direction !== filters.direction) return false;
      return technicalMatches(row, filters.technical);
    })
    .sort(compareCryptoFuturesRows);
  return {
    rows,
    scanned: unique.size,
    excludedCount: unique.size - rows.length,
    duplicateCount: tickers.length - unique.size,
    updatedAt: new Date(now).toISOString(),
  };
}
