import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESEARCH_CENTER_READONLY_CONTRACT,
  sanitizeResearchCenterOverview,
} from './research-center-readonly-contract.service.ts';

const SHA = '1111111111111111111111111111111111111111';

function liquidityIndependence() {
  return {
    present: true,
    status: 'PRESENT',
    schemaVersion: 'public-forward-liquidity-v3-authoritative-independence-summary-v1',
    producerSha: SHA,
    upstreamIngestRunId: '33935833024',
    upstreamIngestArtifactId: '9960130145',
    upstreamIngestArtifactDigest: '2'.repeat(64),
    sourceInventoryDigest: '3'.repeat(64),
    targetSlotIndex: 48,
    genuineScheduledSlotN: 15,
    rawAcceptedN: 335,
    effectiveIndependentN: 15,
    independentBuyN: 10,
    independentSellN: 5,
    independenceAuditDigest: '4'.repeat(64),
    independentSplitSourceDigest: '5'.repeat(64),
    v3IndependentSplitIndexDigest: '6'.repeat(64),
    frozenSplitCounts: {
      TRAIN: 15,
      TRAIN_BUY: 10,
      TRAIN_SELL: 5,
      VALIDATION: 0,
      VALIDATION_BUY: 0,
      VALIDATION_SELL: 0,
      OOS: 0,
      OOS_BUY: 0,
      OOS_SELL: 0,
    },
    oosOutcomeCredit: 0,
    calibrationArtifactProduced: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    evidenceComplete: 0,
    executionAuthority: 'NONE',
    reportDigest: '7'.repeat(64),
  };
}

function validOverview() {
  return {
    schemaVersion: 'research-dashboard-overview-v1',
    generatedAt: 1_800_000_000_000,
    state: { present: true, latestCycleAt: 1_799_999_999_000 },
    safety: {
      readOnlyDashboard: true,
      liveTrading: false,
      privateApi: false,
      orderAuthority: false,
      authorityEvidenceComplete: true,
      forbiddenAuthorityObserved: false,
    },
    research: {
      status: 'collecting',
      failedTasks: 0,
      blockedDataTasks: 0,
      cycles: [{
        profile: 'forward',
        present: true,
        status: 'success',
        cycleId: 'cycle-1',
        researchSha: SHA,
        generatedAt: 1_799_999_999_000,
        concurrency: 1,
        taskCount: 1,
        successCount: 1,
        blockedDataCount: 0,
        failedCount: 0,
        tasks: [{ id: 'canonical-task', status: 'success', durationMs: 15, startedAt: null, endedAt: null, timedOut: false }],
      }],
      liquidityIndependence: liquidityIndependence(),
    },
    paper: {
      runtime: {
        present: true,
        status: 'not_started',
        cycleId: null,
        scheduleActive: false,
        allProvidersReady: null,
        publicForwardEvidenceAccumulating: null,
        paperTradeOutcomeAccumulating: null,
        privateRequestCount: 0,
        financialMutationCount: 0,
        orderCount: 0,
        liveTrading: false,
        orderAuthority: false,
        safetyEvidenceComplete: true,
        lanes: [],
      },
      ledger: { present: true, cycleCount: 1, sampleCount: 0, positionCount: 0, settlementCount: 0 },
    },
    shadow: {
      groups: [],
      records: { present: false, totalRecords: null, settledRecords: null, pendingRecords: null },
    },
    profitability: { proven: false, status: 'evidence_collection', note: 'Evidence only.' },
  };
}

test('Research Center contract publishes a GET-only, authority-free allowlisted DTO', () => {
  const input = validOverview();
  Object.assign(input, {
    accessToken: 'ghp_should-never-leak',
    stateRoot: '/var/lib/private-research',
    accountId: 'private-account-id',
  });
  Object.assign(input.paper.runtime, { credential: 'secret', publisherAccount: 'private' });
  Object.assign(input.research.liquidityIndependence, {
    artifactDownloadUrl: 'https://example.test/private-artifact',
    statePath: '/var/lib/private-research/v3.json',
  });
  const result = sanitizeResearchCenterOverview(input);
  assert.ok(result);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('ghp_should-never-leak'), false);
  assert.equal(serialized.includes('/var/lib/private-research'), false);
  assert.equal(serialized.includes('private-account-id'), false);
  assert.equal(serialized.includes('credential'), false);
  assert.equal(serialized.includes('artifactDownloadUrl'), false);
  const research = result.research as { liquidityIndependence: { effectiveIndependentN: number; independentBuyN: number; independentSellN: number } };
  assert.equal(research.liquidityIndependence.effectiveIndependentN, 15);
  assert.equal(research.liquidityIndependence.independentBuyN, 10);
  assert.equal(research.liquidityIndependence.independentSellN, 5);
  assert.deepEqual(RESEARCH_CENTER_READONLY_CONTRACT.methods, ['GET']);
  assert.equal(RESEARCH_CENTER_READONLY_CONTRACT.executionAuthority, 'NONE');
});

test('older dashboard payloads without independence evidence remain backward-compatible and missing', () => {
  const input = validOverview();
  delete (input.research as { liquidityIndependence?: unknown }).liquidityIndependence;
  const result = sanitizeResearchCenterOverview(input)!;
  const research = result.research as { liquidityIndependence: { status: string; present: boolean; effectiveIndependentN: number | null } };
  assert.equal(research.liquidityIndependence.status, 'MISSING');
  assert.equal(research.liquidityIndependence.present, false);
  assert.equal(research.liquidityIndependence.effectiveIndependentN, null);
});

test('Research Center contract fails closed on unsafe authority, malformed SHA, and filesystem text', () => {
  const unsafe = validOverview();
  unsafe.safety.liveTrading = true;
  assert.equal(sanitizeResearchCenterOverview(unsafe), null);

  const wrongSha = validOverview();
  wrongSha.research.cycles[0]!.researchSha = 'wrong-sha';
  assert.equal(sanitizeResearchCenterOverview(wrongSha), null);

  const wrongIndependenceSha = validOverview();
  wrongIndependenceSha.research.liquidityIndependence.producerSha = 'wrong-sha';
  assert.equal(sanitizeResearchCenterOverview(wrongIndependenceSha), null);

  const pathLeak = validOverview();
  pathLeak.research.cycles[0]!.tasks[0]!.id = 'C:\\Users\\owner\\secret.json';
  assert.equal(sanitizeResearchCenterOverview(pathLeak), null);
});

test('invalid independence evidence carries no partial sample counts', () => {
  const input = validOverview();
  input.research.liquidityIndependence = {
    ...liquidityIndependence(),
    present: true,
    status: 'INVALID',
  };
  const result = sanitizeResearchCenterOverview(input)!;
  const research = result.research as { liquidityIndependence: { status: string; effectiveIndependentN: number | null; independentBuyN: number | null } };
  assert.equal(research.liquidityIndependence.status, 'INVALID');
  assert.equal(research.liquidityIndependence.effectiveIndependentN, null);
  assert.equal(research.liquidityIndependence.independentBuyN, null);
});

test('measured zero counts remain zero while unavailable counts remain null', () => {
  const result = sanitizeResearchCenterOverview(validOverview())!;
  const paper = result.paper as { ledger: { sampleCount: number | null; positionCount: number | null } };
  const shadow = result.shadow as { records: { totalRecords: number | null } };
  const research = result.research as { liquidityIndependence: { frozenSplitCounts: { VALIDATION: number | null; OOS: number | null } } };
  assert.equal(paper.ledger.sampleCount, 0);
  assert.equal(paper.ledger.positionCount, 0);
  assert.equal(shadow.records.totalRecords, null);
  assert.equal(research.liquidityIndependence.frozenSplitCounts.VALIDATION, 0);
  assert.equal(research.liquidityIndependence.frozenSplitCounts.OOS, 0);
});
