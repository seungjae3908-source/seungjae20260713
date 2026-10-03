import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, Database, RefreshCw, TrendingUp, WalletCards, X, MoreHorizontal } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { PROMOTION_STAGE_KO } from '@/lib/labels';
import { fetchResearchCenterOverview, type ResearchCandidatePerformance, type ResearchCenterOverview } from '@/lib/research-center';

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
  if (!overview.state.present) return { value: '근거 미수집', detail: '연구 개요 자료가 아직 없습니다.', tone: 'neutral' as const };
  if ((overview.research.failedTasks ?? 0) > 0) return { value: '확인 필요', detail: `실패 작업 ${overview.research.failedTasks}건`, tone: 'warning' as const };
  if ((overview.research.blockedDataTasks ?? 0) > 0) return { value: '근거 수집 중', detail: `데이터 대기 작업 ${overview.research.blockedDataTasks}건`, tone: 'progress' as const };
  if (/collect|running|progress/i.test(overview.research.status)) return { value: '연구 진행 중', detail: '새 근거를 수집하고 있습니다.', tone: 'progress' as const };
  return { value: '연구 상태 확인됨', detail: '현재 조회용 연구 개요가 연결되어 있습니다.', tone: 'normal' as const };
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
  if (!temporal) return { value: '미수집', detail: '시점 자료 수집 기록이 없습니다.', tone: 'neutral' as const };
  if (!temporal.present) return { value: '미수집', detail: '시점 자료 수집 기록이 없습니다.', tone: 'neutral' as const };
  if (temporal.status === 'INVALID') return { value: '확인 필요', detail: '시점 자료 무결성 검증에 실패했습니다.', tone: 'warning' as const };
  if (temporal.status === 'partial_failure') {
    return {
      value: temporal.observationCount == null ? '부분 실패' : `${temporal.observationCount.toLocaleString('ko-KR')}건`,
      detail: `심볼 실패 ${temporal.failedCount ?? 0}건 · 정상 증거는 보존`,
      tone: 'warning' as const,
    };
  }
  return {
    value: temporal.observationCount == null ? '누적 중' : `${temporal.observationCount.toLocaleString('ko-KR')}건`,
    detail: `${temporal.results.length.toLocaleString('ko-KR')}개 심볼 · 공개 시점 자료`,
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
    return { value: '연구 데이터 대기', detail: '시장 프로필 자료가 준비되는 중입니다.', tone: 'progress' as const };
  }
  if (factory.status === 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_MISSING') {
    return { value: '개발 진단 필요', detail: '준비된 프로필의 개발 전용 진단 자료가 아직 없습니다.', tone: 'progress' as const };
  }
  if (factory.status === 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_INVALID') {
    return { value: '개발 진단 오류', detail: '진단값 형식 또는 사후정보 사용 금지 규칙을 확인해야 합니다.', tone: 'warning' as const };
  }
  if (factory.status === 'BLOCKED_RUNTIME_BINDINGS') {
    return { value: '엔진 연결 중', detail: '기존 백테스터·검증 연결 자료를 기다립니다.', tone: 'progress' as const };
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
  return { value: `${value.toLocaleString('ko-KR')}건`, detail: '현재 연구 개요가 제공한 표본 수입니다.', tone: 'normal' as const };
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
  if (overview.profitability.proven) return { value: '검증 완료', detail: '현재 연구 개요가 수익성 검증 충족을 보고합니다.', tone: 'normal' as const };
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
  if (state === 'MODELED') return '추정값 · 실측 아님';
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
      data-testid={testId}
      className={
        'min-w-0 rounded-2xl border bg-card p-3 text-left shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary '
        + (selected ? 'border-primary ring-1 ring-primary/25' : 'border-card-border')
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div className={'flex h-9 w-9 items-center justify-center rounded-xl border ' + TONE[tone]} aria-hidden="true">{icon}</div>
        <span className="text-xs font-black text-muted-foreground">{selected ? '선택됨' : '보기'}</span>
      </div>
      <p className="mt-3 text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-lg font-bold tabular-nums">{value}</p>
      <p className="mt-1 line-clamp-2 break-keep text-xs font-medium leading-5 text-muted-foreground">{detail}</p>
    </button>
  );
}

function FullCostVisibility({ overview }: { overview: ResearchCenterOverview }) {
  const cost = fullCostEvidenceState(overview);
  const incomplete = cost.rows.filter((row) => row.state !== 'MEASURED');
  const ledgerSettlementN = overview.paper.ledger.settlementCount;
  const settlementLabel = cost.settlementN == null
    ? '후보 정산 미확인'
    : cost.settlementN === 0
      ? '후보 정산 0건 · 미연결'
      : `후보 정산 ${cost.settlementN.toLocaleString('ko-KR')}건 연결`;
  const reason = cost.fullCostReady
    ? '비용 8항목과 후보 연결 자료가 모두 확인됐습니다.'
    : incomplete.length > 0
      ? `${incomplete.map((row) => row.label).join(' · ')} 근거가 실측 완료 상태가 아닙니다.`
      : '비용 8항목이 모두 관측돼도 후보 정산·식별·비용정책 연결 자료가 더 필요합니다.';

  return (
    <section className="rounded-2xl border border-card-border bg-card p-4 shadow-sm" data-testid="research-full-cost-summary" aria-label="전체 비용 검증">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          
          <h2 className="mt-1 text-lg font-black">비용 8항목</h2>
          
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[10px] font-black ${cost.fullCostReady ? TONE.normal : TONE.warning}`}>
          전체 비용 검증 · {cost.fullCostReady ? '충족' : '미충족'}
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
          <p className="text-[10px] font-bold text-muted-foreground">정산 연결</p>
          <p className="mt-1 break-keep text-sm font-black">{settlementLabel}</p>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-warning/25 bg-warning/5 p-3">
        <p className="text-xs font-black">왜 아직 미충족인가요?</p>
        <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">{reason}</p>
        <p className="mt-2 text-[10px] text-muted-foreground">현재 막힌 단계 · {cost.firstZero === 'CANDIDATE_PERFORMANCE_EVIDENCE_MISSING' ? '후보 성과 자료 필요' : '추가 검증 자료 필요'}</p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          전체 모의매매 정산 · {ledgerSettlementN == null ? '미확인' : `${ledgerSettlementN.toLocaleString('ko-KR')}건`} · 후보별 정산과 별도 집계
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
            <p className="mt-2 text-[10px] leading-4 text-muted-foreground">출처 · {row.provenance ? '확인됨' : '미제공'}</p>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">신선도 · 미제공</p>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">품질 · 미제공</p>
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
  const [otherOpen, setOtherOpen] = useState(false);

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setSelected(null);
      setOtherOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="research-general-view">
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-24">
        <div className="mx-auto w-full max-w-6xl space-y-4 px-3 py-4 sm:px-5 lg:py-6">

          <header className="rounded-2xl border border-card-border bg-card p-4 shadow-sm sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                
                <h1 className="mt-1 text-xl font-black sm:text-2xl">현재 어디까지 왔나요?</h1>
                
              </div>
              <button
                type="button"
                onClick={() => void query.refetch()}
                disabled={query.isFetching}
                className="flex min-h-11 shrink-0 items-center justify-center rounded-xl border border-card-border px-3 disabled:opacity-50"
                aria-label="연구 상태 새로고침"
              >
                <RefreshCw className={'h-4 w-4 ' + (query.isFetching ? 'animate-spin' : '')} aria-hidden="true" />
              </button>
            </div>
            {overview ? <p className="mt-3 text-xs text-muted-foreground">마지막 업데이트 · <strong className="text-foreground">{formatDate(overview.state.latestCycleAt)}</strong></p> : null}
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
              detail: `${sample.detail} · 전체 비용 ${fullCost.fullCostReady ? '충족' : `${fullCost.measured}/8 실측`}`,
            };
            return (
              <>

                <section className="rounded-2xl border border-card-border bg-card p-4 shadow-sm" aria-label="연구 진행 흐름">
                  <p className="text-xs font-bold text-muted-foreground">전체 흐름</p>
                  <h2 className="mt-1 text-base font-black">수집 → 검증 → 모의매매 → 수익성</h2>
                  <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                    {[
                      ['수집', dataFactory],
                      ['검증', research],
                      ['모의매매', sample],
                      ['수익성', profitability],
                    ].map(([label, state]) => {
                      const item = state as typeof research;
                      return (
                        <div key={label as string} className="min-w-0">
                          <div className={'mx-auto h-1.5 rounded-full ' + (item.tone === 'normal' ? 'bg-positive' : item.tone === 'warning' ? 'bg-warning' : item.tone === 'progress' ? 'bg-primary' : 'bg-muted')} />
                          <p className="mt-2 truncate text-[11px] font-bold">{label as string}</p>
                          <p className="truncate text-[10px] text-muted-foreground">{item.value}</p>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="grid grid-cols-2 gap-2" aria-label="연구 핵심 상태">
                  <SummaryCard testId="research-summary-research" selected={selected === 'research'} onClick={() => setSelected('research')} icon={<Activity className="h-5 w-5" />} label="연구 상태" {...research} />
                  <SummaryCard testId="research-summary-data" selected={selected === 'data'} onClick={() => setSelected('data')} icon={<Database className="h-5 w-5" />} label="데이터 수집" {...dataFactory} />
                  <SummaryCard testId="research-summary-paper" selected={selected === 'paper'} onClick={() => setSelected('paper')} icon={<WalletCards className="h-5 w-5" />} label="모의매매 표본" {...paperSummary} />
                  <SummaryCard testId="research-summary-profitability" selected={selected === 'profitability'} onClick={() => setSelected('profitability')} icon={<TrendingUp className="h-5 w-5" />} label="수익성 검증" {...profitability} />
                </section>
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-card-border bg-card px-3 py-2 text-xs font-bold" data-testid="research-general-compact-status">
                  <span>그림자 검증 {shadow.value}</span>
                  <span className="text-muted-foreground">·</span>
                  <span>{execution.value}</span>
                </div>

                {selected ? (() => {
                  const info = {
                    research: {
                      label: '연구 상태',
                      state: research,
                      why: '최근 연구 작업과 데이터 대기·실패 상태를 합쳐 보여줍니다.',
                      next: '실패 작업이 있으면 상세 검증에서 막힌 단계를 확인하고, 데이터 대기면 자연 표본을 누적합니다.',
                    },
                    data: {
                      label: '데이터 수집',
                      state: dataFactory,
                      why: '시간 순서 기반 자료가 실제로 들어왔는지 보여줍니다.',
                      next: '표본이 없으면 임의로 채우지 않고 실제 관측 자료가 들어오는지 확인합니다.',
                    },
                    paper: {
                      label: '모의매매 표본',
                      state: paperSummary,
                      why: '검증된 모의매매 표본만 집계하고 후보별 전체 비용을 별도로 확인합니다.',
                      next: '비용 8항목의 실측 여부와 후보 정산 연결을 함께 확인합니다.',
                    },
                    profitability: {
                      label: '수익성 검증',
                      state: profitability,
                      why: '표본·정산·비용·미래검증 자료가 모두 충족되기 전에는 검증 중으로 유지합니다.',
                      next: '다음 검증 자료가 자연스럽게 누적되는지 확인합니다.',
                    },
                  }[selected];
                  return (
                    <div
                      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4"
                      role="presentation"
                      onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}
                      data-testid="research-general-detail-overlay"
                    >
                      <section
                        role="dialog"
                        aria-modal="true"
                        aria-label={`${info.label} 상세`}
                        className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-t-3xl border border-card-border bg-background p-4 shadow-2xl sm:rounded-3xl sm:p-5"
                        data-testid="research-general-detail-dialog"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h2 className="text-lg font-black">{info.label}</h2>
                            <p className="mt-1 text-sm font-bold">{info.state.value}</p>
                          </div>
                          <button type="button" onClick={() => setSelected(null)} className="flex h-10 w-10 items-center justify-center rounded-full border border-card-border" aria-label="닫기">
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                        <div className="mt-4 grid gap-2 sm:grid-cols-2">
                          <div className="rounded-xl bg-muted/40 p-3">
                            <p className="text-xs font-black">현재 상태</p>
                            <p className="mt-2 break-keep text-sm leading-6 text-muted-foreground">{info.why}</p>
                          </div>
                          <div className="rounded-xl bg-muted/40 p-3">
                            <p className="text-xs font-black">다음 단계</p>
                            <p className="mt-2 break-keep text-sm leading-6 text-muted-foreground">{info.next}</p>
                          </div>
                        </div>
                        {selected === 'paper' || selected === 'profitability'
                          ? <div className="mt-4"><FullCostVisibility overview={overview} /></div>
                          : null}
                        {onOpenExpert ? (
                          <button type="button" onClick={() => { setSelected(null); onOpenExpert(); }} className="mt-4 min-h-11 w-full rounded-xl border border-primary/30 bg-primary/5 px-4 text-sm font-black text-primary">
                            상세 검증 보기
                          </button>
                        ) : null}
                      </section>
                    </div>
                  );
                })() : null}

                <button
                  type="button"
                  onClick={() => setOtherOpen(true)}
                  className="flex min-h-12 w-full items-center justify-between rounded-2xl border border-card-border bg-card px-4 text-sm font-black shadow-sm"
                  data-testid="research-general-other-open"
                >
                  기타 상태 보기
                  <MoreHorizontal className="h-4 w-4" />
                </button>

                {otherOpen ? (
                  <div
                    className="fixed inset-0 z-[100] flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4"
                    role="presentation"
                    onMouseDown={(event) => { if (event.target === event.currentTarget) setOtherOpen(false); }}
                  >
                    <section role="dialog" aria-modal="true" aria-label="기타 연구 상태" className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-t-3xl border border-card-border bg-background p-4 shadow-2xl sm:rounded-3xl sm:p-5" data-testid="research-general-other-dialog">
                      <div className="mb-4 flex items-center justify-between gap-3">
                        <h2 className="text-base font-black">기타 연구 상태</h2>
                        <button type="button" onClick={() => setOtherOpen(false)} className="flex h-10 w-10 items-center justify-center rounded-full border border-card-border" aria-label="닫기"><X className="h-4 w-4" /></button>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-3">
                        {[
                          ['연구 엔진', factoryRuntime],
                          ['그림자 검증 기록', shadow],
                          ['실행 권한', execution],
                        ].map(([label, state]) => {
                          const item = state as typeof research;
                          return (
                            <article key={label as string} className="rounded-xl bg-muted/35 p-3">
                              <p className="text-xs font-bold text-muted-foreground">{label as string}</p>
                              <p className="mt-2 text-base font-black">{item.value}</p>
                              <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">{item.detail}</p>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  </div>
                ) : null}
              </>
            );
          })() : null}
        </div>
      </main>
      <BottomNav />
    </div>
  );
}