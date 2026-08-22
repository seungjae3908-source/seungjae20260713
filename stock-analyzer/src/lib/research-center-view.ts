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
  return cycle.successCount !== cycleTaskSuccessCount(cycle);
}

export function cyclePlainStatus(cycle: ResearchCycleSummary | undefined): { value: string; tone: ResearchSimpleTone } {
  if (!cycle?.present) return { value: '아직 대기', tone: 'waiting' };
  if (cycle.failedCount > 0 || FAILURE_STATES.has(normalized(cycle.status))) return { value: '오류 확인 필요', tone: 'blocked' };
  if (cycle.blockedDataCount > 0) return { value: '데이터 부족', tone: 'warning' };
  if (SUCCESS_STATES.has(normalized(cycle.status))) return { value: '정상', tone: 'good' };
  if (RUNNING_STATES.has(normalized(cycle.status))) return { value: '진행 중', tone: 'waiting' };
  return { value: '확인 중', tone: 'waiting' };
}

function cycleNote(cycle: ResearchCycleSummary | undefined): string {
  if (!cycle?.present) return '아직 자연 실행 증거가 수집되지 않았습니다.';
  const taskSuccesses = cycleTaskSuccessCount(cycle);
  if (cycleHasSuccessMismatch(cycle)) {
    return `작업별 성공 ${taskSuccesses}건 · 상위 집계 ${cycle.successCount}/${cycle.taskCount} 불일치 확인 필요`;
  }
  return `성공 ${cycle.successCount}/${cycle.taskCount} · 실패 ${cycle.failedCount} · 데이터 부족 ${cycle.blockedDataCount}`;
}

export function buildResearchSimpleItems(overview: ResearchCenterOverview): ResearchSimpleItem[] {
  const byProfile = new Map(overview.research.cycles.map((cycle) => [cycle.profile, cycle] as const));
  const forward = byProfile.get('forward');
  const fast = byProfile.get('fast-historical');
  const long = byProfile.get('long-history');
  const forwardStatus = cyclePlainStatus(forward);
  const fastStatus = cyclePlainStatus(fast);
  const longStatus = cyclePlainStatus(long);
  const ledger = overview.paper.ledger;
  const paperValue = ledger.present
    ? `${ledger.cycleCount}회 확인 · 정산 ${ledger.settlementCount}건`
    : '미수집';
  const paperTone: ResearchSimpleTone = !ledger.present
    ? 'waiting'
    : ledger.settlementCount > 0 ? 'good' : 'warning';
  const shadow = overview.shadow.records;
  const shadowValue = shadow.present
    ? `${shadow.totalRecords}건 중 ${shadow.settledRecords}건 검증완료`
    : '미수집';

  return [
    { key: 'forward', label: '미래 검증', value: forwardStatus.value, note: cycleNote(forward), tone: forwardStatus.tone },
    { key: 'fast', label: '빠른 과거검증', value: fastStatus.value, note: cycleNote(fast), tone: fastStatus.tone },
    { key: 'long', label: '장기 과거검증', value: longStatus.value, note: cycleNote(long), tone: longStatus.tone },
    {
      key: 'shadow',
      label: '미래 예측 검증',
      value: shadowValue,
      note: shadow.present ? `정산 대기 ${shadow.pendingRecords}건 · 표본 수와 예측 품질은 별도 판단` : 'Shadow 증거가 아직 없습니다.',
      tone: shadow.present && shadow.settledRecords > 0 ? 'good' : 'waiting',
    },
    {
      key: 'paper',
      label: '자동 모의매매',
      value: paperValue,
      note: ledger.present && ledger.settlementCount === 0
        ? '시스템은 확인 중이지만 아직 정산된 모의거래가 없습니다.'
        : '정산된 거래가 실제 수익성 계산의 근거가 됩니다.',
      tone: paperTone,
    },
    {
      key: 'profitability',
      label: '수익성',
      value: overview.profitability.proven ? '증명됨' : '아직 미증명',
      note: overview.profitability.proven
        ? '현재 수집된 정산 증거 기준입니다. 미래 수익을 보장하지 않습니다.'
        : 'Paper 정산과 미래 표본이 충분히 쌓이기 전에는 수익성을 증명했다고 표시하지 않습니다.',
      tone: overview.profitability.proven ? 'good' : 'warning',
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

  const ledger = overview.paper.ledger;
  const longHistory = overview.research.cycles.find((cycle) => cycle.profile === 'long-history');
  if (!ledger.present || ledger.settlementCount === 0) {
    return {
      tone: 'warning',
      title: '수익성 판단 보류',
      description: ledger.present
        ? `자동 모의매매는 ${ledger.cycleCount}회 확인됐지만 정산된 거래가 0건이라 아직 돈을 버는 전략인지 판단할 수 없습니다.`
        : '자동 모의매매 정산 증거가 아직 수집되지 않았습니다.',
      nextStep: `${longHistory?.present ? '' : '장기 과거검증을 수집하고, '}조건 통과 → 모의 진입 → 모의 종료 → 정산 → PF·EV·MDD 계산 순서로 진행합니다.`,
    };
  }

  if (!overview.profitability.proven) {
    return {
      tone: 'waiting',
      title: '수익성 증거 수집 중',
      description: `정산 ${ledger.settlementCount}건이 있지만 아직 수익성 승격 기준을 통과하지 못했습니다.`,
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
  if (overview.shadow.records.present && overview.shadow.records.settledRecords > 0) {
    support.push(`Shadow 미래 표본 ${overview.shadow.records.settledRecords}건이 정산됐습니다.`);
  }

  if (!long?.present) oppose.push('장기 과거검증(Long History)이 아직 미수집입니다.');
  if (!overview.paper.ledger.present || overview.paper.ledger.settlementCount === 0) oppose.push('자동 모의매매 정산이 0건이라 실제 수익성 표본이 없습니다.');
  if (!overview.profitability.proven) oppose.push('수익성이 아직 증명되지 않았습니다.');

  if ([forward, fast, long].some((cycle) => cycle && cycleHasSuccessMismatch(cycle))) {
    verify.push('연구 cycle 상위 집계와 작업별 성공 수가 다른 항목을 확인해야 합니다.');
  }
  if (overview.shadow.groups.some((group) => group.macroF1 == null || group.balancedAccuracy == null)) {
    verify.push('Shadow 표본은 있으나 Macro F1 또는 균형정확도 지표가 미수집인 구간이 있습니다.');
  }
  if (overview.paper.ledger.present && overview.paper.ledger.positionCount === 0) {
    verify.push('Paper가 여러 cycle을 돌았는데 Position 0인 첫 차단 단계를 확인해야 합니다.');
  }

  return {
    support: support.length ? support : ['현재 찬성 근거로 확정할 수 있는 증거가 없습니다.'],
    oppose: oppose.length ? oppose : ['현재 명확한 반대 근거가 수집되지 않았습니다.'],
    verify: verify.length ? verify : ['추가로 확인할 데이터 불일치가 없습니다.'],
  };
}
