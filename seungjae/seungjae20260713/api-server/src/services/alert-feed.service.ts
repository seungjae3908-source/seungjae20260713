// Market-wide 호재/악재 alert feed. Aggregates REAL, timestamped events —
// live news and regulatory disclosures/filings — across a bounded universe of
// liquid names. Every alert carries its real source date and (when available)
// an external 원문 link; we never synthesize an event that has no source.
import { cached, TTL } from '../lib/cache';
import { CATALOG, type CatalogEntry } from '../data/catalog';
import { NewsService } from './news.service';
import { RiskAnalysisService } from './risk-analysis.service';
import { MarketDataService } from './market-data.service';
import type { Candle } from '../sample/types';

export interface MarketAlert {
  id: string;
  ticker: string;
  name: string;
  market: 'US' | 'KR';
  kind: 'positive' | 'negative'; // 호재 / 악재
  category: string; // 신호 종류 (뉴스 / 공시 라벨)
  title: string; // 설명
  importance: 'high' | 'medium' | 'low'; // 중요도
  time: string; // 발생 시간 (실제 소스 날짜)
  url: string | null; // 원문 링크 (없으면 상세 페이지로)
}

// Corporate-action events that materially move a stock → high importance.
const HIGH_EVENTS = new Set([
  'OFFERING', 'ATM', 'REVERSE_SPLIT', 'RIGHTS_OFFERING', 'DELISTING',
  'SUPPLY_CONTRACT', 'MERGER', 'DIVIDEND',
]);

function universe(market: string): CatalogEntry[] {
  const kr = CATALOG.filter((e) => e.market === 'KR').slice(0, 22);
  const us = CATALOG.filter((e) => e.market === 'US').slice(0, 22);
  if (market === 'KR') return kr;
  if (market === 'US') return us;
  return [...kr, ...us];
}

function ts(date: string): number {
  const t = Date.parse(date);
  return Number.isNaN(t) ? 0 : t;
}

function candleDate(c: Candle): string {
  return typeof c.time === 'string' ? c.time : new Date(c.time * 1000).toISOString().slice(0, 10);
}

function sma(values: number[], period: number, end: number): number | null {
  if (end + 1 < period) return null;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) sum += values[i];
  return sum / period;
}

// Detect real chart signals from actual daily candles, capturing the exact bar
// date of the event so 발생시간 is genuine (never synthesized).
function detectChartSignals(entry: CatalogEntry, candles: Candle[]): MarketAlert[] {
  const out: MarketAlert[] = [];
  const n = candles.length;
  if (n < 25) return out; // not enough history to judge — stay silent.
  const closes = candles.map((c) => c.close);
  const last = n - 1;

  // MA5 / MA20 crossover within the last 3 sessions.
  for (let k = last; k >= Math.max(1, last - 2); k--) {
    const f0 = sma(closes, 5, k - 1), s0 = sma(closes, 20, k - 1);
    const f1 = sma(closes, 5, k), s1 = sma(closes, 20, k);
    if (f0 == null || s0 == null || f1 == null || s1 == null) continue;
    const date = candleDate(candles[k]);
    if (f0 <= s0 && f1 > s1) {
      out.push({
        id: `${entry.ticker}-sig-golden`, ticker: entry.ticker, name: entry.name, market: entry.market,
        kind: 'positive', category: '차트 신호', title: '골든크로스 발생 (5일선이 20일선 상향 돌파)',
        importance: 'high', time: date, url: null,
      });
      break;
    }
    if (f0 >= s0 && f1 < s1) {
      out.push({
        id: `${entry.ticker}-sig-dead`, ticker: entry.ticker, name: entry.name, market: entry.market,
        kind: 'negative', category: '차트 신호', title: '데드크로스 발생 (5일선이 20일선 하향 이탈)',
        importance: 'high', time: date, url: null,
      });
      break;
    }
  }

  // Volume explosion on the latest bar (> 2x the prior 20-session average).
  const avgVol = sma(candles.map((c) => c.volume), 20, last - 1);
  if (avgVol != null && avgVol > 0 && candles[last].volume > avgVol * 2) {
    const up = closes[last] >= closes[last - 1];
    out.push({
      id: `${entry.ticker}-sig-vol`, ticker: entry.ticker, name: entry.name, market: entry.market,
      kind: up ? 'positive' : 'negative', category: '차트 신호',
      title: `거래량 급증 (평소의 ${(candles[last].volume / avgVol).toFixed(1)}배${up ? ', 주가 상승' : ', 주가 하락'})`,
      importance: 'medium', time: candleDate(candles[last]), url: null,
    });
  }

  return out;
}

async function collect(entry: CatalogEntry): Promise<MarketAlert[]> {
  const [news, risk, candles] = await Promise.all([
    NewsService.getNews(entry.ticker).catch(() => null),
    RiskAnalysisService.getRisk(entry.ticker).catch(() => null),
    MarketDataService.getCandles(entry.ticker, '1D').catch(() => null),
  ]);
  const out: MarketAlert[] = [];

  // Real chart-signal events (골든/데드크로스, 거래량 급증) from actual candles.
  if (candles && candles.length) out.push(...detectChartSignals(entry, candles));

  // News (real headlines with date + url).
  if (news) {
    news.positive.slice(0, 2).forEach((n, i) => {
      out.push({
        id: `${entry.ticker}-news-p${i}`,
        ticker: entry.ticker, name: entry.name, market: entry.market,
        kind: 'positive', category: '뉴스', title: n.title,
        importance: 'medium', time: n.date, url: n.url || null,
      });
    });
    news.negative.slice(0, 2).forEach((n, i) => {
      out.push({
        id: `${entry.ticker}-news-n${i}`,
        ticker: entry.ticker, name: entry.name, market: entry.market,
        kind: 'negative', category: '뉴스', title: n.title,
        importance: 'medium', time: n.date, url: n.url || null,
      });
    });
  }

  // Disclosures + filings (regulatory, classified sentiment + events).
  if (risk) {
    const items = [...(risk.filings ?? []), ...(risk.disclosures ?? [])];
    items.slice(0, 4).forEach((it, i) => {
      if (it.sentiment !== 'positive' && it.sentiment !== 'negative') return;
      const high = (it.events ?? []).some((e) => HIGH_EVENTS.has(e));
      out.push({
        id: `${entry.ticker}-disc${i}`,
        ticker: entry.ticker, name: entry.name, market: entry.market,
        kind: it.sentiment,
        category: it.eventLabels?.[0] ?? '공시',
        title: it.description,
        importance: high ? 'high' : 'medium',
        time: it.date,
        url: it.url || null,
      });
    });
  }

  return out;
}

async function getFeed(market: string): Promise<{ positive: MarketAlert[]; negative: MarketAlert[] }> {
  return cached(`alert-feed:${market}`, TTL.quote, async () => {
    const entries = universe(market);
    const settled = await Promise.all(entries.map((e) => collect(e).catch(() => [] as MarketAlert[])));
    const all = settled.flat();

    const rank = { high: 0, medium: 1, low: 2 } as const;
    const sort = (a: MarketAlert, b: MarketAlert) =>
      rank[a.importance] - rank[b.importance] || ts(b.time) - ts(a.time);

    return {
      positive: all.filter((a) => a.kind === 'positive').sort(sort).slice(0, 40),
      negative: all.filter((a) => a.kind === 'negative').sort(sort).slice(0, 40),
    };
  });
}

export const AlertFeedService = { getFeed };
