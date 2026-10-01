import assert from 'node:assert/strict';
import test from 'node:test';

import { createPaperTradingState } from './paper-trading-core.service';
import { createImmutablePaperTradingStateSnapshot } from './paper-trading-state-snapshot.service';
import {
  buildPumpPaperAccountRiskSnapshot,
  createPumpReversalProspectiveRiskOwner,
} from './pump-reversal-prospective-risk-owner.service';

const NOW = 1_800_000_000_000;
const SHA = 'a'.repeat(40);
const PUBLISHER = 'b'.repeat(64);

function snapshot() {
  const state = createPaperTradingState(1_000_000, new Date(NOW - 1_000));
  state.updatedAt = new Date(NOW - 1_000).toISOString();
  state.account.updatedAt = state.updatedAt;
  state.riskState.dailyRealizedPnl = -100;
  state.riskState.weeklyRealizedPnl = -250;
  state.riskState.consecutiveLosses = 1;
  state.positions.push(
    { status: 'open', side: 'short', notionalValue: 300 } as never,
    { status: 'open', side: 'long', notionalValue: 200 } as never,
    { status: 'closed', side: 'short', notionalValue: 900 } as never,
  );
  return createImmutablePaperTradingStateSnapshot({
    state,
    sourceOwner: 'test-paper-owner',
    sourceSha: SHA,
    market: 'CRYPTO_FUTURES',
    currency: 'USDT',
    provenance: ['test-public-paper-state'],
    publisherAccountIdSha256: PUBLISHER,
    observedAtMs: NOW,
    maximumAgeMs: 30_000,
  });
}

function record() {
  return {
    status: 'OPEN' as const,
    observation: {
      candidateId: 'paper-candidate-v1:' + 'c'.repeat(64),
      candidateDigest: 'd'.repeat(64),
      policyDigest: 'e'.repeat(64),
      symbol: 'ALTUSDT',
    },
    signal: {
      strategyId: 'CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1',
      market: 'CRYPTO_FUTURES' as const,
      direction: 'SHORT' as const,
      symbol: 'ALTUSDT',
      signalId: 'f'.repeat(64),
      parameterHash: '1'.repeat(64),
    },
    position: {
      positionId: '2'.repeat(64),
      entryTimestampMs: NOW - 5_000,
      entryPrice: 100,
      stopPrice: 125,
      timeExitAtMs: NOW + 72 * 60 * 60 * 1000,
      actualExchangeFillClaim: false as const,
    },
  };
}

test('paper snapshot derives nominal total and SHORT-direction exposure without closed positions', () => {
  const value = buildPumpPaperAccountRiskSnapshot(snapshot(), NOW);
  assert.equal(value.equity, 1_000_000);
  assert.equal(value.dailyRealizedPnl, -100);
  assert.equal(value.weeklyRealizedPnl, -250);
  assert.equal(value.consecutiveLosses, 1);
  assert.equal(value.openExposure, 500);
  assert.equal(value.sameDirectionExposure, 300);
  assert.equal(value.observedAtMs, NOW);
});

test('risk owner passes only validated authoritative sources into the existing sizing engine', async () => {
  const seen: any[] = [];
  const expected = Object.freeze({
    status: 'READY' as const,
    version: 'pump-reversal-paper-risk-sizing-v1' as const,
    blockers: Object.freeze([]),
    riskInput: null,
    riskResult: null,
    maximumProbeNotional: 1,
    maximumProbeQuantity: 1,
    observedSlippagePercent: 0,
    observedSpreadPercent: 0,
    conservativeFundingRiskRate: 0,
    finalQuantity: 1,
    finalNotional: 100,
    riskPercent: 0.25 as const,
    leverage: 2 as const,
    marginMode: 'isolated' as const,
    fundingDirectionalFilterUsed: false as const,
    fundingCountsAsProfitabilityEvidence: false as const,
    simulatedOnly: true as const,
    canonicalProfitAdmissionEligible: false as const,
    profitabilityClaimAllowed: false as const,
    executionAuthority: 'NONE' as const,
    liveOrderAllowed: false as const,
    privateTradingApiAllowed: false as const,
    orderSubmitted: false as const,
    exchangeRequestSent: false as const,
  });
  const owner = createPumpReversalProspectiveRiskOwner({
    sources: {
      paperStateSnapshotForRecord: async () => snapshot(),
      contractRulesForRecord: async () => ({ symbol: 'ALTUSDT' } as never),
      publicEvidenceForRecord: async () => ({ symbol: 'ALTUSDT' } as never),
      depthForRecord: async () => ({ observedAtMs: NOW } as never),
      supplementalCostEvidenceForRecord: async () => ({ costPolicyId: 'cost-v1' } as never),
    },
    sizeRisk: ((input: any) => {
      seen.push(input);
      return expected;
    }) as never,
  });
  const result = await owner({ record: record(), observedAtMs: NOW });
  assert.equal(result, expected);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].account.openExposure, 500);
  assert.equal(seen[0].account.sameDirectionExposure, 300);
  assert.equal(seen[0].record.signal.symbol, 'ALTUSDT');
  assert.equal(seen[0].nowMs, NOW);
});

test('invalid or unavailable paper state fails closed before sizing', async () => {
  let sized = 0;
  const owner = createPumpReversalProspectiveRiskOwner({
    sources: {
      paperStateSnapshotForRecord: async () => {
        throw new Error('owner unavailable');
      },
      contractRulesForRecord: async () => { throw new Error('SHOULD_NOT_CALL'); },
      publicEvidenceForRecord: async () => { throw new Error('SHOULD_NOT_CALL'); },
      depthForRecord: async () => { throw new Error('SHOULD_NOT_CALL'); },
      supplementalCostEvidenceForRecord: async () => { throw new Error('SHOULD_NOT_CALL'); },
    },
    sizeRisk: ((input: any) => {
      sized += 1;
      return input;
    }) as never,
  });
  const result = await owner({ record: record(), observedAtMs: NOW });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.blockers, ['PUMP_RISK_OWNER_PAPER_STATE_SOURCE_FAILED']);
  assert.equal(sized, 0);
  assert.equal(result.executionAuthority, 'NONE');
});
