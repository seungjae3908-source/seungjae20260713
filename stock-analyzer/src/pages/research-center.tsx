import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Database,
  FlaskConical,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import {
  fetchResearchCenterOverview,
  type ResearchCycleProfile,
  type ResearchCycleSummary,
} from '@/lib/research-center';
import { fetchStrategyPromotions } from '@/lib/strategy-promotion';

const PROFILE_LABELS: Record<ResearchCycleProfile, string> = {
  forward: 'Forward',
  'fast-historical': 'Fast Historical',
  'long-history': 'Long History',
};

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
  if (['collecting', 'evidence_collection', 'running', 'pending'].includes(normalized)) return '증거 수집 중';
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

function SummaryCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-card-border bg-card p-3 shadow-sm">
      <p className="text-[11px] font-bold text-muted-foreground">{label}</p>
      <p className="mt-2 break-keep text-lg font-black tracking-tight text-foreground">{value}</p>
      {note ? <p className="mt-1 break-keep text-[11px] leading-5 text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function CycleCard({ cycle }: { cycle: ResearchCycleSummary }) {
  return (
    <article className="min-w-0 rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid={`research-cycle-${cycle.profile}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-wider text-primary">Research cycle</p>
          <h3 className="mt-1 text-base font-black">{PROFILE_LABELS[cycle.profile]}</h3>
        </div>
        <StatusBadge status={cycle.present ? cycle.status : 'not_started'} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">성공</dt><dd className="mt-1 font-black tabular-nums">{cycle.present ? `${cycle.successCount}/${cycle.taskCount}` : '미수집'}</dd></div>
        <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">실패</dt><dd className="mt-1 font-black tabular-nums">{cycle.present ? cycle.failedCount : '미수집'}</dd></div>
        <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">BLOCKED_DATA</dt><dd className="mt-1 font-black tabular-nums">{cycle.present ? cycle.blockedDataCount : '미수집'}</dd></div>
        <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">실행 시각</dt><dd className="mt-1 break-keep font-bold">{formatDate(cycle.generatedAt)}</dd></div>
      </dl>
      <div className="mt-3 rounded-xl border border-card-border bg-background p-3 text-[11px]">
        <p className="text-muted-foreground">Research SHA</p>
        <p className="mt-1 truncate font-mono font-bold" title={cycle.researchSha ?? undefined}>{cycle.researchSha ?? '미수집'}</p>
      </div>
      {cycle.tasks.length ? (
        <div className="mt-3 space-y-2">
          {cycle.tasks.map((task) => (
            <div key={task.id} className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-card-border px-3 py-2 text-[11px]">
              <span className="truncate font-bold">{task.id}</span>
              <span className="shrink-0 text-muted-foreground">{task.status}{task.timedOut ? ' · TIMEOUT' : ''}</span>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export default function ResearchCenterPage() {
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
  const orderedCycles = (['forward', 'fast-historical', 'long-history'] as const)
    .map((profile) => cycleByProfile.get(profile) ?? {
      profile,
      present: false,
      status: 'not_started',
      taskCount: 0,
      successCount: 0,
      blockedDataCount: 0,
      failedCount: 0,
      tasks: [],
    });
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
                Research Production의 Forward · Historical · Paper · Shadow · 승격 증거를 한곳에서 확인합니다. 미수집 값은 0으로 만들지 않습니다.
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

        {overviewQuery.isPending ? (
          <section aria-live="polite" className="rounded-3xl border border-card-border bg-card p-8 text-center text-sm text-muted-foreground">연구 상태를 불러오는 중입니다.</section>
        ) : null}

        {overviewQuery.isError ? (
          <section role="alert" className="rounded-3xl border border-destructive/30 bg-destructive/10 p-5">
            <div className="flex items-start gap-2"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /><div><h2 className="font-black text-destructive">Research Production 상태를 불러오지 못했습니다.</h2><p className="mt-1 text-xs text-muted-foreground">내부 Research Dashboard가 비활성 또는 접근 불가하면 안전하게 미표시됩니다.</p></div></div>
            <button type="button" onClick={refreshAll} className="mt-4 min-h-11 rounded-xl border border-destructive/30 px-4 text-sm font-bold">다시 확인</button>
          </section>
        ) : null}

        {overview ? (
          <>
            <section className={`rounded-3xl border p-4 ${overview.safety.forbiddenAuthorityObserved ? 'border-destructive/30 bg-destructive/10' : 'border-emerald-500/30 bg-emerald-500/10'}`} aria-label="Research safety">
              <div className="flex items-start gap-3">
                {overview.safety.forbiddenAuthorityObserved ? <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" /> : <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />}
                <div className="min-w-0">
                  <h2 className="text-sm font-black">{overview.safety.forbiddenAuthorityObserved ? '안전 계약 위반 증거 감지' : 'Research 안전 계약 정상'}</h2>
                  <p className="mt-1 break-keep text-xs text-muted-foreground">Read-only={String(overview.safety.readOnlyDashboard)} · Live trading={String(overview.safety.liveTrading)} · Private API={String(overview.safety.privateApi)} · Order authority={String(overview.safety.orderAuthority)}</p>
                </div>
              </div>
            </section>

            <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-7" aria-label="연구 요약">
              <SummaryCard label="Research" value={statusLabel(overview.research.status)} note={`실패 ${overview.research.failedTasks} · BLOCKED ${overview.research.blockedDataTasks}`} />
              <SummaryCard label="Forward" value={statusLabel(cycleByProfile.get('forward')?.status)} note={formatDate(cycleByProfile.get('forward')?.generatedAt)} />
              <SummaryCard label="Fast Historical" value={statusLabel(cycleByProfile.get('fast-historical')?.status)} note={formatDate(cycleByProfile.get('fast-historical')?.generatedAt)} />
              <SummaryCard label="Long History" value={statusLabel(cycleByProfile.get('long-history')?.status)} note={formatDate(cycleByProfile.get('long-history')?.generatedAt)} />
              <SummaryCard label="Paper 정산" value={overview.paper.ledger.present ? `${overview.paper.ledger.settlementCount}건` : '미수집'} note={overview.paper.runtime.paperTradeOutcomeAccumulating ? 'Outcome 축적 중' : 'Outcome 미축적'} />
              <SummaryCard label="Shadow" value={overview.shadow.records.present ? `${overview.shadow.records.settledRecords}/${overview.shadow.records.totalRecords}` : '미수집'} note={`Pending ${overview.shadow.records.present ? overview.shadow.records.pendingRecords : '미수집'}`} />
              <SummaryCard label="수익성" value={overview.profitability.proven ? '증명됨' : '미증명'} note={statusLabel(overview.profitability.status)} />
            </section>

            <section>
              <div className="mb-3 flex items-center gap-2"><Activity className="h-4 w-4 text-primary" /><h2 className="text-sm font-black">Research Cycle</h2></div>
              <div className="grid min-w-0 gap-3 lg:grid-cols-3">{orderedCycles.map((cycle) => <CycleCard key={cycle.profile} cycle={cycle} />)}</div>
            </section>

            <section className="grid min-w-0 gap-3 xl:grid-cols-2">
              <article className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Database className="h-4 w-4 text-primary" /><h2 className="text-sm font-black">Paper Forward</h2></div><StatusBadge status={overview.paper.runtime.present ? overview.paper.runtime.status : 'not_started'} /></div>
                <dl className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                  <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">Cycle</dt><dd className="mt-1 font-black tabular-nums">{overview.paper.ledger.present ? overview.paper.ledger.cycleCount : '미수집'}</dd></div>
                  <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">Position</dt><dd className="mt-1 font-black tabular-nums">{overview.paper.ledger.present ? overview.paper.ledger.positionCount : '미수집'}</dd></div>
                  <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">Settlement</dt><dd className="mt-1 font-black tabular-nums">{overview.paper.ledger.present ? overview.paper.ledger.settlementCount : '미수집'}</dd></div>
                  <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">Private request</dt><dd className="mt-1 font-black tabular-nums">{overview.paper.runtime.present ? overview.paper.runtime.privateRequestCount : '미수집'}</dd></div>
                  <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">Financial mutation</dt><dd className="mt-1 font-black tabular-nums">{overview.paper.runtime.present ? overview.paper.runtime.financialMutationCount : '미수집'}</dd></div>
                  <div className="rounded-xl bg-background p-3"><dt className="text-muted-foreground">Actual order</dt><dd className="mt-1 font-black tabular-nums">{overview.paper.runtime.present ? overview.paper.runtime.orderCount : '미수집'}</dd></div>
                </dl>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {overview.paper.runtime.lanes.map((lane) => <div key={lane.market} className="flex items-center justify-between gap-2 rounded-xl border border-card-border px-3 py-2 text-xs"><span className="truncate font-bold">{lane.market}</span><span className="shrink-0 text-muted-foreground">{lane.status}</span></div>)}
                </div>
              </article>

              <article className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Activity className="h-4 w-4 text-primary" /><h2 className="text-sm font-black">Shadow</h2></div><StatusBadge status={overview.shadow.records.present ? (overview.shadow.records.settledRecords > 0 ? 'collecting' : 'pending') : 'not_started'} /></div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                  <SummaryCard label="전체" value={overview.shadow.records.present ? String(overview.shadow.records.totalRecords) : '미수집'} />
                  <SummaryCard label="정산" value={overview.shadow.records.present ? String(overview.shadow.records.settledRecords) : '미수집'} />
                  <SummaryCard label="대기" value={overview.shadow.records.present ? String(overview.shadow.records.pendingRecords) : '미수집'} />
                </div>
                <div className="mt-3 space-y-2">
                  {overview.shadow.groups.length ? overview.shadow.groups.map((group) => (
                    <div key={group.name} className="rounded-xl border border-card-border p-3 text-xs">
                      <div className="flex min-w-0 items-center justify-between gap-2"><strong className="truncate">{group.name}</strong><span className={group.collapsed === true ? 'font-black text-destructive' : 'text-muted-foreground'}>{group.collapsed == null ? 'Collapse 미수집' : group.collapsed ? 'COLLAPSED' : '비붕괴'}</span></div>
                      <p className="mt-2 text-muted-foreground">Macro F1 {formatMetric(group.macroF1)} · Balanced Accuracy {formatMetric(group.balancedAccuracy)} · Settled {group.settled ?? '미수집'} · Pending {group.pending ?? '미수집'}</p>
                    </div>
                  )) : <p className="rounded-xl bg-background p-4 text-xs text-muted-foreground">Shadow 그룹 지표는 아직 미수집입니다.</p>}
                </div>
              </article>
            </section>

            <section className="grid min-w-0 gap-3 xl:grid-cols-2">
              <article className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
                <h2 className="text-sm font-black">Strategy Health / Promotion</h2>
                {governanceQuery.isPending ? <p className="mt-3 text-xs text-muted-foreground">승격 증거를 불러오는 중입니다.</p> : null}
                {governanceQuery.isError ? <p className="mt-3 text-xs text-muted-foreground">승격 증거를 불러오지 못했습니다. 미수집으로 유지합니다.</p> : null}
                {promotion ? (
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <SummaryCard label="전략" value={`${promotion.items.length}개`} />
                    <SummaryCard label="승격 후보" value={`${promotion.promotionCandidates}개`} />
                    <SummaryCard label="Drift 측정" value={`${driftMeasured.length}개`} />
                    <SummaryCard label="Degraded/Critical" value={`${driftWarnings}개`} />
                  </div>
                ) : null}
                <p className="mt-3 break-keep text-xs leading-5 text-muted-foreground">Promotion Candidate는 Champion 또는 실거래 승인이 아닙니다. 최종 승격 증거가 없으면 그대로 미승격 상태로 유지됩니다.</p>
              </article>

              <article className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
                <h2 className="text-sm font-black">Profitability Evidence</h2>
                <div className="mt-3 flex items-center justify-between gap-3 rounded-2xl bg-background p-4"><div><p className="text-xs text-muted-foreground">현재 판정</p><p className="mt-1 text-lg font-black">{overview.profitability.proven ? 'PROVEN' : 'NOT PROVEN'}</p></div><StatusBadge status={overview.profitability.status} /></div>
                <p className="mt-3 break-keep text-xs leading-5 text-muted-foreground">{overview.profitability.proven ? '수익성 증거 게이트를 통과한 상태입니다.' : 'Paper 정산과 미래 표본이 충분히 쌓이기 전에는 수익성을 증명된 것으로 표시하지 않습니다.'}</p>
              </article>
            </section>

            <footer className="rounded-2xl border border-card-border bg-card p-3 text-[11px] text-muted-foreground">Research overview 생성: {formatDate(overview.generatedAt)} · 최신 cycle: {formatDate(overview.state.latestCycleAt)}</footer>
          </>
        ) : null}
      </div>
      <BottomNav />
    </main>
  );
}
