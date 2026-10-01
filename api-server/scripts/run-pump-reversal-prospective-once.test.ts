import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PUMP_REVERSAL_ONE_SHOT_RUNNER_VERSION,
  runPumpReversalProspectiveOnce,
} from './run-pump-reversal-prospective-once';

const NOW = 1_800_000_000_000;
const ROOT = '/tmp/pump-one-shot-state';
const POLICY = '/tmp/pump-policy.json';
const PAPER = '/tmp/pump-paper-state.json';
const COST = '/tmp/pump-cost.json';

function policy() {
  return {
    candidate: {
      researchCodeSha: 'a'.repeat(40),
    },
  };
}

test('one-shot preflights all read-only files before invocation and exposes no financial authority', async () => {
  const reads: string[] = [];
  const factoryCalls: any[] = [];
  let invoked = 0;
  const result = await runPumpReversalProspectiveOnce({
    stateRoot: ROOT,
    policyPath: POLICY,
    paperStateSnapshotPath: PAPER,
    supplementalCostEvidencePath: COST,
    ownerId: 'test-owner',
    now: () => NOW,
    readJson: async (path) => {
      reads.push(path);
      if (path === POLICY) return policy();
      if (path === PAPER) return { schemaVersion: 'paper-trading-state-snapshot-v2' };
      if (path === COST) return { costPolicyId: 'pump-cost-v1' };
      throw new Error('UNEXPECTED_PATH');
    },
    verifyPolicy: () => ({ valid: true, blockers: [] }),
    runtimeDependenciesFactory: ((input: any) => {
      factoryCalls.push(input);
      return {
        sizePaperRisk: async () => ({ status: 'BLOCKED', blockers: ['NO_SIGNAL'] }),
        settleFullCost: async () => ({ status: 'BLOCKED_DATA', blockers: ['NO_EXIT'] }),
        executionAuthority: 'NONE',
        liveTrading: false,
        privateTradingApiAllowed: false,
        financialMutationAllowed: false,
        scheduleActivationAuthority: false,
      };
    }) as any,
    runtimeFactory: ((input: any) => ({
      async run() {
        return input;
      },
    })) as any,
    invocationRunner: async (input) => {
      invoked += 1;
      assert.equal(input.rootDirectory, ROOT);
      assert.equal(input.ownerId, 'test-owner');
      assert.equal(input.nowMs, NOW);
      return {
        status: 'COMPLETED',
        cycleId: 'cycle-1',
        runtime: {
          status: 'COMPLETED',
          blockers: [],
          summary: {
            records: 3,
            waitingNextBar: 0,
            entryMissed: 0,
            openPositions: 1,
            exitTriggered: 2,
            riskSized: 2,
            riskSizingExpired: 0,
            prospectiveExecutionSamples: 2,
            fullCostSettled: 1,
            netEconomicOutcomesAvailable: 1,
          },
        },
      };
    },
  });

  assert.deepEqual(reads.slice(0, 3).sort(), [COST, PAPER, POLICY].sort());
  assert.equal(invoked, 1);
  assert.equal(factoryCalls.length, 1);
  assert.equal(result.schemaVersion, PUMP_REVERSAL_ONE_SHOT_RUNNER_VERSION);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.summary?.fullCostSettled, 1);
  assert.equal(result.summary?.netEconomicOutcomesAvailable, 1);
  assert.equal(result.profitabilityProven, false);
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(result.realOrderCount, 0);
  assert.equal(result.sensitiveValuesEmitted, false);
});

test('missing read-only input blocks before runtime dependency or lease creation', async () => {
  let factories = 0;
  let invocations = 0;
  await assert.rejects(
    () => runPumpReversalProspectiveOnce({
      stateRoot: ROOT,
      policyPath: POLICY,
      paperStateSnapshotPath: PAPER,
      supplementalCostEvidencePath: COST,
      now: () => NOW,
      readJson: async (path) => {
        if (path === COST) throw new Error('missing');
        return path === POLICY ? policy() : {};
      },
      verifyPolicy: () => ({ valid: true, blockers: [] }),
      runtimeDependenciesFactory: (() => {
        factories += 1;
        throw new Error('SHOULD_NOT_CALL');
      }) as any,
      runtimeFactory: (() => { throw new Error('SHOULD_NOT_CALL'); }) as any,
      invocationRunner: async () => {
        invocations += 1;
        throw new Error('SHOULD_NOT_CALL');
      },
    }),
  );
  assert.equal(factories, 0);
  assert.equal(invocations, 0);
});

test('invalid policy blocks before cycle creation', async () => {
  let invocations = 0;
  await assert.rejects(
    () => runPumpReversalProspectiveOnce({
      stateRoot: ROOT,
      policyPath: POLICY,
      paperStateSnapshotPath: PAPER,
      supplementalCostEvidencePath: COST,
      now: () => NOW,
      readJson: async (path) => path === POLICY ? policy() : {},
      verifyPolicy: () => ({ valid: false, blockers: ['BAD_POLICY'] }),
      runtimeDependenciesFactory: (() => { throw new Error('SHOULD_NOT_CALL'); }) as any,
      runtimeFactory: (() => { throw new Error('SHOULD_NOT_CALL'); }) as any,
      invocationRunner: async () => {
        invocations += 1;
        throw new Error('SHOULD_NOT_CALL');
      },
    }),
    /PUMP_ONE_SHOT_POLICY_INVALID:BAD_POLICY/,
  );
  assert.equal(invocations, 0);
});
