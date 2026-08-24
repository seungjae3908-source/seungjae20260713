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

function normalizedStatus(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function evidence(
  status: ResearchStrategyHealthStatus,
  reason: string,
  source: string,
  observedCount: number | null = null,
): ResearchStrategyHealthEvidence {
  return Object.freeze({ status, reason, source, observedCount });
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

function shadowQualityEvidence(overview: Record<string, unknown>): ResearchStrategyHealthEvidence {
  const shadow = record(overview.shadow);
  const groups = records(shadow?.groups);
  if (!groups.length) return evidence('MISSING_EVIDENCE', 'SHADOW_QUALITY_MISSING', 'shadow.groups');
  const complete = groups.every((group) => [
    group.macroF1,
    group.balancedAccuracy,
    group.bullRecall,
    group.bearRecall,
    group.neutralRecall,
  ].every((value) => typeof value === 'number' && Number.isFinite(value)) && typeof group.collapsed === 'boolean');
  if (!complete) return evidence('MISSING_EVIDENCE', 'SHADOW_DIRECTIONAL_METRICS_MISSING', 'shadow.groups', groups.length);
  if (groups.some((group) => group.collapsed === true || group.bullRecall === 0 || group.bearRecall === 0)) {
    return evidence('FAIL', 'SHADOW_DIRECTIONAL_RECALL_ZERO_OR_COLLAPSED', 'shadow.groups', groups.length);
  }
  return evidence('HEALTHY', 'SHADOW_DIRECTIONAL_METRICS_PRESENT', 'shadow.groups', groups.length);
}

function naturalPaperEvidence(overview: Record<string, unknown>): ResearchStrategyHealthEvidence {
  const ledger = record(record(overview.paper)?.ledger);
  const cycleCount = optionalCount(ledger?.cycleCount);
  const sampleCount = optionalCount(ledger?.sampleCount);
  if (!ledger || ledger.present !== true || cycleCount === null || sampleCount === null) {
    return evidence('MISSING_EVIDENCE', 'NATURAL_PAPER_LEDGER_MISSING', 'paper.ledger');
  }
  if (cycleCount === 0) return evidence('MISSING_EVIDENCE', 'NATURAL_CYCLE_MISSING', 'paper.ledger', 0);
  if (sampleCount === 0) return evidence('WATCH', 'NATURAL_SAMPLE_ZERO', 'paper.ledger', 0);
  return evidence('HEALTHY', 'NATURAL_SAMPLE_PRESENT', 'paper.ledger', sampleCount);
}

function settlementEvidence(overview: Record<string, unknown>): ResearchStrategyHealthEvidence {
  const ledger = record(record(overview.paper)?.ledger);
  const settlementCount = optionalCount(ledger?.settlementCount);
  if (!ledger || ledger.present !== true || settlementCount === null) {
    return evidence('MISSING_EVIDENCE', 'SETTLEMENT_LEDGER_MISSING', 'paper.ledger');
  }
  if (settlementCount === 0) return evidence('MISSING_EVIDENCE', 'NATURAL_SETTLEMENT_MISSING', 'paper.ledger', 0);
  return evidence('HEALTHY', 'NATURAL_SETTLEMENT_PRESENT', 'paper.ledger', settlementCount);
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
  const canonical = canonicalCoreEvidence(overview);
  const inputs = Object.freeze({
    canonicalCore: canonical.row,
    backtest: backtestEvidence(cycles),
    oos: taskEvidence(cycles, [/\boos\b/i, /out[-_ ]?of[-_ ]?sample/i]),
    walkForward: taskEvidence(cycles, [/purged.*walk/i, /walk[-_ ]?forward/i]),
    holdout: taskEvidence(cycles, [/final[-_ ]?holdout/i, /holdout/i]),
    shadowQuality: shadowQualityEvidence(overview),
    drift: taskEvidence(cycles, [/drift/i]),
    naturalPaper: naturalPaperEvidence(overview),
    settlement: settlementEvidence(overview),
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
