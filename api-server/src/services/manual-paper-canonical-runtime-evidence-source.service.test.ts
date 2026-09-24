import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaperTradingState } from './paper-trading-engine.service';
import { PaperTradingError } from './paper-trading-core.service';
import {
  createManualPaperCanonicalRuntimeEvidenceSource,
  MANUAL_PAPER_CANONICAL_RUNTIME_BRIDGE_SAFETY,
} from './manual-paper-canonical-runtime-evidence-source.service';

const NOW = Date.parse('2026-09-24T07:00:00.000Z');
const SHA = 'a'.repeat(40);
const CANDIDATE_ID = `paper-candidate-v1:${'b'.repeat(64)}`;
const ACCOUNT = 'member-account-id';

function component(valuePercent: number, name: string, quality = 'OBSERVED') {
  return {
    valuePercent,
    source: `public:${name}`,
    quality,
    observedAtMs: NOW - 1_000,
  };
}

function naturalPosition() {
  const components = {
    commission: component(0.10, 'commission'),
    tax: component(0, 'tax', 'NOT_APPLICABLE'),
    spread: component(0.02, 'spread'),
    slippage: component(0.03, 'slippage', 'ESTIMATED'),
    funding: component(0.01, 'funding'),
    latency: component(0.01, 'latency', 'ESTIMATED'),
    liquidityImpact: component(0.02, 'liquidity-impact', 'ESTIMATED'),
    partialFillImpact: component(0.03, 'partial-fill-impact', 'ESTIMATED'),
  };
  const costPolicy = {
    version: 'cost-v1',
    commissionRate: 0.001,
    taxRate: 0,
    spreadRate: 0.0002,
    slippageRate: 0.0003,
    fundingRate: 0.0001,
    latencyRate: 0.0001,
    liquidityImpactRate: 0.0002,
    partialFillImpactRate: 0.0003,
  };
  const candidate = {
    candidateId: CANDIDATE_ID,
    execution: {
      dataEvidence: { maxAgeMs: 30_000 },
      costPolicy,
    },
  };
  return {
    positionId: 'natural-position-1',
    paperSampleId: 'paper-sample-1',
    candidateId: CANDIDATE_ID,
    strategyId: 'strategy-v1',
    strategyVersion: 'v1',
    strategyFamily: 'TREND',
    parameterHash: 'parameter-hash',
    parameterDigest: 'parameter-hash',
    researchCodeSha: SHA,
    accountMode: 'PAPER',
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    costPolicyVersion: 'cost-v1',
    entryTimestampMs: NOW,
    accountingEvidence: { leverage: 2 },
    sample: {
      identity: {
        executionDirection: 'LONG',
        signalDirection: 'LONG',
        timeframe: '15m',
      },
    },
    entryCandidate: candidate,
    entryCostProvenance: {
      policyId: 'cost-v1',
      providerProvenance: 'bitget-public-owner',
      components,
    },
  };
}

function validation(identity: any) {
  const receipt = {
    identity,
    receiptId: 'forward-validation-v1:test',
    receiptVersion: 'manual-paper-forward-validation-receipt-v1',
    source: 'FORWARD_RECOMMENDATION_OBSERVER',
    provenance: 'PROSPECTIVE_PUBLIC_FORWARD',
    status: 'VALIDATED',
    observedAtMs: NOW - 500,
    maximumAgeMs: 60_000,
    synthetic: false,
    replay: false,
    backfill: false,
    historical: false,
    testOnly: false,
    datasetDigest: 'c'.repeat(64),
    resultArtifactDigest: 'd'.repeat(64),
  };
  return {
    receipt,
    verification: {
      ownerId: 'forward-observer-validation-receipt-owner-v1',
      source: receipt.source,
      provenance: receipt.provenance,
      verifiedAtMs: NOW,
      readbackVerified: true as const,
      validationPassed: true as const,
      receiptSha256: 'e'.repeat(64),
    },
  };
}

function request(action: any, state = createPaperTradingState(10_000, new Date(NOW))) {
  return {
    authenticatedAccountId: ACCOUNT,
    candidateId: CANDIDATE_ID,
    action,
    state,
    nowMs: NOW,
  };
}

test('runtime bridge remains inert by default and preserves the legacy canonical route error', async () => {
  let reads = 0;
  const source = createManualPaperCanonicalRuntimeEvidenceSource({
    env: { DEPLOY_SHA: SHA },
    dependencies: {
      async readPaperState() { reads += 1; return createPaperTradingState(10_000, new Date(NOW)); },
      async readRecurringState() { reads += 1; return { identity: { researchCodeSha: SHA }, positions: [naturalPosition()] }; },
      async issueValidationReceipt(identity) { reads += 1; return validation(identity); },
    },
  });

  await assert.rejects(
    () => source(request({ type: 'mark_price', eventId: 'noop', symbol: 'BTCUSDT', price: 100, at: new Date(NOW).toISOString() })),
    (error: unknown) => {
      assert.ok(error instanceof PaperTradingError);
      assert.equal(error.code, 'SERVER_OWNED_CANONICAL_PAPER_EVIDENCE_REQUIRED');
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
  assert.equal(reads, 0);
  assert.equal(MANUAL_PAPER_CANONICAL_RUNTIME_BRIDGE_SAFETY.enabledByDefault, false);
});

test('enabled runtime bridge binds preserved eight-component entry cost evidence to the exact natural position', async () => {
  const state = createPaperTradingState(10_000, new Date(NOW));
  const position = naturalPosition();
  let issuedIdentity: any = null;
  const source = createManualPaperCanonicalRuntimeEvidenceSource({
    env: {
      DEPLOY_SHA: SHA,
      PAPER_CANONICAL_OWNER_BRIDGE_ENABLED: 'true',
    },
    dependencies: {
      async readPaperState() { return structuredClone(state); },
      async readRecurringState() { return { identity: { researchCodeSha: SHA }, positions: [position] }; },
      async issueValidationReceipt(identity) {
        issuedIdentity = structuredClone(identity);
        return validation(identity);
      },
    },
  });

  const evidence = await source(request({
    type: 'mark_price',
    eventId: 'mark-1',
    symbol: 'BTCUSDT',
    price: 100,
    at: new Date(NOW).toISOString(),
  }, state));
  assert.ok(evidence);
  const packet = evidence as any;
  assert.equal(packet.position.positionId, position.positionId);
  assert.equal(packet.candidate.candidateId, CANDIDATE_ID);
  assert.equal(packet.entryCostEvidence.status, 'PRESENT');
  assert.equal(packet.entryCostEvidence.fullCostReady, true);
  assert.equal(packet.entryCostEvidence.unknownIsZero, false);
  assert.equal(packet.entryCostEvidence.unavailableCostConvertedToZero, false);
  assert.equal(Object.keys(packet.entryCostEvidence.components).length, 8);
  for (const component of Object.values(packet.entryCostEvidence.components) as any[]) {
    assert.equal(component.positionId, position.positionId);
    assert.equal(component.paperSampleId, position.paperSampleId);
    assert.equal(component.policyIdentity.version, 'cost-v1');
    assert.deepEqual(component.identity, issuedIdentity);
  }
  assert.equal(issuedIdentity.researchCodeSha, SHA);
  assert.equal(issuedIdentity.side, 'LONG');
  assert.equal(issuedIdentity.leverage, 2);
});

test('enabled runtime bridge never converts a missing entry cost component to zero', async () => {
  const state = createPaperTradingState(10_000, new Date(NOW));
  const position = naturalPosition() as any;
  delete position.entryCostProvenance.components.partialFillImpact;
  const source = createManualPaperCanonicalRuntimeEvidenceSource({
    env: {
      DEPLOY_SHA: SHA,
      PAPER_CANONICAL_OWNER_BRIDGE_ENABLED: 'true',
    },
    dependencies: {
      async readPaperState() { return structuredClone(state); },
      async readRecurringState() { return { identity: { researchCodeSha: SHA }, positions: [position] }; },
      async issueValidationReceipt(identity) { return validation(identity); },
    },
  });

  await assert.rejects(
    () => source(request({ type: 'mark_price', eventId: 'mark-2', symbol: 'BTCUSDT', price: 100 }, state)),
    (error: unknown) => {
      assert.ok(error instanceof PaperTradingError);
      assert.equal(error.code, 'CANONICAL_PAPER_ENTRY_PARTIALFILLIMPACT_PROVENANCE_INCOMPLETE');
      return true;
    },
  );
});

test('close remains fail-closed until trigger-bound settlement readback is connected', async () => {
  const state = createPaperTradingState(10_000, new Date(NOW));
  const source = createManualPaperCanonicalRuntimeEvidenceSource({
    env: {
      DEPLOY_SHA: SHA,
      PAPER_CANONICAL_OWNER_BRIDGE_ENABLED: 'true',
    },
    dependencies: {
      async readPaperState() { return structuredClone(state); },
      async readRecurringState() { return { identity: { researchCodeSha: SHA }, positions: [naturalPosition()] }; },
      async issueValidationReceipt(identity) { return validation(identity); },
    },
  });

  await assert.rejects(
    () => source(request({ type: 'close_position', eventId: 'close-1', positionId: 'manual-position' }, state)),
    (error: unknown) => {
      assert.ok(error instanceof PaperTradingError);
      assert.equal(error.code, 'CANONICAL_PAPER_RUNTIME_SETTLEMENT_EVIDENCE_NOT_CONNECTED');
      assert.equal(error.statusCode, 503);
      return true;
    },
  );
});
