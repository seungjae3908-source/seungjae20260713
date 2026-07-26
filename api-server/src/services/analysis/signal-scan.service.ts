// GET /api/market/signal-scan 백엔드 서비스.
// 실제 캔들/시세 기반으로 매수·매도(또는 롱·숏·관점) 후보를 산출한다.
// 가짜 데이터 금지: 캔들 부족 종목은 제외한다.

import { cached } from '../../lib/cache';
import { CATALOG } from '../../data/catalog';
import { MarketDataService } from '../market-data.service';
import {
  toBars,
  avg,
  rsi,
  macd,
  supportResistance,
  trendState,
  volumeState,
  last,
  lastNonNull,
  pctChange,
  type Bar,
} from './candle-math';
import {
  fetchUpbitTopTickers,
  fetchUpbitCandles,
  fetchBitgetTopTickers,
  fetchBitgetCandles,
} from './crypto-source';

const STOCK_SCAN_TTL = 5 * 60 * 1000;
const COIN_SCAN_TTL = 2 * 60 * 1000;
const MIN_BARS = 60;
const STOCK_MIN_SCORE = 72;
const FUTURES_MIN_SCORE = 74;
const GROUP_LIMIT = 10;
const STOCK_POOL = 80;
const COIN_SPOT_POOL = 40;
const COIN_FUTURES_POOL = 40;

export interface ScanCandidate {
  ticker: string;
  name: string;
  price: number;
  changePercent: number | null;
  currency: string;
  market: string;
  direction: 'long' | 'short' | 'buy' | 'sell';
  score: number;
  verdict: string;
  basis: string[];
  support: number | null;
  resistance: number | null;
  volumeState: string;
  trendState: string;
  risks: string[];
  invalidation: string[];
  dataAsOf: string;
  timeframe?: '15m' | '1D';
}

export interface ScanGroup {
  key: string;
  label: string;
  candidates: ScanCandidate[];
}

export interface SignalScanResult {
  ok: boolean;
  asset: string;
  market: string;
  generatedAt: string;
  scanned: number;
  providerErrors: number;
  groups: ScanGroup[];
}

interface Analyzed {
  bars: Bar[];
  closes: number[];
  latest: number;
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  rsiValue: number | null;
  macdCrossUp: boolean;
  macdCrossDown: boolean;
  trend: string;
  vol: string;
  volRatio: number | null;
  support: number | null;
  resistance: number | null;
  recentMove: number;
  atrPercent: number | null;
  longRiskReward: number | null;
  shortRiskReward: number | null;
  bullScore: number;
  bearScore: number;
}

function analyze(bars: Bar[]): Analyzed | null {
  if (bars.length < MIN_BARS) return null;
  const closes = bars.map((b) => b.close);
  const latest = last(closes);
  if (latest == null) return null;
  const ma5 = avg(closes.slice(-5));
  const ma20 = avg(closes.slice(-20));
  const ma60 = closes.length >= 60 ? avg(closes.slice(-60)) : null;
  const rsiSeries = rsi(closes, 14);
  const rsiValue = lastNonNull(rsiSeries);
  const { macd: macdLine, signal } = macd(closes);
  let macdCrossUp = false;
  let macdCrossDown = false;
  for (let i = Math.max(1, closes.length - 5); i < closes.length; i += 1) {
    const m = macdLine[i];
    const mPrev = macdLine[i - 1];
    const s = signal[i];
    const sPrev = signal[i - 1];
    if (m == null || mPrev == null || s == null || sPrev == null) continue;
    if (mPrev <= sPrev && m > s) macdCrossUp = true;
    if (mPrev >= sPrev && m < s) macdCrossDown = true;
  }
  const trend = trendState(closes);
  const vol = volumeState(bars);
  const base = avg(bars.slice(-21, -1).map((b) => b.volume));
  const latestVol = last(bars.map((b) => b.volume));
  const volRatio = base && base > 0 && latestVol != null ? latestVol / base : null;
  const { support, resistance } = supportResistance(bars, 60);
  const recentMove = pctChange(closes[closes.length - 20] ?? latest, latest);
  const trueRanges = bars.slice(-15).map((bar, index, rows) => {
    const previousClose = index > 0 ? rows[index - 1].close : bar.open;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  });
  const atr14 = avg(trueRanges.slice(-14));
  const atrPercent = atr14 != null && latest > 0 ? (atr14 / latest) * 100 : null;
  const longRisk = support != null && support < latest ? latest - support : null;
  const longReward = resistance != null && resistance > latest ? resistance - latest : null;
  const shortRisk = resistance != null && resistance > latest ? resistance - latest : null;
  const shortReward = support != null && support < latest ? latest - support : null;
  const longRiskReward =
    longRisk != null && longRisk > 0 && longReward != null ? longReward / longRisk : null;
  const shortRiskReward =
    shortRisk != null && shortRisk > 0 && shortReward != null ? shortReward / shortRisk : null;

  let bullScore = 42;
  let bearScore = 42;

  if (ma20 != null && latest > ma20) bullScore += 8;
  else if (ma20 != null) bearScore += 8;
  if (ma5 != null && ma20 != null && ma5 > ma20) bullScore += 8;
  else if (ma5 != null && ma20 != null) bearScore += 8;
  if (ma60 != null && latest > ma60) bullScore += 8;
  else if (ma60 != null) bearScore += 8;
  if (trend === '상승추세') bullScore += 10;
  if (trend === '하락추세') bearScore += 10;
  if (macdCrossUp) bullScore += 7;
  if (macdCrossDown) bearScore += 7;
  if (rsiValue != null) {
    if (rsiValue >= 45 && rsiValue <= 65) bullScore += 6;
    if (rsiValue >= 35 && rsiValue <= 55) bearScore += 3;
    if (rsiValue >= 70) {
      bullScore -= 8;
      bearScore += 5;
    }
    if (rsiValue <= 30) {
      bearScore -= 8;
      bullScore += 5;
    }
  }
  if (volRatio != null) {
    if (volRatio >= 1.2 && latest > (ma20 ?? latest)) bullScore += 7;
    if (volRatio >= 1.2 && latest < (ma20 ?? latest)) bearScore += 7;
    if (volRatio < 0.7) {
      bullScore -= 6;
      bearScore -= 6;
    }
  }
  if (longRiskReward != null && longRiskReward >= 1.5) bullScore += 5;
  if (shortRiskReward != null && shortRiskReward >= 1.5) bearScore += 5;
  if (recentMove > 12) bullScore -= 5;
  if (recentMove < -12) bearScore -= 5;

  bullScore = Math.max(0, Math.min(100, Math.round(bullScore)));
  bearScore = Math.max(0, Math.min(100, Math.round(bearScore)));

  return {
    bars,
    closes,
    latest,
    ma5,
    ma20,
    ma60,
    rsiValue,
    macdCrossUp,
    macdCrossDown,
    trend,
    vol,
    volRatio,
    support,
    resistance,
    recentMove,
    atrPercent,
    longRiskReward,
    shortRiskReward,
    bullScore,
    bearScore,
  };
}

function bullBasis(a: Analyzed): string[] {
  const out: string[] = [];
  if (a.ma20 != null && a.latest > a.ma20) out.push('현재가가 20일선 위에 위치');
  if (a.ma5 != null && a.ma20 != null && a.ma5 > a.ma20) out.push('단기 이평(5일)이 중기 이평(20일) 상향');
  if (a.trend === '상승추세') out.push('중기 추세 상승');
  if (a.macdCrossUp) out.push('MACD 상향 교차 발생(최근 5봉 내)');
  if (a.rsiValue != null && a.rsiValue <= 35) out.push(`RSI ${a.rsiValue.toFixed(0)} 과매도권 반등 관점`);
  if (a.rsiValue != null && a.rsiValue >= 55 && a.rsiValue < 70) out.push(`RSI ${a.rsiValue.toFixed(0)} 강세 유지`);
  if (a.volRatio != null && a.volRatio >= 1.5) out.push(a.vol);
  return out;
}

function bearBasis(a: Analyzed): string[] {
  const out: string[] = [];
  if (a.ma20 != null && a.latest < a.ma20) out.push('현재가가 20일선 아래에 위치');
  if (a.ma5 != null && a.ma20 != null && a.ma5 < a.ma20) out.push('단기 이평(5일)이 중기 이평(20일) 하향');
  if (a.trend === '하락추세') out.push('중기 추세 하락');
  if (a.macdCrossDown) out.push('MACD 하향 교차 발생(최근 5봉 내)');
  if (a.rsiValue != null && a.rsiValue >= 70) out.push(`RSI ${a.rsiValue.toFixed(0)} 과매수권 과열`);
  if (a.recentMove > 8) out.push(`최근 20봉 +${a.recentMove.toFixed(1)}% 단기 급등 부담`);
  if (a.volRatio != null && a.volRatio >= 1.5) out.push(a.vol);
  return out;
}

interface RawItem {
  ticker: string;
  name: string;
  price: number;
  changePercent: number | null;
  currency: string;
  market: string;
  analyzed: Analyzed;
  timeframe?: '15m' | '1D';
}

function makeCandidate(
  item: RawItem,
  direction: ScanCandidate['direction'],
  score: number,
  basis: string[],
  verdict: string,
  dataAsOf: string,
): ScanCandidate {
  const a = item.analyzed;
  const risks: string[] = [];
  if (a.volRatio != null && a.volRatio < 0.8) risks.push('거래량이 평소보다 적어 신뢰도 낮음');
  if (a.trend === '횡보') risks.push('추세 방향성 불명확(횡보)');
  if (direction === 'long' || direction === 'buy') {
    if (a.rsiValue != null && a.rsiValue >= 70) risks.push('RSI 과열 구간 진입 부담');
    if (a.recentMove > 10) risks.push('단기 급등 후 조정 가능성');
  } else {
    if (a.rsiValue != null && a.rsiValue <= 30) risks.push('RSI 과매도 구간 반등 가능성');
  }
  if (!risks.length) risks.push('시장 전체 변동성에 따른 손실 위험');

  const invalidation: string[] = [];
  if (direction === 'long' || direction === 'buy') {
    if (a.support != null) invalidation.push(`지지선 ${Math.round(a.support * 100) / 100} 종가 이탈 시 무효`);
    if (a.ma20 != null) invalidation.push(`20일선 ${Math.round(a.ma20 * 100) / 100} 하회 지속 시 관점 철회`);
  } else {
    if (a.resistance != null) invalidation.push(`저항선 ${Math.round(a.resistance * 100) / 100} 종가 돌파 시 무효`);
    if (a.ma20 != null) invalidation.push(`20일선 ${Math.round(a.ma20 * 100) / 100} 회복 시 관점 철회`);
  }
  if (!invalidation.length) invalidation.push('추세 반전 신호 확인 시 관점 철회');

  return {
    ticker: item.ticker,
    name: item.name,
    price: item.price,
    changePercent: item.changePercent,
    currency: item.currency,
    market: item.market,
    direction,
    score,
    verdict,
    basis: basis.length ? basis : ['기술적 근거 제한적'],
    support: a.support,
    resistance: a.resistance,
    volumeState: a.vol,
    trendState: a.trend,
    risks,
    invalidation,
    dataAsOf,
    timeframe: item.timeframe,
  };
}

async function collectStock(market: 'KR' | 'US'): Promise<{ items: RawItem[]; scanned: number; providerErrors: number }> {
  const pool = CATALOG.filter((e) => e.market === market).slice(0, STOCK_POOL);
  const settled = await Promise.all(
    pool.map(async (entry) => {
      const [quoteResult, intradayResult, dailyResult] = await Promise.allSettled([
        MarketDataService.getQuote(entry.ticker),
        MarketDataService.getCandles(entry.ticker, '15m'),
        MarketDataService.getCandles(entry.ticker, '1D'),
      ]);
      if (
        quoteResult.status === 'rejected' ||
        !quoteResult.value ||
        !Number.isFinite(quoteResult.value.price)
      ) {
        return { items: [] as RawItem[], errors: 1 };
      }

      const items: RawItem[] = [];
      let errors = 0;
      const candleResults = [intradayResult, dailyResult];
      const timeframes: Array<'15m' | '1D'> = ['15m', '1D'];

      candleResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          errors += 1;
          return;
        }
        const analyzed = analyze(toBars(result.value as Bar[]));
        if (!analyzed) return;
        items.push({
          ticker: entry.ticker,
          name: entry.name,
          price: quoteResult.value.price,
          changePercent: Number.isFinite(quoteResult.value.changePercent)
            ? quoteResult.value.changePercent
            : null,
          currency: entry.currency,
          market: entry.market,
          analyzed,
          timeframe: timeframes[index],
        });
      });

      return { items, errors };
    }),
  );

  return {
    items: settled.flatMap((result) => result.items),
    scanned: pool.length,
    providerErrors: settled.reduce((sum, result) => sum + result.errors, 0),
  };
}

async function collectCoinSpot(): Promise<{ items: RawItem[]; scanned: number; providerErrors: number }> {
  const tickers = await fetchUpbitTopTickers(COIN_SPOT_POOL);
  let providerErrors = 0;
  const items: RawItem[] = [];

  // Upbit candle API 호출 제한을 지키며 15분봉과 일봉을 순차 조회한다.
  for (const t of tickers) {
    const sources: Array<{ timeframe: '15m' | '1D'; candles: Bar[] | null }> = [];
    for (const timeframe of ['15m', '1D'] as const) {
      try {
        sources.push({
          timeframe,
          candles: await fetchUpbitCandles(t.symbol, 200, timeframe),
        });
      } catch {
        providerErrors += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    for (const source of sources) {
      const analyzed = source.candles ? analyze(source.candles) : null;
      if (!analyzed || t.price == null) continue;
      items.push({
        ticker: t.symbol,
        name: t.symbol,
        price: t.price,
        changePercent: t.changePercent,
        currency: 'KRW',
        market: 'spot',
        analyzed,
        timeframe: source.timeframe,
      });
    }
  }

  return { items, scanned: tickers.length, providerErrors };
}

async function collectCoinFutures(): Promise<{ items: RawItem[]; scanned: number; providerErrors: number }> {
  const tickers = await fetchBitgetTopTickers(COIN_FUTURES_POOL);
  const settled = await Promise.all(
    tickers.map(async (t) => {
      const sources = await Promise.allSettled([
        fetchBitgetCandles(t.symbol, 200, '15m'),
        fetchBitgetCandles(t.symbol, 200, '1D'),
      ]);
      const timeframes: Array<'15m' | '1D'> = ['15m', '1D'];
      const items: RawItem[] = [];
      let errors = 0;

      sources.forEach((source, index) => {
        if (source.status === 'rejected') {
          errors += 1;
          return;
        }
        const analyzed = analyze(source.value);
        if (!analyzed || t.price == null) return;
        items.push({
          ticker: t.symbol,
          name: t.symbol.replace(/USDT$/, ''),
          price: t.price,
          changePercent: t.changePercent,
          currency: 'USDT',
          market: 'futures',
          analyzed,
          timeframe: timeframes[index],
        });
      });

      return { items, errors };
    }),
  );

  return {
    items: settled.flatMap((result) => result.items),
    scanned: tickers.length,
    providerErrors: settled.reduce((sum, result) => sum + result.errors, 0),
  };
}

function hasUsableVolatility(
  a: Analyzed,
  futures = false,
  timeframe: '15m' | '1D' = '1D',
): boolean {
  if (a.atrPercent == null) return false;
  if (timeframe === '15m') {
    return a.atrPercent >= (futures ? 0.08 : 0.05) && a.atrPercent <= 4;
  }
  return a.atrPercent >= 0.35 && a.atrPercent <= (futures ? 12 : 8);
}

function isOptimizedLong(
  a: Analyzed,
  futures = false,
  timeframe: '15m' | '1D' = '1D',
): boolean {
  const minScore = futures ? FUTURES_MIN_SCORE : STOCK_MIN_SCORE;
  const minRiskReward = futures ? 1.8 : 1.5;
  return (
    a.bullScore >= minScore &&
    a.bullScore - a.bearScore >= (futures ? 12 : 10) &&
    a.trend === '상승추세' &&
    a.ma5 != null &&
    a.ma20 != null &&
    a.ma5 > a.ma20 &&
    a.latest > a.ma20 &&
    a.rsiValue != null &&
    a.rsiValue >= 42 &&
    a.rsiValue <= 68 &&
    a.volRatio != null &&
    a.volRatio >= 0.8 &&
    hasUsableVolatility(a, futures, timeframe) &&
    a.longRiskReward != null &&
    a.longRiskReward >= minRiskReward
  );
}

function isOptimizedShort(
  a: Analyzed,
  futures = false,
  timeframe: '15m' | '1D' = '1D',
): boolean {
  const minScore = futures ? FUTURES_MIN_SCORE : STOCK_MIN_SCORE;
  const minRiskReward = futures ? 1.8 : 1.5;
  return (
    a.bearScore >= minScore &&
    a.bearScore - a.bullScore >= (futures ? 12 : 10) &&
    a.trend === '하락추세' &&
    a.ma5 != null &&
    a.ma20 != null &&
    a.ma5 < a.ma20 &&
    a.latest < a.ma20 &&
    a.rsiValue != null &&
    a.rsiValue >= 32 &&
    a.rsiValue <= 58 &&
    a.volRatio != null &&
    a.volRatio >= 0.8 &&
    hasUsableVolatility(a, futures, timeframe) &&
    a.shortRiskReward != null &&
    a.shortRiskReward >= minRiskReward
  );
}

function isFuturesWatchLong(a: Analyzed, timeframe: '15m' | '1D'): boolean {
  return (
    a.bullScore > a.bearScore &&
    a.ma5 != null &&
    a.ma20 != null &&
    a.rsiValue != null &&
    hasUsableVolatility(a, true, timeframe)
  );
}

function isFuturesWatchShort(a: Analyzed, timeframe: '15m' | '1D'): boolean {
  return (
    a.bearScore > a.bullScore &&
    a.ma5 != null &&
    a.ma20 != null &&
    a.rsiValue != null &&
    hasUsableVolatility(a, true, timeframe)
  );
}

function buildBuySellGroups(items: RawItem[], dataAsOf: string): ScanGroup[] {
  const buy = items
    .filter((i) => isOptimizedLong(i.analyzed, false, i.timeframe ?? '1D'))
    .sort((a, b) => b.analyzed.bullScore - a.analyzed.bullScore)
    .slice(0, GROUP_LIMIT)
    .map((i) =>
      makeCandidate(
        i,
        'buy',
        i.analyzed.bullScore,
        bullBasis(i.analyzed),
        '기술적 지표상 매수 관점이 우세한 후보(확정 매수 아님, 관찰 필요)',
        dataAsOf,
      ),
    );
  const sell = items
    .filter((i) => isOptimizedShort(i.analyzed, false, i.timeframe ?? '1D'))
    .sort((a, b) => b.analyzed.bearScore - a.analyzed.bearScore)
    .slice(0, GROUP_LIMIT)
    .map((i) =>
      makeCandidate(
        i,
        'sell',
        i.analyzed.bearScore,
        bearBasis(i.analyzed),
        '기술적 지표상 매도/차익 관점이 우세한 후보(확정 매도 아님, 관찰 필요)',
        dataAsOf,
      ),
    );
  return [
    { key: 'buy', label: '매수 후보', candidates: buy },
    { key: 'sell', label: '매도 후보', candidates: sell },
  ];
}

function buildFuturesGroups(items: RawItem[], dataAsOf: string): ScanGroup[] {
  // 롱/숏: 단기 모멘텀 + 추세. 매수/매도 관점: 더 보수적 스윙 기준.
  const long = items
    .filter((i) => isOptimizedLong(i.analyzed, true, i.timeframe ?? '1D') && i.analyzed.recentMove > 0)
    .sort((a, b) => b.analyzed.bullScore - a.analyzed.bullScore)
    .slice(0, GROUP_LIMIT)
    .map((i) =>
      makeCandidate(i, 'long', i.analyzed.bullScore, bullBasis(i.analyzed), '단기 모멘텀·추세 기준 롱 관점 후보(고위험, 관찰 필요)', dataAsOf),
    );
  const short = items
    .filter((i) => isOptimizedShort(i.analyzed, true, i.timeframe ?? '1D') && i.analyzed.recentMove < 0)
    .sort((a, b) => b.analyzed.bearScore - a.analyzed.bearScore)
    .slice(0, GROUP_LIMIT)
    .map((i) =>
      makeCandidate(i, 'short', i.analyzed.bearScore, bearBasis(i.analyzed), '단기 모멘텀·추세 기준 숏 관점 후보(고위험, 관찰 필요)', dataAsOf),
    );
  const buyView = items
    .filter((i) => isFuturesWatchLong(i.analyzed, i.timeframe ?? '1D'))
    .sort((a, b) => b.analyzed.bullScore - a.analyzed.bullScore)
    .slice(0, GROUP_LIMIT)
    .map((i) =>
      makeCandidate(i, 'buy', i.analyzed.bullScore, bullBasis(i.analyzed), '차상위 스윙 매수 관찰 후보(강한 롱 신호 아님)', dataAsOf),
    );
  const sellView = items
    .filter((i) => isFuturesWatchShort(i.analyzed, i.timeframe ?? '1D'))
    .sort((a, b) => b.analyzed.bearScore - a.analyzed.bearScore)
    .slice(0, GROUP_LIMIT)
    .map((i) =>
      makeCandidate(i, 'sell', i.analyzed.bearScore, bearBasis(i.analyzed), '차상위 스윙 매도 관찰 후보(강한 숏 신호 아님)', dataAsOf),
    );
  return [
    { key: 'long', label: '롱 후보', candidates: long },
    { key: 'short', label: '숏 후보', candidates: short },
    { key: 'buyView', label: '매수 관찰', candidates: buyView },
    { key: 'sellView', label: '매도 관찰', candidates: sellView },
  ];
}

export async function getSignalScan(
  asset: 'stock' | 'coin',
  market: string,
): Promise<SignalScanResult> {
  const key = `signal-scan:v2-optimized:${asset}:${market}`;
  const ttl = asset === 'coin' ? COIN_SCAN_TTL : STOCK_SCAN_TTL;
  return cached(key, ttl, async () => {
    const generatedAt = new Date().toISOString();
    let collected: { items: RawItem[]; scanned: number; providerErrors: number };
    let groups: ScanGroup[];

    if (asset === 'stock') {
      const mk = market === 'US' ? 'US' : 'KR';
      collected = await collectStock(mk);
      groups = buildBuySellGroups(collected.items, generatedAt);
    } else if (market === 'futures') {
      collected = await collectCoinFutures();
      groups = buildFuturesGroups(collected.items, generatedAt);
    } else {
      collected = await collectCoinSpot();
      groups = buildBuySellGroups(collected.items, generatedAt);
    }

    return {
      ok: true,
      asset,
      market,
      generatedAt,
      scanned: collected.scanned,
      providerErrors: collected.providerErrors,
      groups,
    };
  });
}
