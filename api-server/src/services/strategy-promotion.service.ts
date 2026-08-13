import { createHash } from 'node:crypto';
import {
  listScannerStrategyProfiles,
  type ScannerProfileMarket,
  type ScannerStrategyProfile,
} from './scanner-strategy-profile.service';

export const STRATEGY_PROMOTION_EXECUTION_AUTHORITY = 'NONE' as const;
export const COST_STRESS_MULTIPLIERS = [1, 1.25, 1.5, 2] as const;

export type StrategyDirection = 'BUY' | 'SELL' | 'LONG' | 'SHORT';
export type StrategyAssetClass = 'STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type PromotionStageKey =
  | 'RESEARCH_DESIGN'
  | 'HISTORICAL_BACKTEST'
  | 'OUT_OF_SAMPLE'
  | 'PURGED_WALK_FORWARD'
  | 'COST_STRESS'
  | 'REGIME'
  | 'FINAL_HOLDOUT'
  | 'PAPER'
  | 'SHADOW'
  | 'RECOMMENDATION_OUTCOMES';
export type PromotionStageStatus =
  | 'NOT_STARTED'
  | 'RUNNING'
  | 'PASS'
  | 'FAIL'
  | 'BLOCKED'
  | 'INSUFFICIENT_SAMPLE'
  | 'STALE'
  | 'INVALIDATED';
export type PromotionState =
  | 'RESEARCH'
  | 'BLOCKED_DATA'
  | 'RESEARCH_HOLD'
  | 'PAPER_CANDIDATE'
  | 'PAPER_VALIDATED'
  | 'SHADOW_CANDIDATE'
  | 'SHADOW_VALIDATED'
  | 'PROMOTION_CANDIDATE'
  | 'SUSPENDED'
  | 'KILLED';
export type DriftClassification = 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'CRITICAL';
export type KillState = 'NONE' | 'SUSPEND_RECOMMENDED' | 'KILLED';

export interface StrategyIdentity {
  strategyFamily: string;
  strategyId: string;
  strategyVersion: string;
  version: string;
  parameterHash: string;
  market: ScannerProfileMarket;
  assetClass: StrategyAssetClass;
  symbol: null;
  universe: string;
  timeframe: string;
  strategyHorizon: ScannerStrategyProfile['horizon'];
  horizon: ScannerStrategyProfile['horizon'];
  direction: StrategyDirection;
  researchCodeSha: string;
  costPolicyVersion: string;
  riskPolicyVersion: string;
}

export interface PromotionStageEvidence {
  stage: PromotionStageKey;
  status: PromotionStageStatus;
  startedAt: string | null;
  completedAt: string | null;
  observedAt: string;
  source: string;
  provider: string | null;
  sourceSha: string | null;
  datasetId: string | null;
  dataRange: { start: string; end: string } | null;
  sampleSize: number | null;
  sampleCount: number | null;
  tradeCount: number | null;
  metrics: Readonly<Record<string, number | string | boolean | null>> | null;
  gate: string;
  gateResult: PromotionStageStatus | 'EVIDENCE_REQUIRED';
  failureReason: string | null;
  failureReasons: readonly string[];
  provenance: readonly string[];
  costAssumptions: Readonly<Record<string, number | string | boolean | null>> | null;
  costPolicy: Readonly<Record<string, number | string | boolean | null>> | null;
  dataQuality: 'VERIFIED' | 'PARTIAL' | 'INSUFFICIENT' | 'UNLINKED';
  fetchedAt: string | null;
  validatedAt: string | null;
  corporateActionAdjusted: boolean | null;
  survivorshipSafe: boolean | null;
  pointInTimeSafe: boolean | null;
  requiredEvidence: readonly string[];
}

export interface DriftState {
  classification: DriftClassification | null;
  status: 'MEASURED' | 'INSUFFICIENT_SAMPLE';
  reason: string;
  baselineSampleSize: number | null;
  observedSampleSize: number | null;
  hitRateGap: number | null;
  expectedValueGap: number | null;
  autoPromotionAllowed: false;
}

export interface StrategyPromotionRecord {
  identity: StrategyIdentity;
  promotionState: PromotionState;
  stages: readonly PromotionStageEvidence[];
  drift: DriftState;
  killState: KillState;
  blockers: readonly string[];
  promotionEligible: boolean;
  executionAuthority: 'NONE';
  liveTradingAuthority: false;
  privateTradingApiCount: 0;
}

export interface PromotionEvidenceSource {
  id: string;
  owner: string;
  status: 'AVAILABLE' | 'UNLINKED' | 'NOT_ON_MAIN';
  use: string;
  executionAuthority: 'NONE';
}

export interface StrategyPromotionList {
  generatedAt: string;
  sourceSha: string;
  policyVersion: string;
  items: readonly StrategyPromotionRecord[];
  counts: Readonly<Record<PromotionState, number>>;
  evidenceSources: readonly PromotionEvidenceSource[];
  promotionCandidates: number;
  executionAuthority: 'NONE';
  liveTradingAuthority: false;
  privateTradingApiCount: 0;
}

export interface StrategyEvidenceOverride extends Partial<Omit<PromotionStageEvidence, 'stage' | 'observedAt'>> {
  stage: PromotionStageKey;
  observedAt?: string;
}

export interface StrategyPromotionServiceOptions {
  sourceSha?: string;
  now?: () => Date;
  evidence?: Readonly<Record<string, readonly StrategyEvidenceOverride[]>>;
  killStates?: Readonly<Record<string, KillState>>;
}

const STAGE_ORDER: readonly PromotionStageKey[] = [
  'RESEARCH_DESIGN',
  'HISTORICAL_BACKTEST',
  'OUT_OF_SAMPLE',
  'PURGED_WALK_FORWARD',
  'COST_STRESS',
  'REGIME',
  'FINAL_HOLDOUT',
  'PAPER',
  'SHADOW',
  'RECOMMENDATION_OUTCOMES',
];

const RESEARCH_GATES = STAGE_ORDER.slice(0, 7);
const VALID_SHA = /^[0-9a-f]{40}$/i;
export const STRATEGY_PROMOTION_POLICY = Object.freeze({
  version: 'STRATEGY_PROMOTION_POLICY_V1',
  stageOrder: STAGE_ORDER,
  researchGates: RESEARCH_GATES,
  costStressMultipliers: COST_STRESS_MULTIPLIERS,
  minimumObservedOutcomeSamples: 30,
  thresholdAuthority: 'CANONICAL_UPSTREAM_GATE_RESULTS',
});

const REQUIRED_EVIDENCE: Readonly<Record<PromotionStageKey, readonly string[]>> = Object.freeze({
  RESEARCH_DESIGN: ['immutable identity', 'parameter hash', 'exact research code SHA'],
  HISTORICAL_BACKTEST: ['lookahead control', 'survivorship and delisted-asset handling', 'corporate actions', 'missing and stale candles', 'spread', 'commission', 'tax', 'slippage', 'latency', 'funding where applicable', 'liquidity'],
  OUT_OF_SAMPLE: ['isolated dataset', 'trades', 'net return after costs', 'win rate', 'profit factor', 'expectancy', 'MDD', 'Sharpe where valid', 'average win/loss', 'MFE/MAE'],
  PURGED_WALK_FORWARD: ['purge', 'embargo where applicable', 'no future leakage', 'rolling stability', 'positive-window ratio', 'worst and median windows', 'parameter stability'],
  COST_STRESS: ['baseline', '1.25x', '1.5x', '2x', 'commission', 'spread', 'slippage', 'funding where applicable', 'latency impact'],
  REGIME: ['bull', 'bear', 'sideways', 'high/low volatility', 'high/low liquidity'],
  FINAL_HOLDOUT: ['selection isolation', 'no parameter retuning', 'no threshold retuning', 'no strategy-family retuning'],
  PAPER: ['canonical Paper engine', 'trade count', 'net return', 'expectancy', 'profit factor', 'MDD', 'win rate', 'holding time', 'MFE/MAE', 'cost difference'],
  SHADOW: ['SIMULATED_ONLY', 'LIVE_ORDER_ALLOWED=false', 'ORDER_SUBMITTED=false', 'PRIVATE_TRADING_REQUEST_ALLOWED=false', 'paper-shadow fill/price/latency/spread/outcome gaps'],
  RECOMMENDATION_OUTCOMES: ['immutable signal and evidence snapshot', 'TP-before-SL or SL-before-TP outcome', 'expiry/invalidation', 'MFE/MAE', 'net hypothetical return'],
});

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

export function strategyParameterHash(profile: ScannerStrategyProfile): string {
  return createHash('sha256').update(JSON.stringify(stableValue(profile))).digest('hex');
}

function assetClass(market: ScannerProfileMarket): StrategyAssetClass {
  if (market === 'CRYPTO_FUTURES') return 'CRYPTO_FUTURES';
  if (market === 'CRYPTO_SPOT') return 'CRYPTO_SPOT';
  return 'STOCK';
}

function directions(market: ScannerProfileMarket): readonly StrategyDirection[] {
  return market === 'CRYPTO_FUTURES' ? ['LONG', 'SHORT'] : ['BUY', 'SELL'];
}

function identity(profile: ScannerStrategyProfile, direction: StrategyDirection, sourceSha: string): StrategyIdentity {
  return Object.freeze({
    strategyFamily: 'CANONICAL_SCANNER_PROFILE',
    strategyId: `${profile.id}_${direction}`,
    strategyVersion: profile.version,
    version: profile.version,
    parameterHash: strategyParameterHash(profile),
    market: profile.market,
    assetClass: assetClass(profile.market),
    symbol: null,
    universe: `${profile.market}_CANONICAL_UNIVERSE`,
    timeframe: profile.primaryTimeframe,
    strategyHorizon: profile.horizon,
    horizon: profile.horizon,
    direction,
    researchCodeSha: sourceSha,
    costPolicyVersion: 'BACKTEST_FEES_SLIPPAGE_FUNDING_V1',
    riskPolicyVersion: 'CANONICAL_RISK_ENGINE_V1',
  });
}

function emptyStage(stage: PromotionStageKey, observedAt: string): PromotionStageEvidence {
  return {
    stage,
    status: 'NOT_STARTED',
    startedAt: null,
    completedAt: null,
    observedAt,
    source: 'UNLINKED',
    provider: null,
    sourceSha: null,
    datasetId: null,
    dataRange: null,
    sampleSize: null,
    sampleCount: null,
    tradeCount: null,
    metrics: null,
    gate: `${stage}_EVIDENCE_REQUIRED`,
    gateResult: 'EVIDENCE_REQUIRED',
    failureReason: null,
    failureReasons: [],
    provenance: [],
    costAssumptions: stage === 'COST_STRESS'
      ? { requiredMultipliers: COST_STRESS_MULTIPLIERS.join(',') }
      : null,
    costPolicy: stage === 'COST_STRESS'
      ? { version: 'BACKTEST_FEES_SLIPPAGE_FUNDING_V1', requiredMultipliers: COST_STRESS_MULTIPLIERS.join(',') }
      : null,
    dataQuality: 'UNLINKED',
    fetchedAt: null,
    validatedAt: null,
    corporateActionAdjusted: null,
    survivorshipSafe: null,
    pointInTimeSafe: null,
    requiredEvidence: REQUIRED_EVIDENCE[stage],
  };
}

function researchStage(profile: ScannerStrategyProfile, sourceSha: string, observedAt: string): PromotionStageEvidence {
  const sourceAvailable = VALID_SHA.test(sourceSha);
  return {
    stage: 'RESEARCH_DESIGN',
    status: sourceAvailable ? 'PASS' : 'BLOCKED',
    startedAt: observedAt,
    completedAt: observedAt,
    observedAt,
    source: 'scanner-strategy-profile.service.ts',
    provider: 'INTERNAL_CANONICAL_REGISTRY',
    sourceSha: sourceAvailable ? sourceSha : null,
    datasetId: null,
    dataRange: null,
    sampleSize: null,
    sampleCount: null,
    tradeCount: null,
    metrics: { profileId: profile.id, profileVersion: profile.version, executionAuthority: 'NONE' },
    gate: 'IMMUTABLE_PROFILE_AND_EXACT_CODE_SHA',
    gateResult: sourceAvailable ? 'PASS' : 'BLOCKED',
    failureReason: sourceAvailable ? null : 'EXACT_RESEARCH_CODE_SHA_UNAVAILABLE',
    failureReasons: sourceAvailable ? [] : ['EXACT_RESEARCH_CODE_SHA_UNAVAILABLE'],
    provenance: ['canonical scanner strategy profile registry'],
    costAssumptions: null,
    costPolicy: null,
    dataQuality: sourceAvailable ? 'VERIFIED' : 'INSUFFICIENT',
    fetchedAt: null,
    validatedAt: observedAt,
    corporateActionAdjusted: null,
    survivorshipSafe: null,
    pointInTimeSafe: null,
    requiredEvidence: REQUIRED_EVIDENCE.RESEARCH_DESIGN,
  };
}

function mergeEvidence(base: PromotionStageEvidence, override: StrategyEvidenceOverride | undefined, observedAt: string, expectedSourceSha: string): PromotionStageEvidence {
  if (!override) return base;
  const merged = {
    ...base,
    ...override,
    stage: base.stage,
    observedAt: override.observedAt ?? observedAt,
    sampleCount: override.sampleCount ?? override.sampleSize ?? base.sampleCount,
    sampleSize: override.sampleSize ?? override.sampleCount ?? base.sampleSize,
    gateResult: override.gateResult ?? override.status ?? base.gateResult,
    failureReasons: override.failureReasons
      ? [...override.failureReasons]
      : override.failureReason
        ? [override.failureReason]
        : base.failureReasons,
    provenance: override.provenance ? [...override.provenance] : base.provenance,
  };
  return validateLinkedEvidence({
    ...merged,
    completedAt: override.completedAt ?? (merged.status === 'RUNNING' || merged.status === 'NOT_STARTED' ? null : merged.observedAt),
    validatedAt: override.validatedAt ?? merged.observedAt,
  }, expectedSourceSha);
}

function validateLinkedEvidence(stage: PromotionStageEvidence, expectedSourceSha: string): PromotionStageEvidence {
  if (stage.stage === 'RESEARCH_DESIGN' || stage.status !== 'PASS') return stage;
  const missing = [
    !VALID_SHA.test(stage.sourceSha ?? '') || stage.sourceSha !== expectedSourceSha ? 'EXACT_SOURCE_SHA_REQUIRED' : null,
    !stage.datasetId ? 'DATASET_ID_REQUIRED' : null,
    !stage.dataRange ? 'DATA_RANGE_REQUIRED' : null,
    !stage.provenance.length ? 'PROVENANCE_REQUIRED' : null,
    stage.dataQuality !== 'VERIFIED' ? 'VERIFIED_DATA_QUALITY_REQUIRED' : null,
    !stage.metrics ? 'METRICS_REQUIRED' : null,
  ].filter((value): value is string => Boolean(value));
  if (!missing.length) return stage;
  return {
    ...stage,
    status: 'BLOCKED',
    gateResult: 'BLOCKED',
    failureReason: missing.join(','),
    failureReasons: missing,
  };
}

function stageMap(stages: readonly PromotionStageEvidence[]) {
  return new Map(stages.map((stage) => [stage.stage, stage]));
}

function blockingReason(stage: PromotionStageEvidence): string | null {
  if (stage.status === 'PASS') return null;
  if (stage.status === 'NOT_STARTED' || stage.status === 'RUNNING') return `${stage.stage}_${stage.status}`;
  return `${stage.stage}_${stage.status}${stage.failureReason ? `:${stage.failureReason}` : ''}`;
}

function costStressComplete(stage: PromotionStageEvidence): boolean {
  if (stage.status !== 'PASS' || !stage.metrics) return false;
  return COST_STRESS_MULTIPLIERS.every((multiplier) => stage.metrics?.[`cost_${multiplier}x`] === true);
}

function promotionState(stages: readonly PromotionStageEvidence[], drift: DriftState, killState: KillState): PromotionState {
  if (killState === 'KILLED') return 'KILLED';
  if (killState === 'SUSPEND_RECOMMENDED' || drift.classification === 'DEGRADED' || drift.classification === 'CRITICAL') return 'SUSPENDED';
  const byStage = stageMap(stages);
  const research = RESEARCH_GATES.map((key) => byStage.get(key)!);
  if (research.some((stage) => stage.status === 'BLOCKED' || stage.status === 'INVALIDATED')) return 'BLOCKED_DATA';
  if (research.some((stage) => ['FAIL', 'INSUFFICIENT_SAMPLE', 'STALE'].includes(stage.status))) return 'RESEARCH_HOLD';
  if (!research.every((stage) => stage.status === 'PASS') || !costStressComplete(byStage.get('COST_STRESS')!)) return 'RESEARCH';

  const paper = byStage.get('PAPER')!;
  const shadow = byStage.get('SHADOW')!;
  const outcomes = byStage.get('RECOMMENDATION_OUTCOMES')!;
  if (paper.status !== 'PASS') return paper.status === 'NOT_STARTED' || paper.status === 'RUNNING' ? 'PAPER_CANDIDATE' : 'RESEARCH_HOLD';
  if (shadow.status === 'BLOCKED' || shadow.status === 'FAIL' || shadow.status === 'INSUFFICIENT_SAMPLE' || shadow.status === 'STALE' || shadow.status === 'INVALIDATED') return 'PAPER_VALIDATED';
  if (shadow.status !== 'PASS') return 'SHADOW_CANDIDATE';
  if (outcomes.status !== 'PASS') return 'SHADOW_VALIDATED';
  return 'PROMOTION_CANDIDATE';
}

export function classifyPromotionDrift(stages: readonly PromotionStageEvidence[]): DriftState {
  const byStage = stageMap(stages);
  const baseline = byStage.get('HISTORICAL_BACKTEST');
  const observed = byStage.get('RECOMMENDATION_OUTCOMES');
  const baselineSamples = baseline?.sampleCount ?? baseline?.sampleSize ?? baseline?.tradeCount ?? null;
  const observedSamples = observed?.sampleCount ?? observed?.sampleSize ?? observed?.tradeCount ?? null;
  const baselineHitRate = typeof baseline?.metrics?.hitRate === 'number' ? baseline.metrics.hitRate : null;
  const observedHitRate = typeof observed?.metrics?.hitRate === 'number' ? observed.metrics.hitRate : null;
  const baselineEv = typeof baseline?.metrics?.expectedValue === 'number' ? baseline.metrics.expectedValue : null;
  const observedEv = typeof observed?.metrics?.expectedValue === 'number' ? observed.metrics.expectedValue : null;
  if (baselineSamples == null || observedSamples == null || observedSamples < STRATEGY_PROMOTION_POLICY.minimumObservedOutcomeSamples || baselineHitRate == null || observedHitRate == null || baselineEv == null || observedEv == null) {
    return {
      classification: null,
      status: 'INSUFFICIENT_SAMPLE',
      reason: 'LINKED_BASELINE_AND_AT_LEAST_30_OBSERVED_OUTCOMES_REQUIRED',
      baselineSampleSize: baselineSamples,
      observedSampleSize: observedSamples,
      hitRateGap: null,
      expectedValueGap: null,
      autoPromotionAllowed: false,
    };
  }
  const hitRateGap = observedHitRate - baselineHitRate;
  const expectedValueGap = observedEv - baselineEv;
  const classification: DriftClassification = hitRateGap <= -0.2 || expectedValueGap < -1
    ? 'CRITICAL'
    : hitRateGap <= -0.12 || expectedValueGap < -0.5
      ? 'DEGRADED'
      : hitRateGap <= -0.05 || expectedValueGap < 0
        ? 'WATCH'
        : 'HEALTHY';
  return {
    classification,
    status: 'MEASURED',
    reason: 'BACKTEST_TO_RECOMMENDATION_OUTCOME_COMPARISON',
    baselineSampleSize: baselineSamples,
    observedSampleSize: observedSamples,
    hitRateGap,
    expectedValueGap,
    autoPromotionAllowed: false,
  };
}

function sourceRegistry(): readonly PromotionEvidenceSource[] {
  return Object.freeze([
    { id: 'CANONICAL_SCANNER_PROFILE', owner: 'scanner-strategy-profile.service.ts', status: 'AVAILABLE', use: 'immutable strategy identity and research design', executionAuthority: 'NONE' },
    { id: 'BACKTEST_ENGINE', owner: 'backtest-engine.service.ts', status: 'AVAILABLE', use: 'historical, cost-aware and regime evidence after exact identity linkage', executionAuthority: 'NONE' },
    { id: 'PREDICTION_LAB', owner: 'market-prediction-lab', status: 'UNLINKED', use: 'purged walk-forward and final-holdout artifacts require parameter-hash linkage', executionAuthority: 'NONE' },
    { id: 'PAPER_JOURNAL', owner: 'paper-journal', status: 'AVAILABLE', use: 'paper evidence after strategy identity linkage', executionAuthority: 'NONE' },
    { id: 'SIGNAL_PERFORMANCE', owner: 'signal-performance-learning.service.ts', status: 'AVAILABLE', use: 'shadow and recommendation outcomes after strategy identity linkage', executionAuthority: 'NONE' },
    { id: 'PROFIT_FIRST_SCANNER', owner: 'PR #210 clean-port candidate', status: 'NOT_ON_MAIN', use: 'future scanner evidence source; no evidence accepted until clean-port and exact-head gates pass', executionAuthority: 'NONE' },
  ]);
}

function stateCounts(items: readonly StrategyPromotionRecord[]): Record<PromotionState, number> {
  const counts: Record<PromotionState, number> = {
    RESEARCH: 0, BLOCKED_DATA: 0, RESEARCH_HOLD: 0, PAPER_CANDIDATE: 0, PAPER_VALIDATED: 0,
    SHADOW_CANDIDATE: 0, SHADOW_VALIDATED: 0, PROMOTION_CANDIDATE: 0, SUSPENDED: 0, KILLED: 0,
  };
  for (const item of items) counts[item.promotionState] += 1;
  return counts;
}

export class StrategyPromotionService {
  private readonly sourceSha: string;
  private readonly now: () => Date;
  private readonly evidence: StrategyPromotionServiceOptions['evidence'];
  private readonly killStates: StrategyPromotionServiceOptions['killStates'];

  constructor(options: StrategyPromotionServiceOptions = {}) {
    this.sourceSha = String(options.sourceSha ?? process.env.DEPLOY_SHA ?? process.env.GITHUB_SHA ?? '').trim();
    this.now = options.now ?? (() => new Date());
    this.evidence = options.evidence ?? {};
    this.killStates = options.killStates ?? {};
  }

  list(filters: { market?: string; strategyHorizon?: string; direction?: string; status?: string } = {}): StrategyPromotionList {
    const generatedAt = this.now().toISOString();
    const items = listScannerStrategyProfiles().flatMap((profile) => directions(profile.market).map((direction) => {
      const itemIdentity = identity(profile, direction, this.sourceSha || 'UNAVAILABLE');
      const overrides = new Map((this.evidence?.[itemIdentity.strategyId] ?? []).map((item) => [item.stage, item]));
      const stages = STAGE_ORDER.map((stage) => mergeEvidence(
        stage === 'RESEARCH_DESIGN' ? researchStage(profile, this.sourceSha, generatedAt) : emptyStage(stage, generatedAt),
        overrides.get(stage),
        generatedAt,
        this.sourceSha,
      ));
      const drift = classifyPromotionDrift(stages);
      const killState = this.killStates?.[itemIdentity.strategyId] ?? 'NONE';
      const currentState = promotionState(stages, drift, killState);
      const blockers = stages.map(blockingReason).filter((item): item is string => Boolean(item));
      if (byCostStressNeedsDetails(stages)) blockers.push('COST_STRESS_1X_1_25X_1_5X_2X_REQUIRED');
      return Object.freeze({
        identity: itemIdentity,
        promotionState: currentState,
        stages: Object.freeze(stages),
        drift,
        killState,
        blockers: Object.freeze(blockers),
        promotionEligible: currentState === 'PROMOTION_CANDIDATE',
        executionAuthority: STRATEGY_PROMOTION_EXECUTION_AUTHORITY,
        liveTradingAuthority: false as const,
        privateTradingApiCount: 0 as const,
      });
    })).filter((item) => (!filters.market || item.identity.market === filters.market)
      && (!filters.strategyHorizon || item.identity.strategyHorizon === filters.strategyHorizon)
      && (!filters.direction || item.identity.direction === filters.direction)
      && (!filters.status || item.promotionState === filters.status));
    const counts = stateCounts(items);
    return {
      generatedAt,
      sourceSha: this.sourceSha || 'UNAVAILABLE',
      policyVersion: STRATEGY_PROMOTION_POLICY.version,
      items,
      counts,
      evidenceSources: sourceRegistry(),
      promotionCandidates: counts.PROMOTION_CANDIDATE,
      executionAuthority: STRATEGY_PROMOTION_EXECUTION_AUTHORITY,
      liveTradingAuthority: false,
      privateTradingApiCount: 0,
    };
  }

  get(strategyId: string): StrategyPromotionRecord | null {
    return this.list().items.find((item) => item.identity.strategyId === strategyId) ?? null;
  }

  history(strategyId: string) {
    const record = this.get(strategyId);
    if (!record) return null;
    const events: Array<{
      at: string;
      type: 'STAGE_EVALUATED' | 'PROMOTION_STATE_EVALUATED';
      stage: PromotionStageKey | 'PROMOTION';
      status: PromotionStageStatus | PromotionState;
      source: string;
      sourceSha: string | null;
    }> = record.stages
      .filter((stage) => stage.status !== 'NOT_STARTED')
      .map((stage) => ({ at: stage.validatedAt ?? stage.observedAt, type: 'STAGE_EVALUATED', stage: stage.stage, status: stage.status, source: stage.source, sourceSha: stage.sourceSha }));
    events.push({ at: this.now().toISOString(), type: 'PROMOTION_STATE_EVALUATED', stage: 'PROMOTION', status: record.promotionState, source: 'strategy-promotion.service.ts', sourceSha: VALID_SHA.test(this.sourceSha) ? this.sourceSha : null });
    return { strategyId, events, executionAuthority: STRATEGY_PROMOTION_EXECUTION_AUTHORITY };
  }

  evidenceFor(strategyId: string) {
    const record = this.get(strategyId);
    if (!record) return null;
    return {
      strategyId,
      parameterHash: record.identity.parameterHash,
      stages: record.stages,
      sources: sourceRegistry(),
      exactIdentityRequired: true,
      inventedMetricsAllowed: false,
      executionAuthority: STRATEGY_PROMOTION_EXECUTION_AUTHORITY,
    };
  }
}

function byCostStressNeedsDetails(stages: readonly PromotionStageEvidence[]) {
  const cost = stages.find((stage) => stage.stage === 'COST_STRESS');
  return cost?.status === 'PASS' && !costStressComplete(cost);
}

export function createDefaultStrategyPromotionService() {
  return new StrategyPromotionService();
}
