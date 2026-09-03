import type { ResearchCenterOverview } from './research-center';
import type {
  PromotionStage,
  StrategyPromotionItem,
  StrategyPromotionResponse,
} from './strategy-promotion';

export type ResearchProductStatus =
  | 'normal'
  | 'verified'
  | 'validating'
  | 'running'
  | 'accumulating'
  | 'waiting'
  | 'insufficient'
  | 'unmeasured'
  | 'attention'
  | 'error'
  | 'inactive'
  | 'stale';

export type ResearchPipelineKey =
  | 'external-research'
  | 'backtest'
  | 'oos'
  | 'purged-walk-forward'
  | 'final-holdout'
  | 'shadow'
  | 'paper'
  | 'settlement'
  | 'profitability'
  | 'strategy-health'
  | 'promotion'
  | 'champion';

export type EvidenceAvailability =
  | 'PRESENT'
  | 'MISSING'
  | 'STALE'
  | 'WRONG_SHA'
  | 'NOT_EVALUABLE'
  | 'ZERO_MEASURED';

export const RESEARCH_STATUS_LABELS: Readonly<Record<ResearchProductStatus, string>> = Object.freeze({
  normal: '정상',
  verified: '검증됨',
  validating: '검증 중',
  running: '실행 중',
  accumulating: '축적 중',
  waiting: '대기',
  insufficient: '자료 부족',
  unmeasured: '미측정',
  attention: '확인 필요',
  error: '오류',
  inactive: '미활성',
  stale: '오래된 데이터',
});

export const FULL_COST_KEYS = Object.freeze([
  'commission',
  'tax',
  'spread',
  'slippage',
  'funding',
  'latency',
  'liquidityImpact',
  'partialFillImpact',
] as const);

export type FullCostKey = (typeof FULL_COST_KEYS)[number];

export interface ProductMetric {
  label: string;
  value: string;
  availability: EvidenceAvailability;
}

export interface ProductEvidenceRecord {
  id: string;
  label: string;
  status: ResearchProductStatus;
  source: string;
  sourceSha: string | null;
  observedAt: string | number | null;
  datasetId: string | null;
  period: string;
  sampleN: string;
  metrics: ProductMetric[];
  blocker: string | null;
  provenance: string[];
}

export interface ResearchPipelineCard {
  key: ResearchPipelineKey;
  label: string;
  status: ResearchProductStatus;
  metrics: ProductMetric[];
  updatedAt: string | number | null;
  blocker: string | null;
  evidenceState: EvidenceAvailability;
  records: ProductEvidenceRecord[];
}

export interface CostDisplayRow {
  key: FullCostKey;
  label: string;
  state: 'measured' | 'unmeasured' | 'not-applicable' | 'insufficient';
  value: string;
  quality: string | null;
}

type CanonicalCostComponent = {
  status?: unknown;
  valuePercent?: unknown;
  quality?: unknown;
};

export type CanonicalCostEvidence = {
  fullCostReady?: unknown;
  components?: Partial<Record<FullCostKey, CanonicalCostComponent>>;
};

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const ERROR_STATES = new Set(['FAIL', 'FAILED', 'ERROR', 'CRITICAL', 'SAFETY_BLOCK', 'INVALIDATED']);
const ATTENTION_STATES = new Set(['BLOCKED', 'BLOCKED_DATA', 'ATTENTION']);
const RUNNING_STATES = new Set(['RUNNING', 'PENDING', 'COLLECTING', 'EVIDENCE_COLLECTION']);
const SUCCESS_STATES = new Set(['PASS', 'SUCCESS', 'COMPLETE', 'COMPLETED', 'READY', 'HEALTHY']);

function normalized(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasExplicitChampion(overview: ResearchCenterOverview): boolean {
  const championInput = overview.strategyHealth?.inputs?.champion;
  return Boolean(
    (overview.champion && Object.prototype.hasOwnProperty.call(overview.champion, 'currentValidatedChampion'))
    || championInput?.status === 'HEALTHY'
    || championInput?.reason === 'CURRENT_VALIDATED_CHAMPION_NONE',
  );
}

function stageStatus(stage: PromotionStage): ResearchProductStatus {
  if (stage.status === 'STALE') return 'stale';
  if (ERROR_STATES.has(stage.status)) return 'error';
  if (ATTENTION_STATES.has(stage.status)) return 'attention';
  if (stage.status === 'INSUFFICIENT_SAMPLE') return 'insufficient';
  if (RUNNING_STATES.has(stage.status)) return 'validating';
  if (SUCCESS_STATES.has(stage.status)) return 'verified';
  return 'waiting';
}

export function mapResearchProductStatus(value: unknown, present = true): ResearchProductStatus {
  if (!present) return 'unmeasured';
  const state = normalized(value);
  if (state === 'STALE') return 'stale';
  if (ERROR_STATES.has(state)) return 'error';
  if (ATTENTION_STATES.has(state) || state === 'DEGRADED' || state === 'WATCH') return 'attention';
  if (state === 'INSUFFICIENT_SAMPLE' || state === 'EVIDENCE_INCOMPLETE') return 'insufficient';
  if (RUNNING_STATES.has(state) || state === 'REPLAYED') return 'accumulating';
  if (SUCCESS_STATES.has(state)) return 'normal';
  if (state === 'NOT_STARTED') return 'waiting';
  return 'unmeasured';
}

export function statusLabel(status: ResearchProductStatus): string {
  return RESEARCH_STATUS_LABELS[status];
}

export function formatCanonicalMetric(
  value: number | null | undefined,
  options: { digits?: number; suffix?: string; unavailable?: string } = {},
): string {
  if (!finite(value)) return options.unavailable ?? '미측정';
  const digits = options.digits ?? (Number.isInteger(value) ? 0 : 2);
  return `${new Intl.NumberFormat('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)}${options.suffix ?? ''}`;
}

export function metricAvailability(value: number | null | undefined): EvidenceAvailability {
  if (!finite(value)) return 'MISSING';
  return value === 0 ? 'ZERO_MEASURED' : 'PRESENT';
}

export function classifySha(expected: string | null | undefined, actual: string | null | undefined): EvidenceAvailability {
  if (!expected || !actual || !SHA_PATTERN.test(expected) || !SHA_PATTERN.test(actual)) return 'MISSING';
  return expected.toLowerCase() === actual.toLowerCase() ? 'PRESENT' : 'WRONG_SHA';
}

function metric(label: string, value: number | null | undefined, suffix = '', digits?: number): ProductMetric {
  return {
    label,
    value: formatCanonicalMetric(value, { suffix, digits }),
    availability: metricAvailability(value),
  };
}

function textMetric(label: string, value: unknown): ProductMetric {
  const text = typeof value === 'string' && value.trim() ? value.trim() : null;
  return { label, value: text ?? '미측정', availability: text ? 'PRESENT' : 'MISSING' };
}

function period(stage: PromotionStage): string {
  if (stage.dataRange?.start && stage.dataRange?.end) return `${stage.dataRange.start} ~ ${stage.dataRange.end}`;
  return '미측정';
}

function sampleText(stage: PromotionStage): string {
  const value = stage.tradeCount ?? stage.sampleCount ?? stage.sampleSize;
  return finite(value) ? `N=${formatCanonicalMetric(value)}` : 'N 미측정';
}

function stageMetrics(stage: PromotionStage): ProductMetric[] {
  const metrics = stage.metrics ?? {};
  const preferred = [
    ['Trades N', metrics.tradeCount ?? stage.tradeCount ?? stage.sampleCount ?? stage.sampleSize],
    ['Win Rate', metrics.winRate ?? metrics.hitRate],
    ['Expectancy', metrics.expectancy ?? metrics.expectedValue],
    ['Profit Factor', metrics.profitFactor],
    ['Net Return', metrics.netReturn ?? metrics.netReturnPercent],
    ['MDD', metrics.mdd ?? metrics.maxDrawdown ?? metrics.maxDrawdownPercent],
    ['Sharpe', metrics.sharpe ?? metrics.sharpeRatio],
    ['Avg Win', metrics.avgWin ?? metrics.averageWin],
    ['Avg Loss', metrics.avgLoss ?? metrics.averageLoss],
  ] as const;
  const rows: ProductMetric[] = [];
  for (const [label, value] of preferred) {
    if (finite(value)) rows.push(metric(label, value));
  }
  if (rows.length > 0) return rows.slice(0, 9);
  return [
    metric('표본 N', stage.sampleCount ?? stage.sampleSize),
    metric('거래 N', stage.tradeCount),
  ];
}

function strategyLabel(item: StrategyPromotionItem): string {
  const identity = item.identity;
  return [identity.strategyId, identity.market, identity.direction].filter(Boolean).join(' · ');
}

function stageRecord(item: StrategyPromotionItem, stage: PromotionStage): ProductEvidenceRecord {
  const expectedSha = item.identity.researchCodeSha;
  const shaState = classifySha(expectedSha, stage.sourceSha);
  const wrongSha = stage.status === 'PASS' && shaState === 'WRONG_SHA';
  const missingSha = stage.status === 'PASS' && shaState === 'MISSING';
  return {
    id: `${item.identity.strategyId}:${stage.stage}`,
    label: strategyLabel(item),
    status: wrongSha || missingSha ? 'attention' : stageStatus(stage),
    source: stage.source || '미측정',
    sourceSha: stage.sourceSha,
    observedAt: stage.validatedAt ?? stage.observedAt ?? null,
    datasetId: stage.datasetId ?? null,
    period: period(stage),
    sampleN: sampleText(stage),
    metrics: stageMetrics(stage),
    blocker: wrongSha
      ? 'WRONG_SHA'
      : missingSha
        ? 'MISSING_CANONICAL_SOURCE_SHA'
        : stage.failureReason ?? stage.failureReasons?.[0] ?? (stage.status === 'NOT_STARTED' ? `${stage.stage}_NOT_EVIDENCED` : null),
    provenance: stage.provenance ?? [],
  };
}

function promotionStageCard(
  promotion: StrategyPromotionResponse | null,
  key: ResearchPipelineKey,
  label: string,
  stageName: string,
): ResearchPipelineCard {
  const pairs = promotion?.items.flatMap((item) => {
    const stage = item.stages?.find((candidate) => candidate.stage === stageName);
    return stage ? [{ item, stage }] : [];
  }) ?? [];
  const records = pairs.map(({ item, stage }) => stageRecord(item, stage));
  const wrongSha = records.some((record) => record.blocker === 'WRONG_SHA' || record.blocker === 'MISSING_CANONICAL_SOURCE_SHA');
  const stale = records.some((record) => record.status === 'stale');
  const errors = records.filter((record) => record.status === 'error').length;
  const attention = records.filter((record) => record.status === 'attention').length;
  const verified = records.filter((record) => record.status === 'verified').length;
  const running = records.filter((record) => record.status === 'validating').length;
  const status: ResearchProductStatus = !promotion || records.length === 0
    ? 'unmeasured'
    : wrongSha || errors > 0
      ? 'attention'
      : stale
        ? 'stale'
        : attention > 0
          ? 'attention'
          : verified === records.length
            ? 'verified'
            : running > 0
              ? 'validating'
              : verified > 0
                ? 'accumulating'
                : 'waiting';
  const latest = records
    .map((record) => Date.parse(String(record.observedAt ?? '')))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0] ?? null;
  return {
    key,
    label,
    status,
    metrics: [
      metric('검증', verified),
      metric('전체', records.length),
      metric('확인 필요', errors + attention),
    ],
    updatedAt: latest,
    blocker: records.find((record) => record.blocker)?.blocker ?? null,
    evidenceState: wrongSha ? 'WRONG_SHA' : stale ? 'STALE' : records.length ? 'PRESENT' : 'MISSING',
    records,
  };
}

function missingCard(key: ResearchPipelineKey, label: string, blocker: string): ResearchPipelineCard {
  return {
    key,
    label,
    status: 'unmeasured',
    metrics: [],
    updatedAt: null,
    blocker,
    evidenceState: 'MISSING',
    records: [],
  };
}

function overviewTimestamp(overview: ResearchCenterOverview): number | null {
  return finite(overview.state.latestCycleAt) ? overview.state.latestCycleAt : null;
}

export function buildResearchPipeline(
  overview: ResearchCenterOverview,
  promotion: StrategyPromotionResponse | null,
): ResearchPipelineCard[] {
  const external = missingCard('external-research', '외부 연구', 'EXTERNAL_RESEARCH_NOT_EVIDENCED');
  const sources = promotion?.evidenceSources ?? [];
  if (sources.length > 0) {
    const available = sources.filter((source) => source.status === 'AVAILABLE').length;
    external.status = sources.some((source) => source.status === 'UNLINKED' || source.status === 'NOT_ON_MAIN') ? 'insufficient' : 'verified';
    external.metrics = [metric('Canonical source', available), metric('전체 source', sources.length)];
    external.updatedAt = promotion?.generatedAt ?? null;
    external.blocker = sources.some((source) => source.status !== 'AVAILABLE') ? 'EXTERNAL_RESEARCH_SOURCE_UNLINKED' : null;
    external.evidenceState = external.blocker ? 'NOT_EVALUABLE' : 'PRESENT';
    external.records = sources.map((source) => ({
      id: source.id,
      label: source.id,
      status: source.status === 'AVAILABLE' ? 'verified' : 'insufficient',
      source: source.owner,
      sourceSha: null,
      observedAt: promotion?.generatedAt ?? null,
      datasetId: null,
      period: '미측정',
      sampleN: 'N 미측정',
      metrics: [textMetric('용도', source.use)],
      blocker: source.status === 'AVAILABLE' ? null : `SOURCE_${source.status}`,
      provenance: [],
    }));
  }

  const shadow = overview.shadow.records;
  const shadowCard: ResearchPipelineCard = {
    key: 'shadow',
    label: 'Shadow',
    status: shadow.present ? 'accumulating' : 'unmeasured',
    metrics: [
      metric('전체', shadow.totalRecords),
      metric('정산', shadow.settledRecords),
      metric('대기', shadow.pendingRecords),
    ],
    updatedAt: overviewTimestamp(overview),
    blocker: shadow.present ? null : 'SHADOW_RUNTIME_PROOF_MISSING',
    evidenceState: shadow.present ? 'PRESENT' : 'MISSING',
    records: overview.shadow.groups.map((group) => ({
      id: group.name,
      label: group.name,
      status: group.collapsed === true ? 'attention' : 'accumulating',
      source: 'canonical Shadow summary',
      sourceSha: null,
      observedAt: overviewTimestamp(overview),
      datasetId: null,
      period: '미측정',
      sampleN: finite(group.total) ? `N=${formatCanonicalMetric(group.total)}` : 'N 미측정',
      metrics: [metric('정산', group.settled), metric('대기', group.pending), metric('Macro F1', group.macroF1), metric('Balanced Accuracy', group.balancedAccuracy)],
      blocker: group.collapsed === true ? 'PREDICTION_COLLAPSE' : null,
      provenance: [],
    })),
  };

  const runtime = overview.paper.runtime;
  const ledger = overview.paper.ledger;
  const paperStatus: ResearchProductStatus = !runtime.present
    ? 'unmeasured'
    : runtime.scheduleActive === false
      ? 'inactive'
      : runtime.scheduleActive === true
        ? normalized(runtime.status) === 'RUNNING'
          ? 'running'
          : mapResearchProductStatus(runtime.status)
        : 'insufficient';
  const paperCard: ResearchPipelineCard = {
    key: 'paper',
    label: '모의매매',
    status: paperStatus,
    metrics: [metric('주기', ledger.cycleCount), metric('열린 포지션', ledger.positionCount), metric('정산', ledger.settlementCount)],
    updatedAt: overviewTimestamp(overview),
    blocker: !runtime.present
      ? 'PAPER_RUNTIME_PROOF_MISSING'
      : runtime.scheduleActive == null
        ? 'PAPER_SCHEDULE_STATE_MISSING'
        : runtime.scheduleActive === false
          ? 'PAPER_RUNTIME_INACTIVE'
          : null,
    evidenceState: runtime.present ? 'PRESENT' : 'MISSING',
    records: [],
  };

  const settlementCount = ledger.settlementCount;
  const settlementCard: ResearchPipelineCard = {
    key: 'settlement',
    label: 'Settlement',
    status: !ledger.present || settlementCount == null ? 'unmeasured' : settlementCount === 0 ? 'waiting' : 'accumulating',
    metrics: [metric('Settlement N', settlementCount), textMetric('Full Cost', '자료 부족')],
    updatedAt: overviewTimestamp(overview),
    blocker: !ledger.present || settlementCount == null
      ? 'SETTLEMENT_NOT_EVIDENCED'
      : settlementCount === 0
        ? 'SETTLEMENT_SAMPLE_EMPTY'
        : 'FULL_COST_EVIDENCE_NOT_PUBLISHED',
    evidenceState: !ledger.present || settlementCount == null ? 'MISSING' : settlementCount === 0 ? 'ZERO_MEASURED' : 'PRESENT',
    records: [],
  };

  const health = overview.strategyHealth;
  const healthStatus: ResearchProductStatus = health?.status === 'HEALTHY'
    ? 'normal'
    : health?.status === 'FAIL'
      ? 'error'
      : health?.status === 'WATCH'
        ? 'attention'
        : 'unmeasured';

  const championValue = overview.champion?.currentValidatedChampion
    ?? (overview.strategyHealth?.inputs?.champion?.status === 'HEALTHY' ? { canonical: true } : null);
  const championExplicit = hasExplicitChampion(overview);

  return [
    external,
    promotionStageCard(promotion, 'backtest', '백테스트', 'HISTORICAL_BACKTEST'),
    promotionStageCard(promotion, 'oos', 'OOS', 'OUT_OF_SAMPLE'),
    promotionStageCard(promotion, 'purged-walk-forward', 'Purged Walk-Forward', 'PURGED_WALK_FORWARD'),
    promotionStageCard(promotion, 'final-holdout', 'Final Holdout', 'FINAL_HOLDOUT'),
    shadowCard,
    paperCard,
    settlementCard,
    {
      key: 'profitability',
      label: 'Profitability',
      status: overview.profitability.proven ? 'verified' : 'waiting',
      metrics: [textMetric('검증', overview.profitability.proven ? '충족' : '아직 검증되지 않음')],
      updatedAt: overviewTimestamp(overview),
      blocker: overview.profitability.proven ? null : 'PROFITABILITY_NOT_PROVEN',
      evidenceState: overview.profitability.proven ? 'PRESENT' : 'NOT_EVALUABLE',
      records: [],
    },
    {
      key: 'strategy-health',
      label: 'Strategy Health',
      status: healthStatus,
      metrics: [textMetric('상태', health?.status === 'HEALTHY' ? '정상' : health?.status === 'WATCH' ? '관찰 필요' : health?.status === 'FAIL' ? '실패' : '근거 부족')],
      updatedAt: overviewTimestamp(overview),
      blocker: health?.reasons?.[0] ?? (health ? null : 'STRATEGY_HEALTH_EVIDENCE_MISSING'),
      evidenceState: health?.status === 'MISSING_EVIDENCE' || !health ? 'MISSING' : 'PRESENT',
      records: [],
    },
    {
      key: 'promotion',
      label: 'Promotion',
      status: !promotion ? 'unmeasured' : promotion.promotionCandidates > 0 ? 'validating' : 'waiting',
      metrics: [metric('후보', promotion?.promotionCandidates), metric('전략', promotion?.items.length)],
      updatedAt: promotion?.generatedAt ?? null,
      blocker: !promotion ? 'PROMOTION_API_UNAVAILABLE' : promotion.promotionCandidates === 0 ? 'PROMOTION_CANDIDATE_EMPTY' : null,
      evidenceState: promotion ? (promotion.promotionCandidates === 0 ? 'ZERO_MEASURED' : 'PRESENT') : 'MISSING',
      records: [],
    },
    {
      key: 'champion',
      label: 'Champion',
      status: championExplicit && championValue ? 'verified' : championExplicit ? 'waiting' : 'unmeasured',
      metrics: [textMetric('현재', championExplicit ? (championValue ? '검증된 Champion 있음' : '현재 검증된 Champion 없음') : '자료 없음')],
      updatedAt: overviewTimestamp(overview),
      blocker: championExplicit && !championValue ? 'CURRENT_VALIDATED_CHAMPION_NONE' : championExplicit ? null : 'CHAMPION_EVIDENCE_NOT_PUBLISHED',
      evidenceState: championExplicit ? (championValue ? 'PRESENT' : 'NOT_EVALUABLE') : 'MISSING',
      records: [],
    },
  ];
}

const COST_LABELS: Readonly<Record<FullCostKey, string>> = Object.freeze({
  commission: 'Commission',
  tax: 'Tax',
  spread: 'Spread',
  slippage: 'Slippage',
  funding: 'Funding',
  latency: 'Latency',
  liquidityImpact: 'Liquidity impact',
  partialFillImpact: 'Partial-fill impact',
});

export function buildFullCostRows(evidence: CanonicalCostEvidence | null | undefined): CostDisplayRow[] {
  return FULL_COST_KEYS.map((key) => {
    const component = evidence?.components?.[key];
    const status = normalized(component?.status);
    const quality = typeof component?.quality === 'string' ? component.quality : null;
    const value = finite(component?.valuePercent) && component.valuePercent >= 0 ? component.valuePercent : null;
    if (status === 'PRESENT' && quality === 'NOT_APPLICABLE' && value === 0) {
      return { key, label: COST_LABELS[key], state: 'not-applicable', value: '적용없음', quality };
    }
    if (status === 'PRESENT' && value != null) {
      return { key, label: COST_LABELS[key], state: 'measured', value: formatCanonicalMetric(value, { digits: 4, suffix: '%' }), quality };
    }
    if (status === 'MISSING' || status === 'NOT_EVIDENCED') {
      return { key, label: COST_LABELS[key], state: 'unmeasured', value: '미측정', quality };
    }
    return { key, label: COST_LABELS[key], state: 'insufficient', value: '자료 부족', quality };
  });
}

export function isFullCostReady(evidence: CanonicalCostEvidence | null | undefined): boolean {
  if (evidence?.fullCostReady !== true) return false;
  return buildFullCostRows(evidence).every((row) => row.state === 'measured' || row.state === 'not-applicable');
}

export function answerCanonicalResearchQuestion(
  question: string,
  overview: ResearchCenterOverview,
  cards: ResearchPipelineCard[],
): string {
  const query = question.trim().toLowerCase();
  if (!query) return '질문을 입력하면 현재 canonical evidence에서 확인되는 내용만 찾아드립니다.';
  const card = (key: ResearchPipelineKey) => cards.find((item) => item.key === key);
  if (/수익|승률|profit|pf|mdd/.test(query)) {
    const settlement = overview.paper.ledger.settlementCount;
    return overview.profitability.proven
      ? `현재 API는 수익성 검증을 충족으로 보고합니다. Settlement N=${formatCanonicalMetric(settlement)}이며 세부 지표는 canonical 값이 공개된 경우에만 표시됩니다.`
      : `현재 수익성은 아직 검증되지 않았습니다. Settlement N=${formatCanonicalMetric(settlement, { unavailable: '미측정' })}이며 승률·PF·MDD를 임의 생성하지 않습니다.`;
  }
  if (/shadow|섀도/.test(query)) {
    const records = overview.shadow.records;
    return records.present
      ? `Shadow canonical 요약은 전체 ${formatCanonicalMetric(records.totalRecords)}건, 정산 ${formatCanonicalMetric(records.settledRecords)}건, 대기 ${formatCanonicalMetric(records.pendingRecords)}건입니다.`
      : 'Shadow runtime proof가 현재 read-only API에 없습니다.';
  }
  if (/모의|paper|정산|settlement/.test(query)) {
    return `모의매매는 ${statusLabel(card('paper')?.status ?? 'unmeasured')} 상태입니다. 열린 포지션 ${formatCanonicalMetric(overview.paper.ledger.positionCount)}건, Settlement ${formatCanonicalMetric(overview.paper.ledger.settlementCount)}건이며 미수집 값은 0으로 바꾸지 않습니다.`;
  }
  if (/비용|cost|수수료|슬리피지/.test(query)) {
    return 'Full Cost 8개 구성요소의 canonical 상세가 현재 overview API에 공개되지 않았습니다. 따라서 비용은 0이 아니라 자료 부족으로 표시합니다.';
  }
  const blocker = cards.find((item) => item.blocker)?.blocker;
  return blocker
    ? `현재 가장 먼저 확인할 근거는 ${blocker}입니다. 이 응답은 AI 추정이 아니라 read-only canonical 상태 조회입니다.`
    : '현재 질문과 직접 연결되는 canonical evidence가 없습니다. 없는 결과를 생성하지 않습니다.';
}
