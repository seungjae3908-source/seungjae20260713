import { ArrowRight, BookOpenCheck, CircleDot, Link2, ShieldCheck } from 'lucide-react';
import type { ResearchCenterOverview } from '@/lib/research-center';
import type { ResearchJournalBindingReadback } from '@/lib/research-journal-binding';

type StageTone = 'ready' | 'progress' | 'blocked' | 'missing';

type ClosedLoopStage = Readonly<{
  key: string;
  label: string;
  value: string;
  detail: string;
  tone: StageTone;
}>;

const TONE: Record<StageTone, string> = {
  ready: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  progress: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  blocked: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  missing: 'border-border bg-muted/50 text-muted-foreground',
};

const COST_KEYS = [
  'commission',
  'tax',
  'spread',
  'slippage',
  'funding',
  'latency',
  'liquidityImpact',
  'partialFillImpact',
] as const;

function countStage(
  key: string,
  label: string,
  value: number | null | undefined,
  observedDetail: string,
  zeroDetail: string,
): ClosedLoopStage {
  if (value == null) {
    return { key, label, value: '미관측', detail: '후보별 표본 자료가 없습니다.', tone: 'missing' };
  }
  if (value === 0) {
    return { key, label, value: '0건', detail: zeroDetail, tone: 'progress' };
  }
  return { key, label, value: `${value.toLocaleString('ko-KR')}건`, detail: observedDetail, tone: 'ready' };
}

function money(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '미관측';
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 4 }).format(value);
}

export function PaperClosedLoopObserver({
  overview,
  journalBinding = null,
  journalBindingLoading = false,
  journalBindingError = false,
}: {
  overview: ResearchCenterOverview;
  journalBinding?: ResearchJournalBindingReadback | null;
  journalBindingLoading?: boolean;
  journalBindingError?: boolean;
}) {
  const performance = overview.paper.candidatePerformance;
  const components = performance?.fullCostEvidence?.components;
  const measuredCostN = components
    ? COST_KEYS.filter((key) => components[key]?.state === 'MEASURED').length
    : 0;
  const modeledCostN = components
    ? COST_KEYS.filter((key) => components[key]?.state === 'MODELED').length
    : 0;
  const unknownCostN = components
    ? COST_KEYS.filter((key) => ['UNKNOWN', 'BLOCKED_DATA'].includes(components[key]?.state)).length
    : 8;
  const overviewFullCostReady = Boolean(performance?.FULL_COST_READY && performance?.fullCostEvidence?.fullCostReady);

  const candidateReady = Boolean(
    performance?.status === 'PRESENT'
      && performance.candidateId
      && performance.identity14Verified,
  );
  const candidateId = performance?.candidateId ?? null;
  const exactJournalBindings = candidateId && journalBinding
    ? journalBinding.trades.filter((trade) => trade.status === 'VERIFIED' && trade.candidateId === candidateId)
    : [];
  const settlementBoundJournalN = exactJournalBindings.filter((trade) => trade.settlementBindingVerified).length;
  const triggerBoundJournalBindings = exactJournalBindings.filter((trade) => (
    trade.triggerBindingVerified && Boolean(trade.exitTriggerId) && Boolean(trade.exitExecutionId)
  ));
  const fullCostBoundJournalBindings = exactJournalBindings.filter((trade) => (
    trade.fullCostBindingVerified
      && trade.fullCostComponentCount === 8
      && Boolean(trade.fullCostEvidenceDigest)
  ));
  const canonicalFullCostReady = fullCostBoundJournalBindings.length > 0;
  const netPnlBoundJournalBindings = exactJournalBindings.filter((trade) => (
    trade.netPnlBindingVerified
      && trade.canonicalNetPnl != null
      && Boolean(trade.netPnlEvidenceDigest)
  ));
  const canonicalNetPnlReady = netPnlBoundJournalBindings.length > 0;

  const triggerStage: ClosedLoopStage = journalBindingLoading && !journalBinding
    ? {
        key: 'trigger',
        label: '청산 조건',
        value: '조회 중',
        detail: '정산 기록에서 청산 조건을 확인하고 있습니다.',
        tone: 'progress',
      }
    : journalBindingError
      ? {
          key: 'trigger',
          label: '청산 조건',
          value: '미관측',
          detail: '청산 조건 자료를 확인하지 못했습니다.',
          tone: 'missing',
        }
      : !candidateId
        ? {
            key: 'trigger',
            label: '청산 조건',
            value: '미관측',
            detail: '현재 후보가 확정되지 않아 청산 조건을 연결하지 않습니다.',
            tone: 'missing',
          }
        : triggerBoundJournalBindings.length > 0
          ? {
              key: 'trigger',
              label: '청산 조건',
              value: `${triggerBoundJournalBindings.length.toLocaleString('ko-KR')}건 검증`,
              detail: `동일 후보의 청산 조건과 체결 기록이 확인됐습니다.`,
              tone: 'ready',
            }
          : exactJournalBindings.length > 0
            ? {
                key: 'trigger',
                label: '청산 조건',
                value: '미관측',
                detail: '후보는 확인됐지만 청산 조건 기록이 부족합니다.',
                tone: 'missing',
              }
            : journalBinding?.source === 'AUTHENTICATED_PAPER_STATE'
              ? {
                  key: 'trigger',
                  label: '청산 조건',
                  value: '미관측',
                  detail: '현재 후보와 일치하는 청산 기록이 없습니다.',
                  tone: journalBinding.mismatchTradeCount > 0 ? 'blocked' : 'missing',
                }
              : {
                  key: 'trigger',
                  label: '청산 조건',
                  value: '미관측',
                  detail: '청산 조건 자료가 아직 없습니다.',
                  tone: 'missing',
                };

  const journalStage: ClosedLoopStage = journalBindingLoading && !journalBinding
    ? {
        key: 'journal',
        label: '매매일지',
        value: '조회 중',
        detail: '모의매매 일지 연결을 확인하고 있습니다.',
        tone: 'progress',
      }
    : journalBindingError
      ? {
          key: 'journal',
          label: '매매일지',
          value: '미확인',
          detail: '매매일지 연결을 확인하지 못했습니다.',
          tone: 'missing',
        }
      : !candidateId
        ? {
            key: 'journal',
            label: '매매일지',
            value: '미확인',
            detail: '현재 후보가 확정되지 않아 매매일지를 연결하지 않습니다.',
            tone: 'missing',
          }
        : exactJournalBindings.length > 0
          ? {
              key: 'journal',
              label: '매매일지',
              value: `${exactJournalBindings.length.toLocaleString('ko-KR')}건 검증`,
              detail: `동일 후보의 정산 기록 ${settlementBoundJournalN}/${exactJournalBindings.length}건이 연결됐습니다.`,
              tone: 'ready',
            }
          : journalBinding?.source === 'AUTHENTICATED_PAPER_STATE'
            ? {
                key: 'journal',
                label: '매매일지',
                value: '0건 검증',
                detail: journalBinding.mismatchTradeCount > 0
                  ? `후보 불일치 ${journalBinding.mismatchTradeCount}건 · 연결하지 않았습니다.`
                  : '현재 후보와 일치하는 매매일지가 없습니다.',
                tone: journalBinding.mismatchTradeCount > 0 ? 'blocked' : 'missing',
              }
            : {
                key: 'journal',
                label: '매매일지',
                value: '미확인',
                detail: '매매일지 연결 자료가 아직 없습니다.',
                tone: 'missing',
              };

  const stages: ClosedLoopStage[] = [
    candidateReady
      ? {
          key: 'candidate',
          label: '후보',
          value: '식별 확인',
          detail: '동일 후보 식별정보가 확인됐습니다.',
          tone: 'ready',
        }
      : {
          key: 'candidate',
          label: '후보',
          value: performance?.status === 'PRESENT' ? '확인' : '자료 없음',
          detail: '동일 후보가 확정되지 않으면 뒤 단계 수치를 합치지 않습니다.',
          tone: performance?.status === 'BLOCKED' || performance?.status === 'INVALID' ? 'blocked' : 'missing',
        },
    countStage(
      'entry',
      '진입',
      performance?.Entry_N,
      '동일 후보의 진입 근거가 관측됐습니다.',
      '아직 동일 후보의 진입이 관측되지 않았습니다.',
    ),
    countStage(
      'position',
      '포지션',
      performance?.Position_N,
      '동일 후보의 모의 포지션이 확인됐습니다.',
      '진입 후 포지션 생성 근거를 기다립니다.',
    ),
    triggerStage,
    countStage(
      'settlement',
      '정산',
      performance?.Settlement_N,
      '동일 후보의 정산 기록이 확인됐습니다.',
      '청산·정산 근거가 아직 없습니다.',
    ),
    journalBindingLoading && !journalBinding
      ? {
          key: 'cost',
          label: '비용 8항목',
          value: '조회 중',
          detail: '동일 후보의 전체 비용 자료를 확인하고 있습니다.',
          tone: 'progress',
        }
      : journalBindingError
        ? {
            key: 'cost',
            label: '비용 8항목',
            value: '미관측',
            detail: '전체 비용 자료를 확인하지 못했습니다.',
            tone: 'missing',
          }
        : !candidateId
          ? {
              key: 'cost',
              label: '비용 8항목',
              value: '미관측',
              detail: '현재 후보가 확정되지 않아 비용 자료를 연결하지 않습니다.',
              tone: 'missing',
            }
          : canonicalFullCostReady
            ? {
                key: 'cost',
                label: '비용 8항목',
                value: `8/8 검증 · ${fullCostBoundJournalBindings.length.toLocaleString('ko-KR')}건`,
                detail: `동일 후보의 정산·청산·비용 기록이 모두 일치합니다.`,
                tone: 'ready',
              }
            : {
                key: 'cost',
                label: '비용 8항목',
                value: `${measuredCostN}/8 진단`,
                detail: `후보별 비용 검증이 아직 끝나지 않았습니다. 실측 ${measuredCostN}개 · 추정 ${modeledCostN}개 · 미확인 ${unknownCostN}개.`,
                tone: exactJournalBindings.length > 0 || overviewFullCostReady || measuredCostN > 0 ? 'blocked' : 'missing',
              },
    {
      key: 'net-pnl',
      label: '비용 후 손익',
      value: canonicalNetPnlReady
        ? `${netPnlBoundJournalBindings.length.toLocaleString('ko-KR')}건 검증 · ${netPnlBoundJournalBindings.map((trade) => money(trade.canonicalNetPnl)).join(' · ')}`
        : money(performance?.Net_PnL),
      detail: canonicalNetPnlReady
        ? `동일 후보의 정산·비용·매매일지 손익이 일치합니다. 이 값만으로 수익성 검증 완료 처리하지 않습니다.`
        : performance?.Net_PnL == null
          ? '후보별 비용 후 손익 자료가 없습니다.'
          : canonicalFullCostReady
            ? '비용 검증은 끝났지만 비용 후 손익 연결은 아직 확인되지 않았습니다.'
            : overviewFullCostReady
              ? '전체 비용 자료는 준비됐지만 후보별 비용 후 손익 연결이 남아 있습니다.'
              : '전체 비용 검증이 끝나기 전에는 수익성 검증 완료로 처리하지 않습니다.',
      tone: canonicalNetPnlReady ? 'ready' : performance?.Net_PnL == null ? 'missing' : 'blocked',
    },
    journalStage,
  ];

  const firstIncomplete = stages.find((stage) => stage.tone !== 'ready');

  return (
    <section
      className="rounded-2xl border border-card-border bg-card p-4 shadow-sm sm:p-5"
      data-testid="paper-closed-loop-observer"
      aria-label="모의매매 검증 흐름"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-primary">조회 전용</p>
          <h3 className="mt-1 text-base font-black">모의매매 검증 흐름</h3>
          <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">
            후보 → 진입 → 포지션 → 청산 조건 → 정산 → 비용 → 비용 후 손익 → 매매일지
          </p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-black text-emerald-700 dark:text-emerald-300">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          조회 전용 · 실거래 권한 없음
        </span>
      </div>

      <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-3" data-testid="paper-closed-loop-first-zero">
        <p className="text-[10px] font-black text-primary">첫 미완료 단계</p>
        <p className="mt-1 text-sm font-black">{firstIncomplete?.label ?? '관측 범위 완료'}</p>
        <p className="mt-1 text-[10px] text-muted-foreground">기준 자료에서 확인한 다음 단계</p>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {stages.map((stage, index) => (
          <div key={stage.key} className="contents">
            <article
              className="min-w-0 rounded-xl border border-card-border bg-background p-3"
              data-testid={`paper-closed-loop-${stage.key}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <CircleDot className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  <p className="truncate text-xs font-black">{stage.label}</p>
                </div>
                <span className={`rounded-full border px-2 py-0.5 text-[9px] font-black ${TONE[stage.tone]}`}>
                  {stage.tone === 'ready' ? '확인' : stage.tone === 'progress' ? '대기' : stage.tone === 'blocked' ? '불충족' : '미관측'}
                </span>
              </div>
              <p className="mt-3 break-words text-sm font-black tabular-nums">{stage.value}</p>
              <p className="mt-2 break-keep text-[10px] leading-4 text-muted-foreground">{stage.detail}</p>
            </article>
            {index < stages.length - 1 ? <ArrowRight className="hidden" aria-hidden="true" /> : null}
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <a
          href="/paper-trading"
          className="flex min-h-11 items-center justify-between rounded-xl border border-card-border bg-background px-3 text-xs font-black"
          data-testid="paper-closed-loop-paper-link"
        >
          <span className="flex items-center gap-2"><Link2 className="h-4 w-4 text-primary" />모의매매 상태 보기</span>
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </a>
        <a
          href="/portfolio?tab=journal"
          className="flex min-h-11 items-center justify-between rounded-xl border border-card-border bg-background px-3 text-xs font-black"
          data-testid="paper-closed-loop-journal-link"
        >
          <span className="flex items-center gap-2"><BookOpenCheck className="h-4 w-4 text-primary" />통합 매매일지 보기</span>
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </a>
      </div>

    </section>
  );
}
