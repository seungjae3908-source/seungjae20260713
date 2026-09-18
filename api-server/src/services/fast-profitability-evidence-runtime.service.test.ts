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
import type {
  ManualPaperCanonicalIdentity,
} from './manual-paper-canonical-contract.service';
import {
  assertFastProfitabilityEightComponentFullCost,
  assertFastProfitabilityManualIdentity,
  createFastProfitabilityEvidenceStore,
  createFastProfitabilityParallelEvidenceBridge,
  createFastProfitabilityValidationReceiptBridge,
  routeFastProfitabilityCanonicalIndependentObservation,
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
): { allocation: FastProfitabilityAllocation; audit: CanonicalIndependenceAudit; observationId: string } {
  for (let index = start; index < start + 20_000; index += 1) {
    const seed = `${split.toLowerCase()}:${index}`;
    const audit = auditFor(p, seed, index + 1);
    const observationId = audit.independentObservationRefs[0]!.observationId;
    const allocation = routeFastProfitabilityCanonicalIndependentObservation({
      policy: p,
      independenceAudit: audit,
      observationId,
    });
    if (allocation.split === split) return { allocation, audit, observationId };
  }
  throw new Error(`no deterministic ${split} fixture found`);
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

test('same dependency component always resolves to the same split and forged split metadata is rejected by store recomputation', async () => {
  const p = policy();
  const validation = allocationForSplit(p, 'VALIDATION');
  const sameAudit = structuredClone(validation.audit);
  sameAudit.independentObservationRefs[0]!.eventIdentity = 'different-event-same-component';
  sameAudit.independentObservationRefs[0]!.sourceFrameIdentity = 'different-frame-same-component';
  sameAudit.auditDigest = fastProfitabilitySha256({
    independentObservationRefs: sameAudit.independentObservationRefs,
    dependencyComponents: sameAudit.dependencyComponents,
  });
  const second = routeFastProfitabilityCanonicalIndependentObservation({
    policy: p,
    independenceAudit: sameAudit,
    observationId: validation.observationId,
  });
  assert.equal(second.split, validation.allocation.split);
  assert.equal(second.allocationDigest, validation.allocation.allocationDigest);

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
        evidence: {
          outcomeClass: 'TP',
          observedAtMs: forged.observedAtMs,
          evidence: { netPnl: 1 },
        },
        recordedAtMs: forged.observedAtMs + 1,
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

test('reuses the existing #1096 receipt owner and requires that verified same-candidate receipt before Sealed OOS reveal', async () => {
  const p = policy();
  const sealed = allocationForSplit(p, 'SEALED_OOS', 500);
  const root = await mkdtemp(path.join(os.tmpdir(), 'fast-profit-receipt-'));
  try {
    const store = createFastProfitabilityEvidenceStore({
      validationRoot: path.join(root, 'validation'),
      sealedOosRoot: path.join(root, 'sealed'),
      sealingKey: Buffer.alloc(32, 11),
    });
    await store.recordSealedOos({
      policy: p,
      allocation: sealed.allocation,
      evidence: {
        outcomeClass: 'TP',
        observedAtMs: sealed.allocation.observedAtMs,
        evidence: { netPnl: 4.25, source: 'sealed-oos-genuine' },
      },
      recordedAtMs: sealed.allocation.observedAtMs + 1,
    });

    const manualIdentity = identity();
    assert.doesNotThrow(() => assertFastProfitabilityManualIdentity(p, manualIdentity));

    const receiptObservedAtMs = sealed.allocation.observedAtMs + 10;
    const issueReceipt = createFastProfitabilityValidationReceiptBridge({
      receiptRoot: path.join(root, 'receipts'),
      maximumAgeMs: 60_000,
      readValidationEvidence: async (actualIdentity) => {
        assert.deepEqual(actualIdentity, manualIdentity);
        return Object.freeze({
          source: 'FORWARD_RECOMMENDATION_OBSERVER',
          provenance: 'PROSPECTIVE_PUBLIC_FORWARD',
          observedAtMs: receiptObservedAtMs,
          prospectiveBoundaryMs: p.eligibleAfterMs,
          oosBoundaryProven: true as const,
          sampleSize: 30,
          minimumSampleSize: 30,
          datasetDigest: '4'.repeat(64),
          resultArtifactDigest: '5'.repeat(64),
        });
      },
    });
    const receipt = await issueReceipt({
      policy: p,
      identity: manualIdentity,
      nowMs: receiptObservedAtMs + 1,
    });
    assert.equal(receipt.verification.readbackVerified, true);
    assert.equal(receipt.verification.validationPassed, true);
    assert.equal(receipt.receipt.candidateId, undefined);
    assert.equal(receipt.receipt.identity.candidateId, CANDIDATE_ID);

    const revealed = await store.revealSealedOos({
      policy: p,
      allocationDigest: sealed.allocation.allocationDigest,
      identity: manualIdentity,
      receipt: receipt.receipt,
      verification: receipt.verification,
      nowMs: receiptObservedAtMs + 2,
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
        allocationDigest: sealed.allocation.allocationDigest,
        identity: manualIdentity,
        receipt: receipt.receipt,
        verification: invalidVerification,
        nowMs: receiptObservedAtMs + 2,
      }),
      /SAME_CANDIDATE_OWNER_VERIFIED_RECEIPT_REQUIRED/,
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
    const issueReceipt = createFastProfitabilityValidationReceiptBridge({
      receiptRoot: path.join(root, 'receipts'),
      maximumAgeMs: 60_000,
      readValidationEvidence: async () => Object.freeze({
        source: 'FORWARD_RECOMMENDATION_OBSERVER',
        provenance: 'PROSPECTIVE_PUBLIC_FORWARD',
        observedAtMs: ELIGIBLE_AT + 50_000,
        prospectiveBoundaryMs: ELIGIBLE_AT,
        oosBoundaryProven: true as const,
        sampleSize: 30,
        minimumSampleSize: 30,
        datasetDigest: '6'.repeat(64),
        resultArtifactDigest: '7'.repeat(64),
      }),
    });
    const receipt = await issueReceipt({
      policy: p,
      identity: manualIdentity,
      nowMs: ELIGIBLE_AT + 50_001,
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
