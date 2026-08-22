import type { Candle, Timeframe } from '../sample/types';
import { answerAiChat } from './ai-chat.service';
import { getFuturesCandles } from './futures-market-data.service';
import { MarketDataService } from './market-data.service';
import { fetchPublicMarketJson } from './market-information.service';
import { NewsService } from './news.service';
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
  chart: TelegramEvidenceChartResult | null;
  warnings: string[];
};

const STOCK_TIMEFRAMES = new Set<Timeframe>(['1m', '3m', '5m', '15m', '30m', '60m', '4H', '1D', '1W', '1M']);
const FUTURES_TIMEFRAMES = new Set(['1m', '3m', '5m', '15m', '30m', '1H', '4H', '6H', '12H', '1D', '1W']);
const MAX_AI_TEXT = 900;
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

async function collectStockNews(alert: ScannerAlertCandidate): Promise<TelegramNewsEvidence[]> {
  if (alert.assetClass !== 'stock') return [];
  const data = await NewsService.getNews(alert.symbol);
  if (!data) return [];
  const seen = new Set<string>();
  return [...data.positive, ...data.negative].flatMap((item): TelegramNewsEvidence[] => {
    const url = normalizeTelegramHttpUrl(item.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{
      title: String(item.title ?? '').trim().slice(0, 180),
      source: String(item.source ?? item.sourceDomain ?? '').trim().slice(0, 80),
      url,
      publishedAt: String(item.date ?? '').trim().slice(0, 40),
      tone: typeof item.tone === 'string' ? item.tone : null,
    }];
  }).filter((item) => item.title).slice(0, MAX_NEWS);
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
    message: `다음 Scanner 사실을 바꾸거나 새 가격·확률을 만들지 말고, 실행 지시 없이 신호 근거·반대 근거·무효 조건·데이터 한계를 6문장 이내 한국어로 설명해줘. Scanner 사실: ${JSON.stringify(facts)}`,
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
  const [chartResult, newsResult, themeResult, aiResult] = await Promise.allSettled([
    collectChart(alert, timeframe),
    collectStockNews(alert),
    collectTheme(alert),
    collectAiExplanation(alert, timeframe),
  ]);

  if (chartResult.status === 'rejected') warnings.push('CHART_EVIDENCE_UNAVAILABLE');
  if (newsResult.status === 'rejected') warnings.push('NEWS_EVIDENCE_UNAVAILABLE');
  if (themeResult.status === 'rejected') warnings.push('THEME_EVIDENCE_UNAVAILABLE');
  if (aiResult.status === 'rejected') warnings.push('AI_EXPLANATION_UNAVAILABLE');

  const ai = aiResult.status === 'fulfilled' ? aiResult.value : null;
  return {
    aiExplanation: ai?.explanation ?? null,
    aiModel: ai?.model ?? null,
    aiAsOf: ai?.asOf ?? null,
    theme: themeResult.status === 'fulfilled' ? themeResult.value : null,
    news: newsResult.status === 'fulfilled' ? newsResult.value : [],
    chart: chartResult.status === 'fulfilled' ? chartResult.value : null,
    warnings,
  };
}

function pricePlan(alert: ScannerAlertCandidate): string {
  const entry = alert.entryZone ? `${alert.entryZone.from}~${alert.entryZone.to}` : 'N/A';
  const stop = alert.stopLoss == null ? 'N/A' : String(alert.stopLoss);
  const targets = alert.targets.length ? alert.targets.slice(0, 3).join(' / ') : 'N/A';
  return `진입 ${entry} · 손절 ${stop} · 목표 ${targets}`;
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

  const detail = new URL('/stock-info', url);
  detail.searchParams.set('market', market);
  detail.searchParams.set(alert.assetClass === 'stock' ? 'ticker' : 'symbol', alert.symbol);
  return [[
    { text: '📊 AI차트', url: chart.toString() },
    { text: '🔎 상세보기', url: detail.toString() },
  ]];
}

export function buildTelegramSignalIntelligenceInput(
  base: TelegramAlertInput,
  alert: ScannerAlertCandidate,
  evidence: TelegramSignalIntelligenceEvidence,
  context: TelegramSignalDeliveryContext = {},
): TelegramAlertInput {
  const lines = [
    `${alert.state} · ${alert.direction} · ${context.timeframe || '시간봉 N/A'}`,
    pricePlan(alert),
  ];
  if (alert.evidence.length) lines.push(`근거: ${alert.evidence.slice(0, 6).join(' · ')}`);
  if (evidence.theme) lines.push(`테마/섹터: ${evidence.theme}`);
  if (evidence.aiExplanation) lines.push(`AI 설명: ${evidence.aiExplanation}`);
  if (evidence.news.length) {
    lines.push('관련 뉴스:');
    evidence.news.forEach((item, index) => lines.push(`${index + 1}. ${item.source || '출처 미상'} · ${item.title}`));
  }
  if (evidence.warnings.length) lines.push(`누락: ${evidence.warnings.join(', ')}`);

  const buttons = appButtons(alert, context);
  for (const [index, news] of evidence.news.slice(0, 2).entries()) {
    buttons.push([{ text: `📰 뉴스 원문 ${index + 1}`, url: news.url }]);
  }

  const chart = evidence.chart?.status === 'READY' ? evidence.chart : null;
  if (evidence.chart?.status === 'UNAVAILABLE') lines.push(`차트: ${evidence.chart.reason}`);

  return {
    ...base,
    details: lines.join('\n'),
    linkPreview: evidence.news.length > 0,
    buttons,
    photo: chart ? { bytes: chart.png, filename: `${alert.symbol}-signal-evidence.png` } : undefined,
  };
}
