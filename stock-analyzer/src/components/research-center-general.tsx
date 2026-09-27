import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, Database, RefreshCw, TrendingUp, WalletCards, X } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { PROMOTION_STAGE_KO } from '@/lib/labels';
import { fetchResearchCenterOverview, type ResearchCandidatePerformance, type ResearchCenterOverview } from '@/lib/research-center';


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

const FULL_COST_COMPONENTS = [
  ['commission', '수수료'],
  ['tax', '세금'],
  ['spread', '스프레드'],
  ['slippage', '슬리피지'],
  ['funding', '펀딩'],
  ['latency', '지연 비용'],
  ['liquidityImpact', '유동성 영향'],
  ['partialFillImpact', '부분체결 영향'],
] as const;

type FullCostComponentKey = typeof FULL_COST_COMPONENTS[number][0];
type FullCostComponentState = ResearchCandidatePerformance['fullCostEvidence']['components'][FullCostComponentKey]['state'];

function fullCostStateLabel(state: FullCostComponentState) {
  if (state === 'MEASURED') return '관측됨';
  if (state === 'MODELED') return '모델값 · 경제증거 아님';
  if (state === 'BLOCKED_DATA') return '데이터 차단';
  return '미확인';
}

function fullCostStateClass(state: FullCostComponentState) {
  if (state === 'MEASURED') return 'border-positive/25 bg-positive/5 text-positive';
  if (state === 'MODELED') return 'border-warning/30 bg-warning/5 text-warning';
  if (state === 'BLOCKED_DATA') return 'border-destructive/25 bg-destructive/5 text-destructive';
  return 'border-card-border bg-muted/40 text-muted-foreground';
}

function formatCostValue(value: number | null) {
  return value == null ? '값 없음' : `${value.toFixed(4)}%`;
}

function fullCostEvidenceState(overview: ResearchCenterOverview) {
  const performance = overview.paper.candidatePerformance;
  const rows = FULL_COST_COMPONENTS.map(([key, label]) => {
    const component = performance?.fullCostEvidence?.components?.[key];
    return {
      key,
      label,
      state: component?.state ?? 'UNKNOWN' as FullCostComponentState,
      valuePercent: component?.valuePercent ?? null,
      provenance: component?.provenance ?? null,
    };
  });
  const measured = rows.filter((row) => row.state === 'MEASURED').length;
  const modeled = rows.filter((row) => row.state === 'MODELED').length;
  const blocked = rows.filter((row) => row.state === 'BLOCKED_DATA').length;
  const unknown = rows.filter((row) => row.state === 'UNKNOWN').length;
  const fullCostReady = Boolean(
    performance?.FULL_COST_READY
      && performance?.fullCostEvidence?.fullCostReady,
  );
  return {
    performance,
    rows,
    measured,
    modeled,
    blocked,
    unknown,
    fullCostReady,
    settlementN: performance?.Settlement_N ?? null,
    firstZero: performance?.FIRST_ZERO ?? 'CANDIDATE_PERFORMANCE_EVIDENCE_MISSING',
  };
}

type Tone = 'normal' | 'progress' | 'warning' | 'neutral';
const TONE: Record<Tone, string> = {
  normal: 'border-positive/25 bg-positive/5 text-positive',
  progress: 'border-primary/25 bg-primary/5 text-primary',
  warning: 'border-warning/30 bg-warning/5 text-warning',
  neutral: 'border-card-border bg-card text-muted-foreground',
};


function SummaryCard({ icon, label, value, detail, tone, selected, onClick, testId }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: Tone;
  selected?: boolean;
  onClick?: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={`${label} · ${value}`}
      title={detail}
      data-testid={testId}
      className={
        'min-w-0 rounded-xl border bg-card px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary '
        + (selected ? 'border-primary/60 bg-primary/5 ring-1 ring-primary/20' : 'border-card-border hover:border-primary/30 hover:bg-muted/30')
      }
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ' + TONE[tone]} aria-hidden="true">{icon}</span>
        <p className="min-w-0 truncate text-xs font-semibold text-muted-foreground">{label}</p>
      </div>
      <p className="mt-3 break-words text-lg font-bold tabular-nums">{value}</p>
    </button>
  );
}

function FullCostVisibility({ overview }: { overview: ResearchCenterOverview }) {
  const cost = fullCostEvidenceState(overview);
  const incomplete = cost.rows.filter((row) => row.state !== 'MEASURED');
  const ledgerSettlementN = overview.paper.ledger.settlementCount;
  const settlementLabel = cost.settlementN == null
    ? '후보 Settlement 미확인'
    : cost.settlementN === 0
      ? '후보 Settlement 0건 · 미연결'
      : `후보 Settlement ${cost.settlementN.toLocaleString('ko-KR')}건 연결`;
  const reason = cost.fullCostReady
    ? '8개 비용과 canonical 연결 근거가 모두 FULL_COST_READY로 확인됐습니다.'
    : incomplete.length > 0
      ? `${incomplete.map((row) => row.label).join(' · ')} 근거가 실측 완료 상태가 아닙니다.`
      : '8개 비용이 모두 관측돼도 canonical FULL_COST_READY가 false입니다. Settlement·identity·cost-policy 연결 근거를 더 확인해야 합니다.';

  return (
    <section className="rounded-2xl border border-card-border bg-card p-4 shadow-sm" data-testid="research-full-cost-summary" aria-label="Full Cost 경제증거">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-black uppercase tracking-[0.14em] text-primary">Economic evidence</p>
          <h2 className="mt-1 text-lg font-black">Full Cost 8개 비용</h2>
          <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">
            같은 후보의 비용·Settlement가 연결돼야 합니다. MODELED 값은 실제 경제증거로 승격하지 않습니다.
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[10px] font-black ${cost.fullCostReady ? TONE.normal : TONE.warning}`}>
          FULL_COST_READY · {cost.fullCostReady ? '충족' : '미충족'}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-xl bg-muted/40 p-3">
          <p className="text-[10px] font-bold text-muted-foreground">실측 완료</p>
          <p className="mt-1 text-base font-black tabular-nums">{cost.measured}/8</p>
        </div>
        <div className="rounded-xl bg-muted/40 p-3">
          <p className="text-[10px] font-bold text-muted-foreground">모델값</p>
          <p className="mt-1 text-base font-black tabular-nums">{cost.modeled}개</p>
        </div>
        <div className="rounded-xl bg-muted/40 p-3">
          <p className="text-[10px] font-bold text-muted-foreground">미확인/차단</p>
          <p className="mt-1 text-base font-black tabular-nums">{cost.unknown + cost.blocked}개</p>
        </div>
        <div className="rounded-xl bg-muted/40 p-3">
          <p className="text-[10px] font-bold text-muted-foreground">Settlement 연결</p>
          <p className="mt-1 break-keep text-sm font-black">{settlementLabel}</p>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-warning/25 bg-warning/5 p-3">
        <p className="text-xs font-black">왜 아직 미충족인가요?</p>
        <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">{reason}</p>
        <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">FIRST_ZERO · {cost.firstZero}</p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          전체 Paper ledger Settlement · {ledgerSettlementN == null ? '미확인' : `${ledgerSettlementN.toLocaleString('ko-KR')}건`} · 후보별 Settlement와 별도 집계
        </p>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {cost.rows.map((row) => (
          <article key={row.key} className="min-w-0 rounded-xl border border-card-border bg-background p-3" data-testid={`research-full-cost-${row.key}`}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs font-black">{row.label}</p>
              <span className={`rounded-full border px-2 py-0.5 text-[9px] font-black ${fullCostStateClass(row.state)}`}>{fullCostStateLabel(row.state)}</span>
            </div>
            <p className="mt-2 text-sm font-black tabular-nums">{formatCostValue(row.valuePercent)}</p>
            <p className="mt-2 break-all text-[10px] leading-4 text-muted-foreground">출처 · {row.provenance ?? '미제공'}</p>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">Freshness · API 미제공</p>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">Quality · API 미제공</p>
            <p className="mt-1 font-mono text-[9px] text-muted-foreground">state={row.state}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

export function ResearchCenterGeneral({ onOpenExpert }: { onOpenExpert?: () => void }) {
  const query = useQuery({
    queryKey: ['admin', 'research-center', 'overview'],
    queryFn: ({ signal }) => fetchResearchCenterOverview(signal),
    staleTime: 30_000,
    retry: 1,
  });

  const overview = query.data;
  const [selected, setSelected] = useState<'research' | 'data' | 'paper' | 'profitability' | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="research-general-view">
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-24">
        <div className="mx-auto w-full max-w-6xl space-y-4 px-3 py-4 sm:px-5 lg:py-6">

          <header className="flex items-center justify-between gap-3 border-b border-card-border/80 px-1 pb-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">Research Center</p>
              <h1 className="mt-0.5 text-xl font-bold sm:text-2xl">연구센터</h1>
            </div>
            <button
              type="button"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-card-border bg-card text-muted-foreground transition hover:text-foreground disabled:opacity-50"
              aria-label="연구 상태 새로고침"
            >
              <RefreshCw className={'h-4 w-4 ' + (query.isFetching ? 'animate-spin' : '')} aria-hidden="true" />
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
            const fullCost = fullCostEvidenceState(overview);
            const paperSummary = {
              ...sample,
              detail: `${sample.detail} · Full Cost ${fullCost.fullCostReady ? '충족' : `${fullCost.measured}/8 실측`}`,
            };
            return (
              <>

                <section className="rounded-2xl border border-card-border bg-card/95 p-3 sm:p-4" aria-label="연구 진행">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-bold">연구 진행</h2>
                    <span className="rounded-full bg-muted/70 px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
                      {profitability.tone === 'normal' ? '검증 완료' : '진행 중'}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                    {[
                      ['수집', dataFactory],
                      ['검증', research],
                      ['모의', sample],
                      ['수익성', profitability],
                    ].map(([label, state]) => {
                      const item = state as typeof research;
                      return (
                        <div key={label as string} className="min-w-0">
                          <div className={'mx-auto h-1 rounded-full ' + (item.tone === 'normal' ? 'bg-positive' : item.tone === 'warning' ? 'bg-warning' : item.tone === 'progress' ? 'bg-primary' : 'bg-muted')} />
                          <p className="mt-2 truncate text-[11px] font-semibold">{label as string}</p>
                          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{item.value}</p>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="연구 핵심 상태">
                  <SummaryCard testId="research-summary-research" selected={selected === 'research'} onClick={() => setSelected('research')} icon={<Activity className="h-4 w-4" />} label="연구 상태" {...research} />
                  <SummaryCard testId="research-summary-data" selected={selected === 'data'} onClick={() => setSelected('data')} icon={<Database className="h-4 w-4" />} label="데이터 수집" {...dataFactory} />
                  <SummaryCard testId="research-summary-paper" selected={selected === 'paper'} onClick={() => setSelected('paper')} icon={<WalletCards className="h-4 w-4" />} label="모의매매 표본" {...paperSummary} />
                  <SummaryCard testId="research-summary-profitability" selected={selected === 'profitability'} onClick={() => setSelected('profitability')} icon={<TrendingUp className="h-4 w-4" />} label="수익성 검증" {...profitability} />
                </section>

                {selected ? (() => {
                  const info = {
                    research: {
                      label: '연구 상태',
                      state: research,
                      context: '최근 연구 작업과 데이터 대기 상태를 합쳐 표시합니다.',
                    },
                    data: {
                      label: '데이터 수집',
                      state: dataFactory,
                      context: '실제로 수집된 시간순 public evidence만 집계합니다.',
                    },
                    paper: {
                      label: '모의매매 표본',
                      state: paperSummary,
                      context: '확인된 표본만 집계하며 누락값을 임의로 채우지 않습니다.',
                    },
                    profitability: {
                      label: '수익성 검증',
                      state: profitability,
                      context: '표본·정산·비용·OOS 근거가 충족되기 전까지 검증 중으로 유지합니다.',
                    },
                  }[selected];

                  return (
                    <>
                      <button
                        type="button"
                        aria-label="연구 상세 닫기"
                        onClick={() => setSelected(null)}
                        className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[1px]"
                        data-testid="research-general-detail-backdrop"
                      />
                      <aside
                        className="fixed inset-x-0 bottom-0 z-[51] max-h-[78dvh] overflow-y-auto rounded-t-3xl border border-card-border bg-card p-4 shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:w-[min(30rem,92vw)] md:max-h-none md:rounded-none md:border-y-0 md:border-r-0 lg:w-[28rem]"
                        data-testid="research-general-detail-panel"
                        aria-live="polite"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-primary">{info.label}</p>
                            <h2 className="mt-1 text-xl font-bold">{info.state.value}</h2>
                          </div>
                          <button
                            type="button"
                            onClick={() => setSelected(null)}
                            aria-label="닫기"
                            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-card-border text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <X className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </div>

                        <div className="mt-4 rounded-xl bg-muted/45 p-3">
                          <p className="text-sm font-medium leading-6 text-foreground">{info.state.detail}</p>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">{info.context}</p>
                        </div>

                        {(selected === 'paper' || selected === 'profitability') ? (
                          <details className="mt-3 rounded-xl border border-card-border bg-background/60">
                            <summary className="flex min-h-11 cursor-pointer list-none items-center px-3 text-sm font-semibold">비용 근거 상세</summary>
                            <div className="border-t border-card-border p-3">
                              <FullCostVisibility overview={overview} />
                            </div>
                          </details>
                        ) : null}

                        <details className="mt-3 rounded-xl border border-card-border bg-background/60">
                          <summary className="flex min-h-11 cursor-pointer list-none items-center px-3 text-sm font-semibold">추가 상태</summary>
                          <div className="space-y-2 border-t border-card-border p-3">
                            {[
                              ['리서치 팩토리', factoryRuntime],
                              ['실시간 관찰', shadow],
                              ['실행 권한', execution],
                            ].map(([label, state]) => {
                              const item = state as typeof research;
                              return (
                                <div key={label as string} className="flex items-center justify-between gap-3 rounded-lg bg-muted/35 px-3 py-2">
                                  <span className="text-xs text-muted-foreground">{label as string}</span>
                                  <span className="text-sm font-semibold">{item.value}</span>
                                </div>
                              );
                            })}
                          </div>
                        </details>

                        {onOpenExpert ? (
                          <button
                            type="button"
                            onClick={() => {
                              setSelected(null);
                              onOpenExpert();
                            }}
                            className="mt-4 min-h-11 w-full rounded-xl border border-primary/35 bg-primary/10 px-4 text-sm font-semibold text-primary"
                          >
                            상세 근거
                          </button>
                        ) : null}
                      </aside>
                    </>
                  );
                })() : null}
              </>
            );
          })() : null}
        </div>
      </main>
      <BottomNav />
    </div>
  );
}