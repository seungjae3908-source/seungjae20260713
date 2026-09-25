import type { Candle, Timeframe } from '../sample/types';
import { answerAiChat } from './ai-chat.service';
import { getFuturesCandles } from './futures-market-data.service';
import { MarketDataService } from './market-data.service';
import { fetchPublicMarketJson } from './market-information.service';
import { collectStockNewsDisclosureIntelligence } from './news-disclosure-market-intelligence.service';
import type { ScannerAlertCandidate } from './scanner-signal.types';
import {
  renderTelegramEvidenceChart,
  type TelegramEvidenceChartResult,
} from './telegram-evidence-chart.service';
import {
  normalizeTelegramHttpUrl,
  type TelegramAlertInput,
  type TelegramUrlButton,
} from './telegram-notification.service';

export type TelegramSignalDeliveryContext = {
  timeframe?: string;
  generatedAt?: string;
  strategyMode?: 'scalping' | 'swing' | 'position';
};

export type TelegramMarketEventEvidence = {
  kind: 'NEWS' | 'DISCLOSURE' | 'FILING';
  title: string;
  source: string;
  url: string | null;
  publishedAt: string | null;
  summary: string | null;
  sentiment: string | null;
  importanceScore: number | null;
  confidenceScore: number | null;
  freshness: string | null;
  riskFlags: string[];
  catalystFlags: string[];
};

export type TelegramNewsEvidence = {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  tone: string | null;
};

export type TelegramSignalIntelligenceEvidence = {
  aiExplanation: string | null;
  aiModel: string | null;
  aiAsOf: string | null;
  theme: string | null;
  news: TelegramNewsEvidence[];
  marketEvents?: TelegramMarketEventEvidence[];
  chart: TelegramEvidenceChartResult | null;
  warnings: string[];
};

const STOCK_TIMEFRAMES = new Set<Timeframe>(['1m', '3m', '5m', '15m', '30m', '60m', '4H', '1D', '1W', '1M']);
const FUTURES_TIMEFRAMES = new Set(['1m', '3m', '5m', '15m', '30m', '1H', '4H', '6H', '12H', '1D', '1W']);
const MAX_AI_TEXT = 500;
const MAX_NEWS = 3;

function normalizedStockTimeframe(value: string | undefined): Timeframe {
  const normalized = value === '1H' ? '60m' : value;
  return STOCK_TIMEFRAMES.has(normalized as Timeframe) ? normalized as Timeframe : '1D';
}

function normalizedFuturesTimeframe(value: string | undefined): string {
  const normalized = value === '60m' ? '1H' : value;
  return FUTURES_TIMEFRAMES.has(String(normalized)) ? String(normalized) : '1H';
}

function maxChartAgeMs(timeframe: string): number {
  if (timeframe === '1D') return 5 * 24 * 60 * 60_000;
  if (timeframe === '1W' || timeframe === '1M') return 45 * 24 * 60 * 60_000;
  if (timeframe === '4H' || timeframe === '6H' || timeframe === '12H') return 24 * 60 * 60_000;
  if (timeframe === '60m' || timeframe === '1H') return 6 * 60 * 60_000;
  return 2 * 60 * 60_000;
}

function isoFromCandle(value: string | number): string | null {
  const parsed = typeof value === 'number'
    ? (value > 100_000_000_000 ? value : value * 1000)
    : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function chartFromCandles(
  alert: ScannerAlertCandidate,
  candles: readonly Candle[],
  timeframe: string,
): TelegramEvidenceChartResult | null {
  const dataAsOf = candles.length ? isoFromCandle(candles[candles.length - 1].time) : null;
  if (!dataAsOf) return null;
  return renderTelegramEvidenceChart({
    candles,
    dataAsOf,
    entryZone: alert.entryZone,
    stopLoss: alert.stopLoss,
    targets: alert.targets,
    maxAgeMs: maxChartAgeMs(timeframe),
  });
}

async function stockChart(alert: ScannerAlertCandidate, timeframe: string): Promise<TelegramEvidenceChartResult | null> {
  const normalized = normalizedStockTimeframe(timeframe);
  const loaded = await MarketDataService.getCandlesMeta(alert.symbol, normalized);
  return chartFromCandles(alert, loaded.candles, normalized);
}

function upbitMarket(symbol: string): string | null {
  const normalized = symbol.trim().toUpperCase();
  if (/^KRW-[A-Z0-9]{2,15}$/.test(normalized)) return normalized;
  if (/^[A-Z0-9]{2,15}$/.test(normalized)) return `KRW-${normalized}`;
  return null;
}

function upbitCandleUrl(symbol: string, timeframe: string): string | null {
  const market = upbitMarket(symbol);
  if (!market) return null;
  const minute = timeframe === '1H' ? '60m' : timeframe;
  const units = new Set(['1m', '3m', '5m', '15m', '30m', '60m']);
  if (units.has(minute)) {
    return `https://api.upbit.com/v1/candles/minutes/${minute.replace('m', '')}?market=${encodeURIComponent(market)}&count=60`;
  }
  if (timeframe === '1D') return `https://api.upbit.com/v1/candles/days?market=${encodeURIComponent(market)}&count=60`;
  if (timeframe === '1W') return `https://api.upbit.com/v1/candles/weeks?market=${encodeURIComponent(market)}&count=60`;
  if (timeframe === '1M') return `https://api.upbit.com/v1/candles/months?market=${encodeURIComponent(market)}&count=60`;
  return null;
}

function normalizeUpbitCandles(payload: unknown): Candle[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((value): Candle[] => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    const time = String(row.candle_date_time_utc ?? '');
    const open = Number(row.opening_price);
    const high = Number(row.high_price);
    const low = Number(row.low_price);
    const close = Number(row.trade_price);
    const volume = Number(row.candle_acc_trade_volume);
    if (!time || ![open, high, low, close, volume].every(Number.isFinite)) return [];
    return [{ time: `${time}Z`, open, high, low, close, volume }];
  }).sort((left, right) => Number(Date.parse(String(left.time))) - Number(Date.parse(String(right.time))));
}

async function spotChart(alert: ScannerAlertCandidate, timeframe: string): Promise<TelegramEvidenceChartResult | null> {
  const url = upbitCandleUrl(alert.symbol, timeframe);
  if (!url) return null;
  const payload = await fetchPublicMarketJson(url, { provider: 'Upbit' });
  const candles = normalizeUpbitCandles(payload);
  return chartFromCandles(alert, candles, timeframe);
}

async function futuresChart(alert: ScannerAlertCandidate, timeframe: string): Promise<TelegramEvidenceChartResult | null> {
  const normalized = normalizedFuturesTimeframe(timeframe);
  const result = await getFuturesCandles({ symbol: alert.symbol, timeframe: normalized, limit: 60 });
  const candles: Candle[] = result.data
    .filter((candle) => candle.isClosed)
    .map((candle) => ({
      time: candle.timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    }));
  return chartFromCandles(alert, candles, normalized);
}

async function collectChart(
  alert: ScannerAlertCandidate,
  timeframe: string,
): Promise<TelegramEvidenceChartResult | null> {
  if (alert.assetClass === 'stock') return stockChart(alert, timeframe);
  if (alert.assetClass === 'coin_spot') return spotChart(alert, timeframe);
  return futuresChart(alert, timeframe);
}

async function collectStockMarketEvents(alert: ScannerAlertCandidate): Promise<TelegramMarketEventEvidence[]> {
  if (alert.assetClass !== 'stock') return [];
  const market = alert.market.toUpperCase().includes('US') ? 'US' : 'KR';
  const result = await collectStockNewsDisclosureIntelligence({
    ticker: alert.symbol,
    market,
    analysisScope: 'SCANNER',
    context: {
      scannerCandidate: true,
    },
    maxEvents: MAX_NEWS,
    maxAiEvents: 2,
  }, { timeoutMs: 1_200 });

  return result.events.slice(0, MAX_NEWS).flatMap((event): TelegramMarketEventEvidence[] => {
    const title = String(event.headline ?? '').normalize('NFKC').trim().slice(0, 180);
    if (!title) return [];
    const url = normalizeTelegramHttpUrl(event.sourceUrl);
    const analysis = event.ai?.analysis ?? null;
    return [{
      kind: event.kind,
      title,
      source: String(event.sourceName ?? '').normalize('NFKC').trim().slice(0, 80) || '출처 미상',
      url,
      publishedAt: event.publishedAt,
      summary: analysis?.summaryShort?.trim().slice(0, 320) || null,
      sentiment: analysis?.sentiment ?? null,
      importanceScore: analysis?.importanceScore ?? null,
      confidenceScore: analysis?.confidenceScore ?? null,
      freshness: event.route?.freshness.state ?? null,
      riskFlags: analysis?.riskFlags ?? [],
      catalystFlags: analysis?.catalystFlags ?? [],
    }];
  });
}

async function collectTheme(alert: ScannerAlertCandidate): Promise<string | null> {
  if (alert.assetClass !== 'stock') return null;
  const profile = await MarketDataService.getCompanyProfile(alert.symbol);
  return profile.sector?.trim() || profile.industry?.trim() || null;
}

function aiContext(alert: ScannerAlertCandidate): { market: 'KR' | 'US' | 'UPBIT' | 'BITGET'; symbol: string } | null {
  if (alert.assetClass === 'coin_spot') return { market: 'UPBIT', symbol: alert.symbol.toUpperCase() };
  if (alert.assetClass === 'coin_futures') return { market: 'BITGET', symbol: alert.symbol.toUpperCase() };
  const market = alert.market.toUpperCase();
  if (market.includes('US')) return { market: 'US', symbol: alert.symbol.toUpperCase() };
  if (market.includes('KR')) return { market: 'KR', symbol: alert.symbol };
  return null;
}

async function collectAiExplanation(
  alert: ScannerAlertCandidate,
  timeframe: string,
): Promise<{ explanation: string; model: string | null; asOf: string | null } | null> {
  if (process.env.TELEGRAM_SIGNAL_AI_ENABLED !== 'true') return null;
  const context = aiContext(alert);
  if (!context) return null;
  const facts = {
    signalId: alert.signalId,
    market: alert.market,
    symbol: alert.symbol,
    direction: alert.direction,
    state: alert.state,
    timeframe,
    entryZone: alert.entryZone,
    stopLoss: alert.stopLoss,
    targets: alert.targets,
    evidence: alert.evidence,
    expiresAt: alert.expiresAt,
  };
  const result = await answerAiChat({
    message: `다음 Scanner 사실을 바꾸거나 새 가격·확률을 만들지 말고, 실행 지시 없이 핵심 근거·무효 조건·데이터 한계를 3문장 이내 한국어로 간단히 설명해줘. Scanner 사실: ${JSON.stringify(facts)}`,
    context,
  }, fetch, undefined, 7_000);
  return {
    explanation: result.answer.slice(0, MAX_AI_TEXT),
    model: result.model,
    asOf: result.data.asOf ?? result.generatedAt,
  };
}

export async function collectTelegramSignalIntelligence(
  alert: ScannerAlertCandidate,
  context: TelegramSignalDeliveryContext = {},
): Promise<TelegramSignalIntelligenceEvidence> {
  const timeframe = context.timeframe || '1D';
  const warnings: string[] = [];
  const [chartResult, eventResult, themeResult, aiResult] = await Promise.allSettled([
    collectChart(alert, timeframe),
    collectStockMarketEvents(alert),
    collectTheme(alert),
    collectAiExplanation(alert, timeframe),
  ]);

  if (chartResult.status === 'rejected') warnings.push('CHART_EVIDENCE_UNAVAILABLE');
  if (eventResult.status === 'rejected') warnings.push('NEWS_DISCLOSURE_EVIDENCE_UNAVAILABLE');
  if (themeResult.status === 'rejected') warnings.push('THEME_EVIDENCE_UNAVAILABLE');
  if (aiResult.status === 'rejected') warnings.push('AI_EXPLANATION_UNAVAILABLE');

  const ai = aiResult.status === 'fulfilled' ? aiResult.value : null;
  const marketEvents = eventResult.status === 'fulfilled' ? eventResult.value : [];
  const news = marketEvents
    .filter((event) => event.kind === 'NEWS' && event.url)
    .map((event): TelegramNewsEvidence => ({
      title: event.title,
      source: event.source,
      url: event.url!,
      publishedAt: event.publishedAt ?? '',
      tone: event.sentiment,
    }));
  return {
    aiExplanation: ai?.explanation ?? null,
    aiModel: ai?.model ?? null,
    aiAsOf: ai?.asOf ?? null,
    theme: themeResult.status === 'fulfilled' ? themeResult.value : null,
    news,
    marketEvents,
    chart: chartResult.status === 'fulfilled' ? chartResult.value : null,
    warnings,
  };
}

function marketLabel(alert: ScannerAlertCandidate): string {
  if (alert.assetClass === 'coin_futures') return '코인선물';
  if (alert.assetClass === 'coin_spot') return '코인현물';
  return alert.market.toUpperCase().includes('US') ? '미국' : '국내';
}

function strategyLabel(context: TelegramSignalDeliveryContext): string {
  if (context.strategyMode === 'scalping') return '단타';
  if (context.strategyMode === 'swing') return '스윙';
  if (context.strategyMode === 'position') return '포지션';
  return '전략 미확인';
}

function pricePlan(alert: ScannerAlertCandidate): string {
  const firstEntry = alert.entryZone
    ? (alert.direction === 'SHORT' ? alert.entryZone.from : alert.entryZone.to)
    : null;
  const secondEntry = alert.entryZone
    ? (alert.direction === 'SHORT' ? alert.entryZone.to : alert.entryZone.from)
    : null;
  const stop = alert.stopLoss == null ? 'N/A' : String(alert.stopLoss);
  const target1 = alert.targets[0] == null ? 'N/A' : String(alert.targets[0]);
  const target2 = alert.targets[1] == null ? 'N/A' : String(alert.targets[1]);
  return [
    `1차 진입 ${firstEntry ?? 'N/A'} · 기본 60%`,
    `2차 진입 ${secondEntry ?? 'N/A'} · 기본 40%`,
    `1차 목표 ${target1} · 2차 목표 ${target2}`,
    `손절/무효 ${stop}`,
    '앱 주문 준비에서 현재 시장데이터로 다시 검증·재계산',
  ].join('\n');
}

function appButtons(alert: ScannerAlertCandidate, context: TelegramSignalDeliveryContext): TelegramUrlButton[][] {
  const base = normalizeTelegramHttpUrl(process.env.PUBLIC_APP_URL || process.env.APP_PUBLIC_URL);
  if (!base) return [];
  const url = new URL(base);
  const market = alert.assetClass === 'stock'
    ? (alert.market.toUpperCase().includes('US') ? 'US' : 'KR')
    : alert.assetClass === 'coin_spot' ? 'UPBIT' : 'BITGET';
  const assetType = alert.assetClass === 'stock' ? 'stock' : 'crypto';
  const chart = new URL('/ai-chart', url);
  chart.searchParams.set('assetType', assetType);
  chart.searchParams.set('market', market);
  chart.searchParams.set('symbol', alert.symbol);
  chart.searchParams.set('ticker', alert.symbol);
  chart.searchParams.set('timeframe', context.timeframe || '1D');

  const order = new URL('/telegram-order', url);
  order.searchParams.set('market', market);
  order.searchParams.set('symbol', alert.symbol);
  order.searchParams.set('timeframe', context.timeframe || '1D');
  order.searchParams.set('action', alert.direction === 'SHORT' ? 'SHORT' : alert.assetClass === 'coin_futures' ? 'LONG' : 'BUY');
  order.searchParams.set('strategyMode', context.strategyMode || 'swing');
  order.searchParams.set('orderPreparation', '1');
  order.searchParams.set('source', 'telegram');

  const detail = alert.assetClass === 'stock'
    ? new URL('/stock-info', url)
    : new URL('/market-information', url);
  detail.searchParams.set('market', market);
  detail.searchParams.set(alert.assetClass === 'stock' ? 'ticker' : 'symbol', alert.symbol);
  detail.searchParams.set('tab', 'news');

  const watchlist = new URL('/watchlist', url);
  watchlist.searchParams.set('market', market);
  watchlist.searchParams.set('symbol', alert.symbol);

  return [
    [
      { text: '🛒 주문 준비', url: order.toString() },
      { text: '📊 AI차트', url: chart.toString() },
    ],
    [
      { text: '📰 뉴스·공시', url: detail.toString() },
      { text: '⭐ 관심종목', url: watchlist.toString() },
    ],
  ];
}

export function buildTelegramSignalIntelligenceInput(
  base: TelegramAlertInput,
  alert: ScannerAlertCandidate,
  evidence: TelegramSignalIntelligenceEvidence,
  context: TelegramSignalDeliveryContext = {},
): TelegramAlertInput {
  const events = evidence.marketEvents ?? [];
  const title = `${alert.symbol} | ${marketLabel(alert)} · ${strategyLabel(context)} · ${evidence.theme || '테마 미확인'}`;
  const lines = [
    `🚨 진입가능 · ${alert.direction} · ${context.timeframe || 'N/A'}`,
    pricePlan(alert),
  ];
  if (alert.evidence.length) lines.push(`근거: ${alert.evidence.slice(0, 5).join(' · ')}`);
  if (evidence.aiExplanation) lines.push(`AI: ${evidence.aiExplanation}`);
  if (events.length) {
    lines.push('뉴스·공시');
    events.slice(0, 2).forEach((item, index) => {
      const label = item.kind === 'NEWS' ? '뉴스' : item.kind === 'DISCLOSURE' ? '공시' : '공식';
      lines.push(`${index + 1}. [${label}] ${item.title}`);
      if (item.summary) lines.push(`AI 요약: ${item.summary}`);
    });
  } else if (evidence.news.length) {
    lines.push('뉴스');
    evidence.news.slice(0, 2).forEach((item, index) => lines.push(`${index + 1}. ${item.title}`));
  }
  if (evidence.warnings.length) lines.push(`주의: ${evidence.warnings.join(' · ')}`);

  const buttons = appButtons(alert, context);
  const linkedEvents = events.filter((item): item is TelegramMarketEventEvidence & { url: string } => Boolean(item.url)).slice(0, 2);
  if (linkedEvents.length) {
    linkedEvents.forEach((item, index) => buttons.push([{
      text: `${item.kind === 'NEWS' ? '📰 뉴스' : '🏛️ 공시'} 원문 ${index + 1}`,
      url: item.url,
    }]));
  } else {
    for (const [index, news] of evidence.news.slice(0, 2).entries()) {
      buttons.push([{ text: `📰 뉴스 원문 ${index + 1}`, url: news.url }]);
    }
  }

  const chart = evidence.chart?.status === 'READY' ? evidence.chart : null;
  return {
    ...base,
    title,
    details: lines.join('\n'),
    linkPreview: false,
    buttons,
    photo: chart ? { bytes: chart.png, filename: `${alert.symbol}-signal-evidence.png` } : undefined,
  };
}
