import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { bindCanonicalStrategyHealth } from './strategy-health-research-adapter.service';

const policy = {
  version: 'STRATEGY_HEALTH_V1',
  minimumSampleSize: 30,
  watch: { expectedValueBelow: 0.15, profitFactorBelow: 1.2, maxDrawdownAtOrAbove: 12, hitRateGapAtOrBelow: -5 },
  degraded: { expectedValueBelow: 0.05, profitFactorBelow: 1, maxDrawdownAtOrAbove: 20, hitRateGapAtOrBelow: -10 },
  critical: { expectedValueBelow: 0, profitFactorBelow: 0.8, maxDrawdownAtOrAbove: 30, hitRateGapAtOrBelow: -20 },
};

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(canonical);
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(source).sort().map((key) => [key, canonical(source[key])]));
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function canonicalShadowHandoff({ driftStatus = 'STABLE', bullRecall = 0.6, bearRecall = 0.5, settledN = 40 } = {}) {
  const strategyIdentityDigest = 'a'.repeat(64);
  const modelIdentityDigest = 'b'.repeat(64);
  const quality = {
    sampleN: 50,
    settledN,
    bullRecall,
    bearRecall,
    macroF1: 0.55,
    balancedAccuracy: 0.58,
    perClass: {
      bullish: { recall: bullRecall },
      neutral: { recall: 0.54 },
      bearish: { recall: bearRecall },
    },
  };
  const body = {
    schemaVersion: 'prediction-lab-strategy-health-shadow-handoff-v1',
    strategyIdentity: { strategyId: 'strategy-v1' },
    strategyIdentityDigest,
    modelIdentity: {
      strategyIdentityDigest,
      datasetIdentity: { datasetId: 'dataset-v1', datasetDigest: 'c'.repeat(64) },
    },
    modelIdentityDigest,
    datasetReferenceIdentity: { datasetId: 'dataset-v1', datasetDigest: 'c'.repeat(64) },
    directionalQuality: quality,
    ruleOnlyQuality: quality,
    modelOnlyQuality: quality,
    blendQuality: quality,
    driftVerdict: { status: driftStatus },
    driftMetrics: [],
    sampleN: 50,
    referenceN: 100,
    freshness: { status: 'FRESH', checkedAt: '2026-08-26T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' },
    missingEvidence: driftStatus === 'NOT_EVALUABLE' ? ['CANONICAL_DRIFT_POLICY_MISSING'] : [],
    executionAuthority: 'NONE',
  };
  return { ...body, evidenceDigest: digest(body) };
}

function overview(overrides: Record<string, unknown> = {}) {
  return {
    canonicalStrategyHealth: {
      input: {
        strategyId: 'CRYPTO_FUTURES_SCALP_V1_LONG', strategyVersion: 'V1', sampleSize: 60,
        expectedValue: 0.3, profitFactor: 1.5, maxDrawdownPercent: 8,
        paperVsBacktestHitRateGap: -1, shadowVsBacktestHitRateGap: -2, liveVsBacktestHitRateGap: null,
      },
      policy,
    },
    safety: { authorityEvidenceComplete: true, forbiddenAuthorityObserved: false },
    research: {
      cycles: [
        { profile: 'fast-historical', present: true, status: 'complete', failedCount: 0, tasks: [] },
        {
          profile: 'forward', present: true, status: 'complete', failedCount: 0,
          tasks: [
            { id: 'oos', status: 'success' },
            { id: 'purged-walk-forward', status: 'success' },
            { id: 'final-holdout', status: 'success' },
            { id: 'drift', status: 'success' },
          ],
        },
      ],
    },
    paper: {
      runtime: { present: true, safetyEvidenceComplete: true },
      ledger: { present: true, cycleCount: 2, sampleCount: 60, positionCount: 1, settlementCount: 30 },
    },
    shadow: {
      groups: [{
        name: '15m', collapsed: false, macroF1: 0.55, balancedAccuracy: 0.58,
        bullRecall: 0.6, bearRecall: 0.5, neutralRecall: 0.54,
      }],
      canonicalHandoffs: [{ group: '15m', handoff: canonicalShadowHandoff() }],
    },
    profitability: { proven: true },
    champion: { currentValidatedChampion: { strategyId: 'CRYPTO_FUTURES_SCALP_V1_LONG', strategyVersion: 'V1' } },
    ...overrides,
  };
}

test('runtime adapter directly exposes the canonical Strategy Health core result', () => {
  const healthy = bindCanonicalStrategyHealth(overview());
  assert.equal(healthy.status, 'HEALTHY');
  assert.equal(healthy.canonicalCoreStatus, 'HEALTHY');
  assert.equal(healthy.inputs.canonicalCore.source, 'strategy-health-observatory.service/evaluateStrategyHealth');
  assert.equal(healthy.inputs.canonicalCore.observedCount, 60);
  assert.equal(healthy.executionAuthority, 'NONE');

  const watch = bindCanonicalStrategyHealth(overview({
    canonicalStrategyHealth: {
      input: { ...overview().canonicalStrategyHealth.input, expectedValue: 0.1 },
      policy,
    },
  }));
  assert.equal(watch.status, 'WATCH');
  assert.equal(watch.canonicalCoreStatus, 'WATCH');
});

test('missing canonical input stays MISSING_EVIDENCE without a fabricated zero or PASS', () => {
  const result = bindCanonicalStrategyHealth(overview({
    canonicalStrategyHealth: undefined,
    paper: {
      runtime: { present: true, safetyEvidenceComplete: true },
      ledger: { present: true, cycleCount: null, sampleCount: null, positionCount: null, settlementCount: null },
    },
  }));
  assert.equal(result.status, 'MISSING_EVIDENCE');
  assert.equal(result.canonicalCoreStatus, null);
  assert.equal(result.inputs.canonicalCore.observedCount, null);
  assert.equal(result.inputs.naturalPaper.observedCount, null);
  assert.notEqual(result.status, 'HEALTHY');
});

test('Shadow directional collapse propagates FAIL through the canonical adapter', () => {
  const handoff = canonicalShadowHandoff({ bearRecall: 0 });
  const result = bindCanonicalStrategyHealth(overview({
    shadow: {
      groups: [],
      canonicalHandoffs: [{ group: '15m', handoff }],
    },
  }));
  assert.equal(result.status, 'FAIL');
  assert.equal(result.inputs.shadowQuality.status, 'FAIL');
  assert.ok(result.reasons.includes('shadowQuality:CANONICAL_SHADOW_DIRECTIONAL_RECALL_ZERO'));
});

test('canonical Shadow drift STABLE WATCH BRAKE and NOT_EVALUABLE map without inventing thresholds', () => {
  const cases = [
    ['STABLE', 'HEALTHY', 'HEALTHY'],
    ['WATCH', 'WATCH', 'WATCH'],
    ['BRAKE', 'FAIL', 'FAIL'],
    ['NOT_EVALUABLE', 'MISSING_EVIDENCE', 'MISSING_EVIDENCE'],
  ] as const;
  for (const [driftStatus, driftEvidenceStatus, overall] of cases) {
    const result = bindCanonicalStrategyHealth(overview({
      shadow: { groups: [], canonicalHandoffs: [{ group: '15m', handoff: canonicalShadowHandoff({ driftStatus }) }] },
    }));
    assert.equal(result.inputs.drift.status, driftEvidenceStatus);
    assert.equal(result.status, overall);
  }
});

test('missing, tampered, unsettled, or stale canonical handoff never falls back to legacy Shadow PASS', () => {
  const missing = bindCanonicalStrategyHealth(overview({ shadow: { groups: overview().shadow.groups, canonicalHandoffs: [] } }));
  assert.equal(missing.inputs.shadowQuality.status, 'MISSING_EVIDENCE');
  assert.equal(missing.inputs.drift.status, 'MISSING_EVIDENCE');

  const tampered = canonicalShadowHandoff();
  tampered.directionalQuality.bearRecall = 0.9;
  const tamperedResult = bindCanonicalStrategyHealth(overview({ shadow: { groups: [], canonicalHandoffs: [{ group: '15m', handoff: tampered }] } }));
  assert.equal(tamperedResult.inputs.shadowQuality.reason, 'CANONICAL_SHADOW_DIGEST_OR_FRESHNESS_INVALID');

  const unsettled = canonicalShadowHandoff({ settledN: 0 });
  const unsettledResult = bindCanonicalStrategyHealth(overview({ shadow: { groups: [], canonicalHandoffs: [{ group: '15m', handoff: unsettled }] } }));
  assert.equal(unsettledResult.inputs.shadowQuality.reason, 'CANONICAL_SHADOW_SETTLED_DIRECTIONAL_QUALITY_MISSING');
});

test('forward evidence reuses canonical minimum sample policy and exposes exact deficits', () => {
  const result = bindCanonicalStrategyHealth(overview({
    shadow: { groups: [], canonicalHandoffs: [{ group: '15m', handoff: canonicalShadowHandoff({ settledN: 2 }) }] },
    paper: {
      runtime: { present: true, safetyEvidenceComplete: true },
      ledger: { present: true, cycleCount: 1, sampleCount: 1, positionCount: 1, settlementCount: 0 },
    },
  }));

  assert.equal(result.status, 'MISSING_EVIDENCE');
  assert.equal(result.inputs.shadowQuality.reason, 'CANONICAL_SHADOW_MINIMUM_SAMPLE_DEFICIT');
  assert.equal(result.inputs.shadowQuality.observedCount, 2);
  assert.equal(result.inputs.shadowQuality.minimumRequiredCount, 30);
  assert.equal(result.inputs.shadowQuality.deficitCount, 28);

  assert.equal(result.inputs.naturalPaper.reason, 'NATURAL_SAMPLE_MINIMUM_DEFICIT');
  assert.equal(result.inputs.naturalPaper.observedCount, 1);
  assert.equal(result.inputs.naturalPaper.minimumRequiredCount, 30);
  assert.equal(result.inputs.naturalPaper.deficitCount, 29);

  assert.equal(result.inputs.settlement.reason, 'NATURAL_SETTLEMENT_MINIMUM_DEFICIT');
  assert.equal(result.inputs.settlement.observedCount, 0);
  assert.equal(result.inputs.settlement.minimumRequiredCount, 30);
  assert.equal(result.inputs.settlement.deficitCount, 30);
});

test('forward evidence becomes healthy only after the canonical minimum is actually reached', () => {
  const result = bindCanonicalStrategyHealth(overview({
    shadow: { groups: [], canonicalHandoffs: [{ group: '15m', handoff: canonicalShadowHandoff({ settledN: 30 }) }] },
    paper: {
      runtime: { present: true, safetyEvidenceComplete: true },
      ledger: { present: true, cycleCount: 2, sampleCount: 30, positionCount: 1, settlementCount: 30 },
    },
  }));

  assert.equal(result.status, 'HEALTHY');
  assert.equal(result.inputs.shadowQuality.deficitCount, 0);
  assert.equal(result.inputs.naturalPaper.deficitCount, 0);
  assert.equal(result.inputs.settlement.deficitCount, 0);
});

test('profitability false and Champion NONE remain explicit missing evidence', () => {
  const profitability = bindCanonicalStrategyHealth(overview({ profitability: { proven: false } }));
  assert.equal(profitability.status, 'MISSING_EVIDENCE');
  assert.equal(profitability.inputs.profitability.reason, 'PROFITABILITY_NOT_PROVEN');

  const champion = bindCanonicalStrategyHealth(overview({ champion: { currentValidatedChampion: null } }));
  assert.equal(champion.status, 'MISSING_EVIDENCE');
  assert.equal(champion.inputs.champion.reason, 'CURRENT_VALIDATED_CHAMPION_NONE');
});

test('canonical DEGRADED and CRITICAL statuses map to FAIL without new policy thresholds', () => {
  for (const expectedValue of [0.01, -0.1]) {
    const result = bindCanonicalStrategyHealth(overview({
      canonicalStrategyHealth: {
        input: { ...overview().canonicalStrategyHealth.input, expectedValue },
        policy,
      },
    }));
    assert.equal(result.status, 'FAIL');
    assert.ok(['DEGRADED', 'CRITICAL'].includes(result.canonicalCoreStatus ?? ''));
  }
});
