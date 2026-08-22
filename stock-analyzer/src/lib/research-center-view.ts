import type {
  ResearchCenterOverview,
  ResearchCycleProfile,
  ResearchCycleSummary,
} from '@/lib/research-center';

export type ResearchSimpleTone = 'good' | 'waiting' | 'warning' | 'blocked';

export interface ResearchSimpleItem {
  key: string;
  label: string;
  value: string;
  note: string;
  tone: ResearchSimpleTone;
}

export interface ResearchSimpleConclusion {
  tone: ResearchSimpleTone;
  title: string;
  description: string;
  nextStep: string;
}

export interface ResearchDebateReviewView {
  label: string;
  conclusion: string | null;
  lines: string[];
  provider: string | null;
  model: string | null;
}

export interface ResearchAiDebateView {
  status: string;
  statusLabel: string;
  actualEvidence: boolean;
  ai1: ResearchDebateReviewView | null;
  ai2: ResearchDebateReviewView | null;
  committee: ResearchDebateReviewView[];
  conflictReason: string | null;
  finalLabel: string;
}

export interface ResearchDebatePreview {
  support: string[];
  oppose: string[];
  verify: string[];
}

const SUCCESS_STATES = new Set(['complete', 'completed', 'success', 'pass', 'ready', 'healthy']);
const RUNNING_STATES = new Set(['collecting', 'evidence_collection', 'running', 'pending', 'replayed']);
const FAILURE_STATES = new Set(['fail', 'failed', 'error', 'safety_block', 'critical']);
const SENTINELS = new Set([
  '',
  'NONE',
  'NOT_AVAILABLE',
  'NOT_COLLECTED',
  'NONE/INSUFFICIENT_EVIDENCE',
  'AI_RESEARCH_UNAVAILABLE',
]);

const MISSING_METRICS = '표본 N 미수집 · 거래 수 미수집 · PF 미수집 · EV 미수집 · MDD 미수집 · 승률 미수집 · 비용조정 미수집';
const OVERVIEW_PROVENANCE = '근거: Research Production overview';

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (!cleaned || SENTINELS.has(cleaned.toUpperCase())) return null;
  return cleaned.slice(0, 2_000);
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())).map((value) => value.trim()))];
}

function observedAt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'freshness 미수집';
  return `관측 ${new Date(value).toISOString()}`;
}

function countText(value: number | null | undefined, suffix = '건'): string {
  return value == null ? '미수집' : `${value}${suffix}`;
}

function cycleHasAggregateGap(cycle: ResearchCycleSummary): boolean {
  return cycle.present && [
    cycle.taskCount,
    cycle.successCount,
    cycle.blockedDataCount,
    cycle.failedCount,
  ].some((value) => value == null);
}

export function researchCycleLabel(profile: ResearchCycleProfile): string {
  if (profile === 'forward') return '미래 검증';
  if (profile === 'fast-historical') return '빠른 과거검증';
  return '장기 과거검증';
}

export function taskStatusKorean(status: string, timedOut = false): string {
  if (timedOut) return '시간 초과';
  const state = normalized(status);
  if (SUCCESS_STATES.has(state)) return '성공';
  if (state === 'blocked_data' || state === 'blocked') return '필수 데이터 부족';
  if (RUNNING_STATES.has(state)) return '진행 중';
  if (FAILURE_STATES.has(state)) return '실패';
  return status || '미수집';
}

export function cycleTaskSuccessCount(cycle: ResearchCycleSummary): number {
  return cycle.tasks.filter((task) => SUCCESS_STATES.has(normalized(task.status)) && !task.timedOut).length;
}

export function cycleHasSuccessMismatch(cycle: ResearchCycleSummary): boolean {
  if (!cycle.present || cycle.tasks.length === 0) return false;
  if (cycle.successCount == null || cycle.taskCount == null) return true;
  return cycle.successCount !== cycleTaskSuccessCount(cycle) || cycle.taskCount !== cycle.tasks.length;
}

export function cyclePlainStatus(cycle: ResearchCycleSummary | undefined): { value: string; tone: ResearchSimpleTone } {
  if (!cycle?.present) return { value: '아직 대기', tone: 'waiting' };
  if (cycleHasAggregateGap(cycle)) return { value: '집계 미수집', tone: 'warning' };
  if ((cycle.failedCount ?? 0) > 0 || FAILURE_STATES.has(normalized(cycle.status))) return { value: '오류 확인 필요', tone: 'blocked' };
  if ((cycle.blockedDataCount ?? 0) > 0) return { value: '데이터 부족', tone: 'warning' };
  if (SUCCESS_STATES.has(normalized(cycle.status))) return { value: '정상', tone: 'good' };
  if (RUNNING_STATES.has(normalized(cycle.status))) return { value: '진행 중', tone: 'waiting' };
  return { value: '확인 중', tone: 'waiting' };
}

function cycleNote(cycle: ResearchCycleSummary | undefined): string {
  if (!cycle?.present) return '아직 자연 실행 증거가 수집되지 않았습니다.';
  const taskSuccesses = cycleTaskSuccessCount(cycle);
  if (cycleHasAggregateGap(cycle)) {
    return `작업별 성공 ${taskSuccesses}건 · 상위 집계 미수집 · task ${countText(cycle.taskCount)} · 성공 ${countText(cycle.successCount)} · 실패 ${countText(cycle.failedCount)} · 데이터 부족 ${countText(cycle.blockedDataCount)}`;
  }
  if (cycleHasSuccessMismatch(cycle)) {
    return `작업별 성공 ${taskSuccesses}건 · 상위 집계 ${cycle.successCount}/${cycle.taskCount} 불일치 확인 필요`;
  }
  return `성공 ${cycle.successCount}/${cycle.taskCount} · 실패 ${cycle.failedCount} · 데이터 부족 ${cycle.blockedDataCount}`;
}

function taskEvidence(
  cycles: ResearchCycleSummary[],
  patterns: RegExp[],
): { value: string; tone: ResearchSimpleTone; note: string } {
  for (const cycle of cycles) {
    const task = cycle.tasks.find((candidate) => patterns.some((pattern) => pattern.test(candidate.id)));
    if (!task) continue;
    const state = normalized(task.status);
    const tone: ResearchSimpleTone = task.timedOut || FAILURE_STATES.has(state)
      ? 'blocked'
      : SUCCESS_STATES.has(state)
        ? 'good'
        : state === 'blocked_data' || state === 'blocked'
          ? 'warning'
          : 'waiting';
    return {
      value: taskStatusKorean(task.status, task.timedOut),
      tone,
      note: `${MISSING_METRICS} · 데이터셋/구간 미수집 · ${observedAt(cycle.generatedAt)} · ${OVERVIEW_PROVENANCE}`,
    };
  }
  return {
    value: '미수집',
    tone: 'waiting',
    note: `Missing Evidence · 해당 단계의 canonical task가 current overview에 없습니다. ${MISSING_METRICS}`,
  };
}

/**
 * 12-stage evidence maturity ladder.
 *
 * This is deliberately fail-closed: unavailable metrics stay `미수집`; UNKNOWN,
 * N/A and INSUFFICIENT_DATA are never rewritten to zero or PASS. The dashboard
 * only summarizes evidence already exposed by canonical read-only owners.
 */
export function buildResearchSimpleItems(overview: ResearchCenterOverview): ResearchSimpleItem[] {
  const byProfile = new Map(overview.research.cycles.map((cycle) => [cycle.profile, cycle] as const));
  const fast = byProfile.get('fast-historical');
  const long = byProfile.get('long-history');
  const ledger = overview.paper.ledger;
  const shadow = overview.shadow.records;
  const backtestAvailable = Boolean(fast?.present || long?.present);
  const backtestTone: ResearchSimpleTone = [fast, long].some((cycle) => cyclePlainStatus(cycle).tone === 'blocked')
    ? 'blocked'
    : [fast, long].some((cycle) => cyclePlainStatus(cycle).tone === 'warning')
      ? 'warning'
      : backtestAvailable
        ? 'good'
        : 'waiting';
  const backtestValue = backtestAvailable
    ? `빠른 ${cyclePlainStatus(fast).value} · 장기 ${cyclePlainStatus(long).value}`
    : '미수집';
  const oos = taskEvidence(overview.research.cycles, [/\boos\b/i, /out[-_ ]?of[-_ ]?sample/i]);
  const walkForward = taskEvidence(overview.research.cycles, [/purged.*walk/i, /walk[-_ ]?forward/i]);
  const holdout = taskEvidence(overview.research.cycles, [/final[-_ ]?holdout/i, /holdout/i]);
  const shadowValue = shadow.present
    ? `${countText(shadow.totalRecords)} 중 ${countText(shadow.settledRecords)} 검증완료`
    : '미수집';
  const paperValue = ledger.present
    ? `${countText(ledger.cycleCount, '회')} 확인 · 정산 ${countText(ledger.settlementCount)}`
    : '미수집';
  const paperTone: ResearchSimpleTone = !ledger.present || ledger.settlementCount == null
    ? 'waiting'
    : ledger.settlementCount > 0 ? 'good' : 'warning';
  const profitabilityInsufficient = !ledger.present || ledger.settlementCount == null || ledger.settlementCount === 0 || !overview.profitability.proven;

  return [
    {
      key: 'external-research',
      label: '1. 외부 연구 (EXTERNAL RESEARCH)',
      value: '아직 대기',
      note: 'Missing Evidence · current Research overview에는 외부 논문/연구 provenance가 연결되지 않았습니다. N/A를 PASS 또는 0으로 바꾸지 않습니다.',
      tone: 'waiting',
    },
    {
      key: 'backtest',
      label: '2. 백테스트 (BACKTEST)',
      value: backtestValue,
      note: `${cycleNote(fast)} · ${cycleNote(long)} · ${MISSING_METRICS} · 데이터셋/구간 미수집 · 코드 SHA는 상세 증거에서 확인 · ${OVERVIEW_PROVENANCE}`,
      tone: backtestTone,
    },
    { key: 'oos', label: '3. OOS', value: oos.value, note: oos.note, tone: oos.tone },
    { key: 'purged-walk-forward', label: '4. Purged Walk-Forward', value: walkForward.value, note: walkForward.note, tone: walkForward.tone },
    { key: 'final-holdout', label: '5. Final Holdout', value: holdout.value, note: holdout.note, tone: holdout.tone },
    {
      key: 'shadow',
      label: '6. Shadow',
      value: shadowValue,
      note: shadow.present
        ? `표본 N ${countText(shadow.totalRecords)} · 정산 ${countText(shadow.settledRecords)} · 대기 ${countText(shadow.pendingRecords)} · PF/EV/MDD/비용조정 미수집 · ${OVERVIEW_PROVENANCE}`
        : `Missing Evidence · Shadow 증거가 없습니다. ${MISSING_METRICS}`,
      tone: shadow.present && shadow.settledRecords != null && shadow.settledRecords > 0 ? 'good' : 'waiting',
    },
    {
      key: 'natural-paper',
      label: '7. Natural Paper',
      value: paperValue,
      note: ledger.present
        ? `cycle ${countText(ledger.cycleCount, '회')} · 모의 포지션 ${countText(ledger.positionCount)} · 정산 ${countText(ledger.settlementCount)} · ${ledger.settlementCount == null || ledger.settlementCount === 0 ? '실전 수익성 검증 안 됨 · ' : ''}${MISSING_METRICS} · ${OVERVIEW_PROVENANCE}`
        : `Missing Evidence · Natural Paper ledger가 없습니다. 실전 수익성 검증 안 됨 · ${MISSING_METRICS}`,
      tone: paperTone,
    },
    {
      key: 'settlement',
      label: '8. Settlement',
      value: ledger.present ? `정산 ${countText(ledger.settlementCount)}` : '미수집',
      note: ledger.present && ledger.settlementCount != null && ledger.settlementCount > 0
        ? `거래 수 ${ledger.settlementCount} · PF/EV/MDD/승률/비용조정은 profitability evidence가 제공할 때만 표시합니다. ${OVERVIEW_PROVENANCE}`
        : 'Missing Evidence · 정산 표본이 충분하지 않습니다. 실전 수익성 검증 안 됨',
      tone: ledger.present && ledger.settlementCount != null && ledger.settlementCount > 0 ? 'good' : 'warning',
    },
    {
      key: 'profitability-evidence',
      label: '9. Profitability Evidence',
      value: overview.profitability.proven ? '증명됨' : '아직 미증명',
      note: `${profitabilityInsufficient ? '실전 수익성 검증 안 됨 · ' : ''}${overview.profitability.note} · PF 미수집 · EV 미수집 · MDD 미수집 · 승률 미수집 · 비용조정 미수집`,
      tone: overview.profitability.proven ? 'good' : 'warning',
    },
    {
      key: 'strategy-health',
      label: '10. Strategy Health',
      value: '미수집',
      note: 'Missing Evidence · Strategy Health canonical evidence가 current Research overview에 연결되지 않았습니다. 없는 값을 HEALTHY/PASS로 만들지 않습니다.',
      tone: 'waiting',
    },
    {
      key: 'promotion',
      label: '11. Promotion',
      value: '별도 조회',
      note: '전략 승격 API는 이 화면의 별도 승격 요약에서 조회합니다. Promotion 후보는 Champion 또는 실거래 승인이 아닙니다.',
      tone: 'waiting',
    },
    {
      key: 'champion',
      label: '12. Champion',
      value: 'CURRENT_VALIDATED_CHAMPION = NONE',
      note: 'Missing Evidence · current Research overview에 검증된 Champion identity/provenance가 없습니다. Profitability 상태만으로 Champion을 생성하지 않습니다.',
      tone: 'waiting',
    },
  ];
}

export function buildResearchConclusion(overview: ResearchCenterOverview): ResearchSimpleConclusion {
  if (overview.safety.forbiddenAuthorityObserved) {
    return {
      tone: 'blocked',
      title: '안전 계약 확인 필요',
      description: '연구 화면에서 허용되지 않은 실행 권한 증거가 감지되었습니다.',
      nextStep: '실거래·Private API·주문 권한을 계속 차단한 상태에서 안전 계약부터 확인합니다.',
    };
  }

  if (!overview.safety.authorityEvidenceComplete) {
    return {
      tone: 'blocked',
      title: '안전 증거 미수집',
      description: 'Paper runtime의 Private 요청·금융 변경·주문·실거래·주문권한 증거 중 일부가 없습니다. 없는 값을 0 또는 false로 간주하지 않습니다.',
      nextStep: '안전 핵심 필드를 모두 실제 값으로 수집한 뒤 수익성 판단을 이어갑니다.',
    };
  }

  const ledger = overview.paper.ledger;
  const longHistory = overview.research.cycles.find((cycle) => cycle.profile === 'long-history');
  if (!ledger.present) {
    return {
      tone: 'warning',
      title: '수익성 판단 보류',
      description: '실전 수익성 검증 안 됨. 자동 모의매매 정산 증거가 아직 수집되지 않았습니다.',
      nextStep: `${longHistory?.present ? '' : '장기 과거검증을 수집하고, '}조건 통과 → 모의 진입 → 모의 종료 → 정산 → PF·EV·MDD 계산 순서로 진행합니다.`,
    };
  }

  if (ledger.settlementCount == null) {
    return {
      tone: 'warning',
      title: '수익성 판단 보류',
      description: '실전 수익성 검증 안 됨. Natural Paper ledger는 있으나 정산 건수 증거가 미수집 상태입니다.',
      nextStep: '정산 배열/건수 증거를 복구한 뒤 PF·EV·MDD 계산 단계로 진행합니다.',
    };
  }

  if (ledger.settlementCount === 0) {
    return {
      tone: 'warning',
      title: '수익성 판단 보류',
      description: `실전 수익성 검증 안 됨. 자동 모의매매는 ${countText(ledger.cycleCount, '회')} 확인됐지만 정산된 거래가 0건이라 아직 돈을 버는 전략인지 판단할 수 없습니다.`,
      nextStep: `${longHistory?.present ? '' : '장기 과거검증을 수집하고, '}조건 통과 → 모의 진입 → 모의 종료 → 정산 → PF·EV·MDD 계산 순서로 진행합니다.`,
    };
  }

  if (!overview.profitability.proven) {
    return {
      tone: 'waiting',
      title: '수익성 증거 수집 중',
      description: `실전 수익성 검증 안 됨. 정산 ${ledger.settlementCount}건이 있지만 아직 수익성 승격 기준을 통과하지 못했습니다.`,
      nextStep: '표본을 더 쌓고 비용·손실폭·PF·EV·MDD와 Shadow 방향성 품질을 함께 확인합니다.',
    };
  }

  return {
    tone: 'good',
    title: '현재 증거 기준 수익성 통과',
    description: '현재 수집된 정산 증거가 수익성 기준을 통과했습니다. 이는 미래 수익 보장이 아닙니다.',
    nextStep: 'Shadow 품질·Strategy Health·Promotion·Champion 검증을 통과한 뒤에만 다음 단계로 진행합니다.',
  };
}

function reviewConclusionKorean(value: string | null): string | null {
  if (!value) return null;
  const state = value.toUpperCase();
  if (state === 'SUPPORTS_FURTHER_RESEARCH') return '추가 연구 찬성';
  if (state === 'OPPOSES_FURTHER_RESEARCH') return '추가 연구 반대';
  if (state === 'INSUFFICIENT_EVIDENCE') return '증거 부족';
  if (state === 'PASS') return '찬성';
  if (state === 'FAIL') return '반대';
  return value;
}

function normalizeFinding(value: unknown): string | null {
  if (typeof value === 'string') return text(value);
  const row = asRecord(value);
  return text(row?.statement) ?? text(row?.summary) ?? text(row?.reason) ?? text(row?.explanation);
}

function normalizeReview(value: unknown, label: string): ResearchDebateReviewView | null {
  const direct = text(value);
  if (direct) return { label, conclusion: null, lines: [direct], provider: null, model: null };
  const row = asRecord(value);
  if (!row) return null;
  const findings = Array.isArray(row.findings) ? row.findings.map(normalizeFinding) : [];
  const lines = unique([
    text(row.summary),
    text(row.statement),
    text(row.reason),
    text(row.explanation),
    ...findings,
  ]);
  const conclusion = reviewConclusionKorean(text(row.conclusion) ?? text(row.status));
  if (!conclusion && lines.length === 0) return null;
  return {
    label,
    conclusion,
    lines,
    provider: text(row.providerId) ?? text(row.provider) ?? text(row.providerName),
    model: text(row.modelId) ?? text(row.model) ?? text(row.modelName),
  };
}

function debateRoot(value: unknown): Record<string, unknown> {
  const root = asRecord(value) ?? {};
  const research = asRecord(root.research);
  const candidates = [
    root.aiDebate,
    root.aiCommittee,
    root.autonomousFactory,
    root.researchFactory,
    root.factoryStatus,
    research?.aiDebate,
    research?.autonomousFactory,
  ];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (record) return record;
  }
  return root;
}

function debateStatusLabel(status: string): string {
  if (status === 'AI_REVIEW_AGREE') return '두 AI 의견 일치';
  if (status === 'CONFLICT') return 'AI 의견 충돌';
  if (status === 'BOTH_REJECT') return '두 AI 모두 반대/추가검증';
  if (status === 'ADVISORY_REVIEW_COMPLETE') return 'AI 위원회 검토 완료';
  if (status === 'AI_RESEARCH_UNAVAILABLE') return 'AI 연구 사용 불가';
  return 'AI 토론 미완료';
}

export function extractResearchAiDebate(value: unknown): ResearchAiDebateView {
  const root = debateRoot(value);
  const status = (text(root.dualAiReviewStatus) ?? text(root.status) ?? 'INCOMPLETE').toUpperCase();
  const ai1 = normalizeReview(root.ai1Review, 'AI 1');
  const ai2 = normalizeReview(root.ai2Review, 'AI 2');
  const committeeRoot = asRecord(root.aiCommittee) ?? root;
  const rawReviews = Array.isArray(committeeRoot.reviews)
    ? committeeRoot.reviews
    : Array.isArray(committeeRoot.committeeReviews) ? committeeRoot.committeeReviews : [];
  const committee = rawReviews
    .map((review, index) => normalizeReview(review, `위원 ${index + 1}`))
    .filter((review): review is ResearchDebateReviewView => Boolean(review));
  const conflictReason = text(root.reviewConflictReason) ?? text(root.conflictReason) ?? text(root.disagreementReason);
  const actualEvidence = Boolean(ai1 || ai2 || committee.length > 0);
  let finalLabel = '실제 AI 토론 결과 미수집';
  if (actualEvidence) {
    if (status === 'AI_REVIEW_AGREE') finalLabel = 'AI 의견이 일치했습니다. 데이터 검증을 계속합니다.';
    else if (status === 'CONFLICT') finalLabel = 'AI 의견이 충돌했습니다. 추가 검증이 필요합니다.';
    else if (status === 'BOTH_REJECT') finalLabel = '두 AI 모두 현재 증거로는 추가 진행에 반대합니다.';
    else finalLabel = 'AI 검토가 일부 수집됐지만 최종 합의는 아직 없습니다.';
  }
  return {
    status,
    statusLabel: debateStatusLabel(status),
    actualEvidence,
    ai1,
    ai2,
    committee,
    conflictReason,
    finalLabel,
  };
}

export function buildDebatePreview(overview: ResearchCenterOverview): ResearchDebatePreview {
  const cycles = new Map(overview.research.cycles.map((cycle) => [cycle.profile, cycle] as const));
  const forward = cycles.get('forward');
  const fast = cycles.get('fast-historical');
  const long = cycles.get('long-history');
  const support: string[] = [];
  const oppose: string[] = [];
  const verify: string[] = [];

  if (cyclePlainStatus(forward).tone === 'good') support.push('미래 검증(Forward)이 현재 정상 상태입니다.');
  if (cyclePlainStatus(fast).tone === 'good') support.push('빠른 과거검증이 현재 정상 상태입니다.');
  if (overview.shadow.records.present && overview.shadow.records.settledRecords != null && overview.shadow.records.settledRecords > 0) {
    support.push(`Shadow 미래 표본 ${overview.shadow.records.settledRecords}건이 정산됐습니다.`);
  }

  if (!long?.present) oppose.push('장기 과거검증(Long History)이 아직 미수집입니다.');
  if (!overview.paper.ledger.present || overview.paper.ledger.settlementCount == null) {
    oppose.push('자동 모의매매 정산 증거가 미수집이라 실제 수익성 표본을 확정할 수 없습니다.');
  } else if (overview.paper.ledger.settlementCount === 0) {
    oppose.push('자동 모의매매 정산이 0건이라 실제 수익성 표본이 없습니다.');
  }
  if (!overview.profitability.proven) oppose.push('수익성이 아직 증명되지 않았습니다.');

  if ([forward, fast, long].some((cycle) => cycle && (cycleHasAggregateGap(cycle) || cycleHasSuccessMismatch(cycle)))) {
    verify.push('연구 cycle 상위 집계가 미수집이거나 작업별 성공 수와 다른 항목을 확인해야 합니다.');
  }
  if (overview.shadow.groups.some((group) => group.macroF1 == null || group.balancedAccuracy == null)) {
    verify.push('Shadow 표본은 있으나 Macro F1 또는 균형정확도 지표가 미수집인 구간이 있습니다.');
  }
  if (overview.paper.ledger.present && overview.paper.ledger.positionCount == null) {
    verify.push('Paper Position 건수 증거가 미수집 상태입니다.');
  } else if (overview.paper.ledger.present && overview.paper.ledger.positionCount === 0) {
    verify.push('Paper가 여러 cycle을 돌았는데 Position 0인 첫 차단 단계를 확인해야 합니다.');
  }
  if (!overview.safety.authorityEvidenceComplete) {
    verify.push('Paper runtime 안전 핵심 필드가 일부 미수집 상태입니다.');
  }

  return {
    support: support.length ? support : ['현재 찬성 근거로 확정할 수 있는 증거가 없습니다.'],
    oppose: oppose.length ? oppose : ['현재 명확한 반대 근거가 수집되지 않았습니다.'],
    verify: verify.length ? verify : ['추가로 확인할 데이터 불일치가 없습니다.'],
  };
}