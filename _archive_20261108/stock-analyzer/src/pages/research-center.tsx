import { type FormEvent, type KeyboardEvent, type ReactNode, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BadgeCheck,
  Bot,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Database,
  FileCheck2,
  FileSearch,
  FlaskConical,
  Gauge,
  History,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  WalletCards,
} from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { ResearchDetailDialog } from '@/components/research-detail-dialog';
import { useAuth } from '@/lib/auth';
import { PaperClosedLoopObserver } from '@/components/paper-closed-loop-observer';
import { fetchResearchCenterOverview, type ResearchCandidatePerformance, type ResearchCenterOverview } from '@/lib/research-center';
import { ResearchLightweightMarketWatchPanel } from '@/components/research-lightweight-market-watch-panel';
import { ResearchPITMinuteCoveragePanel } from '@/components/research-pit-minute-coverage';
import {
  answerCanonicalResearchQuestion,
  buildFullCostRows,
  buildResearchPipeline,
  classifySha,
  formatCanonicalMetric,
  isFullCostReady,
  statusLabel,
  type CostDisplayRow,
  type ProductMetric,
  type ResearchPipelineCard,
  type ResearchPipelineKey,
  type ResearchProductStatus,
} from '@/lib/research-center-product';
import { buildDebatePreview, extractResearchAiDebate } from '@/lib/research-center-view';
import { fetchResearchJournalBinding, type ResearchJournalBindingReadback } from '@/lib/research-journal-binding';
import { fetchStrategyPromotions, type StrategyPromotionResponse } from '@/lib/strategy-promotion';

export type ResearchTab = 'overview' | 'ai-lab' | 'evidence' | 'paper';

const TABS: Array<{ key: ResearchTab; label: string; icon: typeof Activity }> = [
  { key: 'overview', label: '연구 현황', icon: Activity },
  { key: 'ai-lab', label: 'AI 분석실', icon: BrainCircuit },
  { key: 'evidence', label: '검증 리포트', icon: FileSearch },
  { key: 'paper', label: '모의매매', icon: WalletCards },
];

const STATUS_STYLE: Readonly<Record<ResearchProductStatus, string>> = {
  normal: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  verified: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  validating: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  running: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  accumulating: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  waiting: 'border-border bg-muted/50 text-muted-foreground',
  insufficient: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  unmeasured: 'border-border bg-muted/50 text-muted-foreground',
  attention: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  inactive: 'border-border bg-muted/50 text-muted-foreground',
  stale: 'border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300',
};

function formatDate(value: string | number | null | undefined): string {
  if (value == null) return '미측정';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '미측정';
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(date);
}

function StatusBadge({ status }: { status: ResearchProductStatus }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-[11px] font-black ${STATUS_STYLE[status]}`}>
      {statusLabel(status)}
    </span>
  );
}

function blockerCopy(card: ResearchPipelineCard): string {
  if (!card.blocker) return '명시적 차단 사유 없음';
  if (card.evidenceState === 'WRONG_SHA') return 'Source SHA 불일치 · 확인 필요';
  if (card.status === 'stale') return '오래된 근거 · 재확인 필요';
  if (card.status === 'inactive') return '현재 런타임 미활성';
  if (card.evidenceState === 'MISSING') return '검증 근거 미수집';
  return '검증 자료 보완 필요';
}

function MetricValue({ metric, compact = false }: { metric: ProductMetric; compact?: boolean }) {
  return (
    <div className={`min-w-0 rounded-xl bg-background/80 ${compact ? 'px-2.5 py-2' : 'p-3'}`}>
      <dt className="break-words text-[10px] font-bold text-muted-foreground">{metric.label}</dt>
      <dd className={`${compact ? 'mt-0.5 text-xs' : 'mt-1 text-sm'} break-words font-black tabular-nums`}>
        {metric.value}
      </dd>
    </div>
  );
}

function PipelineCard({ card, selected, onOpen }: {
  card: ResearchPipelineCard;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={selected}
      aria-label={`${card.label} 상세 보기`}
      aria-controls={card.key === 'paper' ? 'research-tab-paper' : 'research-stage-detail'}
      className={`group min-w-0 rounded-2xl border bg-card p-3 text-left shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${selected ? 'border-primary ring-1 ring-primary/30' : 'border-card-border hover:border-primary/40'}`}
      data-testid={`research-stage-${card.key}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 break-keep text-sm font-black">{card.label}</h3>
        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5" aria-hidden="true" />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <StatusBadge status={card.status} />
        <span className="truncate text-[10px] text-muted-foreground">{formatDate(card.updatedAt)}</span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-1.5">
        {(card.metrics.length ? card.metrics : [
          { label: '표본', value: '미측정', availability: 'MISSING' as const },
        ]).slice(0, 3).map((metric) => <MetricValue key={metric.label} metric={metric} compact />)}
      </dl>
    </button>
  );
}

function StageDetail({ card }: { card: ResearchPipelineCard }) {
  return (
    <aside id="research-stage-detail" className="min-w-0 rounded-3xl border border-card-border bg-card p-4 shadow-sm lg:sticky lg:top-4 lg:self-start" aria-live="polite" data-testid={`research-detail-${card.key}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-primary">선택한 연구 단계</p>
          <h2 className="mt-1 text-lg font-black">{card.label}</h2>
        </div>
        <StatusBadge status={card.status} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {card.metrics.map((metric) => <MetricValue key={metric.label} metric={metric} />)}
      </dl>
      <div className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
        <div className="rounded-xl border border-card-border bg-background p-3">
          <p className="text-muted-foreground">최근 업데이트</p>
          <p className="mt-1 font-bold">{formatDate(card.updatedAt)}</p>
        </div>
        <div className="rounded-xl border border-card-border bg-background p-3">
          <p className="text-muted-foreground">근거 상태</p>
          <p className="mt-1 font-bold">{card.evidenceState === 'PRESENT' ? '수집됨' : card.evidenceState === 'WRONG_SHA' ? '버전 불일치' : card.evidenceState === 'STALE' ? '갱신 지연' : '확인 필요'}</p>
        </div>
      </div>
      {card.blocker ? (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
          <p className="font-black text-amber-700 dark:text-amber-300">현재 막힌 이유</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{blockerCopy(card)}</p>
        </div>
      ) : null}
      {card.records.length ? (
        <div className="mt-4 space-y-2">
          <h3 className="text-xs font-black">원본 검증 기록</h3>
          <div className="max-h-[31rem] space-y-2 overflow-y-auto pr-1">
            {card.records.map((record) => (
              <details key={record.id} className="group rounded-xl border border-card-border bg-background">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 p-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                  <span className="min-w-0 truncate font-black">{record.label}</span>
                  <span className="flex shrink-0 items-center gap-2"><StatusBadge status={record.status} /><ChevronDown className="h-3.5 w-3.5 transition group-open:rotate-180" /></span>
                </summary>
                <div className="border-t border-card-border p-3 text-[11px]">
                  <dl className="grid grid-cols-2 gap-2">
                    <div><dt className="text-muted-foreground">기간</dt><dd className="mt-1 break-words font-bold">{record.period}</dd></div>
                    <div><dt className="text-muted-foreground">표본</dt><dd className="mt-1 font-bold">{record.sampleN}</dd></div>
                    <div><dt className="text-muted-foreground">데이터 식별자</dt><dd className="mt-1 break-all font-mono">{record.datasetId ?? '미측정'}</dd></div>
                    <div><dt className="text-muted-foreground">소스 버전</dt><dd className="mt-1 break-all font-mono">{record.sourceSha ?? '미측정'}</dd></div>
                  </dl>
                  <dl className="mt-3 grid grid-cols-2 gap-2">
                    {record.metrics.map((metric) => <MetricValue key={metric.label} metric={metric} compact />)}
                  </dl>
                  <details className="mt-3 rounded-lg border border-card-border p-2">
                    <summary className="min-h-8 cursor-pointer font-bold">검증 근거 보기</summary>
                    <p className="mt-2 break-all text-muted-foreground">출처: {record.source}</p>
                    <p className="mt-1 text-muted-foreground">차단 사유: {record.blocker ? '검증 근거 확인 필요' : '없음'}</p>
                    <ul className="mt-2 space-y-1 text-muted-foreground">
                      {record.provenance.length ? record.provenance.map((line) => <li key={line}>• {line}</li>) : <li>• 출처 미측정</li>}
                    </ul>
                  </details>
                </div>
              </details>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-dashed border-card-border p-4 text-center text-xs text-muted-foreground">
          조회할 상세 기록이 없습니다.
        </div>
      )}
    </aside>
  );
}

function TopStatus({ label, value, status }: { label: string; value: string; status: ResearchProductStatus; detail: string }) {
  return (
    <article className="min-w-0 rounded-2xl border border-card-border bg-card p-3 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-bold text-muted-foreground">{label}</p>
        <StatusBadge status={status} />
      </div>
      <p className="mt-2 break-words text-sm font-black">{value}</p>
    </article>
  );
}

function LoadingState() {
  return (
    <section className="space-y-3" aria-label="연구센터 불러오는 중" aria-busy="true" data-testid="research-loading-state">
      <span className="sr-only">연구 상태를 불러오는 중입니다.</span>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => <div key={index} className="h-24 animate-pulse rounded-2xl bg-muted" />)}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => <div key={index} className="h-32 animate-pulse rounded-2xl bg-muted" />)}
      </div>
    </section>
  );
}

function OverviewTab({ overview, promotion, cards, selected, onSelect }: {
  overview: ResearchCenterOverview;
  promotion: StrategyPromotionResponse | null;
  cards: ResearchPipelineCard[];
  selected: ResearchPipelineKey | null;
  onSelect: (key: ResearchPipelineKey | null) => void;
}) {
  const selectedCard = cards.find((card) => card.key === selected) ?? cards[0]!;
  const paper = cards.find((card) => card.key === 'paper')!;
  const systemStatus: ResearchProductStatus = overview.safety.forbiddenAuthorityObserved
    ? 'error'
    : !overview.safety.authorityEvidenceComplete
      ? 'attention'
      : overview.state.present
        ? 'normal'
        : 'insufficient';
  const staleCount = cards.filter((card) => card.status === 'stale').length;
  const runtimeLiveness = overview.state.runtimeLiveness;
  const runtimeStale = runtimeLiveness?.stale === true;
  const updateStatus: ResearchProductStatus = runtimeLiveness?.status === 'INVALID'
    ? 'error'
    : runtimeStale || staleCount > 0
      ? 'stale'
      : runtimeLiveness?.status === 'LIVE'
        ? 'normal'
        : overview.state.latestCycleAt
          ? 'normal'
          : 'unmeasured';
  const updateDetail = runtimeLiveness?.status === 'LIVE'
    ? `heartbeat 정상 · missed ${runtimeLiveness.missedCycles ?? 0}`
    : runtimeLiveness?.status === 'STALE'
      ? `heartbeat 지연 · missed ${runtimeLiveness.missedCycles ?? 0}`
      : runtimeLiveness?.status === 'INVALID'
        ? 'heartbeat 시각 무결성 오류'
        : staleCount
          ? `오래된 단계 ${staleCount}개`
          : 'heartbeat 미수집';
  const factory = overview.factory ?? {
    present: false,
    status: 'MISSING' as const,
    generatedAt: null,
    researchSha: null,
    firstZero: null,
    policyPresent: null,
    policyValid: null,
    policyDigest: null,
    readyMarketCount: null,
    blockedMarketCount: null,
    readyProfileCount: null,
    blockedProfileCount: null,
    runtimeStatus: null,
    nextFirstZero: null,
    controlPlaneDigest: null,
  };
  const factoryStatus: ResearchProductStatus = !factory.present
    ? 'unmeasured'
    : factory.status === 'INVALID' || factory.status === 'BLOCKED_POLICY_INVALID'
      ? 'error'
      : factory.status === 'READY_NON_ACTIVATING'
        ? 'normal'
        : 'attention';
  const factoryValue = factory.status === 'READY_NON_ACTIVATING'
    ? '검증 준비'
    : factory.status === 'BLOCKED_POLICY_MISSING'
      ? '정책 미확정'
      : factory.status === 'BLOCKED_NO_READY_PROFILES'
        ? '데이터 대기'
        : factory.status === 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_MISSING'
          ? '개발 진단 필요'
          : factory.status === 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_INVALID'
            ? '개발 진단 오류'
            : factory.status === 'BLOCKED_RUNTIME_BINDINGS'
              ? '연결 대기'
              : factory.status === 'BLOCKED_POLICY_INVALID'
                ? '정책 오류'
                : factory.status === 'INVALID'
                  ? '근거 오류'
                  : '미측정';
  const factoryDetail = factory.present
    ? `시장 ${factory.readyMarketCount ?? '—'}/4 · 프로필 ${factory.readyProfileCount ?? '—'}/12 · ${factory.firstZero ?? 'FIRST_ZERO 미확인'}`
    : 'Factory runtime status 미수집';
  const temporal = overview.dataFactory?.temporalCryptoFutures ?? {
    present: false,
    status: 'MISSING' as const,
    generatedAt: null,
    researchSha: null,
    failedCount: null,
    observationCount: null,
    ledgerDigest: null,
    results: [],
  };
  const temporalStatus: ResearchProductStatus = !temporal.present
    ? 'unmeasured'
    : temporal.status === 'INVALID'
      ? 'error'
      : temporal.status === 'partial_failure'
        ? 'attention'
        : 'accumulating';
  const temporalDetail = !temporal.present
    ? 'Temporal evidence 미수집'
    : temporal.status === 'INVALID'
      ? 'Temporal evidence 무결성 확인 필요'
      : `${temporal.results.length}개 심볼 · 실패 ${temporal.failedCount ?? 0}개`;
  const formulaBacktest = overview.research.formulaBacktest;
  const formulaStatus: ResearchProductStatus = formulaBacktest?.status === 'INVALID'
    ? 'error'
    : formulaBacktest?.status === 'TRAIN_ONLY'
      ? 'attention'
      : 'unmeasured';
  const formulaValue = formulaBacktest?.status === 'TRAIN_ONLY'
    ? `TRAIN ${formulaBacktest.scanned ?? '—'}건`
    : formulaBacktest?.status === 'WAITING_INPUT'
      ? '후보 대기'
      : formulaBacktest?.status === 'INVALID'
        ? '자료 오류'
        : '미연결';
  const formulaDetail = formulaBacktest?.status === 'TRAIN_ONLY'
    ? `입력 ${formulaBacktest.inboxCount ?? '—'}건 · OOS·비용 미검증 · Paper 미연결`
    : formulaBacktest?.status === 'INVALID'
      ? '저장된 백테스터 결과 무결성 확인 필요'
      : '공인된 후보 생산자·Paper 소비자 증거 없음';
  return (
    <section id="research-tab-overview" role="tabpanel" aria-labelledby="research-tab-overview-trigger" className="space-y-4" data-testid="research-overview-tab">
      <section className="grid grid-cols-2 gap-2 lg:grid-cols-4 xl:grid-cols-8" aria-label="연구 핵심 상태">
        <TopStatus label="연구 시스템" value={statusLabel(systemStatus)} status={systemStatus} detail={overview.state.present ? 'Canonical overview 연결됨' : 'Canonical evidence 미수집'} />
        <TopStatus label="데이터 팩토리" value={temporal.observationCount == null ? statusLabel(temporalStatus) : `${temporal.observationCount.toLocaleString('ko-KR')}건`} status={temporalStatus} detail={temporalDetail} />
        <TopStatus label="리서치 팩토리" value={factoryValue} status={factoryStatus} detail={factoryDetail} />
        <div data-testid="research-formula-backtest-status"><TopStatus label="자동 백테스터" value={formulaValue} status={formulaStatus} detail={formulaDetail} /></div>
        <TopStatus label="실거래" value="비활성" status="inactive" detail="executionAuthority=NONE" />
        <TopStatus label="모의매매" value={statusLabel(paper.status)} status={paper.status} detail={blockerCopy(paper)} />
        <TopStatus label="수익성 검증" value={overview.profitability.proven ? '충족' : '미검증'} status={overview.profitability.proven ? 'verified' : 'waiting'} detail="미검증은 수익성 없음과 다릅니다" />
        <TopStatus label="마지막 업데이트" value={formatDate(runtimeLiveness?.lastSuccessAt ?? overview.state.latestCycleAt)} status={updateStatus} detail={updateDetail} />
      </section>

      <ResearchLightweightMarketWatchPanel
        watch={overview.dataFactory?.lightweightMarketWatch}
        cadence={overview.dataFactory?.lightweightMarketWatchCadence}
      />

      {!promotion ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs" role="status" data-testid="research-partial-state">
          전략 검증 기록을 불러오지 못했습니다.
        </div>
      ) : null}

      <div>
        <section className="min-w-0" aria-labelledby="research-pipeline-title">
          <div className="mb-3 flex items-end justify-between gap-3">
            <h2 id="research-pipeline-title" className="text-base font-black">연구 단계</h2>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {cards.map((card) => (
              <PipelineCard
                key={card.key}
                card={card}
                selected={selected === card.key}
                onOpen={() => onSelect(card.key)}
              />
            ))}
          </div>
        </section>
        {selected ? <ResearchDetailDialog title={selectedCard.label} onClose={() => onSelect(null)}><StageDetail card={selectedCard} /></ResearchDetailDialog> : null}
      </div>
    </section>
  );
}

function InsightCard({ title, icon: Icon, children }: { title: string; icon: typeof Activity; children: ReactNode }) {
  return (
    <article className="min-w-0 rounded-2xl border border-card-border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2"><Icon className="h-4 w-4 text-primary" aria-hidden="true" /><h2 className="text-sm font-black">{title}</h2></div>
      <div className="mt-3 text-xs leading-5 text-muted-foreground">{children}</div>
    </article>
  );
}

function AiLabTab({ overview, cards }: { overview: ResearchCenterOverview; cards: ResearchPipelineCard[] }) {
  const debate = extractResearchAiDebate(overview as unknown);
  const preview = buildDebatePreview(overview);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('저장된 연구 기록에서 검색합니다.');
  const firstBlocker = cards.find((card) => card.blocker) ?? null;
  function submit(event: FormEvent) {
    event.preventDefault();
    setAnswer(answerCanonicalResearchQuestion(question, overview, cards));
  }
  return (
    <section id="research-tab-ai-lab" role="tabpanel" aria-labelledby="research-tab-ai-lab-trigger" className="space-y-4" data-testid="research-ai-lab-tab">
      <div className="rounded-3xl border border-card-border bg-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] font-black uppercase tracking-[0.18em] text-primary"></p><h2 className="mt-1 text-lg font-black">AI 분석실</h2></div><StatusBadge status={debate.actualEvidence ? 'accumulating' : 'unmeasured'} /></div>
        <p className="mt-2 text-xs text-muted-foreground">{debate.actualEvidence ? debate.finalLabel : 'AI 분석 근거 미수집'}</p>
      </div>

      {debate.actualEvidence ? <div className="grid gap-3 md:grid-cols-2">
        <InsightCard title="모델 간 합의" icon={BadgeCheck}><ul className="space-y-1">{preview.support.map((line) => <li key={line}>{line}</li>)}</ul></InsightCard>
        <InsightCard title="모델 간 의견 차이" icon={MessageSquareText}><p>{debate.conflictReason ?? '명시적 충돌 근거 없음'}</p></InsightCard>
      </div> : null}

      {debate.actualEvidence ? (
        <section className="grid gap-3 md:grid-cols-2" aria-label="실제 AI 분석 근거">
          {[debate.ai1, debate.ai2, ...debate.committee].filter(Boolean).map((review) => (
            <article key={review!.label} className="rounded-2xl border border-card-border bg-card p-4">
              <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-black">{review!.label}</h3><span className="text-[10px] text-muted-foreground">{review!.conclusion ?? '결론 미측정'}</span></div>
              <p className="mt-1 text-[10px] text-muted-foreground">{[review!.provider, review!.model].filter(Boolean).join(' · ') || '제공자 미확인'}</p>
              <ul className="mt-3 space-y-2 text-xs text-muted-foreground">{review!.lines.map((line) => <li key={line} className="rounded-xl bg-background p-3">{line}</li>)}</ul>
            </article>
          ))}
        </section>
      ) : null}

      <form onSubmit={submit} className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" aria-label="연구 기록 검색">
        <div className="flex items-center gap-2"><Bot className="h-4 w-4 text-primary" /><h2 className="text-sm font-black">연구 기록 검색</h2></div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <label className="sr-only" htmlFor="research-question">연구 근거 질문</label>
          <input id="research-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="예: 수익성은 검증됐나요?" className="min-h-11 min-w-0 flex-1 rounded-xl border border-card-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary" />
          <button type="submit" className="min-h-11 rounded-xl bg-primary px-4 text-sm font-black text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">근거에서 찾기</button>
        </div>
        <output className="mt-3 block rounded-xl border border-card-border bg-background p-3 text-xs leading-5" aria-live="polite">{answer}</output>
      </form>
      <details className="rounded-2xl border border-card-border bg-card p-3 text-xs">
        <summary className="min-h-11 cursor-pointer py-3 font-bold">분석 진단</summary>
        <p>기록 갱신 · {formatDate(overview.state.latestCycleAt)}</p>
        <p>{firstBlocker ? `${firstBlocker.label} · ${blockerCopy(firstBlocker)}` : '명시적 차단 사유 없음'}</p>
        <ul>{preview.verify.slice(0, 4).map(line => <li key={line}>{line}</li>)}</ul>
        <p>기록 검색은 AI 호출이 아닙니다. AI 분석은 정성 의견이며 성과 수치 생성이나 실거래 승인 권한이 없습니다.</p>
      </details>
    </section>
  );
}

function EvidenceItem({ label, value, state = 'unmeasured' }: { label: string; value: string; state?: ResearchProductStatus }) {
  return (
    <div className="min-w-0 rounded-xl border border-card-border bg-background p-3">
      <dt className="text-[10px] font-bold text-muted-foreground">{label}</dt>
      <dd className="mt-1 flex min-w-0 items-center justify-between gap-2"><span className="min-w-0 break-all font-mono text-[11px] font-bold">{value}</span><StatusBadge status={state} /></dd>
    </div>
  );
}

function EvidenceTab({ overview, promotion, cards }: {
  overview: ResearchCenterOverview;
  promotion: StrategyPromotionResponse | null;
  cards: ResearchPipelineCard[];
}) {
  const factory = overview.factory;
  const sourceSha = promotion?.sourceSha && /^[0-9a-f]{40}$/i.test(promotion.sourceSha) ? promotion.sourceSha : null;
  const runtimeSha = factory?.researchSha && /^[0-9a-f]{40}$/i.test(factory.researchSha) ? factory.researchSha : null;
  const binding = sourceSha && runtimeSha ? classifySha(sourceSha, runtimeSha) : 'MISSING';
  const wrongSha = binding === 'WRONG_SHA' || cards.some(card => card.evidenceState === 'WRONG_SHA');
  const liveness = overview.state.runtimeLiveness;
  const performance = overview.paper.candidatePerformance;
  const costsReady = Boolean(performance?.FULL_COST_READY && performance.fullCostEvidence?.fullCostReady);
  const datasets = new Set(cards.flatMap(card => card.records.map(record => record.datasetId).filter(Boolean)));
  const liquidity = overview.research.liquidityIndependence;
  const firstZero = performance?.FIRST_ZERO ?? factory?.firstZero ?? factory?.nextFirstZero ?? '미수집';
  return (
    <section id="research-tab-evidence" role="tabpanel" aria-labelledby="research-tab-evidence-trigger" className="space-y-3" data-testid="research-evidence-tab">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-bold">검증 리포트</h2>
        <StatusBadge status={wrongSha ? 'attention' : liveness?.stale ? 'stale' : 'normal'} />
      </div>
      <dl className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        <EvidenceItem label="연구 버전 일치" value={binding === 'PRESENT' ? '일치' : binding === 'WRONG_SHA' ? '불일치' : '미확인'} state={binding === 'PRESENT' ? 'verified' : binding === 'WRONG_SHA' ? 'attention' : 'unmeasured'} />
        <EvidenceItem label="갱신 상태" value={liveness?.status === 'LIVE' ? '정상' : liveness?.status === 'STALE' ? '갱신 지연' : liveness?.status === 'INVALID' ? '기록 오류' : '미확인'} state={liveness?.status === 'LIVE' ? 'verified' : liveness?.stale ? 'stale' : 'unmeasured'} />
        <EvidenceItem label="총비용 검증" value={costsReady ? '충족' : '자료 부족'} state={costsReady ? 'verified' : 'insufficient'} />
        <EvidenceItem label="검증 표본" value={formatCanonicalMetric(performance?.VALIDATION_N)} />
        <EvidenceItem label="미사용 표본" value={formatCanonicalMetric(performance?.OOS_N)} />
        <EvidenceItem label="수익성 입증" value={overview.profitability.proven ? '입증됨' : '미입증'} state={overview.profitability.proven ? 'verified' : 'waiting'} />
      </dl>
      <details className="rounded-2xl border border-card-border bg-card p-3">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-bold">연결 식별자</summary>
        <dl className="mt-2 grid gap-2 sm:grid-cols-2">
          <EvidenceItem label="실행 버전" value={runtimeSha ?? '미수집'} />
          <EvidenceItem label="소스 버전" value={sourceSha ?? '미수집'} />
          <EvidenceItem label="데이터 식별자" value={datasets.size ? `${datasets.size}개` : '미수집'} />
          <EvidenceItem label="전략 식별자" value={promotion ? `${promotion.items.length}개` : '미수집'} />
          <EvidenceItem label="제어 설정 지문" value={factory?.controlPlaneDigest ?? '미수집'} />
          <EvidenceItem label="실행 기록 식별자" value={liquidity?.upstreamIngestRunId ?? '미수집'} />
          <EvidenceItem label="증거 파일 식별자" value={liquidity?.upstreamIngestArtifactId ?? '미수집'} />
          <EvidenceItem label="검증 영수증" value={liquidity?.reportDigest ?? '미수집'} />
          <EvidenceItem label="현재 차단 사유" value={firstZero} state={firstZero === '미수집' ? 'unmeasured' : 'attention'} />
          <EvidenceItem label="마지막 갱신" value={formatDate(overview.state.latestCycleAt)} />
        </dl>
      </details>
      <details className="rounded-2xl border border-card-border bg-card p-3">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-bold">단계별 연결 진단</summary>
        <div className="mt-2 space-y-2">
          {cards.map(card => <div key={card.key} className="grid gap-1 rounded-xl bg-background p-3 text-xs sm:grid-cols-[10rem_1fr]"><strong>{card.label}</strong><span>{blockerCopy(card)}</span><code className="break-all text-muted-foreground sm:col-span-2">{card.blocker ?? '없음'}</code></div>)}
        </div>
      </details>
      <details className="rounded-2xl border border-card-border bg-card p-3">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-bold">원본 증거 보기</summary>
        <pre className="mt-2 max-h-[32rem] overflow-auto rounded-xl bg-background p-3 text-xs leading-5">{JSON.stringify({ overview, promotion }, null, 2)}</pre>
      </details>
    </section>
  );
}
function PaperKpi({ label, value, state }: { label: string; value: string; state: ResearchProductStatus }) {
  return (
    <article className="min-w-0 rounded-2xl border border-card-border bg-card p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2"><p className="text-[10px] font-bold text-muted-foreground">{label}</p><StatusBadge status={state} /></div>
      <p className="mt-2 truncate text-base font-black tabular-nums" title={value}>{value}</p>
    </article>
  );
}

function CostRow({ row }: { row: CostDisplayRow }) {
  const measuredBasis = row.quality === 'OBSERVED'
    ? 'observed'
    : row.quality === 'DOCUMENTED'
      ? 'documented'
      : row.quality === 'ESTIMATED'
        ? 'estimated'
        : null;
  const status: ResearchProductStatus = row.state === 'measured' && measuredBasis === 'observed'
    ? 'verified'
    : row.state === 'measured' && measuredBasis === 'documented'
      ? 'normal'
      : row.state === 'measured' && measuredBasis === 'estimated'
        ? 'attention'
        : row.state === 'measured'
          ? 'normal'
          : row.state === 'modeled'
            ? 'attention'
            : row.state === 'not-applicable'
              ? 'inactive'
              : row.state === 'unmeasured'
                ? 'unmeasured'
                : 'insufficient';
  const label = row.state === 'measured' && measuredBasis === 'observed'
    ? '실측'
    : row.state === 'measured' && measuredBasis === 'documented'
      ? '문서기반'
      : row.state === 'measured' && measuredBasis === 'estimated'
        ? '추정'
        : row.state === 'measured'
          ? '측정값'
          : row.state === 'modeled'
            ? '모델값'
            : row.state === 'not-applicable'
              ? '적용없음'
              : row.state === 'unmeasured'
                ? '미측정'
                : '자료 부족';
  return (
    <div className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-card-border bg-background p-3">
      <div className="min-w-0"><p className="text-xs font-black">{row.label}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{row.quality ?? '품질 근거 미수집'}</p></div>
      <div className="text-right"><p className="text-xs font-black tabular-nums">{row.value}</p><span className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[9px] font-black ${STATUS_STYLE[status]}`}>{label}</span></div>
    </div>
  );
}

function PaperTab({
  overview,
  cards,
  journalBinding,
  journalBindingLoading,
  journalBindingError,
}: {
  overview: ResearchCenterOverview;
  cards: ResearchPipelineCard[];
  journalBinding: ResearchJournalBindingReadback | null;
  journalBindingLoading: boolean;
  journalBindingError: boolean;
}) {
  const paper = cards.find((card) => card.key === 'paper')!;
  const ledger = overview.paper.ledger;
  const performance = overview.paper.candidatePerformance ?? {
    status: 'MISSING' as const,
    FIRST_ZERO: 'CANDIDATE_PERFORMANCE_EVIDENCE_MISSING',
    candidateId: null,
    strategyId: null,
    freezeTimestamp: null,
    identity14Verified: false,
    fullCostEvidence: {
      fullCostReady: false as const,
      components: Object.fromEntries(['commission', 'tax', 'spread', 'slippage', 'funding', 'latency', 'liquidityImpact', 'partialFillImpact'].map((key) => [key, { state: 'UNKNOWN', valuePercent: null, provenance: null }])) as ResearchCandidatePerformance['fullCostEvidence']['components'],
    },
    candidateMatchedN: null,
    LONG_SIGNAL_N: null,
    SHORT_SIGNAL_N: null,
    NO_TRADE_N: null,
    Entry_N: null,
    Position_N: null,
    PositionObservation_N: null,
    Settlement_N: null,
    TRAIN_N: null,
    VALIDATION_N: null,
    OOS_N: null,
    WIN_RATE: null,
    PF: null,
    MDD: null,
    Gross_PnL: null,
    Net_PnL: null,
    FULL_COST_READY: false as const,
    NET_ALPHA_PROVEN: false as const,
    PROFITABILITY_PROVEN: false as const,
    TRAIN_DIAGNOSTIC_ONLY: true as const,
  };
  const independentN = overview.research.liquidityIndependence?.effectiveIndependentN ?? null;
  const costRows = buildFullCostRows(performance.fullCostEvidence);
  const fullCostReady = performance.FULL_COST_READY && isFullCostReady(performance.fullCostEvidence);
  const candidateValue = (value: number | null, suffix = '') => value == null
    ? 'UNKNOWN/BLOCKED'
    : `${formatCanonicalMetric(value)}${suffix}`;
  const candidateRate = (value: number | null) => value == null
    ? 'UNKNOWN/BLOCKED'
    : `${formatCanonicalMetric(value * 100, { digits: 2 })}%`;
  const openPositionText = !ledger.present || ledger.positionCount == null
    ? '현재 포지션 자료 없음'
    : ledger.positionCount === 0
      ? '열린 모의 포지션 없음'
      : `열린 모의 포지션 ${formatCanonicalMetric(ledger.positionCount)}건`;
  const settlementText = !ledger.present || ledger.settlementCount == null
    ? '정산 자료 없음'
    : ledger.settlementCount === 0
      ? '최근 정산 없음 · 표본 없음'
      : `정산 ${formatCanonicalMetric(ledger.settlementCount)}건`;
  const countState = (value: number | null | undefined): ResearchProductStatus => value == null ? 'unmeasured' : value === 0 ? 'waiting' : 'accumulating';
  return (
    <section id="research-tab-paper" role="tabpanel" aria-labelledby="research-tab-paper-trigger" className="space-y-4" data-testid="research-paper-tab">
      <div className="rounded-3xl border border-card-border bg-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary"><WalletCards className="h-5 w-5" /></span><div><div className="flex items-center gap-2"><h2 className="text-lg font-black">모의매매</h2><span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-black text-primary">모의</span></div><p className="mt-1 text-xs font-bold text-emerald-700 dark:text-emerald-300">실주문 비활성</p></div></div>
          <StatusBadge status={paper.status} />
        </div>
        <div className="mt-3 rounded-xl border border-card-border bg-background p-3" data-testid="research-paper-target-capital">
          <p className="text-xs font-black">모의매매 목표 초기자본: 1,000,000원 (KRW)</p>
          <p className="mt-1 text-xs text-muted-foreground">기준자본 · 실제 잔고 확인 전 평가금액은 미측정</p>
        </div>
        <details className="mt-3 text-xs"><summary className="min-h-11 cursor-pointer py-3">실행 안전장치</summary><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {['LIVE_TRADING=false', 'AUTO_TRADING=false', 'REAL_ORDER_ENABLED=false', 'PRIVATE_TRADING_API_ALLOWED=false', 'executionAuthority=NONE'].map((item) => <span key={item} className="whitespace-nowrap rounded-lg border border-card-border bg-background px-2 py-1.5 text-center font-mono" title={item}>{item}</span>)}
        </div></details>
      </div>

      <details className="rounded-2xl border border-card-border bg-card p-3" data-testid="paper-candidate-performance">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-bold">후보별 성과 기록</summary>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-[10px] font-black uppercase tracking-[0.18em] text-primary"></p><h3 className="mt-1 text-sm font-black">후보별 성과 증거</h3></div>
          <span className={`rounded-full border px-2.5 py-1 text-[10px] font-black ${performance.status === 'PRESENT' ? STATUS_STYLE.accumulating : STATUS_STYLE.unmeasured}`}>{performance.status === 'PRESENT' ? '근거 수집됨' : '미확인·차단'}</span>
        </div>
        <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-card-border bg-background p-3"><dt className="text-[10px] font-bold text-muted-foreground">후보 식별자</dt><dd className="mt-1 truncate font-mono font-bold" title={performance.candidateId ?? 'UNKNOWN/BLOCKED'}>{performance.candidateId ?? 'UNKNOWN/BLOCKED'}</dd></div>
          <div className="rounded-xl border border-card-border bg-background p-3"><dt className="text-[10px] font-bold text-muted-foreground">전략 식별자</dt><dd className="mt-1 font-mono font-bold">{performance.strategyId ?? 'UNKNOWN/BLOCKED'}</dd></div>
          <div className="rounded-xl border border-card-border bg-background p-3"><dt className="text-[10px] font-bold text-muted-foreground">후보 확정 시각</dt><dd className="mt-1 font-bold">{performance.freezeTimestamp ? formatDate(performance.freezeTimestamp) : 'UNKNOWN/BLOCKED'}</dd></div>
          <div className="rounded-xl border border-card-border bg-background p-3"><dt className="text-[10px] font-bold text-muted-foreground">차단 사유</dt><dd className="mt-1 break-all font-mono font-bold">{performance.FIRST_ZERO}</dd></div>
        </dl>
        <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4 xl:grid-cols-6">
          {[
            ['독립 표본', independentN],
            ['후보 일치 표본', performance.candidateMatchedN],
            ['매수 신호', performance.LONG_SIGNAL_N],
            ['매도 신호', performance.SHORT_SIGNAL_N],
            ['거래 보류', performance.NO_TRADE_N],
            ['진입', performance.Entry_N],
            ['포지션', performance.Position_N],
            ['포지션 관측', performance.PositionObservation_N],
            ['정산', performance.Settlement_N],
            ['학습 표본', performance.TRAIN_N],
            ['검증 표본', performance.VALIDATION_N],
            ['미사용 표본', performance.OOS_N],
          ].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-card-border bg-background p-2"><p className="text-[9px] font-bold text-muted-foreground">{label}</p><p className="mt-1 text-xs font-black tabular-nums">{candidateValue(value as number | null)}</p></div>)}
        </div>
      </details>

      <PaperClosedLoopObserver
        overview={overview}
        journalBinding={journalBinding}
        journalBindingLoading={journalBindingLoading}
        journalBindingError={journalBindingError}
      />

      <section className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6" aria-label="모의매매 핵심 KPI">
        <PaperKpi label="모의 평가금액" value="미측정" state="unmeasured" />
        <PaperKpi label="비용 전 손익" value={candidateValue(performance.Gross_PnL)} state={countState(performance.Settlement_N)} />
        <PaperKpi label="미실현손익" value="미측정" state="unmeasured" />
        <PaperKpi label="비용 후 손익" value={candidateValue(performance.Net_PnL)} state="unmeasured" />
        <PaperKpi label="진입 수" value={candidateValue(performance.Entry_N)} state={countState(performance.Entry_N)} />
        <PaperKpi label="후보 포지션" value={candidateValue(performance.Position_N)} state={countState(performance.Position_N)} />
        <PaperKpi label="후보 정산" value={candidateValue(performance.Settlement_N)} state={countState(performance.Settlement_N)} />
        <PaperKpi label="승률" value={candidateRate(performance.WIN_RATE)} state={countState(performance.Settlement_N)} />
        <PaperKpi label="손익계수" value={candidateValue(performance.PF)} state={countState(performance.Settlement_N)} />
        <PaperKpi label="최대 낙폭" value={candidateValue(performance.MDD, '%')} state={countState(performance.Settlement_N)} />
        <PaperKpi label="후보 매치 N" value={candidateValue(performance.candidateMatchedN)} state={countState(performance.candidateMatchedN)} />
        <PaperKpi label="마지막 업데이트" value={formatDate(overview.state.latestCycleAt)} state={overview.state.latestCycleAt ? 'normal' : 'unmeasured'} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <article className="rounded-2xl border border-card-border bg-card p-4 shadow-sm" data-testid="paper-open-positions">
          <div className="flex items-center gap-2"><Gauge className="h-4 w-4 text-primary" /><h3 className="text-sm font-black">현재 포지션</h3></div>
          <div className="mt-3 rounded-xl border border-dashed border-card-border p-5 text-center text-xs text-muted-foreground">{openPositionText}</div>
        </article>
        <article className="rounded-2xl border border-card-border bg-card p-4 shadow-sm" data-testid="paper-recent-settlements">
          <div className="flex items-center gap-2"><History className="h-4 w-4 text-primary" /><h3 className="text-sm font-black">최근 모의거래·정산</h3></div>
          <div className="mt-3 rounded-xl border border-dashed border-card-border p-5 text-center text-xs text-muted-foreground">{settlementText}</div>
        </article>
      </div>

      <details className="rounded-2xl border border-card-border bg-card p-3" data-testid="paper-full-cost">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-bold">비용 분석 · {fullCostReady ? '충족' : '자료 부족'}</summary>
        <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[10px] font-black uppercase tracking-[0.18em] text-primary"></p><h3 className="mt-1 text-sm font-black">비용 분석</h3></div><span className="text-xs font-black">비용 검증 · {fullCostReady ? '충족' : '자료 부족'}</span></div>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">{costRows.map((row) => <CostRow key={row.key} row={row} />)}</div>
      </details>

      <div className="grid gap-4 lg:grid-cols-2">
        <details className="rounded-2xl border border-card-border bg-card p-3">
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-bold">거래 연결 진단</summary>
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] font-bold text-muted-foreground">
            {['진입', '포지션', '청산 조건', '청산 체결', '비용 정책', '정산'].map((item, index) => <span key={item} className="contents"><span className="rounded-lg border border-card-border bg-background px-2 py-1.5">{item}</span>{index < 5 ? <ChevronRight className="h-3 w-3" /> : null}</span>)}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">상세 정산 연결 기록 미공개</p>
        </details>
        <article className="rounded-2xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /><h3 className="text-sm font-black">수익성 검증</h3></div>
          <p className="mt-3 text-lg font-black">{performance.PROFITABILITY_PROVEN ? '검증 충족' : '아직 검증되지 않음'}</p>
          <details className="mt-2 text-xs"><summary className="min-h-11 cursor-pointer py-3">검증 원본 상태</summary><p>TRAIN_DIAGNOSTIC_ONLY={String(performance.TRAIN_DIAGNOSTIC_ONLY)} · VALIDATION={candidateValue(performance.VALIDATION_N)} · OOS={candidateValue(performance.OOS_N)}</p>
          <p className="mt-1 text-xs text-muted-foreground">FULL_COST_READY={String(performance.FULL_COST_READY)} · NET_ALPHA_PROVEN={String(performance.NET_ALPHA_PROVEN)} · PROFITABILITY_PROVEN={String(performance.PROFITABILITY_PROVEN)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{cards.find((card) => card.key === 'champion')?.metrics[0]?.value ?? '검증된 대표 전략 근거 미수집'}</p></details>
        </article>
      </div>
    </section>
  );
}

export default function ResearchCenterPage({ activeTab, onTabChange, embedded = false }: {
  activeTab?: ResearchTab;
  onTabChange?: (tab: ResearchTab) => void;
  embedded?: boolean;
} = {}) {
  const { profile, isAdmin, can } = useAuth();
  const canReadJournal = can('canAccessJournalSync');
  const [localTab, setLocalTab] = useState<ResearchTab>('overview');
  const tab = activeTab ?? localTab;
  const setTab = (next: ResearchTab) => { setLocalTab(next); onTabChange?.(next); };
  const [selected, setSelected] = useState<ResearchPipelineKey | null>(null);
  const overviewQuery = useQuery({
    queryKey: ['research-center', 'overview', profile?.id, isAdmin ? 'admin' : 'member'],
    queryFn: ({ signal }) => fetchResearchCenterOverview(signal, isAdmin ? 'admin' : 'member'),
    staleTime: 30_000,
    retry: 1,
  });
  const promotionQuery = useQuery({
    queryKey: ['admin', 'research-center', 'promotion', profile?.id],
    queryFn: ({ signal }) => fetchStrategyPromotions(signal),
    enabled: isAdmin,
    staleTime: 60_000,
    retry: 1,
  });
  const journalBindingQuery = useQuery({
    queryKey: ['research-center', 'paper-journal-binding', profile?.id],
    queryFn: ({ signal }) => fetchResearchJournalBinding(signal),
    enabled: tab === 'paper' && canReadJournal,
    staleTime: 30_000,
    retry: 0,
  });
  const overview = overviewQuery.data;
  const promotion = promotionQuery.data ?? null;
  const cards = useMemo(() => overview ? buildResearchPipeline(overview, promotion) : [], [overview, promotion]);
  const refreshing = overviewQuery.isFetching || promotionQuery.isFetching || (tab === 'paper' && journalBindingQuery.isFetching);

  function refreshAll() {
    void overviewQuery.refetch();
    if (isAdmin) void promotionQuery.refetch();
    if (tab === 'paper' && canReadJournal) void journalBindingQuery.refetch();
  }

  function selectCard(key: ResearchPipelineKey | null) {
    if (key === 'paper') {
      setTab('paper');
      return;
    }
    setSelected(key);
  }

  function moveTabFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? -1
        : null;
    const targetIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? TABS.length - 1
        : delta == null
          ? null
          : (index + delta + TABS.length) % TABS.length;
    if (targetIndex == null) return;
    event.preventDefault();
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[targetIndex]?.focus();
  }

  return (
    <main className="h-full overflow-y-auto overscroll-contain bg-background pb-28" data-testid="research-center-page">
      <div className="mx-auto w-full max-w-7xl space-y-4 px-3 py-4 sm:px-5 lg:px-6">
        <header className="rounded-3xl border border-card-border bg-card p-4 shadow-sm sm:p-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary"><FlaskConical className="h-5 w-5" aria-hidden="true" /></span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-black sm:text-2xl">{TABS.find((item) => item.key === tab)?.label ?? '연구센터'}</h1><span className="rounded-full border border-card-border bg-background px-2 py-0.5 text-[10px] font-black text-muted-foreground">조회 전용</span></div>
            </div>
            <button type="button" aria-label="연구센터 새로고침" onClick={refreshAll} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-card-border bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" /></button>
          </div>
        </header>

        {!embedded ? <nav className="grid grid-cols-4 gap-1 rounded-2xl border border-card-border bg-card p-1.5" role="tablist" aria-label="연구센터 핵심 화면">
          {TABS.map(({ key, label, icon: Icon }, index) => (
            <button
              key={key}
              id={`research-tab-${key}-trigger`}
              type="button"
              role="tab"
              aria-selected={tab === key}
              aria-controls={`research-tab-${key}`}
              tabIndex={tab === key ? 0 : -1}
              onClick={() => setTab(key)}
              onKeyDown={(event) => moveTabFocus(event, index)}
              className={`flex min-h-11 min-w-0 items-center justify-center gap-1 rounded-xl px-1.5 text-[11px] font-black transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:text-xs ${tab === key ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted'}`}
            >
              <Icon className="hidden h-4 w-4 shrink-0 sm:block" aria-hidden="true" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </nav> : null}

        {overviewQuery.isPending ? <LoadingState /> : null}
        {overviewQuery.isError ? (
          <section role="alert" className="rounded-3xl border border-destructive/30 bg-destructive/10 p-5" data-testid="research-error-state">
            <div className="flex items-start gap-2"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /><div><h2 className="font-black text-destructive">연구 상태를 불러오지 못했습니다.</h2><p className="mt-1 text-xs text-muted-foreground">오류를 정상이나 0으로 바꾸지 않습니다.</p></div></div>
            <button type="button" onClick={refreshAll} className="mt-4 min-h-11 rounded-xl border border-destructive/30 px-4 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive">다시 확인</button>
          </section>
        ) : null}

        {tab === 'evidence' ? <ResearchPITMinuteCoveragePanel /> : null}
        {overview && cards.length ? (
          <>
            {tab === 'overview' ? <OverviewTab overview={overview} promotion={promotion} cards={cards} selected={selected} onSelect={selectCard} /> : null}
            {tab === 'ai-lab' ? <AiLabTab overview={overview} cards={cards} /> : null}
            {tab === 'evidence' ? <EvidenceTab overview={overview} promotion={promotion} cards={cards} /> : null}
            {tab === 'paper' ? (
              <PaperTab
                overview={overview}
                cards={cards}
                journalBinding={journalBindingQuery.data ?? null}
                journalBindingLoading={journalBindingQuery.isFetching}
                journalBindingError={journalBindingQuery.isError}
              />
            ) : null}
          </>
        ) : null}
      </div>
      <BottomNav />
    </main>
  );
}
