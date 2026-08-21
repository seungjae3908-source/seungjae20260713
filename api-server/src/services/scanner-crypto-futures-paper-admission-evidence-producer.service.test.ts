import test from 'node:test';
import assert from 'node:assert/strict';
import { createScannerCryptoFuturesPaperAdmissionEvidenceProducer } from './scanner-crypto-futures-paper-admission-evidence-producer.service';

const NOW = Date.parse('2026-08-21T00:00:00.000Z');
const SAFE_BUNDLE = Object.freeze({
  schemaVersion: 'scanner-paper-admission-evidence-bundle-v1',
  evidenceDigest: 'a'.repeat(64),
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
    blockers: [],
    ...safety(),
  } as never;
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

test('P0-C9 delegates exact authoritative evidence to the existing P0-C5 composer and returns only its canonical READY bundle', async () => {
  const { values, sources } = authoritativeSources();
  const capture: { input: Record<string, unknown> | null } = { input: null };
  const producer = createScannerCryptoFuturesPaperAdmissionEvidenceProducer({
    sources,
    now: () => NOW,
    maxEvidenceAgeMs: 45_000,
    compose: ((input: Record<string, unknown>) => {
      capture.input = input;
      return readyComposition();
    }) as never,
  });

  const result = await producer({
    card: Object.freeze({ id: 'card-1' }),
    market: 'CRYPTO_FUTURES',
    cycle: Object.freeze({ id: 'cycle-1' }),
  });

  assert.equal(result.status, 'READY');
  assert.equal(result.bundle, SAFE_BUNDLE);
  assert.deepEqual(result.blockers, []);
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
});

test('P0-C9 fails closed when any authoritative evidence source throws and does not invoke the composer', async () => {
  const { sources } = authoritativeSources();
  let composeCalls = 0;
  const producer = createScannerCryptoFuturesPaperAdmissionEvidenceProducer({
    sources: {
      ...(sources as Record<string, unknown>),
      publicEvidence: async () => {
        throw new Error('provider unavailable');
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
