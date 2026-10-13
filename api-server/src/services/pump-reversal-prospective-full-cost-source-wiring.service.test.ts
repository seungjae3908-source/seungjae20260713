import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPumpReversalFullCostSourceWiring,
  PUMP_REVERSAL_FULL_COST_SOURCE_WIRING_SAFETY,
} from './pump-reversal-prospective-full-cost-source-wiring.service';

const NOW = 1_800_000_000_000;

test('wiring binds the current Pump record to the canonical supplemental-cost callback and owner', async () => {
  const record = { recordId: 'a'.repeat(64) };
  let supplementalCalls = 0;
  let collectorCalls = 0;
  let ownerCalls = 0;

  const wiring = createPumpReversalFullCostSourceWiring({
    supplementalCostEvidenceForRecord: async (context) => {
      supplementalCalls += 1;
      assert.equal(context.record, record);
      return {
        costPolicyId: 'pump-cost-v1',
        observedAtMs: NOW,
        latency: { valuePercent: 0.01, quality: 'ESTIMATED', source: 'latency', observedAtMs: NOW },
        liquidityImpact: { valuePercent: 0.02, quality: 'ESTIMATED', source: 'liquidity', observedAtMs: NOW },
        partialFillImpact: { valuePercent: 0.01, quality: 'ESTIMATED', source: 'partial', observedAtMs: NOW },
        funding: { valuePercent: 0, quality: 'OBSERVED', source: 'funding', observedAtMs: NOW },
      };
    },
    bitgetClient: { get: async () => ({ code: '00000' }) } as any,
    now: () => NOW,
    collectorFactory: ((options: any) => {
      collectorCalls += 1;
      return async () => {
        const supplemental = await options.readSupplementalCostInput();
        assert.equal(supplemental.costPolicyId, 'pump-cost-v1');
        return { status: 'PRESENT', fullCostReady: true };
      };
    }) as any,
    settlementOwnerFactory: ((options: any) => {
      ownerCalls += 1;
      return async (context: any) => {
        const evidence = await options.collectAuthoritativeEvidence({
          position: {},
          observation: {},
          exitTrigger: {},
          evaluatedAtMs: context.observedAtMs,
        });
        assert.equal(evidence.status, 'PRESENT');
        return {
          schemaVersion: 'crypto-pump-reversal-full-cost-settlement-v1',
          status: 'SETTLED',
          settlementId: 'settlement-1',
          recordId: context.record.recordId,
          economicSampleCredit: 1,
          profitabilityClaimAllowed: false,
          executionAuthority: 'NONE',
        };
      };
    }) as any,
  });

  const result = await wiring.settleFullCost({ record, observedAtMs: NOW });
  assert.equal(result.status, 'SETTLED');
  assert.equal(result.recordId, record.recordId);
  assert.equal(supplementalCalls, 1);
  assert.equal(collectorCalls, 1);
  assert.equal(ownerCalls, 1);
  assert.equal(wiring.executionAuthority, 'NONE');
  assert.equal(wiring.liveTrading, false);
  assert.equal(wiring.privateTradingApiAllowed, false);
  assert.equal(wiring.financialMutationAllowed, false);
});

test('safety contract keeps Full Cost source wiring public-only and non-mutating', () => {
  assert.equal(PUMP_REVERSAL_FULL_COST_SOURCE_WIRING_SAFETY.canonicalPredictionLabSettlementOwnerRequired, true);
  assert.equal(PUMP_REVERSAL_FULL_COST_SOURCE_WIRING_SAFETY.authoritativePublicSettlementCollectorRequired, true);
  assert.equal(PUMP_REVERSAL_FULL_COST_SOURCE_WIRING_SAFETY.supplementalCostOwnerRequired, true);
  assert.equal(PUMP_REVERSAL_FULL_COST_SOURCE_WIRING_SAFETY.missingCostConvertedToZero, false);
  assert.equal(PUMP_REVERSAL_FULL_COST_SOURCE_WIRING_SAFETY.executionAuthority, 'NONE');
  assert.equal(PUMP_REVERSAL_FULL_COST_SOURCE_WIRING_SAFETY.liveTrading, false);
  assert.equal(PUMP_REVERSAL_FULL_COST_SOURCE_WIRING_SAFETY.privateTradingApiAllowed, false);
  assert.equal(PUMP_REVERSAL_FULL_COST_SOURCE_WIRING_SAFETY.financialMutationAllowed, false);
});
