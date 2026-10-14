import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyLongHistoryForOperationalTransitionV2,
  evaluateResearchAiOperationalTransitionV2,
} from '../src/research-ai-operational-transition-v2.mjs';

const TARGET = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const OBSERVED_AT = '2026-10-14T03:00:00.000Z';

function naturalCycle(overrides = {}) {
  return {
    schemaVersion: 2,
    contract: 'autonomous-research-cycle/v2',
    status: 'COMPLETE',
    observedAt: OBSERVED_AT,
    researchCodeSha: TARGET,
    directiveConsumed: true,
    discoveryStatus: 'DOSSIER_STAGED',
    actualProviderCalls: { attempted: 2, succeeded: 2, failed: 0 },
    actualSourceFetches: { attempted: 3, succeeded: 3, failed: 0 },
    selectedNextStrategy: {
      repository: 'https://github.com/example/public-strategy',
      sourcePath: 'strategy.py',
      sourceRevision: 'c'.repeat(40),
      family: 'PARTICIPATION_BREAKOUT',
      templateId: 'RVOL_BREAKOUT_V1',
    },
    stagedDossierDigest: 'd'.repeat(64),
    formulaGeneratedCount: 1,
    actualBacktestCount: 1,
    safety: { executionAuthority: 'NONE', liveTrading: false, privateTradingApi: false, realOrder: false },
    ...overrides,
  };
}

function discoveryEvidence(overrides = {}) {
  return {
    schemaVersion: 2,
    contract: 'autonomous-research-discovery/v2',
    status: 'DOSSIER_STAGED',
    researchCodeSha: TARGET,
    directiveConsumed: true,
    actualProviderCalls: { attempted: 2, succeeded: 2, failed: 0 },
    actualSourceFetches: { attempted: 3, succeeded: 3, failed: 0 },
    stagedDossierDigest: 'd'.repeat(64),
    ...overrides,
  };
}

test('pretransition proof requires the real directive-to-source-to-formula-to-backtest path', () => {
  const result = evaluateResearchAiOperationalTransitionV2({
    targetSha: TARGET,
    startedAtMs: Date.parse(OBSERVED_AT) - 1,
    autonomousCycle: naturalCycle(),
    autonomousDiscovery: discoveryEvidence(),
    longHistory: {
      schemaVersion: 'research-production-cycle-v1', profile: 'long-history', researchSha: OLD, status: 'complete',
    },
    video: {
      schemaVersion: 'research-video-discovery-scan-v1', status: 'COMPLETE', sourceCount: 0,
      query: 'crypto strategy', queryIndex: 3, queryCount: 8, nextQueryIndex: 4,
      requestOrder: 'date', publishedAfter: '2026-09-14T03:00:00.000Z', publishedAfterHours: 720,
      zeroResultReason: 'ACTIVE_QUERY_AND_FILTERS_RETURNED_NO_PUBLIC_VIDEO',
    },
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.actualNaturalCycle.status, 'NATURAL_CYCLE_PROVEN');
  assert.equal(result.actualNaturalCycle.actualBacktestCount, 1);
  assert.equal(result.longHistory.state, 'STALE_RELEASE_EVIDENCE_PRESERVED');
  assert.equal(result.longHistory.historicalCompletionPreserved, true);
  assert.equal(result.longHistory.treatedAsFailure, false);
  assert.equal(result.youtube.state, 'PROVIDER_SUCCESS_ZERO_RESULTS');
  assert.equal(result.youtube.providerFailure, false);
  assert.equal(result.executionAuthority, 'NONE');
});

test('waiting, partial, cached-only or formula-less cycles cannot prove a new natural cycle', () => {
  for (const cycle of [
    naturalCycle({ status: 'PARTIAL_AI_DISCOVERY_UNAVAILABLE' }),
    naturalCycle({ discoveryStatus: 'ALREADY_DISCOVERED', actualProviderCalls: { attempted: 1, succeeded: 1, failed: 0 },
      actualSourceFetches: { attempted: 0, succeeded: 0, failed: 0 } }),
    naturalCycle({ formulaGeneratedCount: 0 }),
    naturalCycle({ actualBacktestCount: 0 }),
  ]) {
    assert.throws(() => evaluateResearchAiOperationalTransitionV2({
      targetSha: TARGET,
      startedAtMs: Date.parse(OBSERVED_AT) - 1,
      autonomousCycle: cycle,
      autonomousDiscovery: discoveryEvidence(),
    }), /AUTONOMOUS_V2_/u);
  }
});

test('an exact-SHA restart may finish a staged dossier without repeating provider or source calls', () => {
  const result = evaluateResearchAiOperationalTransitionV2({
    targetSha: TARGET,
    startedAtMs: Date.parse(OBSERVED_AT) - 1,
    autonomousCycle: naturalCycle({
      discoveryStatus: 'ALREADY_DISCOVERED',
      actualProviderCalls: { attempted: 0, succeeded: 0, failed: 0 },
      actualSourceFetches: { attempted: 0, succeeded: 0, failed: 0 },
    }),
    autonomousDiscovery: discoveryEvidence(),
  });
  assert.equal(result.actualNaturalCycle.status, 'NATURAL_CYCLE_PROVEN');
  assert.equal(result.actualNaturalCycle.discoveryExecution, 'RESUMED_EXACT_SHA');
});

test('current and stale long-history evidence remain distinct without rewriting historical status', () => {
  const current = classifyLongHistoryForOperationalTransitionV2({
    targetSha: TARGET,
    longHistory: { schemaVersion: 'research-production-cycle-v1', profile: 'long-history', researchSha: TARGET, status: 'complete' },
  });
  const stale = classifyLongHistoryForOperationalTransitionV2({
    targetSha: TARGET,
    longHistory: { schemaVersion: 'research-production-cycle-v1', profile: 'long-history', researchSha: OLD, status: 'complete' },
  });
  assert.equal(current.state, 'CURRENT_SHA_EVIDENCE');
  assert.equal(current.refreshRequired, false);
  assert.equal(stale.state, 'STALE_RELEASE_EVIDENCE_PRESERVED');
  assert.equal(stale.sourceStatus, 'complete');
  assert.equal(stale.refreshService, 'research-production@long-history.service');
  assert.equal(stale.refreshTimer, 'research-production-long-history.timer');
  assert.equal(stale.treatedAsFailure, false);
});
