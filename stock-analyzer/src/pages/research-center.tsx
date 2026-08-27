import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  CircleAlert,
  Database,
  FileSearch,
  FlaskConical,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { InvestmentExplanationButton } from '@/components/investment-explanation-sheet';
import type { InvestmentExplanationKey } from '@/lib/investment-explanations';
import {
  fetchResearchCenterOverview,
  type ResearchCycleProfile,
  type ResearchCycleSummary,
} from '@/lib/research-center';
import {
  buildDebatePreview,
  buildResearchConclusion,
  buildResearchSimpleItems,
  cycleHasSuccessMismatch,
  cycleTaskSuccessCount,
  extractResearchAiDebate,
  researchCycleLabel,
  taskStatusKorean,
  type ResearchDebateReviewView,
  type ResearchSimpleTone,
} from '@/lib/research-center-view';
import { fetchStrategyPromotions } from '@/lib/strategy-promotion';

type ResearchTab = 'summary' | 'debate' | 'details';

const TABS: Array<{ key: ResearchTab; label: string; icon: typeof Activity }> = [
  { key: 'summary', label: '한눈에 보기', icon: Activity },
  { key: 'debate', label: 'AI 토론', icon: MessageSquareText },
  { key: 'details', label: '상세 증거', icon: FileSearch },
];

function formatDate(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return '미수집';
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'Asia/Seoul',
  }).format(new Date(value));
}

function formatMetric(value: number | null | undefined, digits = 3): string {
  return value == null || !Number.isFinite(value) ? '미수집' : value.toFixed(digits);
}

function statusLabel(status: string | null | undefined): string {
  const normalized = String(status ?? '').toLowerCase();
  if (!normalized || normalized === 'not_started') return '미수집';
  if (['complete', 'completed', 'success', 'pass', 'ready', 'healthy'].includes(normalized)) return '정상';
  if (['collecting', 'evidence_collection', 'running', 'pending', 'replayed'].includes(normalized)) return '증거 수집 중';
  if (['attention', 'blocked', 'blocked_data', 'stale', 'insufficient_sample'].includes(normalized)) return '확인 필요';
  if (['fail', 'failed', 'error', 'safety_block', 'critical'].includes(normalized)) return '오류/차단';
  return status ?? '미수집';
}

function statusClass(status: string | null | undefined): string {
  const label = statusLabel(status);
  if (label === '정상') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (label === '오류/차단') return 'border-destructive/30 bg-destructive/10 text-destructive';
  if (label === '확인 필요') return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  return 'border-border bg-muted/50 text-muted-foreground';
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  return <span className={`rounded-full border px-2.5 py-1 text-[11px] font-black ${statusClass(status)}`}>{statusLabel(status)}</span>;
}

function toneClass(tone: ResearchSimpleTone): string {
  if (tone === 'good') return 'border-emerald-500/25 bg-emerald-500/5';
  if (tone === 'blocked') return 'border-destructive/30 bg-destructive/5';
  if (tone === 'warning') return 'border-amber-500/30 bg-amber-500/5';
  return 'border-card-border bg-card';
}

function toneBadge(tone: ResearchSimpleTone): string {
  if (tone === 'good') return '정상';
  if (tone === 'blocked') return '확인 필요';
  if (tone === 'warning') return '아직 부족';
  return '진행 중';
}

function researchExplanationKey(label: string): InvestmentExplanationKey | null {
  const value = label.toLowerCase();
  if (value.includes('macro f1')) return 'macroF1';
  if (value.includes('균형') || value.includes('balanced')) return 'balancedAccuracy';
  if (value.includes('profit factor') || value.includes('pf')) return 'profitFactor';
  if (value.includes('기대값') || value.includes(' ev')) return 'expectancy';
  if (value.includes('mdd')) return 'maxDrawdown';
  if (value.includes('승률')) return 'winRate';
  if (value.includes('표본')) return 'sampleN';
  if (value.includes('holdout')) return 'holdout';
  if (value.includes('shadow')) return 'shadow';
  if (value.includes('natural') || value.includes('모의매매')) return 'naturalPaper';
  if (value.includes('정산')) return 'settlement';
  if (value.includes('수익성')) return 'profitability';
  if (value.includes('건강')) return 'strategyHealth';
  if (value.includes('승격')) return 'promotion';
  return null;
}

function SimpleCard({ label, value, note, tone }: { label: string; value: string; note: string; tone: ResearchSimpleTone }) {
  const explanationKey = researchExplanationKey(label);
  return (
    <article className={`min-w-0 rounded-2xl border p-4 shadow-sm ${toneClass(tone)}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-xs font-bold text-muted-foreground">{label}</p>
          {explanationKey ? <InvestmentExplanationButton metric={explanationKey} value={value} compact /> : null}
        </div>
        <span className="rounded-full border border-card-border bg-background/70 px-2 py-1 text-[10px] font-black text-muted-foreground">{toneBadge(tone)}</span>
      </div>
      <p className="mt-2 break-keep text-lg font-black tracking-tight text-foreground">{value}</p>
      <p className="mt-2 break-keep text-xs leading-5 text-muted-foreground">{note}</p>
    </article>
  );
}

function CycleCard({ cycle }: { cycle: ResearchCycleSummary }) {
  const mismatch = cycleHasSuccessMismatch(cycle);
  const taskSuccesses = cycleTaskSuccessCount(cycle);
  return (
    <article className="min-w-0 rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid={`research-cycle-${cycle.profile}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black text-primary">연구 실행 상세</p>
          <h3 className="mt-1 text-base font-black">{researchCycleLabel(cycle.profile)}</h3>
        </div>
        <StatusBadge status={cycle.present ? cycle.status : 'not_started'} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">상위 집계 성공</dt><dd className="mt-1 font-black tabular-nums">{cycle.present ? `${cycle.successCount}/${cycle.taskCount}` : '미수집'}</dd></div>
        <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">실패</dt><dd className="mt-1 font-black tabular-nums">{cycle.present ? cycle.failedCount : '미수집'}</dd></div>
        <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">필수 데이터 부족</dt><dd className="mt-1 font-black tabular-nums">{cycle.present ? cycle.blockedDataCount : '미수집'}</dd></div>
        <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">실행 시각</dt><dd className="mt-1 break-keep font-bold">{formatDate(cycle.generatedAt)}</dd></div>
      </dl>
      {mismatch ? (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs" data-testid="research-cycle-count-mismatch">
          <p className="font-black text-amber-700 dark:text-amber-300">집계 확인 필요</p>
          <p className="mt-1 leading-5 text-muted-foreground">작업별 성공은 {taskSuccesses}건인데 상위 집계는 {cycle.successCount}/{cycle.taskCount}입니다. 값을 임의로 고치지 않고 불일치 그대로 표시합니다.</p>
        </div>
      ) : null}
      <div className="mt-3 rounded-xl border border-card-border bg-background p-3 text-[11px]">
        <p className="text-muted-foreground">검증 코드 버전</p>
        <p className="mt-1 truncate font-mono font-bold" title={cycle.researchSha ?? undefined}>{cycle.researchSha ?? '미수집'}</p>
      </div>
      {cycle.tasks.length ? (
        <div className="mt-3 space-y-2">
          {cycle.tasks.map((task) => (
            <div key={task.id} className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-card-border px-3 py-2 text-[11px]">
              <span className="truncate font-bold">{task.id}</span>
              <span className="shrink-0 text-muted-foreground">{taskStatusKorean(task.status, task.timedOut)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function SafetyCard({ forbidden }: { forbidden: boolean }) {
  return (
    <section className={`rounded-3xl border p-4 ${forbidden ? 'border-destructive/30 bg-destructive/10' : 'border-emerald-500/30 bg-emerald-500/10'}`} aria-label="연구 안전 상태">
      <div className="flex items-start gap-3">
        {forbidden ? <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" /> : <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />}
        <div className="min-w-0">
          <h2 className="text-sm font-black">{forbidden ? '안전 계약 확인 필요' : '연구 안전장치 정상'}</h2>
          <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">조회만 허용합니다. 실제 주문·자동매매·Private API 권한은 이 연구화면에 없습니다.</p>
        </div>
      </div>
    </section>
  );
}

function ReviewCard({ review }: { review: ResearchDebateReviewView }) {
  return (
    <article className="rounded-2xl border border-card-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-black">{review.label}</h3>
        {review.conclusion ? <span className="rounded-full border border-card-border bg-background px-2.5 py-1 text-[10px] font-black">{review.conclusion}</span> : null}
      </div>
      {(review.provider || review.model) ? <p className="mt-2 text-[10px] text-muted-foreground">{[review.provider, review.model].filter(Boolean).join(' · ')}</p> : null}
      <ul className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
        {review.lines.map((line) => <li key={line} className="rounded-xl bg-background p-3">{line}</li>)}
      </ul>
    </article>
  );
}

export default function ResearchCenterPage() {
  const [tab, setTab] = useState<ResearchTab>('summary');
  const overviewQuery = useQuery({
    queryKey: ['admin', 'research-center', 'overview'],
    queryFn: ({ signal }) => fetchResearchCenterOverview(signal),
    staleTime: 30_000,
    retry: 1,
  });
  const governanceQuery = useQuery({
    queryKey: ['admin', 'research-center', 'promotion'],
    queryFn: ({ signal }) => fetchStrategyPromotions(signal),
    staleTime: 60_000,
    retry: 1,
  });

  const overview = overviewQuery.data;
  const cycles = overview?.research.cycles ?? [];
  const cycleByProfile = new Map(cycles.map((cycle) => [cycle.profile, cycle] as const));
  const cycleFor = (profile: ResearchCycleProfile): ResearchCycleSummary => cycleByProfile.get(profile) ?? {
    profile,
    present: false,
    status: 'not_started',
    taskCount: 0,
    successCount: 0,
    blockedDataCount: 0,
    failedCount: 0,
    tasks: [],
  };
  const orderedCycles = (['forward', 'fast-historical', 'long-history'] as const).map(cycleFor);
  const promotion = governanceQuery.data;
  const driftMeasured = promotion?.items.filter((item) => item.drift.status === 'MEASURED') ?? [];
  const driftWarnings = driftMeasured.filter((item) => item.drift.classification === 'DEGRADED' || item.drift.classification === 'CRITICAL').length;
  const refreshing = overviewQuery.isFetching || governanceQuery.isFetching;

  function refreshAll() {
    void overviewQuery.refetch();
    void governanceQuery.refetch();
  }

  return (
    <main className="h-full overflow-y-auto overscroll-contain bg-background pb-28" data-testid="research-center-page">
      <div className="mx-auto w-full max-w-7xl space-y-4 px-3 py-4 sm:px-5 lg:px-6">
        <header className="rounded-3xl border border-card-border bg-card p-4 shadow-sm sm:p-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <FlaskConical className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-black sm:text-2xl">연구센터</h1>
                <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[10px] font-black text-primary">관리자 전용</span>
                <span className="rounded-full border border-card-border bg-background px-2.5 py-1 text-[10px] font-black text-muted-foreground">조회 전용</span>
              </div>
              <p className="mt-2 max-w-3xl break-keep text-xs leading-5 text-muted-foreground">
                어려운 연구용 숫자보다 먼저 “지금 정상인지, 무엇이 부족한지, 다음에 뭘 해야 하는지”를 한글로 보여줍니다. 설명 가능한 항목의 <strong>왜?</strong>를 누르면 뜻·중요성·주의점·같이 볼 지표를 바로 확인할 수 있습니다.
              </p>
            </div>
            <button
              type="button"
              aria-label="연구센터 새로고침"
              onClick={refreshAll}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-card-border bg-background"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
            </button>
          </div>
        </header>

        <nav className="grid grid-cols-3 gap-2 rounded-2xl border border-card-border bg-card p-1.5" role="tablist" aria-label="연구센터 보기 방식">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              aria-controls={`research-tab-${key}`}
              onClick={() => setTab(key)}
              className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-2 text-xs font-black transition ${tab === key ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted'}`}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="break-keep">{label}</span>
            </button>
          ))}
        </nav>

        {overviewQuery.isPending ? (
          <section aria-live="polite" className="rounded-3xl border border-card-border bg-card p-8 text-center text-sm text-muted-foreground">연구 상태를 불러오는 중입니다.</section>
        ) : null}

        {overviewQuery.isError ? (
          <section role="alert" className="rounded-3xl border border-destructive/30 bg-destructive/10 p-5">
            <div className="flex items-start gap-2"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /><div><h2 className="font-black text-destructive">연구 서버 상태를 불러오지 못했습니다.</h2><p className="mt-1 text-xs text-muted-foreground">데이터가 없을 때 0으로 꾸미지 않고 사용 불가 상태로 표시합니다.</p></div></div>
            <button type="button" onClick={refreshAll} className="mt-4 min-h-11 rounded-xl border border-destructive/30 px-4 text-sm font-bold">다시 확인</button>
          </section>
        ) : null}

        {overview && tab === 'summary' ? (() => {
          const items = buildResearchSimpleItems(overview);
          const conclusion = buildResearchConclusion(overview);
          return (
            <section id="research-tab-summary" role="tabpanel" className="space-y-4" data-testid="research-summary-tab">
              <SafetyCard forbidden={overview.safety.forbiddenAuthorityObserved} />

              <article className={`rounded-3xl border p-5 shadow-sm ${toneClass(conclusion.tone)}`} data-testid="research-current-conclusion">
                <div className="flex items-start gap-3">
                  {conclusion.tone === 'good' ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" /> : <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />}
                  <div className="min-w-0">
                    <p className="text-[11px] font-black text-muted-foreground">현재 결론</p>
                    <h2 className="mt-1 text-xl font-black">{conclusion.title}</h2>
                    <p className="mt-2 break-keep text-sm leading-6 text-muted-foreground">{conclusion.description}</p>
                  </div>
                </div>
              </article>

              <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="쉬운 연구 요약">
                {items.map((item) => <SimpleCard key={item.key} label={item.label} value={item.value} note={item.note} tone={item.tone} />)}
              </section>

              <article className="rounded-3xl border border-primary/25 bg-primary/5 p-5">
                <div className="flex items-start gap-3">
                  <Activity className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <h2 className="text-sm font-black">다음에 해야 할 일</h2>
                    <p className="mt-2 break-keep text-sm leading-6 text-muted-foreground" data-testid="research-next-step">{conclusion.nextStep}</p>
                  </div>
                </div>
              </article>

              <section className="grid grid-cols-2 gap-3" aria-label="전략 승격 요약">
                <SimpleCard label="검증 중 전략" value={promotion ? `${promotion.items.length}개` : '미수집'} note="전략이 많다고 좋은 전략이 확정된 것은 아닙니다." tone="waiting" />
                <SimpleCard label="승격 후보" value={promotion ? `${promotion.promotionCandidates}개` : '미수집'} note="승격 후보는 Champion 또는 실거래 승인이 아닙니다." tone={promotion?.promotionCandidates ? 'good' : 'waiting'} />
              </section>
            </section>
          );
        })() : null}

        {overview && tab === 'debate' ? (() => {
          const debate = extractResearchAiDebate(overview as unknown);
          const preview = buildDebatePreview(overview);
          const reviews = [debate.ai1, debate.ai2, ...debate.committee].filter((review): review is ResearchDebateReviewView => Boolean(review));
          return (
            <section id="research-tab-debate" role="tabpanel" className="space-y-4" data-testid="research-ai-debate-tab">
              <article className={`rounded-3xl border p-5 ${debate.actualEvidence ? 'border-primary/30 bg-primary/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
                <div className="flex items-start gap-3">
                  <BrainCircuit className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-[11px] font-black text-muted-foreground">실제 AI 연구위원회</p>
                        <h2 className="mt-1 text-lg font-black">{debate.finalLabel}</h2>
                      </div>
                      <span className="rounded-full border border-card-border bg-background px-2.5 py-1 text-[10px] font-black">{debate.statusLabel}</span>
                    </div>
                    <p className="mt-3 break-keep text-xs leading-5 text-muted-foreground">
                      {debate.actualEvidence
                        ? 'Research Production에 실제 저장된 AI 리뷰만 표시합니다. AI 의견은 참고자료이며 수익성·승격·주문 권한이 없습니다.'
                        : '실제 Gemini/Groq 리뷰가 Research Production에 기록되기 전에는 AI 의견을 임의로 만들지 않습니다.'}
                    </p>
                    {debate.conflictReason ? <p className="mt-2 rounded-xl bg-background p-3 text-xs text-muted-foreground">의견 차이: {debate.conflictReason}</p> : null}
                  </div>
                </div>
              </article>

              {reviews.length ? <div className="grid gap-3 lg:grid-cols-2">{reviews.map((review, index) => <ReviewCard key={`${review.label}-${index}`} review={review} />)}</div> : null}

              <article className="rounded-3xl border border-card-border bg-card p-5" data-testid="research-data-debate-preview">
                <div className="flex items-start gap-3">
                  <MessageSquareText className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                  <div>
                    <h2 className="text-sm font-black">데이터 쟁점 미리보기</h2>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground"><strong>AI 의견이 아닙니다.</strong> 현재 수집된 숫자에서 찬성·반대·추가검증 쟁점만 기계적으로 나눠 보여줍니다.</p>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 lg:grid-cols-3">
                  {[
                    { title: '긍정 근거', rows: preview.support },
                    { title: '반대 근거', rows: preview.oppose },
                    { title: '추가 검증', rows: preview.verify },
                  ].map((group) => (
                    <div key={group.title} className="rounded-2xl border border-card-border bg-background p-4">
                      <h3 className="text-xs font-black">{group.title}</h3>
                      <ul className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
                        {group.rows.map((row) => <li key={row}>• {row}</li>)}
                      </ul>
                    </div>
                  ))}
                </div>
              </article>

              <div className="rounded-2xl border border-card-border bg-muted/30 p-4 text-xs leading-5 text-muted-foreground">
                최종 권한은 AI 투표가 아니라 실제 Backtest/OOS/Forward/Shadow/Paper/Settlement 증거에 있습니다. AI는 PF·EV·MDD·승률을 만들어내거나 Champion·자동매매를 승인할 수 없습니다.
              </div>
            </section>
          );
        })() : null}

        {overview && tab === 'details' ? (
          <section id="research-tab-details" role="tabpanel" className="space-y-4" data-testid="research-details-tab">
            <section className={`rounded-3xl border p-4 ${overview.safety.forbiddenAuthorityObserved ? 'border-destructive/30 bg-destructive/10' : 'border-emerald-500/30 bg-emerald-500/10'}`} aria-label="Research safety raw evidence">
              <div className="flex items-start gap-3">
                {overview.safety.forbiddenAuthorityObserved ? <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" /> : <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />}
                <div className="min-w-0"><h2 className="text-sm font-black">연구 안전 계약</h2><p className="mt-1 break-keep text-xs text-muted-foreground">조회 전용={String(overview.safety.readOnlyDashboard)} · 실거래={String(overview.safety.liveTrading)} · Private API={String(overview.safety.privateApi)} · 주문 권한={String(overview.safety.orderAuthority)}</p></div>
              </div>
            </section>

            <section>
              <div className="mb-3 flex items-center gap-2"><Activity className="h-4 w-4 text-primary" /><h2 className="text-sm font-black">연구 실행 상세</h2></div>
              <div className="grid min-w-0 gap-3 lg:grid-cols-3">{orderedCycles.map((cycle) => <CycleCard key={cycle.profile} cycle={cycle} />)}</div>
            </section>

            <section className="grid min-w-0 gap-3 xl:grid-cols-2">
              <article className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Database className="h-4 w-4 text-primary" /><h2 className="text-sm font-black">자동 모의매매 상세</h2><InvestmentExplanationButton metric="naturalPaper" compact /></div><StatusBadge status={overview.paper.runtime.present ? overview.paper.runtime.status : 'not_started'} /></div>
                <dl className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                  <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">확인 횟수</dt><dd className="mt-1 font-black tabular-nums">{overview.paper.ledger.present ? overview.paper.ledger.cycleCount : '미수집'}</dd></div>
                  <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">모의 포지션</dt><dd className="mt-1 font-black tabular-nums">{overview.paper.ledger.present ? overview.paper.ledger.positionCount : '미수집'}</dd></div>
                  <div className="rounded-xl bg-background p-3"><dt className="flex items-center gap-1 text-muted-foreground">정산 완료 <InvestmentExplanationButton metric="settlement" value={overview.paper.ledger.present ? overview.paper.ledger.settlementCount : '미수집'} compact /></dt><dd className="mt-1 font-black tabular-nums">{overview.paper.ledger.present ? overview.paper.ledger.settlementCount : '미수집'}</dd></div>
                  <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">비공개 API 요청</dt><dd className="mt-1 font-black tabular-nums">{overview.paper.runtime.present ? overview.paper.runtime.privateRequestCount : '미수집'}</dd></div>
                  <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">실제 금융 변경</dt><dd className="mt-1 font-black tabular-nums">{overview.paper.runtime.present ? overview.paper.runtime.financialMutationCount : '미수집'}</dd></div>
                  <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">실제 주문</dt><dd className="mt-1 font-black tabular-nums">{overview.paper.runtime.present ? overview.paper.runtime.orderCount : '미수집'}</dd></div>
                </dl>
                {overview.paper.runtime.lanes.length ? <div className="mt-3 space-y-2">{overview.paper.runtime.lanes.map((lane) => <div key={lane.market} className="flex items-center justify-between gap-3 rounded-xl border border-card-border px-3 py-2 text-xs"><span className="font-bold">{lane.market}</span><span className="text-muted-foreground">{statusLabel(lane.status)}</span></div>)}</div> : null}
              </article>

              <article className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Activity className="h-4 w-4 text-primary" /><h2 className="text-sm font-black">Shadow 미래 예측 검증</h2><InvestmentExplanationButton metric="shadow" compact /></div><span className="rounded-full border border-card-border bg-background px-2.5 py-1 text-[11px] font-black text-muted-foreground">증거 수집 중</span></div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded-xl bg-background p-3"><p className="text-muted-foreground">전체</p><p className="mt-1 text-base font-black">{overview.shadow.records.present ? overview.shadow.records.totalRecords : '미수집'}</p></div>
                  <div className="rounded-xl bg-background p-3"><p className="text-muted-foreground">정산</p><p className="mt-1 text-base font-black">{overview.shadow.records.present ? overview.shadow.records.settledRecords : '미수집'}</p></div>
                  <div className="rounded-xl bg-background p-3"><p className="text-muted-foreground">대기</p><p className="mt-1 text-base font-black">{overview.shadow.records.present ? overview.shadow.records.pendingRecords : '미수집'}</p></div>
                </div>
                <div className="mt-3 space-y-2">{overview.shadow.groups.map((group) => <div key={group.name} className="rounded-2xl border border-card-border bg-background p-3 text-xs"><div className="flex min-w-0 items-center justify-between gap-3"><span className="truncate font-black">{group.name}</span><span className="shrink-0 text-muted-foreground">Collapse {group.collapsed == null ? '미수집' : group.collapsed ? '감지' : '아님'}</span></div><div className="mt-2 flex flex-wrap items-center gap-2 text-muted-foreground"><span>Macro F1 {formatMetric(group.macroF1)}</span><InvestmentExplanationButton metric="macroF1" value={formatMetric(group.macroF1)} compact /><span>· 균형정확도 {formatMetric(group.balancedAccuracy)}</span><InvestmentExplanationButton metric="balancedAccuracy" value={formatMetric(group.balancedAccuracy)} compact /><span>· 정산 {group.settled ?? '미수집'} · 대기 {group.pending ?? '미수집'}</span></div></div>)}</div>
              </article>
            </section>

            <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-black">전략 건강도 / 승격</h2><InvestmentExplanationButton metric="strategyHealth" compact /><InvestmentExplanationButton metric="promotion" compact /></div>
              {governanceQuery.isError ? <p className="mt-3 text-xs text-destructive">승격 근거를 불러오지 못했습니다.</p> : <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4"><div className="rounded-xl bg-background p-3"><p className="text-muted-foreground">전략</p><p className="mt-1 text-base font-black">{promotion ? `${promotion.items.length}개` : '미수집'}</p></div><div className="rounded-xl bg-background p-3"><p className="text-muted-foreground">승격 후보</p><p className="mt-1 text-base font-black">{promotion ? `${promotion.promotionCandidates}개` : '미수집'}</p></div><div className="rounded-xl bg-background p-3"><p className="text-muted-foreground">Drift 측정</p><p className="mt-1 text-base font-black">{promotion ? `${driftMeasured.length}개` : '미수집'}</p></div><div className="rounded-xl bg-background p-3"><p className="text-muted-foreground">저하/위험</p><p className="mt-1 text-base font-black">{promotion ? `${driftWarnings}개` : '미수집'}</p></div></div>}
              <p className="mt-3 break-keep text-xs leading-5 text-muted-foreground">승격 후보는 Champion 또는 실거래 승인이 아닙니다. 최종 증거가 없으면 미승격 상태를 유지합니다.</p>
            </section>

            <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-black">수익성 증거</h2><InvestmentExplanationButton metric="profitability" value={overview.profitability.proven ? '증명됨' : '아직 미증명'} status={overview.profitability.status} compact /></div>
              <div className="mt-4 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs text-muted-foreground">현재 판정</p><p className="mt-1 text-xl font-black">{overview.profitability.proven ? '증명됨' : '아직 미증명'}</p></div><StatusBadge status={overview.profitability.status} /></div>
              <p className="mt-4 break-keep text-xs leading-5 text-muted-foreground">{overview.profitability.note}</p>
            </section>

            <footer className="rounded-2xl border border-card-border bg-card p-3 text-[11px] leading-5 text-muted-foreground">연구 개요 생성: {formatDate(overview.generatedAt)} · 최신 cycle: {formatDate(overview.state.latestCycleAt)}</footer>
          </section>
        ) : null}
      </div>
      <BottomNav />
    </main>
  );
}
