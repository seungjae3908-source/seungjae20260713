import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESEARCH_CENTER_READONLY_CONTRACT,
  sanitizeResearchCenterOverview,
} from './research-center-readonly-contract.service.ts';

const SHA = '1111111111111111111111111111111111111111';

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
  const result = sanitizeResearchCenterOverview(input);
  assert.ok(result);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('ghp_should-never-leak'), false);
  assert.equal(serialized.includes('/var/lib/private-research'), false);
  assert.equal(serialized.includes('private-account-id'), false);
  assert.equal(serialized.includes('credential'), false);
  assert.deepEqual(RESEARCH_CENTER_READONLY_CONTRACT.methods, ['GET']);
  assert.equal(RESEARCH_CENTER_READONLY_CONTRACT.executionAuthority, 'NONE');
});

test('Research Center contract fails closed on unsafe authority, malformed SHA, and filesystem text', () => {
  const unsafe = validOverview();
  unsafe.safety.liveTrading = true;
  assert.equal(sanitizeResearchCenterOverview(unsafe), null);

  const wrongSha = validOverview();
  wrongSha.research.cycles[0]!.researchSha = 'wrong-sha';
  assert.equal(sanitizeResearchCenterOverview(wrongSha), null);

  const pathLeak = validOverview();
  pathLeak.research.cycles[0]!.tasks[0]!.id = 'C:\\Users\\owner\\secret.json';
  assert.equal(sanitizeResearchCenterOverview(pathLeak), null);
});

test('measured zero counts remain zero while unavailable counts remain null', () => {
  const result = sanitizeResearchCenterOverview(validOverview())!;
  const paper = result.paper as { ledger: { sampleCount: number | null; positionCount: number | null } };
  const shadow = result.shadow as { records: { totalRecords: number | null } };
  assert.equal(paper.ledger.sampleCount, 0);
  assert.equal(paper.ledger.positionCount, 0);
  assert.equal(shadow.records.totalRecords, null);
});
