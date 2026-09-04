import {
  collectStockNewsDisclosureIntelligence,
  type StockNewsDisclosureIntelligenceResult,
  type StockNewsDisclosureMarket,
} from './news-disclosure-market-intelligence.service';
import type { ScannerSignalCard } from './scanner-signal.types';

export type ScannerNewsDisclosureEvidenceStatus = 'READY' | 'PARTIAL' | 'NOT_AVAILABLE' | 'TIMEOUT' | 'NOT_RUN';

export type ScannerNewsDisclosureEventView = {
  kind: 'DISCLOSURE' | 'FILING' | 'NEWS';
  headline: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
  eventType: string;
  sourceTier: string;
  freshness: 'FRESH' | 'AGING' | 'STALE' | 'EXPIRED' | 'UNKNOWN';
  routeStatus: string;
  aiStatus: 'ANALYZED' | 'SKIPPED' | 'AI_ANALYSIS_UNAVAILABLE' | 'DEFERRED' | 'NOT_RUN';
  summary: string | null;
  sentiment: string;
  importanceScore: number | null;
  confidenceScore: number | null;
  riskFlags: string[];
  catalystFlags: string[];
};

export type ScannerNewsDisclosureEvidenceSummary = {
  contract: 'ScannerNewsDisclosureEvidenceV1';
  status: ScannerNewsDisclosureEvidenceStatus;
  reason: string | null;
  eventCount: number;
  analyzedCount: number;
  aiDeferredCount: number;
  sourceStatus: {
    news: 'READY' | 'EMPTY' | 'FAILED' | 'NOT_RUN';
    filings: 'READY' | 'EMPTY' | 'FAILED' | 'NOT_RUN';
  };
  officialRiskEvents: string[];
  events: ScannerNewsDisclosureEventView[];
  warnings: string[];
  safety: {
    evidenceOnly: true;
    scoreImpact: 0;
    rankImpact: 0;
    sentimentIsPriceDirection: false;
    executionAuthority: 'NONE';
    orderAllowed: false;
  };
};

export type ScannerNewsDisclosureAugmentedCard = ScannerSignalCard & {
  newsDisclosureIntelligence: ScannerNewsDisclosureEvidenceSummary;
};

type Collector = typeof collectStockNewsDisclosureIntelligence;

export type ScannerNewsDisclosureEnrichmentOptions = {
  market: StockNewsDisclosureMarket;
  enabled?: boolean;
  disabledReason?: string;
  maxCandidates?: number;
  budgetMs?: number;
  collector?: Collector;
  signal?: AbortSignal;
};

const OFFICIAL_RISK_EVENTS = new Set([
  'DELISTING', 'DEFAULT', 'BANKRUPTCY', 'REGULATORY_ACTION', 'INVESTIGATION', 'LAWSUIT',
  'CAPITAL_RAISE', 'RIGHTS_OFFERING', 'CB', 'BW',
]);

const safety = Object.freeze({
  evidenceOnly: true as const,
  scoreImpact: 0 as const,
  rankImpact: 0 as const,
  sentimentIsPriceDirection: false as const,
  executionAuthority: 'NONE' as const,
  orderAllowed: false as const,
});

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, number));
}

function notRun(reason: string): ScannerNewsDisclosureEvidenceSummary {
  return {
    contract: 'ScannerNewsDisclosureEvidenceV1', status: 'NOT_RUN', reason,
    eventCount: 0, analyzedCount: 0, aiDeferredCount: 0,
    sourceStatus: { news: 'NOT_RUN', filings: 'NOT_RUN' },
    officialRiskEvents: [], events: [], warnings: [reason], safety,
  };
}

function timeoutSummary(): ScannerNewsDisclosureEvidenceSummary {
  return {
    contract: 'ScannerNewsDisclosureEvidenceV1', status: 'TIMEOUT', reason: 'SCANNER_NEWS_DISCLOSURE_BUDGET_TIMEOUT',
    eventCount: 0, analyzedCount: 0, aiDeferredCount: 0,
    sourceStatus: { news: 'NOT_RUN', filings: 'NOT_RUN' },
    officialRiskEvents: [], events: [], warnings: ['SCANNER_NEWS_DISCLOSURE_BUDGET_TIMEOUT'], safety,
  };
}

function notAvailableSummary(reason: string): ScannerNewsDisclosureEvidenceSummary {
  return {
    contract: 'ScannerNewsDisclosureEvidenceV1', status: 'NOT_AVAILABLE', reason,
    eventCount: 0, analyzedCount: 0, aiDeferredCount: 0,
    sourceStatus: { news: 'NOT_RUN', filings: 'NOT_RUN' },
    officialRiskEvents: [], events: [], warnings: [reason], safety,
  };
}

function summary(result: StockNewsDisclosureIntelligenceResult): ScannerNewsDisclosureEvidenceSummary {
  const events: ScannerNewsDisclosureEventView[] = result.events.slice(0, 4).map((event) => {
    const analysis = event.ai?.analysis ?? null;
    return {
      kind: event.kind,
      headline: event.headline,
      sourceName: event.sourceName,
      sourceUrl: event.sourceUrl,
      publishedAt: event.publishedAt,
      eventType: event.route?.event.eventType ?? 'UNKNOWN',
      sourceTier: event.route?.event.sourceTier ?? 'UNKNOWN',
      freshness: event.route?.freshness.state ?? 'UNKNOWN',
      routeStatus: event.route?.status ?? 'NOT_AVAILABLE',
      aiStatus: event.state === 'AI_BUDGET_DEFERRED'
        ? 'DEFERRED'
        : event.ai?.status ?? 'NOT_RUN',
      summary: analysis?.summaryShort ?? null,
      sentiment: analysis?.sentiment ?? 'UNKNOWN',
      importanceScore: analysis?.importanceScore ?? null,
      confidenceScore: analysis?.confidenceScore ?? null,
      riskFlags: analysis?.riskFlags ?? [],
      catalystFlags: analysis?.catalystFlags ?? [],
    };
  });
  const officialRiskEvents = [...new Set(events
    .filter((event) => event.sourceTier === 'TIER_1_OFFICIAL' && OFFICIAL_RISK_EVENTS.has(event.eventType))
    .map((event) => event.eventType))];
  return {
    contract: 'ScannerNewsDisclosureEvidenceV1',
    status: result.status,
    reason: null,
    eventCount: result.events.length,
    analyzedCount: result.events.filter((event) => event.ai?.status === 'ANALYZED').length,
    aiDeferredCount: result.budget.aiDeferredEvents,
    sourceStatus: result.sourceStatus,
    officialRiskEvents,
    events,
    warnings: result.warnings,
    safety,
  };
}

async function withBudget(
  promise: Promise<StockNewsDisclosureIntelligenceResult>,
  budgetMs: number,
): Promise<StockNewsDisclosureIntelligenceResult | null> {
  if (budgetMs <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function enrichStockScannerCardsWithNewsDisclosureIntelligence(
  cards: ScannerSignalCard[],
  options: ScannerNewsDisclosureEnrichmentOptions,
): Promise<ScannerNewsDisclosureAugmentedCard[]> {
  const enabled = options.enabled !== false;
  const maxCandidates = boundedInteger(options.maxCandidates, 2, 0, 3);
  const budgetMs = boundedInteger(options.budgetMs, 1_200, 0, 2_000);
  const collector = options.collector ?? collectStockNewsDisclosureIntelligence;

  if (!enabled || options.signal?.aborted || maxCandidates === 0 || budgetMs < 250) {
    const reason = options.signal?.aborted
      ? 'SCANNER_REQUEST_ABORTED'
      : options.disabledReason ?? (budgetMs < 250 ? 'SCANNER_NEWS_DISCLOSURE_BUDGET_UNAVAILABLE' : 'SCANNER_NEWS_DISCLOSURE_DISABLED');
    return cards.map((card) => Object.assign({ ...card }, { newsDisclosureIntelligence: notRun(reason) }));
  }

  const selected = cards.slice(0, maxCandidates);
  const selectedResults = await Promise.all(selected.map(async (card) => {
    const strongCandidate = card.strongSignalEligible && (card.signalGrade === 'S' || card.signalGrade === 'A');
    try {
      const result = await withBudget(collector({
        ticker: card.symbol,
        market: options.market,
        companyName: card.name,
        analysisScope: 'SCANNER',
        context: {
          scannerCandidate: strongCandidate,
          abnormalPriceMove: typeof card.changePercent === 'number' && Math.abs(card.changePercent) >= 5,
        },
        maxEvents: 3,
        maxAiEvents: strongCandidate ? 1 : 0,
      }, { timeoutMs: Math.min(1_000, budgetMs) }), budgetMs);
      return result ? summary(result) : timeoutSummary();
    } catch {
      return notAvailableSummary('SCANNER_NEWS_DISCLOSURE_COLLECTOR_FAILED');
    }
  }));

  return cards.map((card, index) => {
    const intelligence = index < selectedResults.length
      ? selectedResults[index]
      : notRun('SCANNER_EVIDENCE_BUDGET_NOT_SELECTED');
    const riskWarnings = intelligence.officialRiskEvents.map((eventType) => `MI_OFFICIAL_RISK_EVENT:${eventType}`);
    const statusWarnings = intelligence.status === 'PARTIAL'
      ? ['MI_NEWS_DISCLOSURE_PARTIAL']
      : intelligence.status === 'TIMEOUT'
        ? ['MI_NEWS_DISCLOSURE_TIMEOUT']
        : intelligence.status === 'NOT_AVAILABLE'
          ? ['MI_NEWS_DISCLOSURE_NOT_AVAILABLE']
          : [];
    return Object.assign({
      ...card,
      warnings: [...new Set([...card.warnings, ...riskWarnings, ...statusWarnings])],
    }, { newsDisclosureIntelligence: intelligence });
  });
}
