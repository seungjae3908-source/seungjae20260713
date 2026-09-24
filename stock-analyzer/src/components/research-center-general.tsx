import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, Clock3, Database, RefreshCw, TrendingUp, WalletCards } from 'lucide-react';
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

export function ResearchCenterGeneral({ onOpenExpert }: { onOpenExpert?: () => void }) {
  const query = useQuery({
    queryKey: ['admin', 'research-center', 'overview'],
    queryFn: ({ signal }) => fetchResearchCenterOverview(signal),
    staleTime: 30_000,
    retry: 1,
  });

  const overview = query.data;
  const [selected, setSelected] = useState<'research' | 'data' | 'paper' | 'profitability'>('research');

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="research-general-view">
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-24">
        <div className="mx-auto w-full max-w-6xl space-y-4 px-3 py-4 sm:px-5 lg:py-6">

          <header className="rounded-2xl border border-card-border bg-card p-4 shadow-sm sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-black uppercase tracking-[0.14em] text-primary">Research Center</p>
                <h1 className="mt-1 text-xl font-black sm:text-2xl">현재 어디까지 왔나요?</h1>
                <p className="mt-2 break-keep text-sm leading-6 text-muted-foreground">
                  카드 하나를 누르면 왜 그런 상태인지와 다음에 볼 것을 바로 설명합니다.
                </p>
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
                  <SummaryCard testId="research-summary-paper" selected={selected === 'paper'} onClick={() => setSelected('paper')} icon={<WalletCards className="h-5 w-5" />} label="모의매매 표본" {...sample} />
                  <SummaryCard testId="research-summary-profitability" selected={selected === 'profitability'} onClick={() => setSelected('profitability')} icon={<TrendingUp className="h-5 w-5" />} label="수익성 검증" {...profitability} />
                </section>

                {(() => {
                  const info = {
                    research: {
                      label: '연구 상태',
                      state: research,
                      why: '최근 연구 작업과 데이터 대기·실패 상태를 합쳐 보여주는 값입니다.',
                      next: '실패 작업이 있으면 상세 근거에서 FIRST_ZERO를 확인하고, 데이터 대기면 자연 표본을 기다립니다.',
                    },
                    data: {
                      label: '데이터 수집',
                      state: dataFactory,
                      why: '시간 순서 기반 public evidence가 실제로 들어왔는지 보여줍니다.',
                      next: '표본이 0이면 억지로 채우지 않고 첫 자연 observation이 들어오는지 확인합니다.',
                    },
                    paper: {
                      label: '모의매매 표본',
                      state: sample,
                      why: '모의매매 중에서도 canonical ledger가 확인한 표본만 집계합니다.',
                      next: '표본 수뿐 아니라 정산과 비용이 같은 후보에 연결되는지 확인해야 합니다.',
                    },
                    profitability: {
                      label: '수익성 검증',
                      state: profitability,
                      why: '표본·정산·비용·OOS 근거가 모두 충족되기 전에는 검증 중으로 유지합니다.',
                      next: '미검증을 손실로 해석하지 말고, 다음 evidence 단계가 채워지는지 확인합니다.',
                    },
                  }[selected];
                  return (
                    <section className="rounded-2xl border border-primary/25 bg-card p-4 shadow-sm" data-testid="research-general-selected-detail" aria-live="polite">
                      <p className="text-[11px] font-black text-primary">선택한 항목</p>
                      <h2 className="mt-1 text-lg font-black">{info.label} · {info.state.value}</h2>
                      <div className="mt-4 grid gap-2 sm:grid-cols-2">
                        <div className="rounded-xl bg-muted/40 p-3">
                          <p className="text-xs font-black">왜 이렇게 표시되나요?</p>
                          <p className="mt-2 break-keep text-sm leading-6 text-muted-foreground">{info.why}</p>
                        </div>
                        <div className="rounded-xl bg-muted/40 p-3">
                          <p className="text-xs font-black">다음에 뭘 보면 되나요?</p>
                          <p className="mt-2 break-keep text-sm leading-6 text-muted-foreground">{info.next}</p>
                        </div>
                      </div>
                      {onOpenExpert ? (
                        <button type="button" onClick={onOpenExpert} className="mt-3 min-h-11 w-full rounded-xl border border-primary/30 bg-primary/5 px-4 text-sm font-black text-primary">
                          상세 근거 보기
                        </button>
                      ) : null}
                    </section>
                  );
                })()}

                <details className="rounded-2xl border border-card-border bg-card shadow-sm">
                  <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-black">
                    <span>기타 상태 보기</span>
                    <span className="text-xs font-medium text-muted-foreground">팩토리 · Shadow · 실행 권한</span>
                  </summary>
                  <div className="grid gap-2 border-t border-card-border p-3 sm:grid-cols-3">
                    {[
                      ['리서치 팩토리', factoryRuntime],
                      ['Shadow 기록', shadow],
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
                </details>

                <section className="rounded-2xl border border-card-border bg-card p-4 shadow-sm">
                  <div className="flex items-start gap-3">
                    <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                    <div>
                      <h2 className="text-sm font-black">이 화면은 이렇게 보면 됩니다</h2>
                      <p className="mt-1 break-keep text-sm leading-6 text-muted-foreground">
                        위 카드 하나를 누르면 설명이 바뀝니다. SHA·원본 식별자·검증 코드는 필요할 때만 ‘상세 근거 보기’에서 확인하세요.
                      </p>
                    </div>
                  </div>
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