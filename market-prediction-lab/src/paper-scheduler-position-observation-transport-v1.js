export const PAPER_SCHEDULER_POSITION_OBSERVATION_TRANSPORT_VERSION =
  "paper-scheduler-position-observation-transport-v1";

const NATURAL_FORWARD = "NATURAL_FORWARD";
const REQUIRED_COST_COMPONENTS = Object.freeze([
  "fees",
  "spread",
  "slippage",
  "funding",
  "latency",
  "liquidityImpact",
  "partialFillImpact",
]);

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function immutableSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value);
}

function digest64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/iu.test(value);
}

function freezeClone(value) {
  const cloned = structuredClone(value);
  const freeze = (item) => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return item;
    for (const child of Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(cloned);
}

function add(blockers, market, code, positionId = null, observationId = null) {
  blockers.push(Object.freeze({ market, code, positionId, observationId }));
}

export function openPositionsForSchedulerMarket(state, market) {
  if (!Array.isArray(state?.positions)) return Object.freeze([]);
  return Object.freeze(state.positions
    .filter((position) => position?.lifecycleState === "OPEN" && position?.market === market)
    .map((position) => freezeClone(position)));
}

function accountIdentity(state) {
  const binding = state?.ledger?.accountBinding;
  if (!binding
    || !nonEmpty(binding.accountId)
    || !digest64(binding.publisherAccountIdSha256)
    || !immutableSha(binding.sourceSha)) return null;
  return Object.freeze({
    accountId: binding.accountId,
    publisherAccountIdSha256: binding.publisherAccountIdSha256.toLowerCase(),
    sourceSha: binding.sourceSha.toLowerCase(),
  });
}

function riskPolicyIdentity(position) {
  const value = position?.riskPolicyIdentity
    ?? position?.lifecycle?.riskPolicyIdentity
    ?? position?.sample?.riskPolicyIdentity;
  if (!value
    || !nonEmpty(value.policyId)
    || !nonEmpty(value.policyVersion)
    || !nonEmpty(value.recordId)
    || !nonEmpty(value.recordVersion)
    || !nonEmpty(value.source)
    || !immutableSha(value.researchCodeSha)) return null;
  return Object.freeze({
    policyId: value.policyId,
    policyVersion: value.policyVersion,
    recordId: value.recordId,
    recordVersion: value.recordVersion,
    source: value.source,
    researchCodeSha: value.researchCodeSha.toLowerCase(),
  });
}

function sameAccountIdentity(left, right) {
  return Boolean(left && right
    && left.accountId === right.accountId
    && String(left.publisherAccountIdSha256).toLowerCase() === right.publisherAccountIdSha256
    && String(left.sourceSha).toLowerCase() === right.sourceSha);
}

function sameRiskIdentity(left, right) {
  return Boolean(left && right
    && left.policyId === right.policyId
    && left.policyVersion === right.policyVersion
    && left.recordId === right.recordId
    && left.recordVersion === right.recordVersion
    && left.source === right.source
    && String(left.researchCodeSha).toLowerCase() === right.researchCodeSha);
}

function entryProvenance(position) {
  const value = position?.sample?.entryEvidenceProvenance;
  if (value?.schemaVersion !== "paper-evidence-provenance-v1"
    || !digest64(value.provenanceDigest)
    || !digest64(value.evidenceSnapshotDigest)
    || !nonEmpty(value.provider)
    || !nonEmpty(value.provenance)
    || value.publicOnly !== true
    || value.dataQuality !== "READY"
    || !finite(value.asOfMs)) return null;
  return value;
}

function sameEntryProvenance(left, right) {
  return Boolean(left && right
    && right.schemaVersion === left.schemaVersion
    && String(right.provenanceDigest).toLowerCase() === left.provenanceDigest.toLowerCase()
    && String(right.evidenceSnapshotDigest).toLowerCase() === left.evidenceSnapshotDigest.toLowerCase()
    && right.provider === left.provider
    && right.provenance === left.provenance
    && right.asOfMs === left.asOfMs);
}

function cycleIdentityMatches(observation, cycle, position) {
  const value = observation?.cycleIdentity;
  return Boolean(value
    && value.cycleId === cycle?.cycleId
    && value.strategyId === position.strategyId
    && value.strategyVersion === position.strategyVersion
    && value.parameterHash === position.parameterHash
    && immutableSha(value.researchCodeSha)
    && value.researchCodeSha.toLowerCase() === position.researchCodeSha.toLowerCase()
    && value.costPolicyVersion === position.costPolicyVersion);
}

function observationIdentityMatches(observation, position) {
  return Boolean(observation
    && observation.positionId === position.positionId
    && observation.paperSampleId === position.paperSampleId
    && observation.signalId === position.signalId
    && observation.market === position.market
    && observation.symbol === position.symbol
    && observation.direction === position.direction
    && observation.strategyId === position.strategyId
    && observation.strategyVersion === position.strategyVersion
    && observation.parameterHash === position.parameterHash
    && immutableSha(observation.researchCodeSha)
    && observation.researchCodeSha.toLowerCase() === position.researchCodeSha.toLowerCase()
    && observation.costPolicyVersion === position.costPolicyVersion);
}

function genuineNaturalObservation(observation) {
  const natural = observation?.naturalEvidence;
  return Boolean(natural
    && natural.provenanceClass === NATURAL_FORWARD
    && natural.synthetic === false
    && natural.replay === false
    && natural.backfill === false
    && natural.duplicate === false
    && natural.testOnly === false
    && nonEmpty(natural.observationId)
    && natural.observationId === observation.observationId
    && nonEmpty(natural.source)
    && natural.source === observation.source
    && nonEmpty(natural.provenance)
    && natural.provenance === observation.provenance
    && natural.observedAtMs === observation.observedAtMs);
}

function validBar(bar) {
  return positive(bar?.open)
    && positive(bar?.high)
    && positive(bar?.low)
    && positive(bar?.close)
    && bar.high >= bar.low
    && bar.open >= bar.low
    && bar.open <= bar.high
    && bar.close >= bar.low
    && bar.close <= bar.high;
}

function fullCostReady(observation, evaluatedAtMs, position) {
  const cost = observation?.settlementCostEvidence;
  if (!cost
    || !nonEmpty(cost.schemaVersion)
    || cost.status !== "PRESENT"
    || cost.fullCostReady !== true
    || cost.unknownIsZero !== false
    || cost.unavailableCostConvertedToZero !== false
    || cost?.supplementalCostInput?.costPolicyId !== position.costPolicyVersion) return false;
  if (!positive(observation?.maxAgeMs)) return false;
  return REQUIRED_COST_COMPONENTS.every((name) => {
    const component = cost?.components?.[name];
    return component?.state === "PRESENT"
      && component.countsAsExecutionCost === true
      && finite(component.value)
      && nonEmpty(component.unit)
      && nonEmpty(component.quality)
      && nonEmpty(component.source)
      && finite(component.observedAtMs)
      && component.observedAtMs <= evaluatedAtMs
      && evaluatedAtMs - component.observedAtMs <= observation.maxAgeMs;
  });
}

function settlementInputsReady(observation) {
  return Boolean(observation?.settlementInput?.exitExecution
    && observation.settlementInput.fundingEvidence?.complete === true
    && Array.isArray(observation.settlementInput.fundingEvidence.payments));
}

function positionNaturalEntryReady(position) {
  return position?.lifecycle?.sampleEligibility?.provenanceClass === NATURAL_FORWARD
    && position?.lifecycle?.sampleEligibility?.entryObservationId != null
    && position?.lifecycle?.sampleEligibility?.testOnlySampleCredit === 0;
}

function validateObservation({ observation, position, cycle, state, evaluatedAtMs, market, blockers }) {
  const positionId = position?.positionId ?? null;
  const observationId = observation?.observationId ?? null;
  if (!nonEmpty(observationId)) add(blockers, market, "PAPER_POSITION_OBSERVATION_ID_REQUIRED", positionId, observationId);
  if (!observationIdentityMatches(observation, position)) add(blockers, market, "PAPER_POSITION_OBSERVATION_IDENTITY_MISMATCH", positionId, observationId);
  if (!cycleIdentityMatches(observation, cycle, position)) add(blockers, market, "PAPER_POSITION_OBSERVATION_CYCLE_IDENTITY_MISMATCH", positionId, observationId);
  if (observation?.publicOnly !== true || !nonEmpty(observation?.source) || !nonEmpty(observation?.provenance)) {
    add(blockers, market, "PAPER_POSITION_PUBLIC_PROVENANCE_REQUIRED", positionId, observationId);
  }
  if (!Number.isSafeInteger(observation?.observedAtMs)
    || observation.observedAtMs <= position.entryTimestampMs
    || observation.observedAtMs > evaluatedAtMs
    || !positive(observation?.maxAgeMs)
    || evaluatedAtMs - observation.observedAtMs > observation.maxAgeMs) {
    add(blockers, market, "PAPER_POSITION_OBSERVATION_TIME_INVALID", positionId, observationId);
  }
  if (!validBar(observation?.bar)) add(blockers, market, "PAPER_POSITION_MARK_BAR_INVALID", positionId, observationId);
  if (!genuineNaturalObservation(observation)) add(blockers, market, "PAPER_POSITION_NATURAL_PROVENANCE_INVALID", positionId, observationId);
  if (!positionNaturalEntryReady(position)) add(blockers, market, "PAPER_POSITION_GENUINE_ENTRY_PROVENANCE_MISSING", positionId, observationId);

  const entry = entryProvenance(position);
  if (!entry || !sameEntryProvenance(entry, observation?.entryEvidenceProvenance)) {
    add(blockers, market, "PAPER_POSITION_ENTRY_PROVENANCE_MISMATCH", positionId, observationId);
  }

  const expectedAccount = accountIdentity(state);
  if (!expectedAccount) {
    add(blockers, market, "PAPER_POSITION_ACCOUNT_IDENTITY_MISSING", positionId, observationId);
  } else if (!sameAccountIdentity(observation?.accountIdentity, expectedAccount)) {
    add(blockers, market, "PAPER_POSITION_ACCOUNT_IDENTITY_MISMATCH", positionId, observationId);
  }

  const expectedRiskPolicy = riskPolicyIdentity(position);
  if (!expectedRiskPolicy) {
    add(blockers, market, "PAPER_POSITION_RISK_POLICY_IDENTITY_MISSING", positionId, observationId);
  } else if (!sameRiskIdentity(observation?.riskPolicyIdentity, expectedRiskPolicy)) {
    add(blockers, market, "PAPER_POSITION_RISK_POLICY_IDENTITY_MISMATCH", positionId, observationId);
  }

  if (!fullCostReady(observation, evaluatedAtMs, position)) {
    add(blockers, market, "PAPER_POSITION_FULL_COST_EVIDENCE_MISSING", positionId, observationId);
  }
  if (!settlementInputsReady(observation)) {
    add(blockers, market, "PAPER_POSITION_SETTLEMENT_INPUT_EVIDENCE_MISSING", positionId, observationId);
  }
}

export function validatePaperSchedulerPositionObservationTransport({
  state,
  cycle,
  lanes,
  evaluatedAtMs,
} = {}) {
  const blockers = [];
  const validated = [];
  if (!state || !Array.isArray(state.positions)) {
    return Object.freeze({
      schemaVersion: PAPER_SCHEDULER_POSITION_OBSERVATION_TRANSPORT_VERSION,
      status: "BLOCKED_DATA",
      positionObservations: Object.freeze([]),
      blockers: Object.freeze([Object.freeze({ market: null, code: "PAPER_POSITION_STATE_MISSING", positionId: null, observationId: null })]),
    });
  }
  if (!cycle || !nonEmpty(cycle.cycleId) || !finite(evaluatedAtMs)) {
    return Object.freeze({
      schemaVersion: PAPER_SCHEDULER_POSITION_OBSERVATION_TRANSPORT_VERSION,
      status: "BLOCKED_DATA",
      positionObservations: Object.freeze([]),
      blockers: Object.freeze([Object.freeze({ market: null, code: "PAPER_POSITION_CYCLE_IDENTITY_MISSING", positionId: null, observationId: null })]),
    });
  }
  if (!Array.isArray(lanes)) {
    return Object.freeze({
      schemaVersion: PAPER_SCHEDULER_POSITION_OBSERVATION_TRANSPORT_VERSION,
      status: "BLOCKED_DATA",
      positionObservations: Object.freeze([]),
      blockers: Object.freeze([Object.freeze({ market: null, code: "PAPER_POSITION_PROVIDER_LANES_MISSING", positionId: null, observationId: null })]),
    });
  }

  const seenObservationIds = new Set();
  for (const lane of lanes) {
    const market = lane?.market ?? null;
    const positions = openPositionsForSchedulerMarket(state, market);
    const supplied = lane?.result?.positionObservations;
    if (positions.length === 0) {
      if (Array.isArray(supplied) && supplied.length > 0) {
        for (const observation of supplied) {
          add(blockers, market, "PAPER_POSITION_UNEXPECTED_OBSERVATION", null, observation?.observationId ?? null);
        }
      } else if (supplied != null && !Array.isArray(supplied)) {
        add(blockers, market, "PAPER_POSITION_OBSERVATION_PAYLOAD_INVALID");
      }
      continue;
    }
    if (!Array.isArray(supplied)) {
      for (const position of positions) {
        add(blockers, market, "PAPER_POSITION_OBSERVATION_EVIDENCE_MISSING", position.positionId, null);
      }
      continue;
    }

    const byPosition = new Map();
    for (const observation of supplied) {
      if (nonEmpty(observation?.observationId)) {
        if (seenObservationIds.has(observation.observationId)) {
          add(blockers, market, "PAPER_POSITION_DUPLICATE_OBSERVATION", observation?.positionId ?? null, observation.observationId);
        }
        seenObservationIds.add(observation.observationId);
      }
      const key = observation?.positionId;
      if (!nonEmpty(key)) {
        add(blockers, market, "PAPER_POSITION_OBSERVATION_POSITION_ID_REQUIRED", null, observation?.observationId ?? null);
        continue;
      }
      const rows = byPosition.get(key) ?? [];
      rows.push(observation);
      byPosition.set(key, rows);
    }

    for (const position of positions) {
      const rows = byPosition.get(position.positionId) ?? [];
      if (rows.length !== 1) {
        add(blockers, market, rows.length === 0
          ? "PAPER_POSITION_OBSERVATION_EVIDENCE_MISSING"
          : "PAPER_POSITION_MULTIPLE_OBSERVATIONS_FOR_POSITION", position.positionId, rows[0]?.observationId ?? null);
        continue;
      }
      const before = blockers.length;
      validateObservation({ observation: rows[0], position, cycle, state, evaluatedAtMs, market, blockers });
      if (blockers.length === before) validated.push(freezeClone(rows[0]));
    }

    for (const [positionId, rows] of byPosition) {
      if (!positions.some((position) => position.positionId === positionId)) {
        for (const observation of rows) {
          add(blockers, market, "PAPER_POSITION_OBSERVATION_POSITION_NOT_OPEN", positionId, observation?.observationId ?? null);
        }
      }
    }
  }

  return Object.freeze({
    schemaVersion: PAPER_SCHEDULER_POSITION_OBSERVATION_TRANSPORT_VERSION,
    status: blockers.length === 0 ? "READY" : "BLOCKED_DATA",
    positionObservations: Object.freeze(blockers.length === 0 ? validated : []),
    blockers: Object.freeze(blockers),
  });
}
