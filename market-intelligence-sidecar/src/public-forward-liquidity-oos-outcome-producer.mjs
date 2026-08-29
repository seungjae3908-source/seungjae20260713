import {
  canonicalJson,
  sha256,
} from './public-forward-liquidity-calibration.mjs';
import {
  validatePublicForwardLiquidityObservationIdentity,
} from './public-forward-liquidity-capture-ingest.mjs';
import {
  verifyPublicForwardLiquidityIngestReceiptChain,
} from './public-forward-liquidity-ingest-receipt-chain.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_RECEIPT_VERSION,
  validatePublicForwardLiquidityOosOutcomes,
} from './public-forward-liquidity-calibration-oos-outcome-validator.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_OOS_OUTCOME_ARTIFACT_VERSION =
  'public-forward-liquidity-held-out-oos-outcome-artifact-v1';
export const PUBLIC_FORWARD_LIQUIDITY_OOS_SELECTION_POLICY =
  'FIRST_PUBLIC_OBSERVATION_AT_OR_AFTER_HORIZON';

export const PUBLIC_FORWARD_LIQUIDITY_OOS_PRODUCER_SAFETY = Object.freeze({
  genuinePublicForwardOnly: true,
  completeIngestReceiptChainRequired: true,
  authenticatedSplitReceiptRequired: true,
  exactOneOutcomePerAssignment: true,
  duplicateFrameCreditAllowed: false,
  historicalBackfillCreditAllowed: false,
  replayCreditAllowed: false,
  syntheticCreditAllowed: false,
  independentSampleAuthority: false,
  calibrationArtifactProduced: false,
  liquidityImpactProduced: false,
  outcomeExecutionCostEligible: false,
  causalMarketImpactClaimAllowed: false,
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
  fullCostReady: false,
});

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 && normalized.length <= 512 ? normalized : null;
}

function exactDigest(value) {
  const normalized = text(value)?.replace(/^sha256:/u, '').toLowerCase() ?? null;
  return normalized && SHA256.test(normalized) ? normalized : null;
}

function exactCommitSha(value) {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && COMMIT_SHA.test(normalized) ? normalized : null;
}

function positiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function add(list, code) {
  if (!list.includes(code)) list.push(code);
}

function scopeIdentity(assignment) {
  const parts = typeof assignment?.scopeKey === 'string' ? assignment.scopeKey.split('|') : [];
  if (parts.length !== 6 || parts.some((part) => !text(part))) return null;
  const [market, symbol, side, quantityNotionalBucketIdentity, volatilityRegimeIdentity, liquidityRegimeIdentity] = parts;
  if (quantityNotionalBucketIdentity !== assignment.quantityNotionalBucketIdentity
    || volatilityRegimeIdentity !== assignment.volatilityRegimeIdentity
    || liquidityRegimeIdentity !== assignment.liquidityRegimeIdentity) return null;
  if (market !== 'CRYPTO_FUTURES' || !['BUY', 'SELL'].includes(side)) return null;
  return Object.freeze({ market, symbol, side });
}

function validateFrozenHorizon(methodology) {
  const blockers = [];
  if (!positiveInteger(methodology?.outcomeHorizonMs)) add(blockers, 'OOS_HORIZON_POLICY_MISSING');
  if (methodology?.outcomeSelectionPolicy !== PUBLIC_FORWARD_LIQUIDITY_OOS_SELECTION_POLICY) {
    add(blockers, 'OOS_HORIZON_SELECTION_POLICY_MISSING');
  }
  return blockers;
}

function validatePreflight({ splitReceipt, methodology, outcomeProducerCodeSha }) {
  const splitAudit = splitReceipt?.splitAudit ?? null;
  const result = validatePublicForwardLiquidityOosOutcomes({
    splitAudit,
    splitReceipt,
    outcomes: [],
    methodology,
    expectedOutcomeProducerCodeSha: outcomeProducerCodeSha,
  });
  if (result.status === 'BLOCKED_DATA'
    && result.blockers.length === 1
    && result.blockers[0] === 'OOS_OUTCOMES_MISSING') {
    return Object.freeze({ valid: true, blockers: Object.freeze([]), splitAudit });
  }
  return Object.freeze({
    valid: false,
    blockers: Object.freeze([...(result.blockers ?? ['OOS_PRODUCER_PREFLIGHT_INVALID'])]),
    splitAudit,
  });
}

function compareChainToUpstream(chain, upstream, blockers) {
  if (chain.schemaVersion !== upstream.ingestReceiptChainVersion) add(blockers, 'OOS_SOURCE_RECEIPT_CHAIN_VERSION_MISMATCH');
  if (chain.receiptChainDigest !== upstream.ingestReceiptChainDigest) add(blockers, 'OOS_SOURCE_RECEIPT_CHAIN_DIGEST_MISMATCH');
  if (chain.receiptCount !== upstream.ingestReceiptCount) add(blockers, 'OOS_SOURCE_RECEIPT_CHAIN_COUNT_MISMATCH');
  if (!sameArray(chain.receiptDigests, upstream.ingestReceiptDigests)) add(blockers, 'OOS_SOURCE_RECEIPT_CHAIN_RECEIPTS_MISMATCH');
  if (!sameArray(chain.artifactIds, upstream.artifactIds)) add(blockers, 'OOS_SOURCE_RECEIPT_CHAIN_ARTIFACT_IDS_MISMATCH');
  if (!sameArray(chain.artifactDigests, upstream.artifactDigests)) add(blockers, 'OOS_SOURCE_RECEIPT_CHAIN_ARTIFACT_DIGESTS_MISMATCH');
  if (!sameArray(chain.rawBatchDigests, upstream.rawBatchDigests)) add(blockers, 'OOS_SOURCE_RECEIPT_CHAIN_RAW_DIGESTS_MISMATCH');
  if (chain.collectorImplementationBlobSha !== upstream.collectorImplementationBlobSha) {
    add(blockers, 'OOS_SOURCE_COLLECTOR_IMPLEMENTATION_MISMATCH');
  }
  if (chain.finalReceiptDigest !== upstream.receiptDigest) add(blockers, 'OOS_SOURCE_FINAL_RECEIPT_MISMATCH');
  if (chain.finalDatasetDigest !== upstream.datasetDigest) add(blockers, 'OOS_SOURCE_FINAL_DATASET_MISMATCH');
}

function validateBoundSource({ source, upstream, assignment }) {
  const blockers = [];
  if (!object(source) || !object(source.dataset) || !Array.isArray(source.ingestReceipts)) {
    add(blockers, 'OOS_SOURCE_EVIDENCE_REQUIRED');
    return { blockers, observation: null };
  }
  if (source.dataset.datasetDigest !== assignment.sourceDatasetDigest
    || source.dataset.datasetDigest !== upstream.datasetDigest) {
    add(blockers, 'OOS_SOURCE_DATASET_DIGEST_MISMATCH');
  }
  if (source.dataset.collectorCodeSha !== assignment.sourceCollectorCodeSha
    || source.dataset.collectorCodeSha !== upstream.collectorCodeSha) {
    add(blockers, 'OOS_SOURCE_COLLECTOR_SHA_MISMATCH');
  }
  if (source.datasetRelativePath !== upstream.datasetRelativePath) {
    add(blockers, 'OOS_SOURCE_DATASET_PATH_MISMATCH');
  }
  try {
    const chain = verifyPublicForwardLiquidityIngestReceiptChain({
      dataset: source.dataset,
      ingestReceipts: source.ingestReceipts,
      datasetRelativePath: source.datasetRelativePath,
      collectorImplementationPath: upstream.collectorImplementationPath,
    });
    compareChainToUpstream(chain, upstream, blockers);
  } catch (error) {
    add(blockers, `OOS_SOURCE_RECEIPT_CHAIN_INVALID:${String(error?.message ?? error)}`);
  }

  const matches = source.dataset.observations?.filter(
    (observation) => observation?.observationId === assignment.sourceObservationId,
  ) ?? [];
  if (matches.length !== 1) {
    add(blockers, matches.length === 0 ? 'OOS_SOURCE_OBSERVATION_MISSING' : 'OOS_SOURCE_OBSERVATION_DUPLICATE');
    return { blockers, observation: null };
  }
  const observation = matches[0];
  try {
    const identity = validatePublicForwardLiquidityObservationIdentity(observation);
    if (identity.observationId !== assignment.sourceObservationId || identity.sourceDigest !== assignment.sourceDigest) {
      add(blockers, 'OOS_SOURCE_OBSERVATION_IDENTITY_MISMATCH');
    }
  } catch (error) {
    add(blockers, `OOS_SOURCE_OBSERVATION_IDENTITY_INVALID:${String(error?.message ?? error)}`);
  }
  return { blockers, observation };
}

function validateDrifts(observation, assignment) {
  const blockers = [];
  const drifts = observation?.subsequentPublicPriceDrift;
  if (!Array.isArray(drifts)) return { blockers: ['OOS_POST_EVENT_OBSERVATIONS_MISSING'], drifts: [] };
  const normalized = [];
  const identities = new Set();
  const rawDigests = new Set();
  for (const drift of drifts) {
    if (!object(drift)
      || drift.kind !== 'SUBSEQUENT_PUBLIC_PRICE_DRIFT'
      || drift.calibrationSourceOnly !== true
      || drift.executionCostEligible !== false
      || !text(drift.identity)
      || !positiveFinite(drift.marketTimestampMs)
      || drift.marketTimestampMs <= assignment.eventTimestampMs
      || !positiveFinite(drift.mid)
      || !exactDigest(drift.rawSourceDigest)
      || !exactDigest(drift.bookDigest)) {
      add(blockers, 'OOS_PUBLIC_FORWARD_OBSERVATION_INVALID');
      continue;
    }
    if (identities.has(drift.identity) || rawDigests.has(drift.rawSourceDigest)) {
      add(blockers, 'OOS_REPLAY_OUTCOME_SOURCE');
    }
    identities.add(drift.identity);
    rawDigests.add(drift.rawSourceDigest);
    normalized.push(drift);
  }
  normalized.sort((left, right) => left.marketTimestampMs - right.marketTimestampMs
    || left.identity.localeCompare(right.identity));
  return { blockers, drifts: normalized };
}

function blockedArtifact({ splitReceipt, methodology, outcomeProducerCodeSha, createdAtMs, blockers }) {
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_OOS_OUTCOME_ARTIFACT_VERSION,
    kind: 'public-forward-liquidity-held-out-oos-outcome-artifact',
    status: 'BLOCKED_DATA',
    blockers: Object.freeze([...new Set(blockers)]),
    producerCodeSha: exactCommitSha(outcomeProducerCodeSha) ?? null,
    createdAtMs: positiveFinite(createdAtMs) ? createdAtMs : null,
    splitReceiptVersion: splitReceipt?.schemaVersion ?? null,
    splitReceiptDigest: splitReceipt?.receiptDigest ?? null,
    splitAuditDigest: splitReceipt?.splitAuditDigest ?? null,
    splitPolicyDigest: splitReceipt?.splitPolicyDigest ?? null,
    independenceAuditDigest: splitReceipt?.independenceAuditDigest ?? null,
    independentSplitSourceDigest: splitReceipt?.independentSplitSourceDigest ?? null,
    upstreamLineageDigest: splitReceipt?.upstreamLineageDigest ?? null,
    scopeBindingsDigest: splitReceipt?.scopeBindingsDigest ?? null,
    regimeBindingsDigest: splitReceipt?.regimeBindingsDigest ?? null,
    datasetDigests: Object.freeze([...(splitReceipt?.datasetDigests ?? [])]),
    receiptDigests: Object.freeze([...(splitReceipt?.receiptDigests ?? [])]),
    collectorCodeShas: Object.freeze([...(splitReceipt?.collectorCodeShas ?? [])]),
    methodologyIdentity: methodology?.methodologyIdentity ?? null,
    methodologyDigest: methodology?.methodologyDigest ?? null,
    methodologyFrozenAtMs: methodology?.methodologyFrozenAtMs ?? null,
    outcomeHorizonIdentity: methodology?.outcomeHorizonIdentity ?? null,
    outcomeHorizonMs: methodology?.outcomeHorizonMs ?? null,
    outcomeSelectionPolicy: methodology?.outcomeSelectionPolicy ?? null,
    assignmentCount: 0,
    eligibleAssignmentCount: 0,
    matureAssignmentCount: 0,
    settledOutcomeCount: 0,
    missingOutcomeCount: 0,
    rejectedOutcomeCount: 0,
    buyOosCount: 0,
    sellOosCount: 0,
    exactOosCoverage: false,
    oosPolicyPass: false,
    oosStatus: 'MISSING_EVIDENCE',
    assignmentOutcomes: Object.freeze([]),
    outcomes: Object.freeze([]),
    validationDigest: null,
    effectiveIndependentN: null,
    buyCoverageProven: false,
    representativenessProven: false,
    calibrationArtifactProduced: false,
    liquidityImpactProduced: false,
    fullCostReady: false,
    evidenceCompleteCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    syntheticCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    safety: PUBLIC_FORWARD_LIQUIDITY_OOS_PRODUCER_SAFETY,
  };
  return Object.freeze({ ...body, outcomeArtifactDigest: sha256(canonicalJson(body)) });
}

export function producePublicForwardLiquidityHeldOutOosArtifact({
  splitReceipt,
  methodology,
  sources = [],
  outcomeProducerCodeSha,
  createdAtMs = Date.now(),
} = {}) {
  const basicBlockers = [];
  if (splitReceipt?.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_RECEIPT_VERSION) {
    add(basicBlockers, 'MULTI_SOURCE_SPLIT_RECEIPT_REQUIRED');
  }
  if (!exactCommitSha(outcomeProducerCodeSha)) add(basicBlockers, 'OOS_OUTCOME_PRODUCER_SHA_INVALID');
  if (!positiveFinite(createdAtMs)) add(basicBlockers, 'OOS_ARTIFACT_CREATED_AT_INVALID');
  validateFrozenHorizon(methodology).forEach((code) => add(basicBlockers, code));
  if (basicBlockers.length > 0) {
    return blockedArtifact({ splitReceipt, methodology, outcomeProducerCodeSha, createdAtMs, blockers: basicBlockers });
  }

  const preflight = validatePreflight({ splitReceipt, methodology, outcomeProducerCodeSha });
  if (!preflight.valid) {
    return blockedArtifact({ splitReceipt, methodology, outcomeProducerCodeSha, createdAtMs, blockers: preflight.blockers });
  }
  const splitAudit = preflight.splitAudit;
  const oosAssignments = splitAudit.assignments.filter((assignment) => assignment.split === 'OOS');
  const earliestOosEventMs = Math.min(...oosAssignments.map((assignment) => assignment.eventTimestampMs));
  if (!(methodology.methodologyFrozenAtMs < earliestOosEventMs)) {
    return blockedArtifact({
      splitReceipt,
      methodology,
      outcomeProducerCodeSha,
      createdAtMs,
      blockers: ['OOS_METHODOLOGY_NOT_FROZEN_BEFORE_OOS'],
    });
  }

  const sourceByDatasetDigest = new Map();
  for (const source of sources) {
    const digest = source?.dataset?.datasetDigest;
    if (!exactDigest(digest)) continue;
    if (sourceByDatasetDigest.has(digest)) {
      return blockedArtifact({
        splitReceipt,
        methodology,
        outcomeProducerCodeSha,
        createdAtMs,
        blockers: ['OOS_SOURCE_DATASET_DUPLICATE'],
      });
    }
    sourceByDatasetDigest.set(digest, source);
  }

  const usedOutcomeSourceDigests = new Set();
  const usedOutcomeSourceIdentities = new Set();
  const assignmentOutcomes = [];
  const outcomes = [];
  let eligibleAssignmentCount = 0;
  let matureAssignmentCount = 0;
  let pendingOutcomeCount = 0;
  let rejectedOutcomeCount = 0;

  for (const assignment of oosAssignments) {
    const rowBlockers = [];
    const scope = scopeIdentity(assignment);
    if (!scope) add(rowBlockers, 'OOS_ASSIGNMENT_SCOPE_IDENTITY_INVALID');
    const upstream = splitAudit.upstreamSources.find((item) => item.sourceIdentity === assignment.sourceIdentity);
    if (!upstream) add(rowBlockers, 'OOS_ASSIGNMENT_SOURCE_ORPHAN');
    const source = sourceByDatasetDigest.get(assignment.sourceDatasetDigest) ?? null;
    if (!source) add(rowBlockers, 'OOS_SOURCE_EVIDENCE_REQUIRED');

    let sourceObservation = null;
    if (upstream && source) {
      const validated = validateBoundSource({ source, upstream, assignment });
      validated.blockers.forEach((code) => add(rowBlockers, code));
      sourceObservation = validated.observation;
    }
    if (sourceObservation && scope) {
      if (sourceObservation.market !== scope.market) add(rowBlockers, 'OOS_OUTCOME_WRONG_MARKET');
      if (sourceObservation.symbol !== scope.symbol) add(rowBlockers, 'OOS_OUTCOME_WRONG_SYMBOL');
      if (sourceObservation.aggressiveSide !== scope.side) add(rowBlockers, 'OOS_OUTCOME_WRONG_SIDE');
      if (sourceObservation.eventTimestampMs !== assignment.eventTimestampMs) add(rowBlockers, 'OOS_OUTCOME_WRONG_ASSIGNMENT');
      if (sourceObservation.rawSourceProvenance?.publicTrade?.publicExecutionId !== assignment.publicExecutionId) {
        add(rowBlockers, 'OOS_OUTCOME_WRONG_PUBLIC_EXECUTION');
      }
      if (sourceObservation.sampleClass !== 'FORWARD_NATURAL_SAMPLE'
        || sourceObservation.forwardCalibrationSampleCredit !== 1
        || sourceObservation.historicalBackfillForwardCredit !== 0
        || sourceObservation.publicDataSource !== 'BITGET_PUBLIC_UTA_V3'
        || sourceObservation.calibrationSourceOnly !== true
        || sourceObservation.executionCostEligible !== false
        || sourceObservation.liquidityImpactCoefficient !== null
        || sourceObservation.causalMarketImpactClaim !== false
        || sourceObservation.paperOrderSourceAllowed !== false) {
        add(rowBlockers, 'OOS_NON_GENUINE_FORWARD_SOURCE');
      }
    }

    const targetObservedAtMs = assignment.eventTimestampMs + methodology.outcomeHorizonMs;
    let selected = null;
    let rowStatus = 'REJECTED';
    let rejectionReason = null;

    if (rowBlockers.length === 0) {
      eligibleAssignmentCount += 1;
      const driftValidation = validateDrifts(sourceObservation, assignment);
      driftValidation.blockers.forEach((code) => add(rowBlockers, code));
      if (rowBlockers.length === 0) {
        const candidates = driftValidation.drifts.filter((drift) => drift.marketTimestampMs >= targetObservedAtMs);
        if (candidates.length === 0) {
          rowStatus = 'PENDING_DATA';
          pendingOutcomeCount += 1;
          rejectionReason = 'NO_POST_FREEZE_PUBLIC_FORWARD_OBSERVATION_AT_HORIZON';
        } else {
          matureAssignmentCount += 1;
          const firstTimestamp = candidates[0].marketTimestampMs;
          const earliest = candidates.filter((drift) => drift.marketTimestampMs === firstTimestamp);
          if (earliest.length !== 1) {
            add(rowBlockers, 'AMBIGUOUS_DUPLICATE_OUTCOME');
          } else {
            selected = earliest[0];
            if (selected.marketTimestampMs <= methodology.methodologyFrozenAtMs) {
              add(rowBlockers, 'OOS_PRE_FREEZE_OUTCOME_FORBIDDEN');
            }
            if (usedOutcomeSourceDigests.has(selected.rawSourceDigest)
              || usedOutcomeSourceIdentities.has(selected.identity)) {
              add(rowBlockers, 'OOS_PUBLIC_FRAME_REUSED');
            }
          }
        }
      }
    }

    if (rowBlockers.length > 0) {
      rowStatus = 'REJECTED';
      rejectedOutcomeCount += 1;
      rejectionReason = rowBlockers[0];
      selected = null;
    }

    let outcome = null;
    if (selected && rowBlockers.length === 0) {
      usedOutcomeSourceDigests.add(selected.rawSourceDigest);
      usedOutcomeSourceIdentities.add(selected.identity);
      const outcomeIdentityInput = {
        splitReceiptDigest: splitReceipt.receiptDigest,
        observationId: assignment.observationId,
        outcomeSourceDigest: selected.rawSourceDigest,
        methodologyDigest: methodology.methodologyDigest,
      };
      outcome = Object.freeze({
        outcomeId: `liquidity-oos-outcome:${sha256(canonicalJson(outcomeIdentityInput))}`,
        observationId: assignment.observationId,
        referenceSourceDigest: assignment.sourceDigest,
        publicExecutionId: assignment.publicExecutionId,
        splitAuditDigest: splitAudit.auditDigest,
        splitReceiptDigest: splitReceipt.receiptDigest,
        sourceIdentity: assignment.sourceIdentity,
        sourceObservationId: assignment.sourceObservationId,
        sourceDatasetDigest: assignment.sourceDatasetDigest,
        sourceReceiptDigest: assignment.sourceReceiptDigest,
        sourceReceiptChainDigest: assignment.sourceReceiptChainDigest,
        sourceReceiptCount: assignment.sourceReceiptCount,
        sourceCollectorCodeSha: assignment.sourceCollectorCodeSha,
        upstreamLineageDigest: splitAudit.upstreamLineageDigest,
        independenceAuditDigest: splitAudit.independenceAuditDigest,
        independentSplitSourceDigest: splitAudit.independentSplitSourceDigest,
        splitPolicyDigest: splitAudit.splitPolicyDigest,
        scopeKey: assignment.scopeKey,
        referenceEventTimestampMs: assignment.eventTimestampMs,
        observedAtMs: selected.marketTimestampMs,
        sourceType: 'PUBLIC_FORWARD_MARKET_DATA',
        publicDataSource: sourceObservation.publicDataSource,
        outcomeSourceIdentity: selected.identity,
        outcomeSourceDigest: selected.rawSourceDigest,
        outcomeProducerCodeSha,
        observedPublicMidPrice: selected.mid,
        methodologyIdentity: methodology.methodologyIdentity,
        methodologyDigest: methodology.methodologyDigest,
        methodologyFrozenAtMs: methodology.methodologyFrozenAtMs,
        outcomeHorizonIdentity: methodology.outcomeHorizonIdentity,
        heldOut: true,
        contaminationFree: true,
        causalMarketImpactClaim: false,
        executionCostEligible: false,
        liquidityImpactCoefficient: null,
        historicalBackfillCredit: 0,
        testFixtureCredit: 0,
        naturalEntryCredit: 0,
        runtimeCostCredit: 0,
      });
      outcomes.push(outcome);
      rowStatus = 'SETTLED';
      rejectionReason = null;
    }

    assignmentOutcomes.push(Object.freeze({
      assignmentId: assignment.observationId,
      observationId: assignment.observationId,
      sourceObservationId: assignment.sourceObservationId,
      market: scope?.market ?? null,
      symbol: scope?.symbol ?? null,
      side: scope?.side ?? null,
      splitPolicyFrozenAtMs: splitAudit.splitPolicyFrozenAtMs ?? null,
      methodologyFrozenAtMs: methodology.methodologyFrozenAtMs,
      referenceEventTimestampMs: assignment.eventTimestampMs,
      targetObservedAtMs,
      outcomeObservationId: outcome?.outcomeId ?? null,
      outcomeObservedAtMs: outcome?.observedAtMs ?? null,
      sourceDatasetDigest: assignment.sourceDatasetDigest,
      sourceReceiptDigest: assignment.sourceReceiptDigest,
      sourceReceiptChainDigest: assignment.sourceReceiptChainDigest,
      sourceReceiptCount: assignment.sourceReceiptCount,
      sourceCollectorCodeSha: assignment.sourceCollectorCodeSha,
      outcomeStatus: rowStatus,
      rejectionReason,
    }));
  }

  const exactOosCoverage = outcomes.length === oosAssignments.length
    && pendingOutcomeCount === 0
    && rejectedOutcomeCount === 0;
  let validation = null;
  const finalBlockers = [];
  if (exactOosCoverage) {
    const result = validatePublicForwardLiquidityOosOutcomes({
      splitAudit,
      splitReceipt,
      outcomes,
      methodology,
      expectedOutcomeProducerCodeSha: outcomeProducerCodeSha,
    });
    if (result.status === 'PRESENT') validation = result.validation;
    else (result.blockers ?? []).forEach((code) => add(finalBlockers, code));
  } else {
    if (matureAssignmentCount === 0) add(finalBlockers, 'NO_MATURE_FROZEN_ASSIGNMENTS');
    if (pendingOutcomeCount > 0) add(finalBlockers, 'NO_POST_FREEZE_PUBLIC_FORWARD_OBSERVATIONS');
    if (rejectedOutcomeCount > 0) add(finalBlockers, 'OOS_OUTCOME_REJECTED');
  }

  const buyOosCount = assignmentOutcomes.filter((row) => row.outcomeStatus === 'SETTLED' && row.side === 'BUY').length;
  const sellOosCount = assignmentOutcomes.filter((row) => row.outcomeStatus === 'SETTLED' && row.side === 'SELL').length;
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_OOS_OUTCOME_ARTIFACT_VERSION,
    kind: 'public-forward-liquidity-held-out-oos-outcome-artifact',
    status: validation ? 'PRESENT' : 'BLOCKED_DATA',
    blockers: Object.freeze(finalBlockers),
    producerCodeSha: outcomeProducerCodeSha,
    createdAtMs,
    splitReceiptVersion: splitReceipt.schemaVersion,
    splitReceiptDigest: splitReceipt.receiptDigest,
    splitAuditDigest: splitAudit.auditDigest,
    splitPolicyDigest: splitAudit.splitPolicyDigest,
    independenceAuditDigest: splitAudit.independenceAuditDigest,
    independentSplitSourceDigest: splitAudit.independentSplitSourceDigest,
    upstreamLineageDigest: splitAudit.upstreamLineageDigest,
    scopeBindingsDigest: splitReceipt.scopeBindingsDigest,
    regimeBindingsDigest: splitReceipt.regimeBindingsDigest,
    datasetDigests: Object.freeze([...splitAudit.datasetDigests]),
    receiptDigests: Object.freeze([...splitAudit.receiptDigests]),
    receiptChainDigests: Object.freeze([...splitAudit.receiptChainDigests]),
    receiptCounts: Object.freeze([...splitAudit.receiptCounts]),
    collectorCodeShas: Object.freeze([...splitAudit.collectorCodeShas]),
    methodologyIdentity: methodology.methodologyIdentity,
    methodologyDigest: methodology.methodologyDigest,
    methodologyFrozenAtMs: methodology.methodologyFrozenAtMs,
    methodologyFrozenBeforeOos: methodology.methodologyFrozenAtMs < earliestOosEventMs,
    oosDataAccessBeforeFreeze: methodology.oosDataAccessBeforeFreeze,
    outcomeHorizonIdentity: methodology.outcomeHorizonIdentity,
    outcomeHorizonMs: methodology.outcomeHorizonMs,
    outcomeSelectionPolicy: methodology.outcomeSelectionPolicy,
    assignmentCount: oosAssignments.length,
    eligibleAssignmentCount,
    matureAssignmentCount,
    settledOutcomeCount: outcomes.length,
    missingOutcomeCount: pendingOutcomeCount,
    rejectedOutcomeCount,
    buyOosCount,
    sellOosCount,
    exactOosCoverage,
    oosPolicyPass: Boolean(validation),
    oosStatus: validation ? 'PRESENT' : 'MISSING_EVIDENCE',
    assignmentOutcomes: Object.freeze(assignmentOutcomes),
    outcomes: Object.freeze(outcomes),
    validationDigest: validation?.validationDigest ?? null,
    effectiveIndependentN: null,
    buyCoverageProven: false,
    representativenessProven: false,
    calibrationArtifactProduced: false,
    liquidityImpactProduced: false,
    fullCostReady: false,
    evidenceCompleteCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    syntheticCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    safety: PUBLIC_FORWARD_LIQUIDITY_OOS_PRODUCER_SAFETY,
  };
  return Object.freeze({ ...body, outcomeArtifactDigest: sha256(canonicalJson(body)) });
}
