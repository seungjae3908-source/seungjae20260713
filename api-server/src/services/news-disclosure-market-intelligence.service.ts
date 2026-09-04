import type { NewsData, NewsItem } from '../sample/types';
import type { FilingItem, DisclosureItem, FilingResult } from './filing.service';
import { FilingService } from './filing.service';
import { NewsService } from './news.service';
import {
  routeNewsDisclosureMarketIntelligence,
  type MarketIntelligenceFetchOptions,
  type MarketIntelligenceMarket,
  type MarketIntelligenceNewsDisclosureRoute,
  type MarketIntelligenceNewsDisclosureRouteInput,
} from './market-intelligence-client.service';
import {
  marketIntelligenceAiAnalyzer,
  type MarketIntelligenceAiAnalysisResult,
  type MarketIntelligencePublicEvidenceInput,
} from './market-intelligence-ai-analysis.service';

export type StockNewsDisclosureMarket = 'KR' | 'US';
export type StockNewsDisclosureIntelligenceStatus = 'READY' | 'PARTIAL' | 'NOT_AVAILABLE';

type EvidenceNewsItem = NewsItem & {
  provider?: 'FINNHUB' | 'GOOGLE_NEWS';
  publishedAt?: string;
  collectedAt?: string;
  relevanceProvenance?: 'TICKER_SCOPED_PROVIDER' | 'COMPANY_NAME_QUERY';
  summaryProvenance?: 'PROVIDER_SUPPLIED' | 'NOT_PROVIDED';
};

type Candidate = {
  kind: 'DISCLOSURE' | 'FILING' | 'NEWS';
  priority: number;
  publishedAt: string | null;
  input: MarketIntelligenceNewsDisclosureRouteInput['event'];
};

export type StockNewsDisclosureIntelligenceEvent = {
  kind: Candidate['kind'];
  headline: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
  route: MarketIntelligenceNewsDisclosureRoute | null;
  ai: MarketIntelligenceAiAnalysisResult | null;
  state: 'ANALYZED' | 'ROUTED_NO_AI' | 'AI_BUDGET_DEFERRED' | 'AI_UNAVAILABLE' | 'ROUTE_UNAVAILABLE';
  reason: string | null;
};

export type StockNewsDisclosureIntelligenceResult = {
  contract: 'StockNewsDisclosureIntelligenceV1';
  status: StockNewsDisclosureIntelligenceStatus;
  ticker: string;
  market: StockNewsDisclosureMarket;
  collectedAt: string;
  events: StockNewsDisclosureIntelligenceEvent[];
  sourceStatus: {
    news: 'READY' | 'EMPTY' | 'FAILED';
    filings: 'READY' | 'EMPTY' | 'FAILED';
  };
  budget: {
    maxEvents: number;
    maxAiEvents: number;
    routedEvents: number;
    aiEligibleEvents: number;
    aiAttemptedEvents: number;
    aiDeferredEvents: number;
  };
  warnings: string[];
  safety: {
    publicEvidenceOnly: true;
    generatedFactsAllowed: false;
    executionAuthority: 'NONE';
    orderAllowed: false;
  };
};

export type StockNewsDisclosureIntelligenceInput = {
  ticker: string;
  market: StockNewsDisclosureMarket;
  companyName?: string | null;
  analysisScope?: 'CORE' | 'SCANNER' | 'CHART' | 'PORTFOLIO' | 'ASSISTANT' | 'BACKTEST' | 'SHADOW' | 'PAPER';
  context?: {
    portfolioHolding?: boolean;
    watchlist?: boolean;
    scannerCandidate?: boolean;
    abnormalPriceMove?: boolean;
    abnormalVolume?: boolean;
    historicalAnalysis?: boolean;
  };
  maxEvents?: number;
  maxAiEvents?: number;
};

type Dependencies = {
  getNews: (ticker: string) => Promise<NewsData | null>;
  getFilings: (ticker: string) => Promise<FilingResult | null>;
  route: (
    input: MarketIntelligenceNewsDisclosureRouteInput,
    options?: MarketIntelligenceFetchOptions,
  ) => Promise<MarketIntelligenceNewsDisclosureRoute>;
  analyze: (
    input: MarketIntelligencePublicEvidenceInput,
    signal?: AbortSignal,
  ) => Promise<MarketIntelligenceAiAnalysisResult>;
  now: () => number;
};

export type StockNewsDisclosureIntelligenceOptions = MarketIntelligenceFetchOptions & {
  dependencies?: Partial<Dependencies>;
};

const DEFAULT_MAX_EVENTS = 5;
const DEFAULT_MAX_AI_EVENTS = 2;
const DEFAULT_FRESHNESS = Object.freeze({
  futureToleranceMs: 5 * 60_000,
  freshMs: 6 * 60 * 60_000,
  agingMs: 24 * 60 * 60_000,
  staleMs: 72 * 60 * 60_000,
});
const safety = Object.freeze({
  publicEvidenceOnly: true as const,
  generatedFactsAllowed: false as const,
  executionAuthority: 'NONE' as const,
  orderAllowed: false as const,
});

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim().slice(0, max) : '';
}

function safeUrl(value: unknown): string | null {
  const text = cleanText(value, 1_000);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function safeIsoOrDate(value: unknown): string | null {
  const text = cleanText(value, 80);
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, parsed));
}

function marketOf(value: StockNewsDisclosureMarket): MarketIntelligenceMarket {
  return value === 'KR' ? 'KR_STOCK' : 'US_STOCK';
}

function eventTypeForFiling(row: FilingItem | DisclosureItem): string {
  const material = row.materialEventTypes ?? [];
  const direct: Array<[string, string]> = [
    ['DELISTING', 'DELISTING'],
    ['LAWSUIT', 'LAWSUIT'],
    ['M_AND_A', 'M_AND_A'],
    ['CAPITAL_RAISE', 'CAPITAL_RAISE'],
    ['BUYBACK', 'BUYBACK'],
    ['DIVIDEND', 'DIVIDEND'],
    ['EARNINGS', 'EARNINGS'],
    ['SUPPLY_CONTRACT', 'CONTRACT'],
  ];
  for (const [source, target] of direct) if (material.includes(source as never)) return target;
  const events = row.events ?? [];
  if (events.includes('RIGHTS_OFFERING')) return 'RIGHTS_OFFERING';
  if (events.includes('CB')) return 'CB';
  if (events.includes('BW')) return 'BW';
  if (events.includes('DELISTING')) return 'DELISTING';
  if (events.includes('DIVIDEND')) return 'DIVIDEND';
  if (events.includes('SUPPLY_CONTRACT')) return 'CONTRACT';
  if (events.includes('OFFERING') || events.includes('ATM')) return 'CAPITAL_RAISE';
  return 'UNKNOWN';
}

function importanceScore(row: FilingItem | DisclosureItem): number {
  return row.importance === 'CRITICAL' ? 95 : row.importance === 'IMPORTANT' ? 80 : 40;
}

function filingCandidate(
  row: FilingItem | DisclosureItem,
  kind: 'DISCLOSURE' | 'FILING',
  market: StockNewsDisclosureMarket,
  ticker: string,
  companyName: string | null,
): Candidate {
  const headline = kind === 'DISCLOSURE'
    ? cleanText((row as DisclosureItem).report, 500)
    : `${cleanText((row as FilingItem).form, 80)} ${cleanText(row.description, 400)}`.trim();
  const publishedAt = safeIsoOrDate(row.publishedAt ?? row.date);
  const materialLabels = Array.isArray(row.materialEventLabels) ? row.materialEventLabels.map(String).filter(Boolean).slice(0, 8) : [];
  const facts = [
    `공식 출처: ${row.sourceLabel}`,
    headline ? `공시: ${headline}` : '',
    publishedAt ? `공개시각: ${publishedAt}` : '',
    materialLabels.length ? `중요 이벤트: ${materialLabels.join(', ')}` : '',
    `정정상태: ${row.revisionStatus}`,
    `중요도: ${row.importance}`,
  ].filter(Boolean);
  const sourceUrl = safeUrl(row.url);
  return {
    kind,
    priority: row.importance === 'CRITICAL' ? 300 : row.importance === 'IMPORTANT' ? 200 : 100,
    publishedAt,
    input: {
      sourceId: `${row.source}:${sourceUrl ?? `${row.date}:${headline}`}`.slice(0, 200),
      sourceType: kind,
      sourceTier: 'TIER_1_OFFICIAL',
      sourceUrl,
      sourceName: row.sourceLabel,
      market: marketOf(market),
      symbol: ticker,
      companyName,
      publishedAt,
      receivedAt: safeIsoOrDate(row.collectedAt),
      headline,
      originalText: cleanText(row.description, 800) || null,
      eventType: eventTypeForFiling(row),
      direction: 'UNKNOWN',
      importanceScore: importanceScore(row),
      evidence: {
        facts,
        inferences: [],
        uncertainty: row.marketImpactStatus === 'UNVERIFIED' ? ['시장 가격 영향은 아직 검증되지 않음'] : [],
      },
    },
  };
}

function newsCandidate(
  raw: NewsItem,
  market: StockNewsDisclosureMarket,
  ticker: string,
  companyName: string | null,
): Candidate {
  const row = raw as EvidenceNewsItem;
  const headline = cleanText(row.title, 500);
  const sourceUrl = safeUrl(row.url);
  const publishedAt = safeIsoOrDate(row.publishedAt ?? row.date);
  const provider = row.provider ?? 'GOOGLE_NEWS';
  const sourceTier = provider === 'FINNHUB' ? 'TIER_3_VERIFIED_NEWS' : 'TIER_4_OTHER_VERIFIED';
  return {
    kind: 'NEWS',
    priority: 10,
    publishedAt,
    input: {
      sourceId: `${provider}:${sourceUrl ?? `${publishedAt ?? row.date}:${headline}`}`.slice(0, 200),
      sourceType: 'NEWS',
      sourceTier,
      sourceUrl,
      sourceName: cleanText(row.source, 160) || cleanText(row.sourceDomain, 160) || provider,
      market: marketOf(market),
      symbol: ticker,
      companyName,
      publishedAt,
      receivedAt: safeIsoOrDate(row.collectedAt),
      headline,
      originalText: row.summaryProvenance === 'PROVIDER_SUPPLIED' ? cleanText(row.summary, 800) || null : null,
      eventType: 'UNKNOWN',
      direction: 'UNKNOWN',
      evidence: {
        facts: [
          headline ? `기사 제목: ${headline}` : '',
          row.source ? `출처: ${cleanText(row.source, 160)}` : '',
          publishedAt ? `공개시각: ${publishedAt}` : '',
          row.summaryProvenance === 'PROVIDER_SUPPLIED' && row.summary ? `공급자 요약: ${cleanText(row.summary, 260)}` : '',
        ].filter(Boolean),
        inferences: row.tone ? [`기존 규칙 기반 톤: ${row.tone}`] : [],
        uncertainty: row.relevanceProvenance === 'COMPANY_NAME_QUERY' ? ['회사명 검색 기반 기사 연결'] : [],
      },
    },
  };
}

function newsItems(data: NewsData | null): NewsItem[] {
  if (!data) return [];
  const rows = Array.isArray(data.news) ? data.news : [...(data.positive ?? []), ...(data.negative ?? [])];
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${safeUrl(row.url) ?? ''}|${cleanText(row.title, 500)}|${cleanText(row.source, 160)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortNewest<T extends Candidate>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? ''));
  });
}

function aiInput(route: MarketIntelligenceNewsDisclosureRoute): MarketIntelligencePublicEvidenceInput {
  return {
    analysisKey: route.ai.analysisKey,
    aiMode: route.ai.mode,
    evidenceStatus: route.status,
    market: route.event.market ?? 'KR_STOCK',
    symbol: route.event.symbol,
    sourceType: route.event.sourceType,
    sourceTier: route.event.sourceTier,
    sourceName: route.event.sourceName,
    sourceUrl: route.event.sourceUrl,
    publishedAt: route.event.publishedAt,
    eventType: route.event.eventType,
    headline: route.event.headline,
    sourceText: route.event.originalText,
    evidenceFacts: route.event.evidence.facts,
    conflictDetected: route.status === 'CONFLICTING_EVIDENCE',
  };
}

function defaultDependencies(): Dependencies {
  return {
    getNews: NewsService.getNews,
    getFilings: (ticker) => FilingService.getFilings(ticker),
    route: routeNewsDisclosureMarketIntelligence,
    analyze: (input, signal) => marketIntelligenceAiAnalyzer.analyze(input, signal),
    now: Date.now,
  };
}

function routeTruthWarning(status: MarketIntelligenceNewsDisclosureRoute['status']): string | null {
  return status === 'READY' ? null : `MARKET_INTELLIGENCE_ROUTE_${status}`;
}

function usableRouteStatus(status: MarketIntelligenceNewsDisclosureRoute['status']): boolean {
  return status === 'READY' || status === 'PARTIAL_EVIDENCE' || status === 'CONFLICTING_EVIDENCE';
}

export async function collectStockNewsDisclosureIntelligence(
  input: StockNewsDisclosureIntelligenceInput,
  options: StockNewsDisclosureIntelligenceOptions = {},
): Promise<StockNewsDisclosureIntelligenceResult> {
  const ticker = cleanText(input.ticker, 40).toUpperCase();
  const companyName = cleanText(input.companyName, 200) || null;
  const maxEvents = boundedInteger(input.maxEvents, DEFAULT_MAX_EVENTS, 1, 8);
  const maxAiEvents = boundedInteger(input.maxAiEvents, DEFAULT_MAX_AI_EVENTS, 0, 3);
  const deps = { ...defaultDependencies(), ...(options.dependencies ?? {}) } as Dependencies;
  const collectedAt = new Date(deps.now()).toISOString();
  const warnings: string[] = [];

  if (!ticker || !['KR', 'US'].includes(input.market)) {
    return {
      contract: 'StockNewsDisclosureIntelligenceV1', status: 'NOT_AVAILABLE', ticker, market: input.market,
      collectedAt, events: [], sourceStatus: { news: 'EMPTY', filings: 'EMPTY' },
      budget: { maxEvents, maxAiEvents, routedEvents: 0, aiEligibleEvents: 0, aiAttemptedEvents: 0, aiDeferredEvents: 0 },
      warnings: ['STOCK_NEWS_DISCLOSURE_INPUT_INVALID'], safety,
    };
  }

  const [newsResult, filingResult] = await Promise.allSettled([deps.getNews(ticker), deps.getFilings(ticker)]);
  const news = newsResult.status === 'fulfilled' ? newsResult.value : null;
  const filings = filingResult.status === 'fulfilled' ? filingResult.value : null;
  if (newsResult.status === 'rejected') warnings.push('NEWS_PROVIDER_FAILED');
  if (filingResult.status === 'rejected') warnings.push('FILING_PROVIDER_FAILED');
  if (filings && filings.market !== input.market) warnings.push('FILING_MARKET_MISMATCH');

  const filingRows = filings && filings.market === input.market
    ? [
        ...filings.disclosures.map((row) => filingCandidate(row, 'DISCLOSURE', input.market, ticker, companyName)),
        ...filings.filings.map((row) => filingCandidate(row, 'FILING', input.market, ticker, companyName)),
      ]
    : [];
  const selectedFilings = sortNewest(filingRows).slice(0, Math.min(3, maxEvents));
  const selectedNews = sortNewest(newsItems(news).map((row) => newsCandidate(row, input.market, ticker, companyName)))
    .slice(0, Math.max(0, maxEvents - selectedFilings.length));
  const selected = [...selectedFilings, ...selectedNews];

  const sourceStatus = {
    news: newsResult.status === 'rejected' ? 'FAILED' as const : newsItems(news).length ? 'READY' as const : 'EMPTY' as const,
    filings: filingResult.status === 'rejected' ? 'FAILED' as const : filingRows.length ? 'READY' as const : 'EMPTY' as const,
  };

  if (selected.length === 0) {
    return {
      contract: 'StockNewsDisclosureIntelligenceV1',
      status: warnings.length ? 'PARTIAL' : 'NOT_AVAILABLE',
      ticker, market: input.market, collectedAt, events: [], sourceStatus,
      budget: { maxEvents, maxAiEvents, routedEvents: 0, aiEligibleEvents: 0, aiAttemptedEvents: 0, aiDeferredEvents: 0 },
      warnings: [...new Set([...warnings, 'NO_PUBLIC_NEWS_DISCLOSURE_EVIDENCE'])], safety,
    };
  }

  const events: StockNewsDisclosureIntelligenceEvent[] = [];
  const seenRawHashes: string[] = [];
  let aiEligibleEvents = 0;
  let aiAttemptedEvents = 0;
  let aiDeferredEvents = 0;

  for (const candidate of selected) {
    let route: MarketIntelligenceNewsDisclosureRoute;
    try {
      route = await deps.route({
        event: candidate.input,
        context: input.context,
        nowMs: deps.now(),
        freshnessPolicyMs: DEFAULT_FRESHNESS,
        promptVersion: 'market-intel-v1',
        analysisScope: input.analysisScope ?? 'CORE',
        seenRawHashes,
      }, options);
      seenRawHashes.push(route.event.rawHash);
      const routeWarning = routeTruthWarning(route.status);
      if (routeWarning) warnings.push(routeWarning);
    } catch (cause) {
      warnings.push('MARKET_INTELLIGENCE_ROUTE_FAILED');
      events.push({
        kind: candidate.kind,
        headline: cleanText(candidate.input.headline, 500) || null,
        sourceName: cleanText(candidate.input.sourceName, 160) || null,
        sourceUrl: safeUrl(candidate.input.sourceUrl),
        publishedAt: candidate.publishedAt,
        route: null,
        ai: null,
        state: 'ROUTE_UNAVAILABLE',
        reason: cause instanceof Error ? cause.message : 'MARKET_INTELLIGENCE_ROUTE_FAILED',
      });
      continue;
    }

    if (route.ai.mode === 'NO_AI') {
      events.push({
        kind: candidate.kind, headline: route.event.headline, sourceName: route.event.sourceName,
        sourceUrl: route.event.sourceUrl, publishedAt: route.event.publishedAt, route, ai: null,
        state: 'ROUTED_NO_AI', reason: route.reasons[0] ?? null,
      });
      continue;
    }

    aiEligibleEvents += 1;
    if (aiAttemptedEvents >= maxAiEvents) {
      aiDeferredEvents += 1;
      events.push({
        kind: candidate.kind, headline: route.event.headline, sourceName: route.event.sourceName,
        sourceUrl: route.event.sourceUrl, publishedAt: route.event.publishedAt, route, ai: null,
        state: 'AI_BUDGET_DEFERRED', reason: 'REALTIME_AI_EVENT_BUDGET_REACHED',
      });
      continue;
    }

    aiAttemptedEvents += 1;
    const ai = await deps.analyze(aiInput(route));
    events.push({
      kind: candidate.kind, headline: route.event.headline, sourceName: route.event.sourceName,
      sourceUrl: route.event.sourceUrl, publishedAt: route.event.publishedAt, route, ai,
      state: ai.status === 'ANALYZED' ? 'ANALYZED' : 'AI_UNAVAILABLE',
      reason: ai.reason,
    });
    if (ai.status !== 'ANALYZED' && ai.status !== 'SKIPPED') warnings.push('AI_ANALYSIS_PARTIAL');
  }

  const routedEvents = events.filter((event) => event.route !== null);
  const hasRoutedButNoUsableEvidence = routedEvents.length > 0
    && !routedEvents.some((event) => event.route && usableRouteStatus(event.route.status));
  const status: StockNewsDisclosureIntelligenceStatus = hasRoutedButNoUsableEvidence
    ? 'NOT_AVAILABLE'
    : warnings.length || events.some((event) => event.state === 'ROUTE_UNAVAILABLE')
      ? 'PARTIAL'
      : 'READY';
  return {
    contract: 'StockNewsDisclosureIntelligenceV1',
    status,
    ticker,
    market: input.market,
    collectedAt,
    events,
    sourceStatus,
    budget: {
      maxEvents,
      maxAiEvents,
      routedEvents: routedEvents.length,
      aiEligibleEvents,
      aiAttemptedEvents,
      aiDeferredEvents,
    },
    warnings: [...new Set(warnings)],
    safety,
  };
}
