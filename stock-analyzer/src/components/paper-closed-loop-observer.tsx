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
    return { key, label, value: '미관측', detail: '후보별 canonical count가 현재 overview에 없습니다.', tone: 'missing' };
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
        label: 'Trigger',
        value: '조회 중',
        detail: 'authenticated journal binding의 canonical Trigger evidence를 읽고 있습니다.',
        tone: 'progress',
      }
    : journalBindingError
      ? {
          key: 'trigger',
          label: 'Trigger',
          value: '미관측',
          detail: 'Trigger readback 조회에 실패했습니다. 실패를 완료로 바꾸지 않습니다.',
          tone: 'missing',
        }
      : !candidateId
        ? {
            key: 'trigger',
            label: 'Trigger',
            value: '미관측',
            detail: '현재 Research candidateId가 없어 Trigger evidence를 같은 후보에 바인딩하지 않습니다.',
            tone: 'missing',
          }
        : triggerBoundJournalBindings.length > 0
          ? {
              key: 'trigger',
              label: 'Trigger',
              value: `${triggerBoundJournalBindings.length.toLocaleString('ko-KR')}건 검증`,
              detail: `canonical settlement lineage · exitTriggerId ${triggerBoundJournalBindings.map((trade) => trade.exitTriggerId).join(' · ')}`,
              tone: 'ready',
            }
          : exactJournalBindings.length > 0
            ? {
                key: 'trigger',
                label: 'Trigger',
                value: '미관측',
                detail: 'candidate binding은 VERIFIED지만 완전 검증된 settlement lineage의 exitTriggerId가 없습니다.',
                tone: 'missing',
              }
            : journalBinding?.source === 'AUTHENTICATED_PAPER_STATE'
              ? {
                  key: 'trigger',
                  label: 'Trigger',
                  value: '미관측',
                  detail: '현재 candidateId와 VERIFIED journal binding이 없어 Trigger를 연결하지 않습니다.',
                  tone: journalBinding.mismatchTradeCount > 0 ? 'blocked' : 'missing',
                }
              : {
                  key: 'trigger',
                  label: 'Trigger',
                  value: '미관측',
                  detail: 'canonical Trigger readback이 아직 공개되지 않았습니다. Settlement 존재만으로 Trigger 완료를 추정하지 않습니다.',
                  tone: 'missing',
                };

  const journalStage: ClosedLoopStage = journalBindingLoading && !journalBinding
    ? {
        key: 'journal',
        label: '매매일지',
        value: '조회 중',
        detail: 'authenticated Paper state 기반 journal binding을 읽고 있습니다.',
        tone: 'progress',
      }
    : journalBindingError
      ? {
          key: 'journal',
          label: '매매일지',
          value: '미확인',
          detail: 'journal binding 조회에 실패했습니다. 실패를 연결 완료로 바꾸지 않습니다.',
          tone: 'missing',
        }
      : !candidateId
        ? {
            key: 'journal',
            label: '매매일지',
            value: '미확인',
            detail: '현재 Research candidateId가 없어 journal trade와 동일 후보인지 비교하지 않습니다.',
            tone: 'missing',
          }
        : exactJournalBindings.length > 0
          ? {
              key: 'journal',
              label: '매매일지',
              value: `${exactJournalBindings.length.toLocaleString('ko-KR')}건 검증`,
              detail: `AUTHENTICATED_PAPER_STATE · candidateId 일치 · Settlement binding ${settlementBoundJournalN}/${exactJournalBindings.length} · sourceSha ${journalBinding?.sourceSha ?? '미확인'}`,
              tone: 'ready',
            }
          : journalBinding?.source === 'AUTHENTICATED_PAPER_STATE'
            ? {
                key: 'journal',
                label: '매매일지',
                value: '0건 검증',
                detail: journalBinding.mismatchTradeCount > 0
                  ? `journal identity 불일치 ${journalBinding.mismatchTradeCount}건 · 현재 candidate와 연결 완료로 처리하지 않습니다.`
                  : '현재 candidateId와 VERIFIED journal trade가 일치하지 않습니다.',
                tone: journalBinding.mismatchTradeCount > 0 ? 'blocked' : 'missing',
              }
            : {
                key: 'journal',
                label: '매매일지',
                value: '미확인',
                detail: 'canonical journal binding이 아직 API에 공개되지 않았습니다. 일반 Paper ledger 수를 대신 사용하지 않습니다.',
                tone: 'missing',
              };

  const stages: ClosedLoopStage[] = [
    candidateReady
      ? {
          key: 'candidate',
          label: 'Candidate',
          value: 'identity 확인',
          detail: `후보 ${performance?.candidateId ?? ''} · identity14 검증됨`,
          tone: 'ready',
        }
      : {
          key: 'candidate',
          label: 'Candidate',
          value: performance?.status ?? 'MISSING',
          detail: '동일 후보 identity가 확정되지 않으면 뒤 단계 수치를 다른 후보와 합치지 않습니다.',
          tone: performance?.status === 'BLOCKED' || performance?.status === 'INVALID' ? 'blocked' : 'missing',
        },
    countStage(
      'entry',
      'Entry',
      performance?.Entry_N,
      '동일 후보의 진입 근거가 관측됐습니다.',
      '아직 동일 후보의 진입이 관측되지 않았습니다.',
    ),
    countStage(
      'position',
      'Position',
      performance?.Position_N,
      '동일 후보의 Paper 포지션 근거가 관측됐습니다.',
      '진입 후 포지션 생성 근거를 기다립니다.',
    ),
    triggerStage,
    countStage(
      'settlement',
      'Settlement',
      performance?.Settlement_N,
      '동일 후보의 Settlement 수가 관측됐습니다.',
      '청산·정산 근거가 아직 없습니다.',
    ),
    journalBindingLoading && !journalBinding
      ? {
          key: 'cost',
          label: '8 Cost',
          value: '조회 중',
          detail: '동일 candidate의 authenticated canonical Full Cost readback을 확인하고 있습니다.',
          tone: 'progress',
        }
      : journalBindingError
        ? {
            key: 'cost',
            label: '8 Cost',
            value: '미관측',
            detail: 'Full Cost readback 조회에 실패했습니다. 실패를 8/8 완료로 바꾸지 않습니다.',
            tone: 'missing',
          }
        : !candidateId
          ? {
              key: 'cost',
              label: '8 Cost',
              value: '미관측',
              detail: '현재 candidateId가 없어 비용 근거를 다른 후보에서 빌려오지 않습니다.',
              tone: 'missing',
            }
          : canonicalFullCostReady
            ? {
                key: 'cost',
                label: '8 Cost',
                value: `8/8 검증 · ${fullCostBoundJournalBindings.length.toLocaleString('ko-KR')}건`,
                detail: `AUTHENTICATED_PAPER_STATE · settlement/Trigger/Execution/digest 일치 · fullCostEvidenceDigest ${fullCostBoundJournalBindings.map((trade) => trade.fullCostEvidenceDigest).join(' · ')}`,
                tone: 'ready',
              }
            : {
                key: 'cost',
                label: '8 Cost',
                value: `${measuredCostN}/8 진단`,
                detail: `candidate별 canonical 8 Cost는 아직 검증되지 않았습니다. Research overview 진단: MODELED ${modeledCostN}개 · UNKNOWN/BLOCKED ${unknownCostN}개. MODELED/UNKNOWN을 실제 비용 0으로 승격하지 않습니다.`,
                tone: exactJournalBindings.length > 0 || overviewFullCostReady || measuredCostN > 0 ? 'blocked' : 'missing',
              },
    {
      key: 'net-pnl',
      label: 'Net PnL',
      value: canonicalNetPnlReady
        ? `${netPnlBoundJournalBindings.length.toLocaleString('ko-KR')}건 검증 · ${netPnlBoundJournalBindings.map((trade) => money(trade.canonicalNetPnl)).join(' · ')}`
        : money(performance?.Net_PnL),
      detail: canonicalNetPnlReady
        ? `AUTHENTICATED_PAPER_STATE · Settlement/8 Cost/owner journal/unified journal Net PnL 일치 · netPnlEvidenceDigest ${netPnlBoundJournalBindings.map((trade) => trade.netPnlEvidenceDigest).join(' · ')} · profitabilityCredit=0. Net PnL 검증만으로 수익성 증거로 승격하지 않습니다.`
        : performance?.Net_PnL == null
          ? '후보별 Net PnL 근거가 없습니다.'
          : canonicalFullCostReady
            ? '8 Cost canonical 검증은 완료됐지만 Net PnL canonical binding은 아직 별도 검증되지 않았습니다. 따라서 수익성 증거로 승격하지 않습니다.'
            : overviewFullCostReady
              ? 'Research overview Full Cost는 준비됐지만 candidate별 canonical 8 Cost와 Net PnL binding은 아직 연결되지 않았습니다.'
              : '값이 있어도 Full Cost가 미충족이면 수익성 증거로 승격하지 않습니다.',
      tone: canonicalNetPnlReady ? 'ready' : performance?.Net_PnL == null ? 'missing' : 'blocked',
    },
    journalStage,
  ];

  const firstIncomplete = stages.find((stage) => stage.tone !== 'ready');
  const firstZero = performance?.FIRST_ZERO ?? 'CANDIDATE_PERFORMANCE_EVIDENCE_MISSING';

  return (
    <section
      className="rounded-2xl border border-card-border bg-card p-4 shadow-sm sm:p-5"
      data-testid="paper-closed-loop-observer"
      aria-label="Paper closed loop 관측"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-primary">Read-only observer</p>
          <h3 className="mt-1 text-base font-black">Paper closed loop</h3>
          <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">
            Candidate → Entry → Position → Trigger → Settlement → 8 Cost → Net PnL → 매매일지를 같은 후보 기준으로 봅니다.
          </p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-black text-emerald-700 dark:text-emerald-300">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          READ ONLY · executionAuthority=NONE
        </span>
      </div>

      <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-3" data-testid="paper-closed-loop-first-zero">
        <p className="text-[10px] font-black text-primary">화면 기준 첫 미완료 단계</p>
        <p className="mt-1 text-sm font-black">{firstIncomplete?.label ?? '관측 범위 완료'}</p>
        <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">Canonical FIRST_ZERO · {firstZero}</p>
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
          화면 단계는 선택적 journal readback까지 반영합니다. Canonical FIRST_ZERO는 Research overview 원본이며 이 UI가 임의로 변경하지 않습니다.
        </p>
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

      <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
        이 화면은 read-only Research overview와 선택적 authenticated journal binding만 재구성합니다. 누락된 Trigger·journal binding을 임의로 완료 처리하지 않고, UNKNOWN 비용을 0으로 바꾸지 않습니다.
      </p>
    </section>
  );
}
