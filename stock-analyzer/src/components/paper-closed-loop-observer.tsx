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
        label: '청산 조건',
        value: '조회 중',
        detail: 'authenticated journal binding의 canonical Trigger evidence를 읽고 있습니다.',
        tone: 'progress',
      }
    : journalBindingError
      ? {
          key: 'trigger',
          label: '청산 조건',
          value: '미관측',
          detail: 'Trigger readback 조회에 실패했습니다. 실패를 완료로 바꾸지 않습니다.',
          tone: 'missing',
        }
      : !candidateId
        ? {
            key: 'trigger',
            label: '청산 조건',
            value: '미관측',
            detail: '현재 Research candidateId가 없어 Trigger evidence를 같은 후보에 바인딩하지 않습니다.',
            tone: 'missing',
          }
        : triggerBoundJournalBindings.length > 0
          ? {
              key: 'trigger',
              label: '청산 조건',
              value: `${triggerBoundJournalBindings.length.toLocaleString('ko-KR')}건 검증`,
              detail: `canonical settlement lineage · exitTriggerId ${triggerBoundJournalBindings.map((trade) => trade.exitTriggerId).join(' · ')}`,
              tone: 'ready',
            }
          : exactJournalBindings.length > 0
            ? {
                key: 'trigger',
                label: '청산 조건',
                value: '미관측',
                detail: 'candidate binding은 VERIFIED지만 완전 검증된 settlement lineage의 exitTriggerId가 없습니다.',
                tone: 'missing',
              }
            : journalBinding?.source === 'AUTHENTICATED_PAPER_STATE'
              ? {
                  key: 'trigger',
                  label: '청산 조건',
                  value: '미관측',
                  detail: '현재 candidateId와 VERIFIED journal binding이 없어 Trigger를 연결하지 않습니다.',
                  tone: journalBinding.mismatchTradeCount > 0 ? 'blocked' : 'missing',
                }
              : {
                  key: 'trigger',
                  label: '청산 조건',
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
          label: '후보',
          value: '후보 일치 확인',
          detail: `후보 ${performance?.candidateId ?? ''} · identity14 검증됨`,
          tone: 'ready',
        }
      : {
          key: 'candidate',
          label: '후보',
          value: performance?.status === 'PRESENT' ? '수집됨' : '미확인·차단',
          detail: '동일 후보 identity가 확정되지 않으면 뒤 단계 수치를 다른 후보와 합치지 않습니다.',
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
      '동일 후보의 Paper 포지션 근거가 관측됐습니다.',
      '진입 후 포지션 생성 근거를 기다립니다.',
    ),
    triggerStage,
    countStage(
      'settlement',
      '정산',
      performance?.Settlement_N,
      '동일 후보의 Settlement 수가 관측됐습니다.',
      '청산·정산 근거가 아직 없습니다.',
    ),
    journalBindingLoading && !journalBinding
      ? {
          key: 'cost',
          label: '총비용 8항목',
          value: '조회 중',
          detail: '동일 candidate의 authenticated canonical Full Cost readback을 확인하고 있습니다.',
          tone: 'progress',
        }
      : journalBindingError
        ? {
            key: 'cost',
            label: '총비용 8항목',
            value: '미관측',
            detail: 'Full Cost readback 조회에 실패했습니다. 실패를 8/8 완료로 바꾸지 않습니다.',
            tone: 'missing',
          }
        : !candidateId
          ? {
              key: 'cost',
              label: '총비용 8항목',
              value: '미관측',
              detail: '현재 candidateId가 없어 비용 근거를 다른 후보에서 빌려오지 않습니다.',
              tone: 'missing',
            }
          : canonicalFullCostReady
            ? {
                key: 'cost',
                label: '총비용 8항목',
                value: `8/8 검증 · ${fullCostBoundJournalBindings.length.toLocaleString('ko-KR')}건`,
                detail: `AUTHENTICATED_PAPER_STATE · settlement/Trigger/Execution/digest 일치 · fullCostEvidenceDigest ${fullCostBoundJournalBindings.map((trade) => trade.fullCostEvidenceDigest).join(' · ')}`,
                tone: 'ready',
              }
            : {
                key: 'cost',
                label: '총비용 8항목',
                value: `${measuredCostN}/8 진단`,
                detail: `candidate별 canonical 8 Cost는 아직 검증되지 않았습니다. Research overview 진단: MODELED ${modeledCostN}개 · UNKNOWN/BLOCKED ${unknownCostN}개. MODELED/UNKNOWN을 실제 비용 0으로 승격하지 않습니다.`,
                tone: exactJournalBindings.length > 0 || overviewFullCostReady || measuredCostN > 0 ? 'blocked' : 'missing',
              },
    {
      key: 'net-pnl',
      label: '비용 후 손익',
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
    <section className="rounded-2xl border border-card-border bg-card p-3" data-testid="paper-closed-loop-observer" aria-label="모의매매 폐쇄루프">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-bold">모의매매 폐쇄루프</h3>
        <span className="text-xs text-muted-foreground">조회 전용 · 실주문 없음</span>
      </div>
      <div className="mt-3 rounded-xl bg-muted/40 p-3" data-testid="paper-closed-loop-first-zero">
        <p className="text-xs text-muted-foreground">화면 기준 첫 미완료 단계</p>
        <p className="mt-1 font-bold">{firstIncomplete?.label ?? '관측 범위 완료'}</p>
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="min-h-11 cursor-pointer py-3">원본 차단 사유</summary>
          <p className="break-all">{firstZero}</p>
        </details>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {stages.map(stage => (
          <article key={stage.key} className="min-w-0 rounded-xl border border-card-border p-3" data-testid={`paper-closed-loop-${stage.key}`}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs font-bold">{stage.label}</p>
              <span className={`rounded-full border px-2 py-0.5 text-xs ${TONE[stage.tone]}`}>{stage.tone === 'ready' ? '확인' : stage.tone === 'progress' ? '대기' : stage.tone === 'blocked' ? '불충족' : '미관측'}</span>
            </div>
            <p className="mt-2 break-words text-sm font-bold tabular-nums">{stage.value}</p>
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="min-h-11 cursor-pointer py-3">연결 근거</summary>
              <p className="break-all">{stage.detail}</p>
            </details>
          </article>
        ))}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <a href="/paper-trading" className="flex min-h-11 items-center justify-between rounded-xl border border-card-border px-3 text-sm font-bold" data-testid="paper-closed-loop-paper-link"><span className="flex items-center gap-2"><Link2 className="h-4 w-4" />모의매매 상태 보기</span><ArrowRight className="h-4 w-4" /></a>
        <a href="/portfolio?tab=journal" className="flex min-h-11 items-center justify-between rounded-xl border border-card-border px-3 text-sm font-bold" data-testid="paper-closed-loop-journal-link"><span className="flex items-center gap-2"><BookOpenCheck className="h-4 w-4" />통합 매매일지 보기</span><ArrowRight className="h-4 w-4" /></a>
      </div>
    </section>
  );
}
