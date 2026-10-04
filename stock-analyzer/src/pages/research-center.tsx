import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BadgeCheck,
  Bot,
  BrainCircuit,
  ChevronRight,
  CircleAlert,
  Database,
  Download,
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
  X,
} from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { PaperClosedLoopObserver } from '@/components/paper-closed-loop-observer';
import { fetchResearchCenterOverview, type ResearchCandidatePerformance, type ResearchCenterOverview } from '@/lib/research-center';
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
import { downloadExcelWorkbook } from '@/lib/excel-export';

type ResearchTab = 'overview' | 'ai-lab' | 'evidence' | 'paper';

const TABS: Array<{ key: ResearchTab; label: string; icon: typeof Activity }> = [
  { key: 'overview', label: '연구 현황', icon: Activity },
  { key: 'ai-lab', label: '인공지능 분석실', icon: BrainCircuit },
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

function evidenceStateLabel(value: string): string {
  const labels: Record<string, string> = {
    PRESENT: '확인됨',
    MISSING: '자료 없음',
    WRONG_SHA: '연구 버전 불일치',
    INVALID: '자료 오류',
    BLOCKED_DATA: '자료 부족',
    UNKNOWN: '미확인',
  };
  return labels[value] ?? '확인 필요';
}

function runtimeCodeLabel(value: string | null | undefined): string {
  if (!value) return '미확인';
  const labels: Record<string, string> = {
    LIVE: '정상',
    STALE: '지연',
    INVALID: '오류',
    MISSING: '자료 없음',
    READY_NON_ACTIVATING: '검증 준비',
    BLOCKED_POLICY_MISSING: '정책 미확정',
    BLOCKED_POLICY_INVALID: '정책 오류',
    BLOCKED_NO_READY_PROFILES: '데이터 대기',
    BLOCKED_DEVELOPMENT_DIAGNOSTICS_MISSING: '개발 진단 필요',
    BLOCKED_DEVELOPMENT_DIAGNOSTICS_INVALID: '개발 진단 오류',
    BLOCKED_RUNTIME_BINDINGS: '연결 대기',
    complete: '완료',
    success: '성공',
    failed: '실패',
    blocked_data: '자료 부족',
    partial_failure: '일부 실패',
    running: '진행 중',
    queued: '대기',
  };
  return labels[value] ?? '확인 필요';
}

function researchLaneLabel(value: string | null | undefined): string {
  const labels: Record<string, string> = {
    forward: '미래 검증',
    'fast-historical': '빠른 과거검증',
    'long-history': '장기 검증',
    'crypto-futures-derivatives': '코인선물',
    'crypto-spot': '코인현물',
    stocks: '주식',
  };
  return value ? (labels[value] ?? '연구 작업') : '연구 작업';
}

function researchStepLabel(value: string): string {
  const labels: Record<string, string> = {
    'market-dataset-candidates': '후보 생성',
    'futures-generalization': '선물 일반화 검증',
    'futures-pnl': '선물 비용 반영 손익',
    'futures-regime': '선물 시장상황 검증',
    'funding-history': '펀딩비 검증',
    'market-structure': '시장구조 검증',
    'upbit-spot': '현물 후보 검증',
    'upbit-spot-pnl': '현물 비용 반영 손익',
    'upbit-spot-alternatives': '현물 대체전략 검증',
    'stock-market-candidates': '주식 후보 생성',
    'stock-pnl': '주식 비용 반영 손익',
    'stock-generalization': '주식 일반화 검증',
    'us-pullback': '미국주식 눌림목 검증',
    'stock-regime': '주식 시장상황 검증',
  };
  return labels[value] ?? '검증 단계';
}

function blockerCopy(card: ResearchPipelineCard): string {
  if (!card.blocker) return '막힌 이유 없음';
  if (card.evidenceState === 'WRONG_SHA') return '연구 버전 불일치 · 확인 필요';
  if (card.status === 'stale') return '오래된 근거 · 재확인 필요';
  if (card.status === 'inactive') return '현재 런타임 미활성';
  if (card.evidenceState === 'MISSING') return '검증 근거 미수집';
  return '검증 자료가 더 필요합니다.';
}

function exportResearchWorkbook(
  overview: ResearchCenterOverview,
  promotion: StrategyPromotionResponse | null,
  cards: ResearchPipelineCard[],
) {
  const performance = overview.paper.candidatePerformance;
  const activity = overview.activity?.entries ?? [];
  const autoBacktest = overview.autoBacktest?.pipelines ?? [];
  const formulaQueue = overview.formulaBacktestQueue?.rows ?? [];
  const timestamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  downloadExcelWorkbook(`research-center-${timestamp}.xls`, [
    {
      name: '요약',
      rows: [
        ['항목', '값'],
        ['보고서 생성시각', formatDate(Date.now())],
        ['연구 상태', overview.research.status],
        ['자동 연구 상태', overview.state.runtimeLiveness?.status ?? '자료 없음'],
        ['마지막 성공', formatDate(overview.state.runtimeLiveness?.lastSuccessAt ?? overview.state.latestCycleAt)],
        ['놓친 실행 횟수', overview.state.runtimeLiveness?.missedCycles ?? '자료 없음'],
        ['시점 표본', overview.dataFactory?.temporalCryptoFutures.observationCount ?? '자료 없음'],
        ['후보 식별자', performance?.candidateId ?? '자료 없음'],
        ['전략 식별자', performance?.strategyId ?? '자료 없음'],
        ['학습 표본', performance?.TRAIN_N ?? '자료 없음'],
        ['검증 표본', performance?.VALIDATION_N ?? '자료 없음'],
        ['미래 검증 표본', performance?.OOS_N ?? '자료 없음'],
        ['정산 표본', performance?.Settlement_N ?? '자료 없음'],
        ['비용 전 손익', performance?.Gross_PnL ?? '자료 없음'],
        ['비용 후 손익', performance?.Net_PnL ?? '자료 없음'],
        ['전체 비용 검증', performance?.FULL_COST_READY ?? false],
        ['수익성 검증', performance?.PROFITABILITY_PROVEN ?? false],
        ['실거래 권한', '없음'],
      ],
    },
    {
      name: '24시간 활동',
      rows: [
        ['시각', '출처', '작업', '상태', '프로필', '상세'],
        ...activity.map((row) => [
          formatDate(row.at), row.source, row.label, row.status, row.profile ?? '', row.detail ?? '',
        ]),
      ],
    },
    {
      name: '연구 피드백',
      rows: [
        ['단계', '상태', '증거상태', '막힌 이유/피드백', '업데이트'],
        ...cards.map((card) => [
          card.label, statusLabel(card.status), card.evidenceState, card.blocker ?? '없음', formatDate(card.updatedAt),
        ]),
        ...((promotion?.items ?? []).flatMap((item) =>
          item.blockers.map((blocker) => [
            item.identity.strategyId,
            item.promotionState,
            item.identity.market,
            blocker,
            item.identity.timeframe,
          ]),
        )),
      ],
    },
    {
      name: '신규 수식',
      rows: [
        ['수식', '상태', '사유', '후보 수', '생존 수', '막힌 이유', '평가시각', '감사보관'],
        ...formulaQueue.map((row) => [
          row.formulaId,
          row.state === 'PASS' ? '통과' : row.state === 'HOLD' ? '보류' : row.state === 'RESERVE' ? '예비' : '제외',
          row.reason,
          row.candidateCount,
          row.researchSurvivorCount,
          row.blockers.join(', '),
          row.evaluatedAt ?? '',
          row.retainedForAudit,
        ]),
      ],
    },
    {
      name: '백테스트 결과',
      rows: [
        ['파이프라인', '상태', '자동전달', '후보통과', '단계', '단계상태', '리포트상태', '시작', '종료', '피드백'],
        ...autoBacktest.flatMap((pipeline) => pipeline.steps.length
          ? pipeline.steps.map((step) => [
              pipeline.id,
              pipeline.status,
              pipeline.automaticHandoffObserved,
              pipeline.candidatePassed,
              step.id,
              step.status,
              step.reportStatus ?? '',
              formatDate(step.startedAt),
              formatDate(step.endedAt),
              pipeline.feedback,
            ])
          : [[
              pipeline.id,
              pipeline.status,
              pipeline.automaticHandoffObserved,
              pipeline.candidatePassed,
              '',
              '',
              '',
              formatDate(pipeline.startedAt),
              formatDate(pipeline.endedAt),
              pipeline.feedback,
            ]]),
      ],
    },
  ]);
}

function ResearchActivityPanel({ overview }: { overview: ResearchCenterOverview }) {
  const rows = overview.activity?.entries ?? [];
  return (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm sm:p-5" data-testid="research-activity-24h">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          
          <h2 className="mt-1 text-base font-black">24시간 연구 활동내역</h2>
        </div>
        
      </div>
      <div className="mt-3 max-h-80 overflow-auto rounded-xl border border-card-border">
        {rows.length ? (
          <table className="w-full min-w-[680px] text-left text-xs">
            <thead className="sticky top-0 bg-muted"><tr><th className="p-2">시각</th><th className="p-2">작업</th><th className="p-2">상태</th><th className="p-2">상세</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.source}:${row.id}`} className="border-t border-card-border">
                  <td className="whitespace-nowrap p-2">{formatDate(row.at)}</td>
                  <td className="p-2"><strong>{row.label}</strong><div className="mt-0.5 text-[9px] text-muted-foreground">{researchLaneLabel(row.profile ?? row.source)}</div></td>
                  <td className="p-2 font-bold">{runtimeCodeLabel(row.status)}</td>
                  <td className="p-2 text-muted-foreground">{row.detail ?? '추가 상세 없음'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="p-5 text-center text-xs text-muted-foreground">최근 24시간 실제 실행 이력이 아직 없습니다.</p>
        )}
      </div>
    </section>
  );
}

function AutoResearchBacktestPanel({ overview }: { overview: ResearchCenterOverview }) {
  const auto = overview.autoBacktest;
  const rows = auto?.pipelines ?? [];
  return (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm sm:p-5" data-testid="research-auto-backtest">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          
          <h2 className="mt-1 text-base font-black">자동 연구 → 백테스터 진행내역</h2>
        </div>
        <StatusBadge status={!auto?.present ? 'unmeasured' : auto.status === 'complete' ? 'normal' : auto.status === 'blocked_data' ? 'attention' : 'running'} />
      </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
        {rows.length ? rows.map((pipeline) => (
          <article key={pipeline.id} className="min-w-0 rounded-2xl border border-card-border bg-background p-3">
            <div className="flex items-start justify-between gap-2">
              <div><h3 className="text-xs font-black">{researchLaneLabel(pipeline.id)}</h3><p className="mt-1 text-[10px] text-muted-foreground">{pipeline.feedback}</p></div>
              <span className="rounded-full border border-card-border px-2 py-1 text-[9px] font-black">{runtimeCodeLabel(pipeline.status)}</span>
            </div>
            <div className="mt-3 grid gap-1.5">
              {pipeline.steps.map((step, index) => (
                <div key={step.id} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-card-border px-2 py-2 text-[10px]">
                  <span className="font-black">{index + 1}</span>
                  <span className="min-w-0 truncate" title={researchStepLabel(step.id)}>{researchStepLabel(step.id)}</span>
                  <span className="font-black">{runtimeCodeLabel(step.status)}</span>
                </div>
              ))}
              {!pipeline.steps.length ? <p className="text-[10px] text-muted-foreground">아직 실행된 단계 없음</p> : null}
            </div>
            <p className="mt-3 text-[10px] font-bold">
              자동 전달: {pipeline.automaticHandoffObserved ? '확인됨' : pipeline.candidatePassed ? '후속 단계 대기' : '후보 통과 전'}
            </p>
          </article>
        )) : <p className="col-span-full rounded-xl border border-dashed border-card-border p-5 text-center text-xs text-muted-foreground">자동 백테스트 실행 이력 미수집</p>}
      </div>
      
    </section>
  );
}

function FormulaBacktestQueuePanel({ overview }: { overview: ResearchCenterOverview }) {
  const queue = overview.formulaBacktestQueue;
  const rows = queue?.rows ?? [];
  const counts = queue?.counts ?? { PASS: 0, HOLD: 0, RESERVE: 0, EXCLUDE: 0 };
  return (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm sm:p-5" data-testid="research-formula-backtest-queue">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-black">신규 수식 자동 검증</h2>
        <span className="text-[10px] font-bold text-muted-foreground">{formatDate(queue?.generatedAt)}</span>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2">
        {[
          ['통과', counts.PASS],
          ['보류', counts.HOLD],
          ['예비', counts.RESERVE],
          ['제외', counts.EXCLUDE],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-xl border border-card-border bg-background p-2 text-center">
            <p className="text-[9px] font-bold text-muted-foreground">{label}</p>
            <p className="mt-1 text-sm font-black tabular-nums">{value}</p>
          </div>
        ))}
      </div>
      <div className="mt-3 max-h-72 overflow-auto rounded-xl border border-card-border">
        {rows.length ? (
          <table className="w-full min-w-[680px] text-left text-xs">
            <thead className="sticky top-0 bg-muted"><tr><th className="p-2">수식</th><th className="p-2">상태</th><th className="p-2">사유</th><th className="p-2">감사기록</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.itemDigest} className="border-t border-card-border">
                  <td className="max-w-72 truncate p-2" title={row.formulaId}>{row.formulaId}</td>
                  <td className="p-2 font-black">{row.state === 'PASS' ? '통과' : row.state === 'HOLD' ? '보류' : row.state === 'RESERVE' ? '예비' : '제외'}</td>
                  <td className="p-2 text-muted-foreground">{row.reason}</td>
                  <td className="p-2">{row.retainedForAudit ? '보관' : '확인 필요'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="p-5 text-center text-xs text-muted-foreground">아직 신규 수식 검증 이력이 없습니다.</p>}
      </div>
    </section>
  );
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
      <p className="mt-2 text-[10px] font-bold text-primary">눌러서 상세 보기</p>
    </button>
  );
}

function StageDetail({ card, onClose }: { card: ResearchPipelineCard; onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <aside id="research-stage-detail" role="dialog" aria-modal="true" aria-label={`${card.label} 상세`} className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-t-3xl border border-card-border bg-card p-4 shadow-2xl sm:rounded-3xl sm:p-5" aria-live="polite" data-testid={`research-detail-${card.key}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><h2 className="text-lg font-black">{card.label}</h2></div>
        <div className="flex items-center gap-2">
          <StatusBadge status={card.status} />
          <button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-full border border-card-border" aria-label="닫기">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <div className="rounded-xl bg-muted/40 p-3">
          <p className="text-xs font-black">현재 상태</p>
          <p className="mt-2 break-keep text-xs leading-5 text-muted-foreground">{blockerCopy(card)}</p>
        </div>
        <div className="rounded-xl bg-muted/40 p-3">
          <p className="text-xs font-black">다음 단계</p>
          <p className="mt-2 break-keep text-xs leading-5 text-muted-foreground">
            {card.blocker ? '필요한 자료가 들어오면 자동으로 다음 단계가 갱신됩니다.' : '표본과 검증 결과가 자동으로 누적됩니다.'}
          </p>
        </div>
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
          <p className="text-muted-foreground">상태</p>
          <p className="mt-1 font-bold">{evidenceStateLabel(card.evidenceState)}</p>
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
          <h3 className="text-xs font-black">검증 기록</h3>
          <div className="max-h-[31rem] space-y-2 overflow-y-auto pr-1">
            {card.records.map((record) => (
              <article key={record.id} className="rounded-xl border border-card-border bg-background p-3 text-[11px]">
                <div className="flex items-start justify-between gap-2">
                  <strong className="min-w-0 break-keep text-xs">{record.label}</strong>
                  <StatusBadge status={record.status} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2">
                  <div><dt className="text-muted-foreground">기간</dt><dd className="mt-1 break-words font-bold">{record.period}</dd></div>
                  <div><dt className="text-muted-foreground">표본</dt><dd className="mt-1 font-bold">{record.sampleN}</dd></div>
                  <div><dt className="text-muted-foreground">데이터</dt><dd className="mt-1 font-bold">{record.datasetId ? '확인됨' : '미측정'}</dd></div>
                  <div><dt className="text-muted-foreground">연구 버전</dt><dd className="mt-1 font-bold">{record.sourceSha ? '확인됨' : '미측정'}</dd></div>
                </dl>
                <dl className="mt-3 grid grid-cols-2 gap-2">
                  {record.metrics.map((metric) => <MetricValue key={metric.label} metric={metric} compact />)}
                </dl>
                <div className="mt-3 rounded-lg bg-muted/40 p-2 text-muted-foreground">
                  <p>출처 · {record.source ? '확인됨' : '미측정'}</p>
                  <p className="mt-1">막힌 이유 · {record.blocker ? '검증 자료 확인 필요' : '없음'}</p>
                  <p className="mt-1">출처 기록 · {record.provenance.length ? record.provenance.length + '건 확인됨' : '미측정'}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-dashed border-card-border p-4 text-center text-xs text-muted-foreground">
          상세 기록이 아직 없습니다.
        </div>
      )}
      </aside>
    </div>
  );
}

function TopStatus({ label, value, status, detail }: { label: string; value: string; status: ResearchProductStatus; detail: string }) {
  return (
    <article className="min-w-0 rounded-2xl border border-card-border bg-card p-3 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-bold text-muted-foreground">{label}</p>
        <StatusBadge status={status} />
      </div>
      <p className="mt-2 break-words text-sm font-black">{value}</p>
      <p className="mt-1 break-words text-[10px] text-muted-foreground">{detail}</p>
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
  selected: ResearchPipelineKey;
  onSelect: (key: ResearchPipelineKey) => void;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
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
    ? `자동 연구 정상 · 놓친 실행 ${runtimeLiveness.missedCycles ?? 0}`
    : runtimeLiveness?.status === 'STALE'
      ? `자동 연구 지연 · 놓친 실행 ${runtimeLiveness.missedCycles ?? 0}`
      : runtimeLiveness?.status === 'INVALID'
        ? '자동 연구 시각 오류'
        : staleCount
          ? `오래된 단계 ${staleCount}개`
          : '자동 연구 상태 미수집';
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
    ? `시장 ${factory.readyMarketCount ?? '—'}/4 · 프로필 ${factory.readyProfileCount ?? '—'}/12 · ${factory.firstZero ?? '막힌 단계 미확인'}`
    : '연구 팩토리 상태 미수집';
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
    ? '시점 자료 미수집'
    : temporal.status === 'INVALID'
      ? '시점 자료 확인 필요'
      : `${temporal.results.length}개 심볼 · 실패 ${temporal.failedCount ?? 0}개`;
  return (
    <section id="research-tab-overview" role="tabpanel" aria-labelledby="research-tab-overview-trigger" className="space-y-4" data-testid="research-overview-tab">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-card-border bg-card p-3 shadow-sm">
        <div><p className="text-xs font-black">연구 운영 현황</p></div>
        <button type="button" onClick={() => exportResearchWorkbook(overview, promotion, cards)} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-card-border px-3 text-xs font-black hover:border-primary/50" data-testid="research-excel-export">
          <Download className="h-4 w-4" /> 엑셀 다운로드
        </button>
      </div>
      <section className="grid grid-cols-2 gap-2 lg:grid-cols-7" aria-label="연구 핵심 상태">
        <TopStatus label="연구 시스템" value={statusLabel(systemStatus)} status={systemStatus} detail={overview.state.present ? '연구 개요 연결됨' : '연구 자료 미수집'} />
        <TopStatus label="데이터 팩토리" value={temporal.observationCount == null ? statusLabel(temporalStatus) : `${temporal.observationCount.toLocaleString('ko-KR')}건`} status={temporalStatus} detail={temporalDetail} />
        <TopStatus label="리서치 팩토리" value={factoryValue} status={factoryStatus} detail={factoryDetail} />
        <TopStatus label="실거래" value="비활성" status="inactive" detail="실거래 권한 없음" />
        <TopStatus label="모의매매" value={statusLabel(paper.status)} status={paper.status} detail={blockerCopy(paper)} />
        <TopStatus label="수익성 검증" value={overview.profitability.proven ? '충족' : '미검증'} status={overview.profitability.proven ? 'verified' : 'waiting'} detail="자료 축적 중" />
        <TopStatus label="마지막 업데이트" value={formatDate(runtimeLiveness?.lastSuccessAt ?? overview.state.latestCycleAt)} status={updateStatus} detail={updateDetail} />
      </section>

      {!promotion ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs" role="status" data-testid="research-partial-state">
          <strong>부분 데이터:</strong> 연구 개요는 연결됐지만 전략 승격 자료를 사용할 수 없습니다.
        </div>
      ) : null}

      <ResearchActivityPanel overview={overview} />
      <AutoResearchBacktestPanel overview={overview} />
      <FormulaBacktestQueuePanel overview={overview} />

      <div>
        <section className="min-w-0" aria-labelledby="research-pipeline-title">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div><h2 id="research-pipeline-title" className="text-base font-black">연구 단계</h2></div>
            <p className="text-[10px] text-muted-foreground">카드를 눌러 상세 확인</p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {cards.map((card) => (
              <PipelineCard
                key={card.key}
                card={card}
                selected={selected === card.key}
                onOpen={() => {
                  onSelect(card.key);
                  setDetailOpen(true);
                }}
              />
            ))}
          </div>
        </section>
        {detailOpen ? <StageDetail card={selectedCard} onClose={() => setDetailOpen(false)} /> : null}
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
  const [answer, setAnswer] = useState('질문을 입력하면 현재 수집된 연구 자료에서 확인되는 내용만 찾아드립니다.');
  const firstBlocker = cards.find((card) => card.blocker) ?? null;
  function submit(event: FormEvent) {
    event.preventDefault();
    setAnswer(answerCanonicalResearchQuestion(question, overview, cards));
  }
  return (
    <section id="research-tab-ai-lab" role="tabpanel" aria-labelledby="research-tab-ai-lab-trigger" className="space-y-4" data-testid="research-ai-lab-tab">
      <div className="rounded-3xl border border-card-border bg-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] font-black uppercase tracking-[0.18em] text-primary">검증 자료</p><h2 className="mt-1 text-lg font-black">인공지능 분석실</h2></div><StatusBadge status={debate.actualEvidence ? 'accumulating' : 'unmeasured'} /></div>
        <p className="mt-2 text-xs text-muted-foreground">{debate.actualEvidence ? debate.finalLabel : '인공지능 분석 근거 미수집'}</p>
        <p className="mt-1 text-[10px] text-muted-foreground">검증 시각 · {formatDate(overview.state.latestCycleAt)} · 자료 신선도 미측정</p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <InsightCard title="인공지능 연구 요약" icon={Sparkles}><p>{debate.actualEvidence ? debate.finalLabel : '인공지능 분석 자료가 없습니다.'}</p></InsightCard>
        <InsightCard title="모델 간 합의" icon={BadgeCheck}><ul className="space-y-1">{debate.actualEvidence ? preview.support.map((line) => <li key={line}>• {line}</li>) : <li>인공지능 분석 근거 미수집</li>}</ul></InsightCard>
        <InsightCard title="모델 간 의견 차이" icon={MessageSquareText}><p>{debate.conflictReason ?? (debate.actualEvidence ? '명시적 충돌 근거 없음' : '인공지능 분석 근거 미수집')}</p></InsightCard>
        <InsightCard title="현재 가장 큰 막힘" icon={CircleAlert}><p>{firstBlocker ? `${firstBlocker.label} · ${blockerCopy(firstBlocker)}` : '막힌 이유 없음'}</p></InsightCard>
        <InsightCard title="데이터가 더 필요한 항목" icon={Database}><ul className="space-y-1">{preview.verify.slice(0, 4).map((line) => <li key={line}>• {line}</li>)}</ul></InsightCard>
        <InsightCard title="다음 연구 후보" icon={FlaskConical}><p>{cards.find((card) => card.status === 'waiting' || card.status === 'insufficient')?.label ?? '연구 후보 없음'}</p></InsightCard>
      </div>

      {debate.actualEvidence ? (
        <section className="grid gap-3 md:grid-cols-2" aria-label="실제 인공지능 분석 자료">
          {[debate.ai1, debate.ai2, ...debate.committee].filter(Boolean).map((review) => (
            <article key={review!.label} className="rounded-2xl border border-card-border bg-card p-4">
              <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-black">{review!.label}</h3><span className="text-[10px] text-muted-foreground">{review!.conclusion ?? '결론 미측정'}</span></div>
              <p className="mt-1 text-[10px] text-muted-foreground">{[review!.provider, review!.model].filter(Boolean).join(' · ') || '분석 출처 미측정'}</p>
              <ul className="mt-3 space-y-2 text-xs text-muted-foreground">{review!.lines.map((line) => <li key={line} className="rounded-xl bg-background p-3">{line}</li>)}</ul>
            </article>
          ))}
        </section>
      ) : null}

      <form onSubmit={submit} className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" aria-label="연구 근거 질문">
        <div className="flex items-center gap-2"><Bot className="h-4 w-4 text-primary" /><h2 className="text-sm font-black">연구 근거에 질문하기</h2></div>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <label className="sr-only" htmlFor="research-question">연구 근거 질문</label>
          <input id="research-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="예: 수익성은 검증됐나요?" className="min-h-11 min-w-0 flex-1 rounded-xl border border-card-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary" />
          <button type="submit" className="min-h-11 rounded-xl bg-primary px-4 text-sm font-black text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">근거에서 찾기</button>
        </div>
        <output className="mt-3 block rounded-xl border border-card-border bg-background p-3 text-xs leading-5" aria-live="polite">{answer}</output>
        <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-muted-foreground">인공지능은 수익성 수치나 자동매매 승인을 만들지 않습니다.</p>
      </form>
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
  const [stageDetailOpen, setStageDetailOpen] = useState(false);
  useEffect(() => {
    if (!stageDetailOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setStageDetailOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [stageDetailOpen]);
  const sourceSha = promotion?.sourceSha && /^[0-9a-f]{40}$/i.test(promotion.sourceSha) ? promotion.sourceSha : '미수집';
  const factory = overview.factory;
  const liquidity = overview.research.liquidityIndependence;
  const runtimeSha = factory?.researchSha && /^[0-9a-f]{40}$/i.test(factory.researchSha) ? factory.researchSha : '미수집';
  const researchShaBinding = sourceSha === '미수집' || runtimeSha === '미수집' ? 'MISSING' : classifySha(sourceSha, runtimeSha);
  const firstZero = overview.paper.candidatePerformance?.FIRST_ZERO
    ?? factory?.firstZero
    ?? factory?.nextFirstZero
    ?? '미수집';
  const datasets = new Set(cards.flatMap((card) => card.records.map((record) => record.datasetId).filter(Boolean)));
  const stale = cards.filter((card) => card.status === 'stale').length;
  const runtimeLiveness = overview.state.runtimeLiveness;
  const wrongSha = cards.filter((card) => card.evidenceState === 'WRONG_SHA').length;
  const champion = cards.find((card) => card.key === 'champion')!;
  return (
    <section id="research-tab-evidence" role="tabpanel" aria-labelledby="research-tab-evidence-trigger" className="space-y-4" data-testid="research-evidence-tab">
      <div className="rounded-3xl border border-card-border bg-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] font-black uppercase tracking-[0.18em] text-primary">검증 상세</p><h2 className="mt-1 text-lg font-black">검증 리포트</h2></div><StatusBadge status={wrongSha ? 'attention' : stale ? 'stale' : 'normal'} /></div>
        <p className="mt-2 text-xs text-muted-foreground">검증 상태와 자료 연결 여부를 확인합니다.</p>
      </div>

      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <EvidenceItem label="연구 실행 버전" value={runtimeSha === '미수집' ? '미수집' : '확인됨'} state={runtimeSha === '미수집' ? 'unmeasured' : 'verified'} />
        <EvidenceItem label="연구 소스 버전" value={sourceSha === '미수집' ? '미수집' : '확인됨'} state={sourceSha === '미수집' ? 'unmeasured' : 'verified'} />
        <EvidenceItem label="데이터셋 연결" value={datasets.size ? `${datasets.size}개 확인됨` : '미수집'} state={datasets.size ? 'verified' : 'unmeasured'} />
        <EvidenceItem label="전략 연결" value={promotion ? `${promotion.items.length}개` : '미수집'} state={promotion ? 'normal' : 'unmeasured'} />
        <EvidenceItem label="제어 정보" value={factory?.controlPlaneDigest ? '확인됨' : '미수집'} state={factory?.controlPlaneDigest ? 'verified' : 'unmeasured'} />
        <EvidenceItem label="실행 기록" value={liquidity?.upstreamIngestRunId ? '확인됨' : '미수집'} state={liquidity?.upstreamIngestRunId ? 'verified' : 'unmeasured'} />
        <EvidenceItem label="결과물 기록" value={liquidity?.upstreamIngestArtifactId ? '확인됨' : '미수집'} state={liquidity?.upstreamIngestArtifactId ? 'verified' : 'unmeasured'} />
        <EvidenceItem label="검증 영수증" value={liquidity?.reportDigest ? '확인됨' : '미수집'} state={liquidity?.reportDigest ? 'verified' : 'unmeasured'} />
        <EvidenceItem label="연구 버전 연결" value={researchShaBinding === 'PRESENT' ? '일치' : researchShaBinding === 'WRONG_SHA' ? '불일치' : '미수집'} state={researchShaBinding === 'PRESENT' ? 'verified' : researchShaBinding === 'WRONG_SHA' ? 'attention' : 'unmeasured'} />
        <EvidenceItem label="게시 시각" value={formatDate(overview.state.latestCycleAt)} state={overview.state.latestCycleAt ? 'normal' : 'unmeasured'} />
        <EvidenceItem
          label="자료 신선도"
          value={runtimeLiveness?.status === 'LIVE'
            ? `정상 · ${Math.round((runtimeLiveness.ageMs ?? 0) / 60000)}분 전 · 놓친 실행 ${runtimeLiveness.missedCycles ?? 0}`
            : runtimeLiveness?.status === 'STALE'
              ? `지연 · ${Math.round((runtimeLiveness.ageMs ?? 0) / 60000)}분 전 · 놓친 실행 ${runtimeLiveness.missedCycles ?? 0}`
              : runtimeLiveness?.status === 'INVALID'
                ? '시각 오류'
                : stale ? `지연 단계 ${stale}개` : '상태 미수집'}
          state={runtimeLiveness?.status === 'INVALID' ? 'error' : runtimeLiveness?.stale ? 'stale' : runtimeLiveness?.status === 'LIVE' ? 'verified' : stale ? 'stale' : 'unmeasured'}
        />
        <EvidenceItem label="버전 일치" value={wrongSha ? `불일치 ${wrongSha}개` : '불일치 없음'} state={wrongSha ? 'attention' : 'normal'} />
        <EvidenceItem label="재실행 제외" value="미수집" />
        <EvidenceItem label="과거채움 제외" value="미수집" />
        <EvidenceItem label="가상자료 제외" value="미수집" />
        <EvidenceItem label="중복 제외" value="미수집" />
        <EvidenceItem label="전체 비용" value="자료 부족" state="insufficient" />
        <EvidenceItem label="그림자 검증" value={overview.shadow.records.present ? '확인됨' : '자료 없음'} state={overview.shadow.records.present ? 'accumulating' : 'unmeasured'} />
        <EvidenceItem label="모의매매 검증" value={overview.paper.runtime.present ? '확인됨' : '자료 없음'} state={overview.paper.runtime.present ? 'normal' : 'unmeasured'} />
        <EvidenceItem label="수익성 검증" value={overview.profitability.proven ? '검증됨' : '미검증'} state={overview.profitability.proven ? 'verified' : 'waiting'} />
        <EvidenceItem label="최종 전략" value={champion.metrics[0]?.value ?? '자료 없음'} state={champion.status} />
        <EvidenceItem label="현재 막힌 단계" value={firstZero === '미수집' ? '미수집' : '다음 검증 자료 필요'} state={firstZero === '미수집' ? 'unmeasured' : 'attention'} />
      </dl>

      <button
        type="button"
        onClick={() => setStageDetailOpen(true)}
        className="flex min-h-12 w-full items-center justify-between rounded-2xl border border-card-border bg-card px-4 text-sm font-black"
      >
        단계별 검증 상태 보기
        <ChevronRight className="h-4 w-4" />
      </button>
      {stageDetailOpen ? (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4"
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setStageDetailOpen(false); }}
        >
          <section role="dialog" aria-modal="true" aria-label="단계별 검증 상태" className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-t-3xl border border-card-border bg-card p-4 shadow-2xl sm:rounded-3xl sm:p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="text-base font-black">단계별 검증 상태</h3>
              <button type="button" onClick={() => setStageDetailOpen(false)} className="flex h-10 w-10 items-center justify-center rounded-full border border-card-border" aria-label="닫기">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-2">
              {cards.map((card) => (
                <div key={card.key} className="grid gap-1 rounded-xl bg-background p-3 text-[11px] sm:grid-cols-[10rem_8rem_1fr]">
                  <strong>{card.label}</strong>
                  <span>{evidenceStateLabel(card.evidenceState)}</span>
                  <span className="text-muted-foreground">{card.blocker ? blockerCopy(card) : '없음'}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}

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

const COST_LABELS_KO: Record<CostDisplayRow['key'], string> = {
  commission: '수수료',
  tax: '세금',
  spread: '스프레드',
  slippage: '슬리피지',
  funding: '펀딩비',
  latency: '지연 비용',
  liquidityImpact: '유동성 영향',
  partialFillImpact: '부분체결 영향',
};

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
      <div className="min-w-0"><p className="text-xs font-black">{COST_LABELS_KO[row.key]}</p></div>
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
    ? '자료 없음'
    : `${formatCanonicalMetric(value)}${suffix}`;
  const candidateRate = (value: number | null) => value == null
    ? '자료 없음'
    : `${formatCanonicalMetric(value * 100, { digits: 2 })}%`;
  const openPositionText = !ledger.present || ledger.positionCount == null
    ? '현재 포지션 자료 없음'
    : ledger.positionCount === 0
      ? '열린 모의 포지션 없음'
      : `열린 모의 포지션 ${formatCanonicalMetric(ledger.positionCount)}건 · 상세 기록 미공개`;
  const settlementText = !ledger.present || ledger.settlementCount == null
    ? '정산 자료 없음'
    : ledger.settlementCount === 0
      ? '최근 정산 없음 · 표본 없음'
      : `정산 ${formatCanonicalMetric(ledger.settlementCount)}건 · 상세 기록 미공개`;
  const countState = (value: number | null | undefined): ResearchProductStatus => value == null ? 'unmeasured' : value === 0 ? 'waiting' : 'accumulating';
  return (
    <section id="research-tab-paper" role="tabpanel" aria-labelledby="research-tab-paper-trigger" className="space-y-4" data-testid="research-paper-tab">
      <div className="rounded-3xl border border-card-border bg-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary"><WalletCards className="h-5 w-5" /></span><div><div className="flex items-center gap-2"><h2 className="text-lg font-black">모의매매</h2><span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-black text-primary">모의</span></div><p className="mt-1 text-xs font-bold text-emerald-700 dark:text-emerald-300">실주문 비활성</p></div></div>
          <StatusBadge status={paper.status} />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 text-[10px] sm:grid-cols-5">
          {['실거래 꺼짐', '실자동매매 꺼짐', '실주문 꺼짐', '거래소 주문 기능 꺼짐', '실거래 권한 없음'].map((item) => <span key={item} className="whitespace-nowrap rounded-lg border border-card-border bg-background px-2 py-1.5 text-center font-mono" title={item}>{item}</span>)}
        </div>
      </div>

      <article className="rounded-2xl border border-card-border bg-card p-4 shadow-sm" data-testid="paper-candidate-performance">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-[10px] font-black uppercase tracking-[0.18em] text-primary">고정 후보</p><h3 className="mt-1 text-sm font-black">후보별 성과 증거</h3></div>
          <span className={`rounded-full border px-2.5 py-1 text-[10px] font-black ${performance.status === 'PRESENT' ? STATUS_STYLE.accumulating : STATUS_STYLE.unmeasured}`}>{performance.status === 'PRESENT' ? '자료 있음' : '자료 없음'}</span>
        </div>
        <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-card-border bg-background p-3"><dt className="text-[10px] font-bold text-muted-foreground">후보 식별</dt><dd className="mt-1 font-bold">{performance.candidateId ? '확인됨' : '자료 없음'}</dd></div>
          <div className="rounded-xl border border-card-border bg-background p-3"><dt className="text-[10px] font-bold text-muted-foreground">전략 식별</dt><dd className="mt-1 font-bold">{performance.strategyId ? '확인됨' : '자료 없음'}</dd></div>
          <div className="rounded-xl border border-card-border bg-background p-3"><dt className="text-[10px] font-bold text-muted-foreground">고정 시각</dt><dd className="mt-1 font-bold">{performance.freezeTimestamp ? formatDate(performance.freezeTimestamp) : '자료 없음'}</dd></div>
          <div className="rounded-xl border border-card-border bg-background p-3"><dt className="text-[10px] font-bold text-muted-foreground">현재 막힌 단계</dt><dd className="mt-1 font-bold">{performance.FIRST_ZERO === 'NONE' ? '없음' : '추가 검증 자료 필요'}</dd></div>
        </dl>
        <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4 xl:grid-cols-6">
          {[
            ['독립 표본', independentN],
            ['후보 일치 표본', performance.candidateMatchedN],
            ['롱 신호', performance.LONG_SIGNAL_N],
            ['숏 신호', performance.SHORT_SIGNAL_N],
            ['거래 없음', performance.NO_TRADE_N],
            ['진입', performance.Entry_N],
            ['포지션', performance.Position_N],
            ['포지션 관찰', performance.PositionObservation_N],
            ['정산', performance.Settlement_N],
            ['학습 표본', performance.TRAIN_N],
            ['검증 표본', performance.VALIDATION_N],
            ['미래 검증 표본', performance.OOS_N],
          ].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-card-border bg-background p-2"><p className="text-[9px] font-bold text-muted-foreground">{label}</p><p className="mt-1 text-xs font-black tabular-nums">{candidateValue(value as number | null)}</p></div>)}
        </div>
        
      </article>

      <PaperClosedLoopObserver
        overview={overview}
        journalBinding={journalBinding}
        journalBindingLoading={journalBindingLoading}
        journalBindingError={journalBindingError}
      />

      <section className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6" aria-label="모의매매 핵심지표">
        <PaperKpi label="모의 평가금액" value="미측정" state="unmeasured" />
        <PaperKpi label="비용 전 손익" value={candidateValue(performance.Gross_PnL)} state={countState(performance.Settlement_N)} />
        <PaperKpi label="미실현손익" value="미측정" state="unmeasured" />
        <PaperKpi label="비용 후 손익" value={candidateValue(performance.Net_PnL)} state="unmeasured" />
        <PaperKpi label="진입 수" value={candidateValue(performance.Entry_N)} state={countState(performance.Entry_N)} />
        <PaperKpi label="후보 포지션" value={candidateValue(performance.Position_N)} state={countState(performance.Position_N)} />
        <PaperKpi label="후보 정산" value={candidateValue(performance.Settlement_N)} state={countState(performance.Settlement_N)} />
        <PaperKpi label="승률" value={candidateRate(performance.WIN_RATE)} state={countState(performance.Settlement_N)} />
        <PaperKpi label="손익비" value={candidateValue(performance.PF)} state={countState(performance.Settlement_N)} />
        <PaperKpi label="최대 낙폭" value={candidateValue(performance.MDD, '%')} state={countState(performance.Settlement_N)} />
        <PaperKpi label="후보 일치 표본" value={candidateValue(performance.candidateMatchedN)} state={countState(performance.candidateMatchedN)} />
        <PaperKpi label="마지막 업데이트" value={formatDate(overview.state.latestCycleAt)} state={overview.state.latestCycleAt ? 'normal' : 'unmeasured'} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <article className="rounded-2xl border border-card-border bg-card p-4 shadow-sm" data-testid="paper-open-positions">
          <div className="flex items-center gap-2"><Gauge className="h-4 w-4 text-primary" /><h3 className="text-sm font-black">현재 포지션</h3></div>
          <div className="mt-3 rounded-xl border border-dashed border-card-border p-5 text-center text-xs text-muted-foreground">{openPositionText}</div>
        </article>
        <article className="rounded-2xl border border-card-border bg-card p-4 shadow-sm" data-testid="paper-recent-settlements">
          <div className="flex items-center gap-2"><History className="h-4 w-4 text-primary" /><h3 className="text-sm font-black">최근 모의거래 / 정산</h3></div>
          <div className="mt-3 rounded-xl border border-dashed border-card-border p-5 text-center text-xs text-muted-foreground">{settlementText}</div>
        </article>
      </div>

      <article className="rounded-2xl border border-card-border bg-card p-4 shadow-sm" data-testid="paper-full-cost">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[10px] font-black uppercase tracking-[0.18em] text-primary">비용 8항목</p><h3 className="mt-1 text-sm font-black">비용 분석</h3></div><span className="text-xs font-black">전체 비용 검증 · {fullCostReady ? '충족' : '자료 부족'}</span></div>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">{costRows.map((row) => <CostRow key={row.key} row={row} />)}</div>
        <p className="mt-3 text-[10px] text-muted-foreground">확인되지 않은 비용은 0으로 처리하지 않습니다.</p>
      </article>

      <div className="grid gap-4 lg:grid-cols-2">
        <article className="rounded-2xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2"><FileCheck2 className="h-4 w-4 text-primary" /><h3 className="text-sm font-black">거래 흐름</h3></div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] font-bold text-muted-foreground">
            {['진입', '포지션', '청산 조건', '청산', '비용 정책', '정산'].map((item, index) => <span key={item} className="contents"><span className="rounded-lg border border-card-border bg-background px-2 py-1.5">{item}</span>{index < 5 ? <ChevronRight className="h-3 w-3" /> : null}</span>)}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">상세 정산 기록이 아직 공개되지 않아 검증 완료로 표시하지 않습니다.</p>
        </article>
        <article className="rounded-2xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /><h3 className="text-sm font-black">수익성 검증</h3></div>
          <p className="mt-3 text-lg font-black">{performance.PROFITABILITY_PROVEN ? '검증 충족' : '아직 검증되지 않음'}</p>
          <p className="mt-2 text-xs text-muted-foreground">학습 전용 {performance.TRAIN_DIAGNOSTIC_ONLY ? '예' : '아니오'} · 검증 {candidateValue(performance.VALIDATION_N)} · 미래검증 {candidateValue(performance.OOS_N)}</p>
          <p className="mt-1 text-xs text-muted-foreground">전체 비용 {performance.FULL_COST_READY ? '충족' : '미충족'} · 비용 후 성과 {performance.NET_ALPHA_PROVEN ? '검증됨' : '미검증'} · 수익성 {performance.PROFITABILITY_PROVEN ? '검증됨' : '미검증'}</p>
          <p className="mt-1 text-xs text-muted-foreground">{cards.find((card) => card.key === 'champion')?.metrics[0]?.value ?? '검증된 최종 전략 자료 없음'}</p>
        </article>
      </div>
    </section>
  );
}

export default function ResearchCenterPage() {
  const [tab, setTab] = useState<ResearchTab>('overview');
  const [selected, setSelected] = useState<ResearchPipelineKey>('external-research');
  const overviewQuery = useQuery({
    queryKey: ['admin', 'research-center', 'overview'],
    queryFn: ({ signal }) => fetchResearchCenterOverview(signal),
    staleTime: 30_000,
    retry: 1,
  });
  const promotionQuery = useQuery({
    queryKey: ['admin', 'research-center', 'promotion'],
    queryFn: ({ signal }) => fetchStrategyPromotions(signal),
    staleTime: 60_000,
    retry: 1,
  });
  const journalBindingQuery = useQuery({
    queryKey: ['research-center', 'paper-journal-binding'],
    queryFn: ({ signal }) => fetchResearchJournalBinding(signal),
    enabled: tab === 'paper',
    staleTime: 30_000,
    retry: 0,
  });
  const overview = overviewQuery.data;
  const promotion = promotionQuery.data ?? null;
  const cards = useMemo(() => overview ? buildResearchPipeline(overview, promotion) : [], [overview, promotion]);
  const refreshing = overviewQuery.isFetching || promotionQuery.isFetching || (tab === 'paper' && journalBindingQuery.isFetching);

  function refreshAll() {
    void overviewQuery.refetch();
    void promotionQuery.refetch();
    if (tab === 'paper') void journalBindingQuery.refetch();
  }

  function selectCard(key: ResearchPipelineKey) {
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
              <div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-black sm:text-2xl">연구센터</h1><span className="rounded-full border border-card-border bg-background px-2 py-0.5 text-[10px] font-black text-muted-foreground">조회 전용</span></div>
                          </div>
            <button type="button" aria-label="연구센터 새로고침" onClick={refreshAll} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-card-border bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" /></button>
          </div>
        </header>

        <nav className="grid grid-cols-4 gap-1 rounded-2xl border border-card-border bg-card p-1.5" role="tablist" aria-label="연구센터 핵심 화면">
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
        </nav>

        {overviewQuery.isPending ? <LoadingState /> : null}
        {overviewQuery.isError ? (
          <section role="alert" className="rounded-3xl border border-destructive/30 bg-destructive/10 p-5" data-testid="research-error-state">
            <div className="flex items-start gap-2"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /><div><h2 className="font-black text-destructive">연구 상태를 불러오지 못했습니다.</h2><p className="mt-1 text-xs text-muted-foreground">오류를 정상이나 0으로 바꾸지 않습니다.</p></div></div>
            <button type="button" onClick={refreshAll} className="mt-4 min-h-11 rounded-xl border border-destructive/30 px-4 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive">다시 확인</button>
          </section>
        ) : null}

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
