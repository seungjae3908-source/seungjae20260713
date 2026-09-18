import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FAST_PROFITABILITY_FULL_COST_COMPONENTS,
  FAST_PROFITABILITY_MINIMUM_FUTURE_BUFFER_MS,
  buildFastProfitabilityProspectivePolicyV1,
  fastProfitabilitySha256,
} from '../../../market-prediction-lab/src/fast-profitability-prospective-policy-v1.js';
import {
  manualPaperEvidenceSha256,
  type ManualPaperCanonicalIdentity,
} from './manual-paper-canonical-contract.service';
import type { ScannerSignalCard } from './scanner-signal.types';
import {
  advanceForwardRecommendationObservation,
  prepareForwardRecommendationObservation,
  type ForwardObservationIdentity,
  type ForwardRecommendationObservation,
} from './forward-recommendation-observer.service';
import {
  FAST_PROFITABILITY_EXECUTION_CALIBRATION_CLASS,
  FAST_PROFITABILITY_FORWARD_EVIDENCE_CLASS,
  assertFastProfitabilityEightComponentFullCost,
  assertFastProfitabilityManualIdentity,
  buildFastProfitabilityForwardIndependenceProjection,
  createFastProfitabilityEvidenceStore,
  createFastProfitabilityParallelEvidenceBridge,
  createFastProfitabilityValidationReceiptBridge,
  fastProfitabilityEconomicEvidenceFromForwardObservation,
  routeFastProfitabilityCanonicalIndependentObservation,
  routeFastProfitabilityForwardRepresentative,
  type CanonicalIndependenceAudit,
  type FastProfitabilityAllocation,
  type FastProfitabilityPolicy,
} from './fast-profitability-evidence-runtime.service';

const FROZEN_AT = Date.parse('2026-09-18T08:00:00.000Z');
const ELIGIBLE_AT = FROZEN_AT + FAST_PROFITABILITY_MINIMUM_FUTURE_BUFFER_MS;
const CANDIDATE_ID = `paper-candidate-v1:${'1'.repeat(64)}`;
const PARAMETER_HASH = '2'.repeat(64);
const RESEARCH_SHA = '3'.repeat(40);

function policy(): FastProfitabilityPolicy {
  return buildFastProfitabilityProspectivePolicyV1({
    candidate: {
      candidateId: CANDIDATE_ID,
      strategyId: 'strategy:fast-profitability-v1',
      strategyVersion: '1.0.0',
      parameterHash: PARAMETER_HASH,
      researchCodeSha: RESEARCH_SHA,
      market: 'CRYPTO_FUTURES',
      symbol: 'BTCUSDT',
      timeframe: '15m',
      horizon: 8,
      side: 'LONG',
      riskPolicyRef: 'risk-policy:fast-v1',
      costPolicyRef: 'cost-policy:fast-v1',
      exitPolicyRef: 'exit-policy:fast-v1',
    },
    policyFrozenAtMs: FROZEN_AT,
    eligibleAfterMs: ELIGIBLE_AT,
  }) as FastProfitabilityPolicy;
}

function identity(): ManualPaperCanonicalIdentity {
  return Object.freeze({
    candidateId: CANDIDATE_ID,
    strategyId: 'strategy:fast-profitability-v1',
    parameterHash: PARAMETER_HASH,
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    timeframe: '15m',
    side: 'LONG',
    leverage: 3,
    parameterDigest: PARAMETER_HASH,
    signalDirection: 'LONG',
    accountMode: 'PAPER',
    researchCodeSha: RESEARCH_SHA,
  });
}

function forwardIdentity(p: FastProfitabilityPolicy): ForwardObservationIdentity {
  return Object.freeze({
    strategyId: p.candidate.strategyId,
    strategyVersion: p.candidate.strategyVersion,
    parameterHash: p.candidate.parameterHash,
    researchCodeSha: p.candidate.researchCodeSha,
    market: 'CRYPTO_FUTURES',
    symbol: p.candidate.symbol,
    timeframe: p.candidate.timeframe,
    horizon: p.candidate.horizon,
    direction: 'LONG',
  });
}

function forwardSignalAt(p: FastProfitabilityPolicy, index: number): number {
  const evaluationWindowMs = 15 * 60_000 * p.candidate.horizon;
  const blockSpanMs = evaluationWindowMs * 2;
  return p.eligibleAfterMs + index * blockSpanMs + 60_000;
}

function forwardCard(p: FastProfitabilityPolicy, index: number): ScannerSignalCard {
  const signalAtMs = forwardSignalAt(p, index);
  return {
    signalId: `fast-forward-${index}`,
    assetClass: 'coin_futures',
    market: 'CRYPTO_FUTURES',
    exchange: 'bitget',
    symbol: p.candidate.symbol,
    name: 'Bitcoin',
    currency: 'USDT',
    assetType: 'crypto',
    listingStatus: 'LISTED',
    price: 100,
    changePercent: 1,
    direction: 'LONG',
    action: 'LONG',
    signalState: 'CONFIRMED',
    score: 82,
    confidence: 76,
    dataCompleteness: 100,
    riskScore: 20,
    riskLevel: 'LOW',
    liquidity: 90,
    volume: 1000,
    tradingValue: 100000,
    spreadPercent: 0.1,
    volatilityPercent: 2,
    matched: ['trend'],
    notMatched: [],
    unverified: [],
    evidence: [],
    pricePlan: {
      entryZone: { from: 99, to: 101 },
      invalidation: 95,
      stopLoss: 95,
      targets: [105, 110],
      riskReward: 1.5,
    },
    dataState: 'complete',
    dataSources: ['bitget-public-v2'],
    observedAt: new Date(signalAtMs).toISOString(),
    expiresAt: new Date(signalAtMs + 2 * 60 * 60_000).toISOString(),
    strongSignalEligible: true,
    warnings: [],
    strategyMode: 'scalping',
    signalGrade: 'A',
    dataQuality: { state: 'TRUSTED', score: 100, strongSignalAllowed: true, issues: [] },
    quantScore: {
      technical: 80, trend: 85, momentum: 75, volume: 70,
      liquidity: 90, volatility: 65, marketRegime: 80, risk: 80,
    },
    aiValidation: {
      status: 'NOT_RUN', provider: null, counterEvidence: [],
      missingData: [], risks: [], explanation: null,
    },
    backtestQuality: {
      status: 'verified', regime: 'Bull', costsIncluded: true,
      slippageIncluded: true, lookaheadGuarded: true,
      survivorshipGuarded: true, oos: true, walkForward: true,
    },
  };
}

function preparedForward(p: FastProfitabilityPolicy, index: number): ForwardRecommendationObservation {
  const card = forwardCard(p, index);
  const prepared = prepareForwardRecommendationObservation({
    card,
    strategyIdentity: forwardIdentity(p),
    dataTimestamp: card.observedAt,
    dataMaxAgeMs: 60_000,
    publicDataOnly: true,
  });
  assert.equal(prepared.status, 'OBSERVATION_READY');
  assert.ok(prepared.observation);
  return prepared.observation;
}

function settledForward(
  p: FastProfitabilityPolicy,
  index: number,
  outcomeClass: 'TP' | 'SL' | 'EXPIRED',
): ForwardRecommendationObservation {
  const observation = preparedForward(p, index);
  const signalAtMs = Date.parse(observation.snapshot.timestamp);
  const expiryMs = Date.parse(observation.expiresAt);
  const bar = outcomeClass === 'TP'
    ? { timestamp: new Date(signalAtMs + 15 * 60_000).toISOString(), high: 106, low: 99, close: 105 }
    : outcomeClass === 'SL'
      ? { timestamp: new Date(signalAtMs + 15 * 60_000).toISOString(), high: 101, low: 94, close: 95 }
      : { timestamp: new Date(expiryMs).toISOString(), high: 102, low: 98, close: 100 };
  const evaluatedAt = outcomeClass === 'EXPIRED'
    ? new Date(expiryMs).toISOString()
    : bar.timestamp;
  const advanced = advanceForwardRecommendationObservation({
    observation,
    bars: [bar],
    evaluatedAt,
    evidenceCompleteThrough: evaluatedAt,
  });
  assert.equal(advanced.status, 'SETTLED');
  return advanced.observation;
}

function auditFor(
  p: FastProfitabilityPolicy,
  seed: string,
  timestampOffset = 1,
): CanonicalIndependenceAudit {
  const observationId = `observation:${seed}`;
  const eventIdentity = `event:${seed}`;
  const sourceFrameIdentity = `frame:${seed}`;
  const componentDigest = fastProfitabilitySha256(`component:${seed}`);
  const dependencyComponentId = `dependency-component:${componentDigest}`;
  const body = {
    schemaVersion: 'public-forward-liquidity-independence-audit-v1' as const,
    independentObservationRefs: [{
      observationId,
      eventIdentity,
      sourceFrameIdentity,
      dependencyComponentId,
    }],
    dependencyComponents: [{
      dependencyComponentId,
      representativeObservationId: observationId,
      representativeEventTimestampMs: p.eligibleAfterMs + timestampOffset,
      memberObservationIds: [observationId],
      maximumEffectiveIndependentCredit: 1,
    }],
  };
  return Object.freeze({
    ...body,
    auditDigest: fastProfitabilitySha256(body),
  });
}

function allocationForSplit(
  p: FastProfitabilityPolicy,
  split: 'VALIDATION' | 'SEALED_OOS',
  start = 0,
  outcomeClass: 'TP' | 'SL' | 'EXPIRED' = 'TP',
): {
  allocation: FastProfitabilityAllocation;
  observation: ForwardRecommendationObservation;
  economic: ReturnType<typeof fastProfitabilityEconomicEvidenceFromForwardObservation>;
} {
  for (let index = start; index < start + 1_000; index += 1) {
    const observation = settledForward(p, index, outcomeClass);
    const projection = buildFastProfitabilityForwardIndependenceProjection({
      policy: p,
      observations: [observation],
    });
    if (projection.components.length !== 1) continue;
    const allocation = routeFastProfitabilityForwardRepresentative({
      policy: p,
      projection,
      observationId: observation.observationId,
    });
    if (allocation.split !== split) continue;
    const economic = fastProfitabilityEconomicEvidenceFromForwardObservation({
      policy: p,
      allocation,
      observation,
    });
    return { allocation, observation, economic };
  }
  throw new Error(`no deterministic ${split} Forward fixture found`);
}
function fullCostFixture() {
  return {
    status: 'PRESENT',
    fullCostReady: true,
    unknownIsZero: false,
    executionAuthority: 'NONE',
    components: Object.fromEntries(FAST_PROFITABILITY_FULL_COST_COMPONENTS.map((name) => [
      name,
      {
        status: 'PRESENT',
        valuePercent: name === 'tax' ? 0 : 0.01,
        quality: name === 'tax' ? 'NOT_APPLICABLE' : 'OBSERVED',
        source: `source:${name}`,
        provenance: `provenance:${name}`,
      },
    ])),
  };
}

function parallelEnvelope(
  p: FastProfitabilityPolicy,
  lane: 'SHADOW' | 'NATURAL_PAPER',
  evidence: unknown,
) {
  return Object.freeze({
    lane,
    policyDigest: p.policyDigest,
    candidateDigest: p.candidateDigest,
    candidateId: p.candidate.candidateId,
    status: 'PRESENT',
    evidenceDigest: fastProfitabilitySha256(evidence),
    evidence,
    synthetic: false as const,
    replay: false as const,
    backfill: false as const,
    executionAuthority: 'NONE' as const,
    profitabilityClaimAllowed: false as const,
  });
}

test('routes only the canonical independent representative and binds allocation to the audit digest', () => {
  const p = policy();
  const audit = auditFor(p, 'canonical');
  const observationId = audit.independentObservationRefs[0]!.observationId;
  const allocation = routeFastProfitabilityCanonicalIndependentObservation({
    policy: p,
    independenceAudit: audit,
    observationId,
  });

  assert.ok(['VALIDATION', 'SEALED_OOS'].includes(allocation.split));
  assert.equal(allocation.evidenceClass, FAST_PROFITABILITY_EXECUTION_CALIBRATION_CLASS);
  assert.equal(allocation.independenceAuditDigest, audit.auditDigest);
  assert.equal(allocation.dependencyComponentId, audit.dependencyComponents[0]!.dependencyComponentId);
  assert.equal(allocation.outcomeConsulted, false);
  assert.equal(allocation.reassignmentAllowed, false);
  assert.equal(allocation.profitabilityCredit, 0);

  assert.throws(
    () => routeFastProfitabilityCanonicalIndependentObservation({
      policy: p,
      independenceAudit: { status: 'BLOCKED_DATA', audit },
      observationId,
    }),
    /FAST_PROFITABILITY_INDEPENDENCE_BLOCKED/,
  );

  assert.throws(
    () => routeFastProfitabilityCanonicalIndependentObservation({
      policy: p,
      independenceAudit: audit,
      observationId: 'dependent-not-representative',
    }),
    /FAST_PROFITABILITY_INDEPENDENT_REPRESENTATIVE_REQUIRED/,
  );
});

test('Forward representative router produces candidate-performance allocation and forged split metadata is rejected by store recomputation', async () => {
  const p = policy();
  const validation = allocationForSplit(p, 'VALIDATION', 10, 'TP');
  assert.equal(validation.allocation.evidenceClass, FAST_PROFITABILITY_FORWARD_EVIDENCE_CLASS);
  assert.equal(validation.allocation.publicEventIdentity, validation.observation.observationId);
  assert.equal(validation.economic.sourceObservationId, validation.observation.observationId);
  assert.equal(validation.economic.outcomeClass, 'TP');

  const root = await mkdtemp(path.join(os.tmpdir(), 'fast-profit-forged-'));
  try {
    const store = createFastProfitabilityEvidenceStore({
      validationRoot: path.join(root, 'validation'),
      sealedOosRoot: path.join(root, 'sealed'),
      sealingKey: randomBytes(32),
    });
    const forged = {
      ...validation.allocation,
      split: 'SEALED_OOS',
    } as FastProfitabilityAllocation;
    await assert.rejects(
      () => store.recordSealedOos({
        policy: p,
        allocation: forged,
        evidence: validation.economic,
        recordedAtMs: validation.economic.observedAtMs + 1,
      }),
      /FAST_PROFITABILITY_ALLOCATION_RECOMPUTE_MISMATCH/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Validation store is create-only while Sealed OOS is encrypted, idempotent, and hides economic outcome at rest', async () => {
  const p = policy();
  const validation = allocationForSplit(p, 'VALIDATION', 100);
  const sealed = allocationForSplit(p, 'SEALED_OOS', 100);
  const root = await mkdtemp(path.join(os.tmpdir(), 'fast-profit-store-'));
  try {
    const store = createFastProfitabilityEvidenceStore({
      validationRoot: path.join(root, 'validation'),
      sealedOosRoot: path.join(root, 'sealed'),
      sealingKey: Buffer.alloc(32, 7),
    });

    const validationRecord = await store.recordValidation({
      policy: p,
      allocation: validation.allocation,
      evidence: {
        outcomeClass: 'TP',
        observedAtMs: validation.allocation.observedAtMs,
        evidence: { netPnl: 2.5, fullCost: fullCostFixture() },
      },
      recordedAtMs: validation.allocation.observedAtMs + 1,
    });
    assert.equal(validationRecord.outcomeClass, 'TP');
    assert.equal(validationRecord.economicCreditCreated, false);
    assert.equal(validationRecord.profitabilityCredit, 0);

    const evidence = {
      outcomeClass: 'SL' as const,
      observedAtMs: sealed.allocation.observedAtMs,
      evidence: { netPnl: -123.456, secretMarker: 'SEALED_ECONOMIC_OUTCOME' },
    };
    const first = await store.recordSealedOos({
      policy: p,
      allocation: sealed.allocation,
      evidence,
      recordedAtMs: sealed.allocation.observedAtMs + 1,
    });
    const second = await store.recordSealedOos({
      policy: p,
      allocation: sealed.allocation,
      evidence,
      recordedAtMs: sealed.allocation.observedAtMs + 1,
    });
    assert.equal(first.recordDigest, second.recordDigest);
    assert.equal(first.ciphertext, second.ciphertext);
    assert.equal(first.economicOutcomeVisible, false);

    const filePath = path.join(
      root,
      'sealed',
      p.policyDigest,
      p.candidateDigest,
      'sealed-oos',
      `${sealed.allocation.allocationDigest}.json`,
    );
    const raw = await readFile(filePath, 'utf8');
    assert.equal(raw.includes('SEALED_ECONOMIC_OUTCOME'), false);
    assert.equal(raw.includes('-123.456'), false);
    assert.equal(raw.includes('"outcomeClass"'), false);

    const metadata = await store.readSealedMetadata({
      policy: p,
      allocationDigest: sealed.allocation.allocationDigest,
    });
    assert.equal(metadata.economicOutcomeVisible, false);
    assert.equal('outcomeClass' in metadata, false);

    await assert.rejects(
      () => store.recordSealedOos({
        policy: p,
        allocation: sealed.allocation,
        evidence: {
          ...evidence,
          evidence: { netPnl: 999 },
        },
        recordedAtMs: sealed.allocation.observedAtMs + 1,
      }),
      /FAST_PROFITABILITY_SEALED_OOS_IMMUTABLE_CONFLICT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reuses #1096 only when its receipt is cryptographically bound to the Fast durable Validation store before Sealed OOS reveal', async () => {
  const p = policy();
  const root = await mkdtemp(path.join(os.tmpdir(), 'fast-profit-receipt-'));
  try {
    const store = createFastProfitabilityEvidenceStore({
      validationRoot: path.join(root, 'validation'),
      sealedOosRoot: path.join(root, 'sealed'),
      sealingKey: Buffer.alloc(32, 11),
    });

    let validationCursor = 500;
    let sealedCursor = 500;
    let targetSealed: ReturnType<typeof allocationForSplit> | null = null;
    for (let index = 0; index < 30; index += 1) {
      const validation = allocationForSplit(p, 'VALIDATION', validationCursor);
      validationCursor += 100;
      await store.recordValidation({
        policy: p,
        allocation: validation.allocation,
        evidence: {
          outcomeClass: ['TP', 'SL', 'EXPIRED'][index % 3] as 'TP' | 'SL' | 'EXPIRED',
          observedAtMs: validation.allocation.observedAtMs,
          evidence: { result: `validation-receipt:${index}` },
        },
        recordedAtMs: validation.allocation.observedAtMs + 1,
      });

      const sealed = allocationForSplit(p, 'SEALED_OOS', sealedCursor);
      sealedCursor += 100;
      await store.recordSealedOos({
        policy: p,
        allocation: sealed.allocation,
        evidence: {
          outcomeClass: index === 0 ? 'TP' : ['TP', 'SL', 'EXPIRED'][index % 3] as 'TP' | 'SL' | 'EXPIRED',
          observedAtMs: sealed.allocation.observedAtMs,
          evidence: index === 0
            ? { netPnl: 4.25, source: 'sealed-oos-genuine' }
            : { result: `sealed-receipt:${index}` },
        },
        recordedAtMs: sealed.allocation.observedAtMs + 1,
      });
      if (index === 0) targetSealed = sealed;
    }
    assert.ok(targetSealed);

    const manualIdentity = identity();
    assert.doesNotThrow(() => assertFastProfitabilityManualIdentity(p, manualIdentity));

    const fastEvidence = await store.buildValidationEvidence(p, manualIdentity);
    assert.equal(fastEvidence.sampleSize, 30);
    assert.equal(fastEvidence.minimumSampleSize, 30);

    const foreignIssueReceipt = createFastProfitabilityValidationReceiptBridge({
      receiptRoot: path.join(root, 'foreign-receipts'),
      maximumAgeMs: 60_000,
      readValidationEvidence: async () => Object.freeze({
        ...fastEvidence,
        datasetDigest: '4'.repeat(64),
        resultArtifactDigest: '5'.repeat(64),
      }),
    });
    const foreignReceipt = await foreignIssueReceipt({
      policy: p,
      identity: manualIdentity,
      nowMs: fastEvidence.observedAtMs + 1,
    });
    const foreignSummary = await store.summarize(p, foreignReceipt);
    assert.equal(foreignSummary.validationReady, false);
    assert.equal(foreignSummary.sealedOosRevealAllowed, false);
    await assert.rejects(
      () => store.revealSealedOos({
        policy: p,
        allocationDigest: targetSealed!.allocation.allocationDigest,
        identity: manualIdentity,
        receipt: foreignReceipt.receipt,
        verification: foreignReceipt.verification,
        nowMs: fastEvidence.observedAtMs + 2,
      }),
      /FAST_PROFITABILITY_VALIDATION_RECEIPT_STORE_BINDING_MISMATCH/,
    );

    const issueReceipt = createFastProfitabilityValidationReceiptBridge({
      receiptRoot: path.join(root, 'receipts'),
      maximumAgeMs: 60_000,
      policy: p,
      store,
    });
    const receipt = await issueReceipt({
      policy: p,
      identity: manualIdentity,
      nowMs: fastEvidence.observedAtMs + 1,
    });
    assert.equal(receipt.verification.readbackVerified, true);
    assert.equal(receipt.verification.validationPassed, true);
    assert.equal(receipt.receipt.identity.candidateId, CANDIDATE_ID);
    assert.equal(receipt.receipt.datasetDigest, fastEvidence.datasetDigest);
    assert.equal(receipt.receipt.resultArtifactDigest, fastEvidence.resultArtifactDigest);

    const readySummary = await store.summarize(p, receipt);
    assert.equal(readySummary.validationReady, true);
    assert.equal(readySummary.sealedOosMinimumReached, true);
    assert.equal(readySummary.sealedOosRevealAllowed, true);

    const revealed = await store.revealSealedOos({
      policy: p,
      allocationDigest: targetSealed!.allocation.allocationDigest,
      identity: manualIdentity,
      receipt: receipt.receipt,
      verification: receipt.verification,
      nowMs: fastEvidence.observedAtMs + 2,
    });
    assert.equal(revealed.outcomeClass, 'TP');
    assert.deepEqual(revealed.evidence, { netPnl: 4.25, source: 'sealed-oos-genuine' });

    const invalidVerification = {
      ...receipt.verification,
      readbackVerified: false,
    } as unknown as typeof receipt.verification;
    await assert.rejects(
      () => store.revealSealedOos({
        policy: p,
        allocationDigest: targetSealed!.allocation.allocationDigest,
        identity: manualIdentity,
        receipt: receipt.receipt,
        verification: invalidVerification,
        nowMs: fastEvidence.observedAtMs + 2,
      }),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          'SAME_CANDIDATE_OWNER_VERIFIED_RECEIPT_REQUIRED',
        );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readiness comes from durable Validation/OOS stores and cannot reveal OOS before receipt verification', async () => {
  const p = policy();
  const root = await mkdtemp(path.join(os.tmpdir(), 'fast-profit-summary-'));
  try {
    const store = createFastProfitabilityEvidenceStore({
      validationRoot: path.join(root, 'validation'),
      sealedOosRoot: path.join(root, 'sealed'),
      sealingKey: Buffer.alloc(32, 13),
    });

    let validationCursor = 1000;
    let sealedCursor = 1000;
    for (let index = 0; index < 30; index += 1) {
      const validation = allocationForSplit(p, 'VALIDATION', validationCursor);
      validationCursor += 100;
      await store.recordValidation({
        policy: p,
        allocation: validation.allocation,
        evidence: {
          outcomeClass: ['TP', 'SL', 'EXPIRED'][index % 3] as 'TP' | 'SL' | 'EXPIRED',
          observedAtMs: validation.allocation.observedAtMs,
          evidence: { result: `validation:${index}` },
        },
        recordedAtMs: validation.allocation.observedAtMs + 1,
      });

      const sealed = allocationForSplit(p, 'SEALED_OOS', sealedCursor);
      sealedCursor += 100;
      await store.recordSealedOos({
        policy: p,
        allocation: sealed.allocation,
        evidence: {
          outcomeClass: ['TP', 'SL', 'EXPIRED'][index % 3] as 'TP' | 'SL' | 'EXPIRED',
          observedAtMs: sealed.allocation.observedAtMs,
          evidence: { result: `sealed:${index}` },
        },
        recordedAtMs: sealed.allocation.observedAtMs + 1,
      });
    }

    const beforeReceipt = await store.summarize(p);
    assert.equal(beforeReceipt.validationReady, false);
    assert.equal(beforeReceipt.sealedOosMinimumReached, true);
    assert.equal(beforeReceipt.sealedOosRevealAllowed, false);

    const manualIdentity = identity();
    const fastEvidence = await store.buildValidationEvidence(p, manualIdentity);
    const issueReceipt = createFastProfitabilityValidationReceiptBridge({
      receiptRoot: path.join(root, 'receipts'),
      maximumAgeMs: 60_000,
      policy: p,
      store,
    });
    const receipt = await issueReceipt({
      policy: p,
      identity: manualIdentity,
      nowMs: fastEvidence.observedAtMs + 1,
    });
    const afterReceipt = await store.summarize(p, receipt);
    assert.equal(afterReceipt.validationReady, true);
    assert.equal(afterReceipt.sealedOosMinimumReached, true);
    assert.equal(afterReceipt.sealedOosRevealAllowed, true);
    assert.equal(afterReceipt.status, 'SEALED_OOS_REVEAL_READY');
    assert.equal(afterReceipt.profitabilityCredit, 0);
    assert.equal(afterReceipt.profitabilityClaimAllowed, false);
    assert.equal(afterReceipt.championPromotionAllowed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parallel bridge collects Shadow and Natural Paper without granting credit while Settlement/Full Cost stay fail-closed when collector is absent', async () => {
  const p = policy();
  const validation = allocationForSplit(p, 'VALIDATION', 3000);
  const shadowEvidence = { owner: '#704/#815', observation: 'shadow-genuine' };
  const naturalEvidence = { owner: '#826/#828', observation: 'natural-paper-genuine' };
  const bridge = createFastProfitabilityParallelEvidenceBridge({
    async collectShadowEvidence() {
      return parallelEnvelope(p, 'SHADOW', shadowEvidence);
    },
    async collectNaturalPaperEvidence() {
      return parallelEnvelope(p, 'NATURAL_PAPER', naturalEvidence);
    },
  });

  const result = await bridge({
    policy: p,
    allocation: validation.allocation,
    observedAtMs: validation.allocation.observedAtMs,
  });
  assert.equal(result.status, 'PARALLEL_EVIDENCE_PARTIAL');
  assert.deepEqual(result.shadow?.evidence, shadowEvidence);
  assert.deepEqual(result.naturalPaper?.evidence, naturalEvidence);
  assert.ok(result.blockers.includes('FAST_PROFITABILITY_SETTLEMENT_COLLECTOR_NOT_CONNECTED'));
  assert.equal(result.fullCostReady, false);
  assert.equal(result.economicCreditCreated, false);
  assert.equal(result.naturalSampleCredit, 0);
  assert.equal(result.profitabilityCredit, 0);
  assert.equal(result.profitabilityClaimAllowed, false);
  assert.equal(result.executionAuthority, 'NONE');
});

test('all-eight Full Cost contract accepts only complete canonical cost evidence and never converts missing cost to zero', () => {
  const complete = fullCostFixture();
  const verified = assertFastProfitabilityEightComponentFullCost(complete);
  assert.equal(verified.fullCostReady, true);
  assert.deepEqual(
    Object.keys(verified.components as Record<string, unknown>).sort(),
    [...FAST_PROFITABILITY_FULL_COST_COMPONENTS].sort(),
  );

  const missing = structuredClone(complete);
  delete (missing.components as Record<string, unknown>).partialFillImpact;
  assert.throws(
    () => assertFastProfitabilityEightComponentFullCost(missing),
    /FAST_PROFITABILITY_FULL_COST_PARTIALFILLIMPACT_MISSING/,
  );

  const zeroFilledUnknown = structuredClone(complete);
  (zeroFilledUnknown.components as Record<string, any>).liquidityImpact = {
    status: 'MISSING',
    valuePercent: 0,
    source: 'fabricated-zero',
    provenance: 'none',
  };
  assert.throws(
    () => assertFastProfitabilityEightComponentFullCost(zeroFilledUnknown),
    /FAST_PROFITABILITY_FULL_COST_LIQUIDITYIMPACT_MISSING/,
  );
});

test('policy/manual identity mismatch fails before #1096 receipt or OOS reveal can run', () => {
  const p = policy();
  const wrong = {
    ...identity(),
    candidateId: `paper-candidate-v1:${'9'.repeat(64)}`,
  };
  assert.throws(
    () => assertFastProfitabilityManualIdentity(p, wrong),
    /FAST_PROFITABILITY_MANUAL_IDENTITY_MISMATCH/,
  );
});
