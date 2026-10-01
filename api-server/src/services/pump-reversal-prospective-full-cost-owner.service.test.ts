import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPumpReversalProspectiveFullCostOwner,
  PUMP_REVERSAL_PROSPECTIVE_FULL_COST_OWNER_SAFETY,
} from './pump-reversal-prospective-full-cost-owner.service';

const NOW = 1_800_000_000_000;
const RECORD_ID = 'a'.repeat(64);
const SIGNAL_ID = 'b'.repeat(64);
const CANDIDATE_ID = 'paper-candidate-v1:' + 'c'.repeat(64);
const RISK_DIGEST = 'd'.repeat(64);
const EXIT_ID = 'e'.repeat(64);
const RESEARCH_SHA = 'f'.repeat(40);

function record() {
  const entryDataEvidence = {
    provider: 'bitget',
    publicOnly: true,
    dataQuality: 'READY',
    provenance: 'test-entry',
    asOfMs: NOW - 5_000,
    maxAgeMs: 30_000,
    tickSize: 0.01,
    barProxyRealtimeAllowed: false,
    quoteEvidence: { available: true, bid: 99, ask: 101, last: 100, asOfMs: NOW - 5_000, maxAgeMs: 30_000 },
    depthEvidence: { available: true, bidSize: 10, askSize: 10 },
    contractStatus: 'TRADABLE',
    minQty: 0.001,
    qtyStep: 0.001,
    quantityPrecision: 3,
    markPrice: 100,
    indexPrice: 100,
    fundingRate: 0.0001,
    openInterest: 1000,
    leverage: 2,
    maxLeverage: 20,
    marginMode: 'ISOLATED',
    liquidationDistancePct: 40,
  };
  return {
    recordId: RECORD_ID,
    status: 'EXIT_TRIGGERED',
    observation: { candidateId: CANDIDATE_ID, symbol: 'ALTUSDT' },
    signal: { signalId: SIGNAL_ID },
    position: { positionId: 'position-1' },
    riskSizingStatus: 'READY',
    riskSizing: {
      evidenceDigest: RISK_DIGEST,
      result: {
        status: 'READY',
        prospectiveEntryExecution: {
          marketAdapterIdentity: { id: 'crypto-futures-bitget-execution', version: 'v2' },
          executionPolicy: {
            version: 'crypto-pump-reversal-prospective-entry-execution-v1',
            fillModel: 'DEPTH_PARTICIPATION',
            sameBarPolicy: 'STOP_FIRST',
            allowPartialFill: false,
            maxParticipationRate: 1,
          },
          dataEvidence: entryDataEvidence,
        },
      },
    },
    prospectiveExecutionSampleStatus: 'READY',
    prospectiveExecutionSample: {
      schemaVersion: 1,
      prospectiveExecutionSampleOnly: true,
      canonicalProfitAdmissionEligible: false,
      profitabilityClaimAllowed: false,
      executionAuthority: 'NONE',
      recordId: RECORD_ID,
      paperSampleId: 'paper-sample-1',
      status: 'OPEN',
      identity: {
        signalId: SIGNAL_ID,
        market: 'CRYPTO_FUTURES',
        symbol: 'ALTUSDT',
        executionDirection: 'SHORT',
        candidateId: CANDIDATE_ID,
        strategyFamily: 'EVENT_SPECIALIST',
        strategyId: 'CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1',
        strategyVersion: 'clean-v1',
        parameterHash: 'params-1',
        parameterDigest: 'params-1',
        researchCodeSha: RESEARCH_SHA,
        accountMode: 'PAPER',
        evaluatedAtMs: NOW - 5_000,
        timeframe: '1h',
        horizon: 72,
      },
      profitEvidence: { costPolicyId: 'cost-v1' },
      fill: {
        status: 'FILLED',
        fillPrice: 99,
        filledQuantity: 0.1,
        notional: 9.9,
        costs: { immediateCost: 0.01 },
        orderSubmitted: false,
        exchangeRequestSent: false,
      },
    },
    fullCostSettlementStatus: 'MISSING_CANONICAL_FULL_COST',
    exitTrigger: {
      exitTriggerId: EXIT_ID,
      reason: 'STOP_25_PERCENT',
      triggerTimestampMs: NOW - 1_000,
      referenceExitPrice: 125,
      bar: { timestampMs: NOW - 1_000, open: 124, high: 126, low: 123, close: 125 },
    },
  };
}

function component(name: string) {
  return {
    status: 'PRESENT',
    valuePercent: name === 'tax' ? 0 : 0.01,
    quality: name === 'tax' ? 'NOT_APPLICABLE' : name === 'commission' ? 'DOCUMENTED' : 'OBSERVED',
    source: 'test-' + name,
    provenance: 'test-full-cost',
    countsAsExecutionCost: true,
    unavailableIsZero: false,
  };
}

function evidence() {
  const components = Object.fromEntries([
    'commission', 'tax', 'spread', 'slippage',
    'funding', 'latency', 'liquidityImpact', 'partialFillImpact',
  ].map((name) => [name, component(name)]));
  return {
    status: 'PRESENT',
    fullCostReady: true,
    settlementCostEvidence: {
      schemaVersion: 'authoritative-paper-execution-cost-sources-v1',
      status: 'PRESENT',
      fullCostReady: true,
      components,
      costPolicyIdentity: { version: 'cost-v1' },
      unknownIsZero: false,
      unavailableCostConvertedToZero: false,
    },
    settlementInput: {
      exitExecution: {
        costPolicy: { version: 'cost-v1' },
      },
      fundingEvidence: { complete: true, payments: [] },
    },
    blockers: [],
  };
}

test('owner reuses the frozen Pump entry sample and returns one economic settlement', async () => {
  let collectorCalls = 0;
  let settleCalls = 0;
  let capturedPosition: any = null;
  const owner = createPumpReversalProspectiveFullCostOwner({
    supplementalCostEvidenceForRecord: async () => ({
      costPolicyId: 'cost-v1',
      observedAtMs: NOW,
      latency: component('latency'),
      liquidityImpact: component('liquidityImpact'),
      partialFillImpact: component('partialFillImpact'),
      funding: component('funding'),
    } as any),
    collectSettlementEvidence: async ({ position, exitTrigger }) => {
      collectorCalls += 1;
      capturedPosition = position;
      assert.equal(exitTrigger.triggeredAtMs, NOW - 1_000);
      assert.equal(exitTrigger.bar.high, 126);
      return evidence();
    },
    settlePaperSample: (input) => {
      settleCalls += 1;
      assert.equal(input.sample.paperSampleId, 'paper-sample-1');
      assert.equal(input.exitOrderType, 'MARKET');
      return {
        status: 'SETTLED',
        paperSampleId: 'paper-sample-1',
        settledAtMs: NOW,
        grossPnl: -2,
        grossReturnPercent: -20,
        netPnl: -2.25,
        netReturnPercent: -22.5,
        entryFillPrice: 99,
        exitFillPrice: 121.5,
        quantity: 0.1,
        costPolicyVersion: 'cost-v1',
        fundingEvidence: { complete: true, payments: [] },
        blockers: [],
        orderSubmitted: false,
        exchangeRequestSent: false,
        privateTradingApiAllowed: false,
        profitabilityClaimAllowed: false,
      };
    },
    now: () => NOW,
  });
  const result = await owner({ record: record(), observedAtMs: NOW - 500 });
  assert.equal(result.status, 'SETTLED');
  if (result.status !== 'SETTLED') throw new Error(result.blockers.join(','));
  assert.equal(collectorCalls, 1);
  assert.equal(settleCalls, 1);
  assert.equal(capturedPosition.sample.paperSampleId, 'paper-sample-1');
  assert.equal(capturedPosition.entryTimestampMs, NOW - 5_000);
  assert.equal(capturedPosition.quantity, 0.1);
  assert.equal(result.netPnl, -2.25);
  assert.equal(result.netReturnPercent, -22.5);
  assert.equal(result.economicSampleCredit, 1);
  assert.equal(result.profitabilityClaimAllowed, false);
  assert.equal(result.executionAuthority, 'NONE');
});

test('missing one Full Cost component blocks before canonical settlement execution', async () => {
  let settleCalls = 0;
  const broken = evidence();
  delete (broken.settlementCostEvidence.components as any).funding;
  const owner = createPumpReversalProspectiveFullCostOwner({
    supplementalCostEvidenceForRecord: async () => ({} as any),
    collectSettlementEvidence: async () => broken,
    settlePaperSample: () => {
      settleCalls += 1;
      throw new Error('SHOULD_NOT_SETTLE');
    },
    now: () => NOW,
  });
  const result = await owner({ record: record(), observedAtMs: NOW - 500 });
  assert.equal(result.status, 'BLOCKED');
  if (result.status !== 'BLOCKED') throw new Error('expected blocked');
  assert.ok(result.blockers.includes('PUMP_FULL_COST_COMPONENT_INVALID:funding'));
  assert.equal(settleCalls, 0);
  assert.equal(result.executionAuthority, 'NONE');
});

test('owner refuses an exit without the frozen triggering minute bar', async () => {
  const broken = structuredClone(record());
  broken.exitTrigger.bar = null;
  const owner = createPumpReversalProspectiveFullCostOwner({
    supplementalCostEvidenceForRecord: async () => ({} as any),
    collectSettlementEvidence: async () => {
      throw new Error('SHOULD_NOT_COLLECT');
    },
    now: () => NOW,
  });
  const result = await owner({ record: broken, observedAtMs: NOW });
  assert.equal(result.status, 'BLOCKED');
  if (result.status !== 'BLOCKED') throw new Error('expected blocked');
  assert.ok(result.blockers.includes('PUMP_FULL_COST_EXIT_BAR_REQUIRED'));
});

test('safety contract keeps settlement research-only and non-mutating', () => {
  assert.equal(PUMP_REVERSAL_PROSPECTIVE_FULL_COST_OWNER_SAFETY.allEightCostComponentsRequired, true);
  assert.equal(PUMP_REVERSAL_PROSPECTIVE_FULL_COST_OWNER_SAFETY.unknownCostIsZero, false);
  assert.equal(PUMP_REVERSAL_PROSPECTIVE_FULL_COST_OWNER_SAFETY.profitabilityClaimAllowed, false);
  assert.equal(PUMP_REVERSAL_PROSPECTIVE_FULL_COST_OWNER_SAFETY.executionAuthority, 'NONE');
  assert.equal(PUMP_REVERSAL_PROSPECTIVE_FULL_COST_OWNER_SAFETY.liveTrading, false);
  assert.equal(PUMP_REVERSAL_PROSPECTIVE_FULL_COST_OWNER_SAFETY.privateTradingApiAllowed, false);
  assert.equal(PUMP_REVERSAL_PROSPECTIVE_FULL_COST_OWNER_SAFETY.financialMutationAllowed, false);
});
