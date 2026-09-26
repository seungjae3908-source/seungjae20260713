import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, FileText, Newspaper, ShieldCheck } from 'lucide-react';
import type { AnalysisSelection } from '@/lib/analysis-selection';
import { authorizedFetch } from '@/lib/auth-fetch';
import { cn } from '@/lib/utils';

type EvidenceEvent = {
  kind: 'DISCLOSURE' | 'FILING' | 'NEWS';
  headline: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
  state: 'ANALYZED' | 'ROUTED_NO_AI' | 'AI_BUDGET_DEFERRED' | 'AI_UNAVAILABLE' | 'ROUTE_UNAVAILABLE';
  reason: string | null;
  route: null | {
    status: string;
    freshness: { state: string; ageMs: number | null; reason: string | null };
    event: { eventType: string; evidence: { facts: string[]; uncertainty: string[] } };
    safety: {
      executionAuthority: 'NONE';
      orderAllowed: false;
      sentimentIsPriceDirection: false;
      fabricatedEvidenceAllowed: false;
    };
  };
  ai: null | {
    status: 'ANALYZED' | 'SKIPPED' | 'AI_ANALYSIS_UNAVAILABLE';
    reason: string | null;
    model: string | null;
    analysis?: {
      summaryShort: string;
      sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'MIXED' | 'UNKNOWN';
      importanceScore: number;
      confidenceScore: number;
      impactHorizon: string;
      inferences: string[];
      uncertainty: string[];
      riskFlags: string[];
      catalystFlags: string[];
    } | null;
  };
};

type EvidenceResult = {
  contract: 'StockNewsDisclosureIntelligenceV1';
  status: 'READY' | 'PARTIAL' | 'NOT_AVAILABLE';
  ticker: string;
  market: 'KR' | 'US';
  collectedAt: string;
  events: EvidenceEvent[];
  sourceStatus: { news: 'READY' | 'EMPTY' | 'FAILED'; filings: 'READY' | 'EMPTY' | 'FAILED' };
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

type EvidenceEnvelope = {
  ok: boolean;
  available: boolean;
  cache?: 'HIT' | 'MISS' | 'IN_FLIGHT_REUSE';
  result: EvidenceResult | null;
  chartPolicy: {
    evidenceOnly: true;
    scoreImpact: 0;
    probabilityImpact: 0;
    sentimentIsPriceDirection: false;
    executionAuthority: 'NONE';
    orderAllowed: false;
    maxAiEvents: number;
    serverCacheTtlMs?: number;
  };
};

function isStockMarket(market: AnalysisSelection['market']): market is 'KR' | 'US' {
  return market === 'KR' || market === 'US';
}

function formatTime(value: string | null): string {
  if (!value) return '시각 미확인';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '시각 미확인';
  return new Date(timestamp).toLocaleString('ko-KR', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function freshnessLabel(value: string | undefined): string {
  return ({
    FRESH: '신선', AGING: '경과', STALE: '오래됨', EXPIRED: '만료', UNKNOWN: '신선도 미확인',
  } as Record<string, string>)[String(value ?? 'UNKNOWN')] ?? '신선도 미확인';
}

function statusLabel(status: EvidenceResult['status'] | 'LOADING' | 'ERROR' | 'NOT_CONNECTED'): string {
  return ({
    READY: 'READY', PARTIAL: 'PARTIAL', NOT_AVAILABLE: 'NOT AVAILABLE',
    LOADING: 'LOADING', ERROR: 'UNAVAILABLE', NOT_CONNECTED: 'NOT CONNECTED',
  } as const)[status];
}

function statusClass(status: EvidenceResult['status'] | 'LOADING' | 'ERROR' | 'NOT_CONNECTED'): string {
  if (status === 'READY') return 'border-positive/30 bg-positive/10 text-positive';
  if (status === 'PARTIAL' || status === 'LOADING') return 'border-warning/30 bg-warning/10 text-warning';
  return 'border-card-border bg-background text-muted-foreground';
}

function eventIcon(kind: EvidenceEvent['kind']) {
  return kind === 'NEWS'
    ? <Newspaper className="h-4 w-4" aria-hidden="true" />
    : <FileText className="h-4 w-4" aria-hidden="true" />;
}

function validateEnvelope(payload: EvidenceEnvelope): EvidenceEnvelope {
  const policy = payload.chartPolicy;
  const result = payload.result;
  const safePolicy = policy?.evidenceOnly === true
    && policy.scoreImpact === 0
    && policy.probabilityImpact === 0
    && policy.sentimentIsPriceDirection === false
    && policy.executionAuthority === 'NONE'
    && policy.orderAllowed === false;
  const safeResult = !result || (
    result.safety.publicEvidenceOnly === true
    && result.safety.generatedFactsAllowed === false
    && result.safety.executionAuthority === 'NONE'
    && result.safety.orderAllowed === false
  );
  if (!safePolicy || !safeResult) throw new Error('MARKET_INTELLIGENCE_UNSAFE_CHART_EVIDENCE');
  return payload;
}

async function fetchEvidence(selection: AnalysisSelection, signal?: AbortSignal): Promise<EvidenceEnvelope> {
  const params = new URLSearchParams({ market: selection.market, ticker: selection.ticker });
  const response = await authorizedFetch(`/api/market-intelligence/news-disclosure?${params.toString()}`, {
    method: 'GET', cache: 'no-store', signal,
  });
  const payload = await response.json().catch(() => ({})) as EvidenceEnvelope & { error?: string };
  if (!response.ok) throw new Error(payload.error || `HTTP_${response.status}`);
  return validateEnvelope(payload);
}

export function AiChartMarketIntelligenceEvidencePanel({ selection }: { selection: AnalysisSelection }) {
  const stock = isStockMarket(selection.market);
  const query = useQuery({
    queryKey: ['ai-chart-market-intelligence-evidence', selection.market, selection.ticker],
    queryFn: ({ signal }) => fetchEvidence(selection, signal),
    enabled: stock && Boolean(selection.ticker),
    staleTime: 60_000,
    gcTime: 15 * 60_000,
    refetchInterval: stock ? 120_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 0,
  });

  const result = query.data?.result ?? null;
  const state: EvidenceResult['status'] | 'LOADING' | 'ERROR' | 'NOT_CONNECTED' = !stock
    ? 'NOT_CONNECTED'
    : query.isLoading
      ? 'LOADING'
      : query.isError
        ? 'ERROR'
        : result?.status ?? 'NOT_AVAILABLE';
  const events = result?.events ?? [];

  return (
    <section data-testid="ai-chart-market-intelligence-evidence" className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-extrabold text-primary">News · Disclosure Intelligence</p>
          <h2 className="mt-1 text-sm font-black">뉴스·공시 Evidence</h2>
          <p className="mt-1 text-[10px] font-bold leading-4 text-muted-foreground">공식 공시를 우선하고, AI는 확인된 공개 근거의 요약·리스크·촉매만 보조합니다.</p>
        </div>
        <span data-testid="ai-chart-market-intelligence-state" className={cn('shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-black', statusClass(state))}>
          {statusLabel(state)}
        </span>
      </div>

      {!stock ? (
        <div className="mt-3 rounded-2xl bg-background p-3 text-xs font-bold leading-5 text-muted-foreground">
          코인 현물·선물의 뉴스·거래소 공지 Intelligence는 아직 이 패널에 연결되지 않았습니다. 미연결 상태를 근거처럼 생성하지 않습니다.
        </div>
      ) : query.isLoading ? (
        <div className="mt-3 rounded-2xl bg-background p-3 text-xs font-bold text-muted-foreground">공개 뉴스·공시 근거를 확인하는 중입니다.</div>
      ) : query.isError ? (
        <div className="mt-3 flex items-start gap-2 rounded-2xl border border-warning/30 bg-warning/5 p-3 text-xs font-bold leading-5 text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>뉴스·공시 Intelligence를 사용할 수 없습니다. 차트 기술분석은 유지되며 이 오류 때문에 임의의 호재·악재를 만들지 않습니다.</span>
        </div>
      ) : events.length === 0 ? (
        <div className="mt-3 rounded-2xl bg-background p-3 text-xs font-bold text-muted-foreground">현재 확인된 공개 뉴스·공시 Evidence가 없습니다.</div>
      ) : (
        <div className="mt-3 max-h-[420px] space-y-2 overflow-y-auto">
          {events.map((event, index) => {
            const analysis = event.ai?.analysis ?? null;
            const riskFlags = analysis?.riskFlags?.slice(0, 3) ?? [];
            const catalystFlags = analysis?.catalystFlags?.slice(0, 3) ?? [];
            return (
              <article key={`${event.kind}:${event.sourceUrl ?? event.headline ?? index}`} data-testid="ai-chart-market-intelligence-event" className="rounded-2xl border border-card-border bg-background p-3">
                <div className="flex items-start gap-2">
                  <div className="mt-0.5 text-primary">{eventIcon(event.kind)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-[9px] font-black text-muted-foreground">
                      <span>{event.kind}</span>
                      <span>·</span>
                      <span>{event.sourceName || '출처 미확인'}</span>
                      <span>·</span>
                      <span>{formatTime(event.publishedAt)}</span>
                      <span>·</span>
                      <span>{freshnessLabel(event.route?.freshness.state)}</span>
                    </div>
                    <p className="mt-1 break-keep text-xs font-black leading-5">{event.headline || '제목 미확인'}</p>
                    <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-bold text-muted-foreground">
                      <span className="rounded-full bg-secondary px-2 py-0.5">{event.route?.event.eventType || 'UNKNOWN'}</span>
                      <span className="rounded-full bg-secondary px-2 py-0.5">{event.state}</span>
                      {analysis && <span className="rounded-full bg-secondary px-2 py-0.5">중요도 {analysis.importanceScore}/100</span>}
                      {analysis && <span className="rounded-full bg-secondary px-2 py-0.5">AI 신뢰 {analysis.confidenceScore}/100</span>}
                    </div>
                    {analysis?.summaryShort && <p className="mt-2 break-keep text-[11px] font-bold leading-5 text-foreground">{analysis.summaryShort}</p>}
                    {(riskFlags.length > 0 || catalystFlags.length > 0) && (
                      <div className="mt-2 grid gap-1 text-[10px] sm:grid-cols-2">
                        <p className="rounded-xl bg-warning/5 px-2 py-1.5 font-bold text-muted-foreground">리스크: {riskFlags.length ? riskFlags.join(', ') : '확인 없음'}</p>
                        <p className="rounded-xl bg-primary/5 px-2 py-1.5 font-bold text-muted-foreground">촉매: {catalystFlags.length ? catalystFlags.join(', ') : '확인 없음'}</p>
                      </div>
                    )}
                    {event.sourceUrl && (
                      <a href={event.sourceUrl} target="_blank" rel="noreferrer noopener" className="mt-2 inline-flex items-center gap-1 text-[10px] font-black text-primary">
                        원문 근거 <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {result?.warnings?.length ? (
        <p className="mt-2 text-[10px] font-bold text-warning">부분 근거: {result.warnings.slice(0, 3).join(' · ')}</p>
      ) : null}

      <div className="mt-3 flex items-start gap-2 rounded-2xl border border-card-border bg-background p-3 text-[10px] font-bold leading-4 text-muted-foreground">
        <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
        <span>Evidence-only · 차트/Scanner 점수 영향 0 · 확률 영향 0 · 감성은 가격방향이 아님 · 실행권한 NONE · 주문 허용 false · AI 최대 1 이벤트 · 서버 캐시 60초</span>
      </div>
    </section>
  );
}
