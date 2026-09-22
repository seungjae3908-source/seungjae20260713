import { useQuery } from '@tanstack/react-query';
import { Activity, Clock3, Database, FlaskConical, RefreshCw, ShieldCheck, TrendingUp, WalletCards } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { PROMOTION_STAGE_KO } from '@/lib/labels';
import { fetchResearchCenterOverview, type ResearchCenterOverview } from '@/lib/research-center';

function formatDate(value: number | null | undefined) {
  if (value == null) return '미확인';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '미확인';
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(date);
}

function researchState(overview: ResearchCenterOverview) {
  if (!overview.state.present) return { value: '근거 미수집', detail: '연구 overview 근거가 아직 없습니다.', tone: 'neutral' as const };
  if ((overview.research.failedTasks ?? 0) > 0) return { value: '확인 필요', detail: `실패 작업 ${overview.research.failedTasks}건`, tone: 'warning' as const };
  if ((overview.research.blockedDataTasks ?? 0) > 0) return { value: '근거 수집 중', detail: `데이터 대기 작업 ${overview.research.blockedDataTasks}건`, tone: 'progress' as const };
  if (/collect|running|progress/i.test(overview.research.status)) return { value: '연구 진행 중', detail: '새 근거를 수집하고 있습니다.', tone: 'progress' as const };
  return { value: '연구 상태 확인됨', detail: '현재 read-only overview가 연결되어 있습니다.', tone: 'normal' as const };
}

function executionState(overview: ResearchCenterOverview) {
  if (overview.safety.forbiddenAuthorityObserved) return { value: '확인 필요', detail: '금지된 실행 권한 근거가 관측되었습니다.', tone: 'warning' as const };
  if (!overview.safety.authorityEvidenceComplete) return { value: '권한 근거 미확인', detail: '실행 권한 상태를 확정할 근거가 부족합니다.', tone: 'neutral' as const };
  if (overview.safety.readOnlyDashboard && !overview.safety.liveTrading && !overview.safety.orderAuthority) {
    return { value: '실거래 비활성', detail: '읽기 전용 · 실행 권한 없음', tone: 'normal' as const };
  }
  return { value: '확인 필요', detail: '전문가 보기에서 권한 근거를 확인하세요.', tone: 'warning' as const };
}

function dataFactoryState(overview: ResearchCenterOverview) {
  const temporal = overview.dataFactory?.temporalCryptoFutures;
  if (!temporal) return { value: '미수집', detail: 'Temporal evidence 수집 기록이 없습니다.', tone: 'neutral' as const };
  if (!temporal.present) return { value: '미수집', detail: 'Temporal evidence 수집 기록이 없습니다.', tone: 'neutral' as const };
  if (temporal.status === 'INVALID') return { value: '확인 필요', detail: 'Temporal evidence 무결성 검증에 실패했습니다.', tone: 'warning' as const };
  if (temporal.status === 'partial_failure') {
    return {
      value: temporal.observationCount == null ? '부분 실패' : `${temporal.observationCount.toLocaleString('ko-KR')}건`,
      detail: `심볼 실패 ${temporal.failedCount ?? 0}건 · 정상 증거는 보존`,
      tone: 'warning' as const,
    };
  }
  return {
    value: temporal.observationCount == null ? '누적 중' : `${temporal.observationCount.toLocaleString('ko-KR')}건`,
    detail: `${temporal.results.length.toLocaleString('ko-KR')}개 심볼 · public temporal evidence`,
    tone: 'progress' as const,
  };
}

function factoryRuntimeState(overview: ResearchCenterOverview) {
  const factory = overview.factory;
  if (!factory?.present) return { value: '상태 미수집', detail: '리서치 팩토리 상태 기록이 아직 없습니다.', tone: 'neutral' as const };
  if (factory.status === 'INVALID' || factory.status === 'BLOCKED_POLICY_INVALID') {
    return { value: '확인 필요', detail: '팩토리 상태 또는 승인 정책 무결성을 확인해야 합니다.', tone: 'warning' as const };
  }
  if (factory.status === 'BLOCKED_POLICY_MISSING') {
    return { value: '정책 확정 필요', detail: '후보 수·단계별 축소 정책이 아직 승인되지 않았습니다.', tone: 'warning' as const };
  }
  if (factory.status === 'BLOCKED_NO_READY_PROFILES') {
    return { value: '연구 데이터 대기', detail: 'Canonical 시장 프로필 근거가 준비되는 중입니다.', tone: 'progress' as const };
  }
  if (factory.status === 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_MISSING') {
    return { value: '개발 진단 필요', detail: '준비된 프로필의 DEVELOPMENT-only 진단 근거가 아직 없습니다.', tone: 'progress' as const };
  }
  if (factory.status === 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_INVALID') {
    return { value: '개발 진단 오류', detail: '진단값 형식 또는 hindsight 금지 규칙을 확인해야 합니다.', tone: 'warning' as const };
  }
  if (factory.status === 'BLOCKED_RUNTIME_BINDINGS') {
    return { value: '엔진 연결 중', detail: '기존 백테스터·검증 owner 연결 근거를 기다립니다.', tone: 'progress' as const };
  }
  if (factory.status === 'READY_NON_ACTIVATING') {
    return { value: '연구 준비됨', detail: '자동 실행 전 단계까지 검증됐으며 실행 권한은 없습니다.', tone: 'normal' as const };
  }
  return { value: '상태 확인 중', detail: factory.firstZero ?? '팩토리 상태를 확인하고 있습니다.', tone: 'neutral' as const };
}

function paperSample(overview: ResearchCenterOverview) {
  const value = overview.paper.ledger.sampleCount ?? overview.paper.ledger.settlementCount;
  if (value == null) return { value: '미확인', detail: '모의매매 표본 수 근거가 없습니다.', tone: 'neutral' as const };
  if (value === 0) return { value: '0건', detail: '아직 정산된 모의매매 표본이 없습니다.', tone: 'progress' as const };
  return { value: `${value.toLocaleString('ko-KR')}건`, detail: '현재 overview가 제공한 표본 수입니다.', tone: 'normal' as const };
}

function shadowState(overview: ResearchCenterOverview) {
  const records = overview.shadow.records;
  if (!records.present || records.totalRecords == null) return { value: '미확인', detail: `${PROMOTION_STAGE_KO.SHADOW} 기록 근거가 아직 없습니다.`, tone: 'neutral' as const };
  return {
    value: `${records.totalRecords.toLocaleString('ko-KR')}건`,
    detail: records.settledRecords == null ? '정산 기록 수는 미확인입니다.' : `정산 ${records.settledRecords.toLocaleString('ko-KR')}건`,
    tone: records.totalRecords === 0 ? 'progress' as const : 'normal' as const,
  };
}

function profitabilityState(overview: ResearchCenterOverview) {
  if (overview.profitability.proven) return { value: '검증 완료', detail: '현재 canonical overview가 수익성 검증 충족을 보고합니다.', tone: 'normal' as const };
  return { value: '검증 중', detail: '미검증은 수익성이 없다는 뜻이 아닙니다.', tone: 'progress' as const };
}

type Tone = 'normal' | 'progress' | 'warning' | 'neutral';
const TONE: Record<Tone, string> = {
  normal: 'border-positive/25 bg-positive/5 text-positive',
  progress: 'border-primary/25 bg-primary/5 text-primary',
  warning: 'border-warning/30 bg-warning/5 text-warning',
  neutral: 'border-card-border bg-card text-muted-foreground',
};

function SummaryCard({ icon, label, value, detail, tone }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: Tone;
}) {
  return (
    <article className="min-w-0 rounded-2xl border border-card-border bg-card p-4 text-center shadow-sm">
      <div className={`mx-auto flex h-10 w-10 items-center justify-center rounded-xl border ${TONE[tone]}`} aria-hidden="true">{icon}</div>
      <p className="mt-3 text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-lg font-bold tabular-nums">{value}</p>
      <p className="mt-2 break-keep text-xs font-medium leading-5 text-muted-foreground">{detail}</p>
    </article>
  );
}

export function ResearchCenterGeneral() {
  const query = useQuery({
    queryKey: ['admin', 'research-center', 'overview'],
    queryFn: ({ signal }) => fetchResearchCenterOverview(signal),
    staleTime: 30_000,
    retry: 1,
  });

  const overview = query.data;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="research-general-view">
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-24">
        <div className="mx-auto w-full max-w-6xl space-y-4 px-3 py-4 sm:px-5 lg:py-6">
          <header className="rounded-2xl border border-card-border bg-card p-4 text-center shadow-sm sm:p-5">
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><FlaskConical className="h-5 w-5" aria-hidden="true" /></span>
            <h1 className="mt-3 text-xl font-bold sm:text-2xl">연구센터</h1>
            <p className="mx-auto mt-2 max-w-2xl break-keep text-sm font-medium leading-6 text-muted-foreground">
              지금 믿을 수 있는 연구 상태와 검증 진행 상황만 간단히 보여줍니다.
            </p>
            <button
              type="button"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
              className="mx-auto mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-card-border px-4 text-sm font-semibold disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
              {query.isFetching ? '확인 중' : '상태 새로고침'}
            </button>
          </header>

          {query.isPending ? (
            <section aria-busy="true" aria-label="연구 상태 확인 중" className="grid grid-cols-2 gap-2 lg:grid-cols-3">
              {Array.from({ length: 6 }, (_, index) => <div key={index} className="h-36 animate-pulse rounded-2xl bg-muted/40" />)}
            </section>
          ) : null}

          {query.isError ? (
            <section role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/10 p-5 text-center">
              <h2 className="text-base font-bold text-destructive">연구 상태를 불러오지 못했습니다.</h2>
              <p className="mt-2 text-sm text-muted-foreground">오류를 정상이나 0으로 바꾸지 않습니다.</p>
              <button type="button" onClick={() => void query.refetch()} className="mt-4 min-h-11 rounded-xl border border-destructive/30 px-4 text-sm font-semibold">다시 확인</button>
            </section>
          ) : null}

          {overview ? (() => {
            const research = researchState(overview);
            const dataFactory = dataFactoryState(overview);
            const factoryRuntime = factoryRuntimeState(overview);
            const sample = paperSample(overview);
            const shadow = shadowState(overview);
            const profitability = profitabilityState(overview);
            const execution = executionState(overview);
            return (
              <>
                <section className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="연구 핵심 상태">
                  <SummaryCard icon={<Activity className="h-5 w-5" />} label="연구 상태" {...research} />
                  <SummaryCard icon={<Database className="h-5 w-5" />} label="데이터 팩토리" {...dataFactory} />
                  <SummaryCard icon={<FlaskConical className="h-5 w-5" />} label="리서치 팩토리" {...factoryRuntime} />
                  <SummaryCard icon={<WalletCards className="h-5 w-5" />} label="모의매매 표본" {...sample} />
                  <SummaryCard icon={<TrendingUp className="h-5 w-5" />} label={`${PROMOTION_STAGE_KO.SHADOW} 기록`} {...shadow} />
                  <SummaryCard icon={<FlaskConical className="h-5 w-5" />} label="수익성 검증" {...profitability} />
                  <SummaryCard icon={<ShieldCheck className="h-5 w-5" />} label="실행 권한" {...execution} />
                  <SummaryCard icon={<Clock3 className="h-5 w-5" />} label="마지막 업데이트" value={formatDate(overview.state.latestCycleAt)} detail="Asia/Seoul 기준" tone={overview.state.latestCycleAt ? 'normal' : 'neutral'} />
                </section>

                <section className="rounded-2xl border border-card-border bg-card p-4 text-center shadow-sm">
                  <h2 className="text-base font-bold">어떻게 보면 되나요?</h2>
                  <p className="mx-auto mt-2 max-w-2xl break-keep text-sm font-medium leading-6 text-muted-foreground">
                    표본과 정산 근거가 충분해질수록 검증이 진행됩니다. 수익성은 근거가 충족되기 전까지 검증 중으로 유지합니다.
                  </p>
                  <p className="mx-auto mt-2 max-w-2xl break-keep text-xs font-medium leading-5 text-muted-foreground">
                    데이터 출처·원본 식별자·검증 근거 같은 기술 정보는 상단의 전문가 보기에서 확인할 수 있습니다.
                  </p>
                </section>
              </>
            );
          })() : null}
        </div>
      </main>
      <BottomNav />
    </div>
  );
}