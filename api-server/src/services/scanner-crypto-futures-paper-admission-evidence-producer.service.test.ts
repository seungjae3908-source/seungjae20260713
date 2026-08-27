import test from 'node:test';
import assert from 'node:assert/strict';
import { createScannerCryptoFuturesPaperAdmissionEvidenceProducer } from './scanner-crypto-futures-paper-admission-evidence-producer.service';

const NOW = Date.parse('2026-08-21T00:00:00.000Z');
const SAFE_BUNDLE = Object.freeze({
  schemaVersion: 'scanner-paper-admission-evidence-bundle-v1',
  evidenceDigest: 'a'.repeat(64),
  executionEvidence: Object.freeze({
    costPolicy: Object.freeze({
      spreadRate: 0.001,
      slippageRate: 0.0005,
      latencyRate: 0.0002,
      liquidityImpactRate: 0.0001,
      partialFillImpactRate: 0.0001,
    }),
  }),
  executionAuthority: 'NONE',
  simulatedOnly: true,
  liveOrderAllowed: false,
  privateTradingApiAllowed: false,
  orderSubmitted: false,
  exchangeRequestSent: false,
  productionMutationAllowed: false,
});

function safety() {
  return {
    executionAuthority: 'NONE',
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
  } as const;
}

function readyComposition(bundle: unknown = SAFE_BUNDLE) {
  return {
    status: 'READY',
    admissionResult: {
      status: 'READY',
      bundle,
      blockers: [],
      ...safety(),
    },
    riskInput: { slippageRate: 0.0005 },
    riskResult: { allowed: true, recommendedQuantity: 10, blockCodes: [] },
    blockers: [],
    ...safety(),
  } as never;
}

function parityPass(capture?: { slippageRate: number | null }) {
  return ((input: Record<string, unknown>) => {
    if (capture) capture.slippageRate = Number(input.slippageRate);
    return {
      allowed: true,
      recommendedQuantity: 10,
      blockCodes: [],
    };
  }) as never;
}

function authoritativeSources(counter?: { calls: number }) {
  const values = {
    paperCandidate: Object.freeze({ source: 'paper-candidate' }),
    learningSnapshot: Object.freeze({ source: 'learning-snapshot' }),
    paperState: Object.freeze({ source: 'paper-state' }),
    contractRules: Object.freeze({ source: 'contract-rules' }),
    publicEvidence: Object.freeze({ source: 'bitget-public' }),
    executionObservation: Object.freeze({ source: 'execution-observation' }),
    supplementalCostEvidence: Object.freeze({ source: 'supplemental-cost' }),
  };
  return {
    values,
    sources: Object.fromEntries(Object.entries(values).map(([key, value]) => [
      key,
      async () => {
        if (counter) counter.calls += 1;
        return value as never;
      },
    ])) as never,
  };
}

test('P0-C9 delegates exact authoritative evidence and rechecks the final execution-cost envelope before READY', async () => {
  const { values, sources } = authoritativeSources();
  const capture: { input: Record<string, unknown> | null } = { input: null };
  const parityCapture = { slippageRate: null as number | null };
  const producer = createScannerCryptoFuturesPaperAdmissionEvidenceProducer({
    sources,
    now: () => NOW,
    maxEvidenceAgeMs: 45_000,
    compose: ((input: Record<string, unknown>) => {
      capture.input = input;
      return readyComposition();
    }) as never,
    recalculateRisk: parityPass(parityCapture),
  });

  const result = await producer({
    card: Object.freeze({ id: 'card-1' }),
    market: 'CRYPTO_FUTURES',
    cycle: Object.freeze({ id: 'cycle-1' }),
  });

  assert.equal(result.status, 'READY');
  assert.equal(result.bundle, SAFE_BUNDLE);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.gateObservability.qualityGate.passed, true);
  assert.equal(result.gateObservability.riskGate.passed, true);
  assert.notEqual(result.gateObservability.qualityGate.provenance, result.gateObservability.riskGate.provenance);
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(result.liveOrderAllowed, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
  assert.ok(capture.input);
  const captured = capture.input as Record<string, unknown>;
  assert.equal(captured.paperCandidate, values.paperCandidate);
  assert.equal(captured.learningSnapshot, values.learningSnapshot);
  assert.equal(captured.paperState, values.paperState);
  assert.equal(captured.contractRules, values.contractRules);
  assert.equal(captured.publicEvidence, values.publicEvidence);
  assert.equal(captured.executionObservation, values.executionObservation);
  assert.equal(captured.supplementalCostEvidence, values.supplementalCostEvidence);
  assert.equal(captured.nowMs, NOW);
  assert.equal(captured.maxEvidenceAgeMs, 45_000);
  assert.ok(parityCapture.slippageRate != null);
  assert.ok(Math.abs(parityCapture.slippageRate - 0.0019) <= 1e-12);
});

test('P0-C9 blocks a canonical READY bundle when the full execution-cost envelope requires a smaller quantity', async () => {
  const { sources } = authoritativeSources();
  const producer = createScannerCryptoFuturesPaperAdmissionEvidenceProducer({
    sources,
    now: () => NOW,
    compose: (() => readyComposition()) as never,
    recalculateRisk: (() => ({
      allowed: true,
      recommendedQuantity: 9,
      blockCodes: [],
    })) as never,
  });

  const result = await producer({ card: {}, market: 'CRYPTO_FUTURES' });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.bundle, null);
  assert.deepEqual(result.blockers, ['P0_C9_RISK_COST_PARITY_MISMATCH']);
  assert.equal(result.gateObservability.qualityGate.passed, true);
  assert.equal(result.gateObservability.riskGate.passed, false);
  assert.equal(result.gateObservability.riskGate.evaluated, true);
  assert.equal(result.gateObservability.reasonObservations[0].canonicalReason, 'RISK_GATE');
});

test('P0-C9 preserves composer blockers and never upgrades missing authoritative evidence to a zero/no-trade result', async () => {
  const { sources } = authoritativeSources();
  const producer = createScannerCryptoFuturesPaperAdmissionEvidenceProducer({
    sources,
    now: () => NOW,
    compose: (() => ({
      status: 'BLOCKED',
      admissionResult: null,
      blockers: ['P0_C5_BITGET_PUBLIC_EVIDENCE_REQUIRED'],
      ...safety(),
    })) as never,
  });

  const result = await producer({ card: {}, market: 'CRYPTO_FUTURES' });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.bundle, null);
  assert.deepEqual(result.blockers, [
    'P0_C9_ADMISSION_COMPOSER_BLOCKED',
    'P0_C5_BITGET_PUBLIC_EVIDENCE_REQUIRED',
  ]);
  assert.equal(result.gateObservability.qualityGate.passed, false);
  assert.equal(result.gateObservability.riskGate.decision, 'NOT_REACHED');
  assert.equal(result.gateObservability.qualityGate.provenance.includes('pre-risk'), true);
});

test('P0-C9 identifies every missing authoritative source without converting it to a sample or safe default', async () => {
  const { sources } = authoritativeSources();
  let composeCalls = 0;
  const producer = createScannerCryptoFuturesPaperAdmissionEvidenceProducer({
    sources: {
      ...(sources as Record<string, unknown>),
      paperState: async () => null,
      contractRules: async () => null,
      executionObservation: async () => null,
      supplementalCostEvidence: async () => null,
    } as never,
    now: () => NOW,
    compose: (() => {
      composeCalls += 1;
      return readyComposition();
    }) as never,
  });

  const result = await producer({ card: { id: 'card-missing' }, market: 'CRYPTO_FUTURES' });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.blockers, ['P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING']);
  assert.equal(composeCalls, 0);
  assert.deepEqual(result.gateObservability.reasonObservations.map((row) => row.sourceCode), [
    'P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING:paperState',
    'P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING:contractRules',
    'P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING:executionObservation',
    'P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING:supplementalCostEvidence',
  ]);
  for (const observation of result.gateObservability.reasonObservations) {
    assert.equal(observation.canonicalReason, 'DATA_MISSING');
    assert.equal(observation.lossless, true);
    assert.equal(observation.identity.observationId, 'card-missing');
    assert.equal(observation.naturalCredit, 0);
    assert.equal(observation.replayCredit, 0);
    assert.equal(observation.duplicateCredit, 0);
  }
  assert.equal(result.gateObservability.qualityGate.status, 'UNKNOWN');
  assert.equal(result.gateObservability.riskGate.status, 'UNKNOWN');
});

test('P0-C9 fails closed when any authoritative evidence source throws and does not invoke the composer', async () => {
  const { sources } = authoritativeSources();
  let composeCalls = 0;
  const sensitiveMessage = 'provider unavailable secret-token-should-never-escape';
  const producer = createScannerCryptoFuturesPaperAdmissionEvidenceProducer({
    sources: {
      ...(sources as Record<string, unknown>),
      publicEvidence: async () => {
        throw new Error(sensitiveMessage);
      },
    } as never,
    now: () => NOW,
    compose: (() => {
      composeCalls += 1;
      return readyComposition();
    }) as never,
  });

  const result = await producer({ card: {}, market: 'CRYPTO_FUTURES' });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.blockers, ['P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_FAILED']);
  assert.equal(composeCalls, 0);
  assert.equal(result.gateObservability.qualityGate.status, 'UNKNOWN');
  assert.equal(result.gateObservability.riskGate.status, 'UNKNOWN');
  assert.equal(result.gateObservability.reasonObservations[0].sourceCode, 'P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_FAILED:publicEvidence');
  assert.equal(result.gateObservability.reasonObservations[0].canonicalReason, 'UNKNOWN');
  assert.equal(result.gateObservability.reasonObservations[0].lossless, true);
  assert.equal(JSON.stringify(result).includes(sensitiveMessage), false);
});

test('P0-C9 owns CRYPTO_FUTURES only and does not touch evidence sources for another market', async () => {
  const counter = { calls: 0 };
  const { sources } = authoritativeSources(counter);
  const producer = createScannerCryptoFuturesPaperAdmissionEvidenceProducer({
    sources,
    now: () => NOW,
    compose: (() => readyComposition()) as never,
  });

  const result = await producer({ card: {}, market: 'CRYPTO_SPOT' });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.blockers, ['P0_C9_MARKET_NOT_OWNED']);
  assert.equal(counter.calls, 0);
});

test('P0-C9 rejects a nominal READY bundle that violates the no-live/no-private safety envelope', async () => {
  const { sources } = authoritativeSources();
  const unsafeBundle = Object.freeze({ ...SAFE_BUNDLE, liveOrderAllowed: true });
  const producer = createScannerCryptoFuturesPaperAdmissionEvidenceProducer({
    sources,
    now: () => NOW,
    compose: (() => readyComposition(unsafeBundle)) as never,
  });

  const result = await producer({ card: {}, market: 'CRYPTO_FUTURES' });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.blockers, ['P0_C9_CANONICAL_ADMISSION_BUNDLE_INVALID']);
  assert.equal(result.bundle, null);
});
