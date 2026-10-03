import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPumpReversalProspectiveRuntimeDependencies,
  PUMP_REVERSAL_RUNTIME_DEPENDENCIES_SAFETY,
} from './pump-reversal-prospective-runtime-dependencies.service';

const SHA = 'a'.repeat(40);

test('runtime dependency factory binds one shared Paper/supplemental owner into risk and Full Cost callbacks', async () => {
  let riskFactoryCalls = 0;
  let fullCostFactoryCalls = 0;
  let sizingCalls = 0;
  let settlementCalls = 0;
  let supplementalCalls = 0;
  const supplemental = async () => {
    supplementalCalls += 1;
    return {
      costPolicyId: 'pump-cost-v1',
      observedAtMs: 1_800_000_000_000,
      latency: { valuePercent: 0.01, quality: 'ESTIMATED', source: 'latency', observedAtMs: 1_800_000_000_000 },
      liquidityImpact: { valuePercent: 0.01, quality: 'ESTIMATED', source: 'liquidity', observedAtMs: 1_800_000_000_000 },
      partialFillImpact: { valuePercent: 0.01, quality: 'ESTIMATED', source: 'partial', observedAtMs: 1_800_000_000_000 },
      funding: { valuePercent: 0, quality: 'OBSERVED', source: 'funding', observedAtMs: 1_800_000_000_000 },
    } as any;
  };

  const dependencies = createPumpReversalProspectiveRuntimeDependencies({
    researchCodeSha: SHA,
    paperStateSnapshotForRecord: async () => ({ snapshot: true }),
    supplementalCostEvidenceForRecord: supplemental,
    now: () => 1_800_000_000_000,
    riskWiringFactory: ((input: any) => {
      riskFactoryCalls += 1;
      assert.equal(input.researchCodeSha, SHA);
      return {
        createOwner: () => async (context: any) => {
          sizingCalls += 1;
          await input.supplementalCostEvidenceForRecord(context);
          return { status: 'READY', executionAuthority: 'NONE' };
        },
        executionAuthority: 'NONE',
        liveTrading: false,
        privateTradingApiAllowed: false,
      };
    }) as any,
    fullCostWiringFactory: ((input: any) => {
      fullCostFactoryCalls += 1;
      return {
        settleFullCost: async (context: any) => {
          settlementCalls += 1;
          await input.supplementalCostEvidenceForRecord(context);
          return { status: 'SETTLED', executionAuthority: 'NONE' };
        },
        executionAuthority: 'NONE',
        liveTrading: false,
        privateTradingApiAllowed: false,
        financialMutationAllowed: false,
      };
    }) as any,
  });

  const context = { record: { recordId: 'b'.repeat(64) }, observedAtMs: 1_800_000_000_000 };
  const sized = await dependencies.sizePaperRisk(context as any);
  const settled = await dependencies.settleFullCost(context as any);
  assert.equal(sized.status, 'READY');
  assert.equal(settled.status, 'SETTLED');
  assert.equal(riskFactoryCalls, 1);
  assert.equal(fullCostFactoryCalls, 1);
  assert.equal(sizingCalls, 1);
  assert.equal(settlementCalls, 1);
  assert.equal(supplementalCalls, 2);
  assert.equal(dependencies.executionAuthority, 'NONE');
  assert.equal(dependencies.liveTrading, false);
  assert.equal(dependencies.privateTradingApiAllowed, false);
  assert.equal(dependencies.financialMutationAllowed, false);
  assert.equal(dependencies.scheduleActivationAuthority, false);
});

test('runtime dependency safety contract never grants deployment, schedule, private API, or financial authority', () => {
  assert.equal(PUMP_REVERSAL_RUNTIME_DEPENDENCIES_SAFETY.riskOwnerConnected, true);
  assert.equal(PUMP_REVERSAL_RUNTIME_DEPENDENCIES_SAFETY.canonicalFullCostOwnerConnected, true);
  assert.equal(PUMP_REVERSAL_RUNTIME_DEPENDENCIES_SAFETY.scheduleActivationAuthority, false);
  assert.equal(PUMP_REVERSAL_RUNTIME_DEPENDENCIES_SAFETY.deploymentAuthority, false);
  assert.equal(PUMP_REVERSAL_RUNTIME_DEPENDENCIES_SAFETY.financialMutationAllowed, false);
  assert.equal(PUMP_REVERSAL_RUNTIME_DEPENDENCIES_SAFETY.executionAuthority, 'NONE');
  assert.equal(PUMP_REVERSAL_RUNTIME_DEPENDENCIES_SAFETY.liveTrading, false);
  assert.equal(PUMP_REVERSAL_RUNTIME_DEPENDENCIES_SAFETY.privateTradingApiAllowed, false);
});
