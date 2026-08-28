import { createHash } from 'node:crypto';

import {
  evaluateStrategyHealth,
  type StrategyHealthInput,
  type StrategyHealthPolicy,
  type StrategyHealthResult,
  type StrategyHealthStatus,
} from './strategy-health-observatory.service';

export type ResearchStrategyHealthStatus = 'HEALTHY' | 'WATCH' | 'FAIL' | 'MISSING_EVIDENCE';

export interface ResearchStrategyHealthEvidence {
  status: ResearchStrategyHealthStatus;
  reason: string;
  source: string;
  observedCount: number | null;
  minimumRequiredCount?: number | null;
  deficitCount?: number | null;
}

export interface ResearchStrategyHealthBinding {
  status: ResearchStrategyHealthStatus;
  evaluator: 'strategy-health-observatory.service/evaluateStrategyHealth';
  canonicalCoreStatus: StrategyHealthStatus | null;
  inputs: Readonly<Record<string, ResearchStrategyHealthEvidence>>;
  reasons: readonly string[];
  executionAuthority: 'NONE';
}

const HEALTHY_TASK_STATES = new Set(['complete', 'completed', 'success', 'pass', 'ready', 'healthy']);
const FAILED_TASK_STATES = new Set(['fail', 'failed', 'error', 'safety_block', 'critical']);
const HASH_64 = /^[0-9a-f]{64}$/u;
const CANONICAL_SHADOW_HEALTH_SCHEMA = 'prediction-lab-strategy-health-shadow-handoff-v1';

function canonical(value: unknown, stack = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical values require finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || value === undefined) throw new TypeError('unsupported canonical value');
  if (stack.has(value)) throw new TypeError('circular canonical value');
  const next = new Set(stack);
  next.add(value);
  if (Array.isArray(value)) return value.map((item) => canonical(item, next));
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(source).sort().map((key) => [key, canonical(source[key], next)]));
}

function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
}

function optionalCount(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : null;
}

function canonicalMinimumSampleSize(overview: Record<string, unknown>): number | null {
  const policy = record(record(overview.canonicalStrategyHealth)?.policy);
  const minimum = optionalCount(policy?.minimumSampleSize);
  return minimum !== null && minimum > 0 ? minimum : null;
}

function normalizedStatus(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function evidence(
  status: ResearchStrategyHealthStatus,
  reason: string,
  source: string,
  observedCount: number | null = null,
  minimumRequiredCount: number | null = null,
): ResearchStrategyHealthEvidence {
  if (minimumRequiredCount === null) return Object.freeze({ status, reason, source, observedCount });
  const deficitCount = observedCount === null ? null : Math.max(0, minimumRequiredCount - observedCount);
  return Object.freeze({ status, reason, source, observedCount, minimumRequiredCount, deficitCount });
}

function canonicalCoreEvidence(overview: Record<string, unknown>): {
  row: ResearchStrategyHealthEvidence;
  result: StrategyHealthResult | null;
} {
  const bundle = record(overview.canonicalStrategyHealth);
  const input = record(bundle?.input);
  const policy = record(bundle?.policy);
  if (!bundle || !input || !policy) {
    return {
      row: evidence('MISSING_EVIDENCE', 'CANONICAL_CORE_INPUT_OR_POLICY_MISSING', 'canonicalStrategyHealth'),
      result: null,
    };
  }
  if (typeof input.strategyId !== 'string' || !input.strategyId.trim()
    || typeof input.strategyVersion !== 'string' || !input.strategyVersion.trim()
    || optionalCount(input.sampleSize) === null) {
    return {
      row: evidence('MISSING_EVIDENCE', 'CANONICAL_CORE_IDENTITY_OR_SAMPLE_MISSING', 'canonicalStrategyHealth'),
      result: null,
    };
  }
  try {
    const result = evaluateStrategyHealth(
      input as unknown as StrategyHealthInput,
      policy as unknown as StrategyHealthPolicy,
    );
    const status: ResearchStrategyHealthStatus = result.status === 'INSUFFICIENT_DATA'
      ? 'MISSING_EVIDENCE'
      : result.status === 'HEALTHY'
        ? 'HEALTHY'
        : result.status === 'WATCH'
          ? 'WATCH'
          : 'FAIL';
    return {
      row: evidence(
        status,
        result.reasons.length ? result.reasons.join('+') : `CANONICAL_CORE_${result.status}`,
        'strategy-health-observatory.service/evaluateStrategyHealth',
        result.sampleSize,
      ),
      result,
    };
  } catch {
    return {
      row: evidence('MISSING_EVIDENCE', 'CANONICAL_CORE_INPUT_OR_POLICY_INVALID', 'canonicalStrategyHealth'),
      result: null,
    };
  }
}

function taskEvidence(cycles: Record<string, unknown>[], patterns: RegExp[]): ResearchStrategyHealthEvidence {
  for (const cycle of cycles) {
    const task = records(cycle.tasks).find((candidate) => patterns.some((pattern) => pattern.test(String(candidate.id ?? ''))));
    if (!task) continue;
    const status = normalizedStatus(task.status);
    if (task.timedOut === true || FAILED_TASK_STATES.has(status)) {
      return evidence('FAIL', task.timedOut === true ? 'TASK_TIMED_OUT' : 'TASK_FAILED', 'research.cycles.tasks');
    }
    if (HEALTHY_TASK_STATES.has(status)) return evidence('HEALTHY', 'CANONICAL_TASK_SUCCEEDED', 'research.cycles.tasks');
    return evidence('WATCH', 'CANONICAL_TASK_NOT_TERMINAL_SUCCESS', 'research.cycles.tasks');
  }
  return evidence('MISSING_EVIDENCE', 'CANONICAL_TASK_MISSING', 'research.cycles.tasks');
}

function backtestEvidence(cycles: Record<string, unknown>[]): ResearchStrategyHealthEvidence {
  const observed = cycles.filter((cycle) => cycle.present === true && ['fast-historical', 'long-history'].includes(String(cycle.profile ?? '')));
  if (!observed.length) return evidence('MISSING_EVIDENCE', 'BACKTEST_CYCLE_MISSING', 'research.cycles');
  if (observed.some((cycle) => FAILED_TASK_STATES.has(normalizedStatus(cycle.status)) || (optionalCount(cycle.failedCount) ?? 0) > 0)) {
    return evidence('FAIL', 'BACKTEST_CYCLE_FAILED', 'research.cycles', observed.length);
  }
  if (observed.some((cycle) => HEALTHY_TASK_STATES.has(normalizedStatus(cycle.status)))) {
    return evidence('HEALTHY', 'CANONICAL_BACKTEST_PRESENT', 'research.cycles', observed.length);
  }
  return evidence('WATCH', 'BACKTEST_CYCLE_NOT_TERMINAL_SUCCESS', 'research.cycles', observed.length);
}

function canonicalShadowDriftEvidence(
  overview: Record<string, unknown>,
  minimumRequiredCount: number | null,
): {
  quality: ResearchStrategyHealthEvidence;
  drift: ResearchStrategyHealthEvidence;
} {
  const wrappers = records(record(overview.shadow)?.canonicalHandoffs);
  if (!wrappers.length) return {
    quality: evidence('MISSING_EVIDENCE', 'CANONICAL_SHADOW_HANDOFF_MISSING', 'shadow.canonicalHandoffs', null, minimumRequiredCount),
    drift: evidence('MISSING_EVIDENCE', 'CANONICAL_DRIFT_HANDOFF_MISSING', 'shadow.canonicalHandoffs'),
  };
  const handoffs: Record<string, unknown>[] = [];
  for (const wrapper of wrappers) {
    const handoff = record(wrapper.handoff);
    const identity = record(handoff?.strategyIdentity);
    const model = record(handoff?.modelIdentity);
    const modelDataset = record(model?.datasetIdentity);
    const reference = record(handoff?.datasetReferenceIdentity);
    const freshness = record(handoff?.freshness);
    if (!handoff || handoff.schemaVersion !== CANONICAL_SHADOW_HEALTH_SCHEMA || handoff.executionAuthority !== 'NONE'
        || typeof handoff.evidenceDigest !== 'string' || !HASH_64.test(handoff.evidenceDigest)
        || !identity || typeof handoff.strategyIdentityDigest !== 'string' || !HASH_64.test(handoff.strategyIdentityDigest)
        || !model || typeof handoff.modelIdentityDigest !== 'string' || !HASH_64.test(handoff.modelIdentityDigest)
        || model.strategyIdentityDigest !== handoff.strategyIdentityDigest
        || !modelDataset || !reference || modelDataset.datasetId !== reference.datasetId || modelDataset.datasetDigest !== reference.datasetDigest
        || optionalCount(handoff.sampleN) === null || optionalCount(handoff.referenceN) === null
        || freshness?.status !== 'FRESH' || typeof freshness.expiresAt !== 'string' || !Number.isFinite(Date.parse(freshness.expiresAt))) {
      return {
        quality: evidence('MISSING_EVIDENCE', 'CANONICAL_SHADOW_IDENTITY_OR_PROVENANCE_INVALID', 'shadow.canonicalHandoffs', null, minimumRequiredCount),
        drift: evidence('MISSING_EVIDENCE', 'CANONICAL_DRIFT_IDENTITY_OR_PROVENANCE_INVALID', 'shadow.canonicalHandoffs'),
      };
    }
    const body = { ...handoff };
    delete body.evidenceDigest;
    if (canonicalDigest(body) !== handoff.evidenceDigest || Date.parse(freshness.expiresAt) <= Date.now()) {
      return {
        quality: evidence('MISSING_EVIDENCE', 'CANONICAL_SHADOW_DIGEST_OR_FRESHNESS_INVALID', 'shadow.canonicalHandoffs', null, minimumRequiredCount),
        drift: evidence('MISSING_EVIDENCE', 'CANONICAL_DRIFT_DIGEST_OR_FRESHNESS_INVALID', 'shadow.canonicalHandoffs'),
      };
    }
    handoffs.push(handoff);
  }
  const pairKeys = handoffs.map((handoff) => `${handoff.strategyIdentityDigest}:${handoff.modelIdentityDigest}`);
  if (new Set(pairKeys).size !== pairKeys.length) return {
    quality: evidence('MISSING_EVIDENCE', 'DUPLICATE_CANONICAL_SHADOW_HANDOFF', 'shadow.canonicalHandoffs', null, minimumRequiredCount),
    drift: evidence('MISSING_EVIDENCE', 'DUPLICATE_CANONICAL_DRIFT_HANDOFF', 'shadow.canonicalHandoffs'),
  };

  const qualities = handoffs.map((handoff) => record(handoff.directionalQuality));
  const qualityCounts = qualities.map((quality) => optionalCount(quality?.settledN));
  const qualityComplete = qualities.every((quality, index) => quality && (qualityCounts[index] ?? 0) > 0
    && ['bullRecall', 'bearRecall', 'macroF1', 'balancedAccuracy'].every((field) => typeof quality[field] === 'number' && Number.isFinite(quality[field]))
    && ['bullish', 'neutral', 'bearish'].every((name) => typeof record(quality.perClass)?.[name] === 'object'
      && typeof record(record(quality.perClass)?.[name])?.recall === 'number'));
  const observed = qualityCounts.every((count) => count !== null) ? qualityCounts.reduce((sum, count) => sum + (count ?? 0), 0) : null;
  const quality = minimumRequiredCount === null
    ? evidence('MISSING_EVIDENCE', 'CANONICAL_MINIMUM_SAMPLE_POLICY_MISSING', 'canonicalStrategyHealth.policy', observed)
    : !qualityComplete
      ? evidence('MISSING_EVIDENCE', 'CANONICAL_SHADOW_SETTLED_DIRECTIONAL_QUALITY_MISSING', 'shadow.canonicalHandoffs', observed, minimumRequiredCount)
      : observed === null || observed < minimumRequiredCount
        ? evidence('MISSING_EVIDENCE', 'CANONICAL_SHADOW_MINIMUM_SAMPLE_DEFICIT', 'shadow.canonicalHandoffs', observed, minimumRequiredCount)
        : qualities.some((row) => row?.bullRecall === 0 || row?.bearRecall === 0)
          ? evidence('FAIL', 'CANONICAL_SHADOW_DIRECTIONAL_RECALL_ZERO', 'shadow.canonicalHandoffs', observed, minimumRequiredCount)
          : evidence('HEALTHY', 'CANONICAL_SHADOW_DIRECTIONAL_QUALITY_VALID', 'shadow.canonicalHandoffs', observed, minimumRequiredCount);

  const driftStatuses = handoffs.map((handoff) => normalizedStatus(record(handoff.driftVerdict)?.status).toUpperCase());
  const drift = driftStatuses.some((status) => status === 'BRAKE')
    ? evidence('FAIL', 'CANONICAL_DRIFT_BRAKE', 'shadow.canonicalHandoffs', handoffs.length)
    : driftStatuses.some((status) => status === 'NOT_EVALUABLE' || !status)
      ? evidence('MISSING_EVIDENCE', 'CANONICAL_DRIFT_NOT_EVALUABLE', 'shadow.canonicalHandoffs', handoffs.length)
      : driftStatuses.some((status) => status === 'WATCH')
        ? evidence('WATCH', 'CANONICAL_DRIFT_WATCH', 'shadow.canonicalHandoffs', handoffs.length)
        : driftStatuses.every((status) => status === 'STABLE')
          ? evidence('HEALTHY', 'CANONICAL_DRIFT_STABLE', 'shadow.canonicalHandoffs', handoffs.length)
          : evidence('MISSING_EVIDENCE', 'CANONICAL_DRIFT_STATUS_INVALID', 'shadow.canonicalHandoffs', handoffs.length);
  return { quality, drift };
}

function naturalPaperEvidence(
  overview: Record<string, unknown>,
  minimumRequiredCount: number | null,
): ResearchStrategyHealthEvidence {
  const ledger = record(record(overview.paper)?.ledger);
  const cycleCount = optionalCount(ledger?.cycleCount);
  const sampleCount = optionalCount(ledger?.sampleCount);
  if (!ledger || ledger.present !== true || cycleCount === null || sampleCount === null) {
    return evidence('MISSING_EVIDENCE', 'NATURAL_PAPER_LEDGER_MISSING', 'paper.ledger', sampleCount, minimumRequiredCount);
  }
  if (minimumRequiredCount === null) {
    return evidence('MISSING_EVIDENCE', 'CANONICAL_MINIMUM_SAMPLE_POLICY_MISSING', 'canonicalStrategyHealth.policy', sampleCount);
  }
  if (cycleCount === 0) return evidence('MISSING_EVIDENCE', 'NATURAL_CYCLE_MISSING', 'paper.ledger', sampleCount, minimumRequiredCount);
  if (sampleCount < minimumRequiredCount) {
    return evidence('MISSING_EVIDENCE', 'NATURAL_SAMPLE_MINIMUM_DEFICIT', 'paper.ledger', sampleCount, minimumRequiredCount);
  }
  return evidence('HEALTHY', 'NATURAL_SAMPLE_PRESENT', 'paper.ledger', sampleCount, minimumRequiredCount);
}

function settlementEvidence(
  overview: Record<string, unknown>,
  minimumRequiredCount: number | null,
): ResearchStrategyHealthEvidence {
  const ledger = record(record(overview.paper)?.ledger);
  const settlementCount = optionalCount(ledger?.settlementCount);
  if (!ledger || ledger.present !== true || settlementCount === null) {
    return evidence('MISSING_EVIDENCE', 'SETTLEMENT_LEDGER_MISSING', 'paper.ledger', settlementCount, minimumRequiredCount);
  }
  if (minimumRequiredCount === null) {
    return evidence('MISSING_EVIDENCE', 'CANONICAL_MINIMUM_SAMPLE_POLICY_MISSING', 'canonicalStrategyHealth.policy', settlementCount);
  }
  if (settlementCount < minimumRequiredCount) {
    return evidence('MISSING_EVIDENCE', 'NATURAL_SETTLEMENT_MINIMUM_DEFICIT', 'paper.ledger', settlementCount, minimumRequiredCount);
  }
  return evidence('HEALTHY', 'NATURAL_SETTLEMENT_PRESENT', 'paper.ledger', settlementCount, minimumRequiredCount);
}

function profitabilityEvidence(overview: Record<string, unknown>): ResearchStrategyHealthEvidence {
  return record(overview.profitability)?.proven === true
    ? evidence('HEALTHY', 'CANONICAL_PROFITABILITY_PROVEN', 'profitability')
    : evidence('MISSING_EVIDENCE', 'PROFITABILITY_NOT_PROVEN', 'profitability');
}

function safetyEvidence(overview: Record<string, unknown>): ResearchStrategyHealthEvidence {
  const safety = record(overview.safety);
  const runtime = record(record(overview.paper)?.runtime);
  if (safety?.forbiddenAuthorityObserved === true) {
    return evidence('FAIL', 'FORBIDDEN_AUTHORITY_OBSERVED', 'safety');
  }
  if (runtime?.present === true && runtime.safetyEvidenceComplete === true && safety?.authorityEvidenceComplete === true) {
    return evidence('HEALTHY', 'READ_ONLY_AUTHORITY_EVIDENCE_COMPLETE', 'safety');
  }
  return evidence('MISSING_EVIDENCE', 'SAFETY_EVIDENCE_INCOMPLETE', 'safety');
}

function championEvidence(overview: Record<string, unknown>): ResearchStrategyHealthEvidence {
  const identity = record(record(overview.champion)?.currentValidatedChampion);
  return identity && typeof identity.strategyId === 'string' && identity.strategyId.trim()
    ? evidence('HEALTHY', 'CURRENT_VALIDATED_CHAMPION_PRESENT', 'champion')
    : evidence('MISSING_EVIDENCE', 'CURRENT_VALIDATED_CHAMPION_NONE', 'champion');
}

export function bindCanonicalStrategyHealth(overviewValue: unknown): ResearchStrategyHealthBinding {
  const overview = record(overviewValue) ?? {};
  const cycles = records(record(overview.research)?.cycles);
  const minimumRequiredCount = canonicalMinimumSampleSize(overview);
  const canonical = canonicalCoreEvidence(overview);
  const shadow = canonicalShadowDriftEvidence(overview, minimumRequiredCount);
  const inputs = Object.freeze({
    canonicalCore: canonical.row,
    backtest: backtestEvidence(cycles),
    oos: taskEvidence(cycles, [/\boos\b/i, /out[-_ ]?of[-_ ]?sample/i]),
    walkForward: taskEvidence(cycles, [/purged.*walk/i, /walk[-_ ]?forward/i]),
    holdout: taskEvidence(cycles, [/final[-_ ]?holdout/i, /holdout/i]),
    shadowQuality: shadow.quality,
    drift: shadow.drift,
    naturalPaper: naturalPaperEvidence(overview, minimumRequiredCount),
    settlement: settlementEvidence(overview, minimumRequiredCount),
    profitability: profitabilityEvidence(overview),
    safety: safetyEvidence(overview),
    champion: championEvidence(overview),
  });
  const rows = Object.entries(inputs);
  const status: ResearchStrategyHealthStatus = rows.some(([, row]) => row.status === 'FAIL')
    ? 'FAIL'
    : rows.some(([, row]) => row.status === 'MISSING_EVIDENCE')
      ? 'MISSING_EVIDENCE'
      : rows.some(([, row]) => row.status === 'WATCH')
        ? 'WATCH'
        : 'HEALTHY';
  return Object.freeze({
    status,
    evaluator: 'strategy-health-observatory.service/evaluateStrategyHealth',
    canonicalCoreStatus: canonical.result?.status ?? null,
    inputs,
    reasons: Object.freeze(rows.filter(([, row]) => row.status !== 'HEALTHY').map(([key, row]) => `${key}:${row.reason}`)),
    executionAuthority: 'NONE',
  });
}
