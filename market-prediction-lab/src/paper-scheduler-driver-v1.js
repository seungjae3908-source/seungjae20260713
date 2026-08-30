import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  RECURRING_PAPER_MARKETS,
  runRecurringPaperCycle,
} from "./recurring-paper-loop-v1.js";

export const PAPER_SCHEDULER_OWNER_LIVENESS = Object.freeze({
  ALIVE: "ALIVE",
  DEAD: "DEAD",
  UNKNOWN: "UNKNOWN",
});

export const PAPER_SCHEDULER_CONTRACT = Object.freeze({
  version: "paper-scheduler-v1",
  publicDataOnly: true,
  simulatedOnly: true,
  privateAccountAccess: false,
  liveTrading: false,
  executionAuthority: "NONE",
  orderAuthority: false,
  orderSubmitted: false,
  scheduleActive: false,
  leaseScope: "SINGLE_HOST_FILE_CAS",
  distributedMultiHostSupported: false,
  remoteOwnerRecoveryAllowed: false,
  liveOwnerExpiryStealAllowed: false,
});

const POSITION_OBSERVATION_HANDOFF_VERSION = "paper-scheduler-position-observation-handoff-v1";

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function digest64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/iu.test(value);
}

function immutableSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function frozenClone(value) {
  return value == null ? value : deepFreeze(structuredClone(value));
}

function cycleFor({ cadence, identityFingerprint, nowMs }) {
  if (!cadence || !nonEmpty(cadence.version) || !positiveInteger(cadence.intervalMs)) {
    throw new TypeError("cadence.version and cadence.intervalMs are required");
  }
  if (!nonEmpty(identityFingerprint) || !finiteNumber(nowMs)) {
    throw new TypeError("identityFingerprint and finite nowMs are required");
  }
  const window = Math.floor(nowMs / cadence.intervalMs);
  return Object.freeze({
    cycleId: `${cadence.version}:${window}`,
    scheduledAtMs: window * cadence.intervalMs,
    startedAtMs: nowMs,
    leaseKey: `paper:${identityFingerprint}:${cadence.version}:${window}`,
  });
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readOwner(path) {
  try {
    return { state: "PRESENT", owner: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "MISSING", owner: null };
    if (error instanceof SyntaxError) return { state: "CORRUPT", owner: null };
    throw error;
  }
}

async function writeJsonExclusive(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
}

function ownerRecordValid(owner) {
  return Boolean(
    owner
    && [owner.leaseKey, owner.cycleId, owner.ownerId, owner.token, owner.hostId].every(nonEmpty)
    && positiveInteger(owner.processId)
    && finiteNumber(owner.acquiredAtMs)
    && finiteNumber(owner.recoveryEligibleAtMs),
  );
}

function normalizeLiveness(value) {
  if (value === true || value === PAPER_SCHEDULER_OWNER_LIVENESS.ALIVE) {
    return PAPER_SCHEDULER_OWNER_LIVENESS.ALIVE;
  }
  if (value === false || value === PAPER_SCHEDULER_OWNER_LIVENESS.DEAD) {
    return PAPER_SCHEDULER_OWNER_LIVENESS.DEAD;
  }
  return PAPER_SCHEDULER_OWNER_LIVENESS.UNKNOWN;
}

function defaultOwnerLiveness(owner, { localHostId }) {
  if (owner.hostId !== localHostId) return PAPER_SCHEDULER_OWNER_LIVENESS.UNKNOWN;
  try {
    process.kill(owner.processId, 0);
    return PAPER_SCHEDULER_OWNER_LIVENESS.ALIVE;
  } catch (error) {
    if (error?.code === "ESRCH") return PAPER_SCHEDULER_OWNER_LIVENESS.DEAD;
    if (error?.code === "EPERM") return PAPER_SCHEDULER_OWNER_LIVENESS.ALIVE;
    return PAPER_SCHEDULER_OWNER_LIVENESS.UNKNOWN;
  }
}

async function reclaimLease(target, ownerId) {
  const tombstone = `${target.lease}.reclaim-${ownerId}-${randomUUID()}`;
  try {
    await rename(target.lease, tombstone);
    await rm(tombstone, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Durable single-host CAS boundary.
 *
 * - Atomic directory creation elects one process.
 * - A live local owner is never stolen merely because wall-clock time elapsed.
 * - A definitively dead local owner can be reclaimed.
 * - An ownerless mkdir->owner-write crash is reclaimed only after bounded grace.
 * - Unknown or remote-host ownership fails closed. Multi-host execution requires
 *   a separate distributed CAS implementation.
 */
export function createFilePaperSchedulerLeaseStore({
  directory,
  localHostId = hostname(),
  localProcessId = process.pid,
  ownerLiveness = defaultOwnerLiveness,
} = {}) {
  if (!nonEmpty(directory)) throw new TypeError("lease directory is required");
  if (!nonEmpty(localHostId) || !positiveInteger(localProcessId)) {
    throw new TypeError("local host and process identity are required");
  }
  if (typeof ownerLiveness !== "function") throw new TypeError("ownerLiveness must be a function");

  function paths(leaseKey) {
    const name = hash(leaseKey);
    return {
      lease: join(directory, `${name}.lease`),
      owner: join(directory, `${name}.lease`, "owner.json"),
      completed: join(directory, `${name}.complete.json`),
    };
  }

  async function acquire({ leaseKey, cycleId, ownerId, nowMs, leaseDurationMs }) {
    if (![leaseKey, cycleId, ownerId].every(nonEmpty) || !finiteNumber(nowMs) || !positiveInteger(leaseDurationMs)) {
      throw new TypeError("valid lease acquisition fields are required");
    }
    await mkdir(directory, { recursive: true });
    const target = paths(leaseKey);
    const completed = await readJson(target.completed);
    if (completed?.cycleId === cycleId) {
      return Object.freeze({ acquired: false, status: "COMPLETED", completed });
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = randomUUID();
      try {
        await mkdir(target.lease);
        const owner = Object.freeze({
          leaseKey,
          cycleId,
          ownerId,
          token,
          hostId: localHostId,
          processId: localProcessId,
          acquiredAtMs: nowMs,
          recoveryEligibleAtMs: nowMs + leaseDurationMs,
        });
        try {
          await writeJsonExclusive(target.owner, owner);
        } catch (error) {
          await rm(target.lease, { recursive: true, force: true });
          throw error;
        }
        return Object.freeze({ acquired: true, status: "ACQUIRED", ...owner });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }

      const activeState = await readOwner(target.owner);
      if (activeState.state === "MISSING") {
        let leaseInfo;
        try {
          leaseInfo = await stat(target.lease);
        } catch (error) {
          if (error?.code === "ENOENT") continue;
          throw error;
        }
        const leaseAgeMs = Math.max(0, nowMs - leaseInfo.mtimeMs);
        if (leaseAgeMs <= leaseDurationMs) {
          return Object.freeze({
            acquired: false,
            status: "BUSY",
            reason: "OWNER_INITIALIZING",
            ownerId: null,
          });
        }
        if (await reclaimLease(target, ownerId)) continue;
        continue;
      }

      if (activeState.state === "CORRUPT" || !ownerRecordValid(activeState.owner)) {
        return Object.freeze({
          acquired: false,
          status: "BUSY",
          reason: activeState.state === "CORRUPT" ? "OWNER_CORRUPT" : "OWNER_INVALID",
          ownerId: null,
        });
      }

      const active = activeState.owner;
      if (active.hostId !== localHostId) {
        return Object.freeze({
          acquired: false,
          status: "BUSY",
          reason: "REMOTE_HOST_OWNER",
          ownerId: active.ownerId,
          hostId: active.hostId,
        });
      }

      const liveness = normalizeLiveness(await ownerLiveness(active, {
        localHostId,
        localProcessId,
        nowMs,
      }));
      if (liveness === PAPER_SCHEDULER_OWNER_LIVENESS.ALIVE) {
        return Object.freeze({
          acquired: false,
          status: "BUSY",
          reason: "LIVE_LOCAL_OWNER",
          ownerId: active.ownerId,
          processId: active.processId,
        });
      }
      if (liveness === PAPER_SCHEDULER_OWNER_LIVENESS.UNKNOWN) {
        return Object.freeze({
          acquired: false,
          status: "BUSY",
          reason: "UNKNOWN_LOCAL_OWNER",
          ownerId: active.ownerId,
          processId: active.processId,
        });
      }

      if (await reclaimLease(target, ownerId)) continue;
    }

    return Object.freeze({
      acquired: false,
      status: "BUSY",
      reason: "LEASE_CONTENTION",
      ownerId: null,
    });
  }

  async function assertOwned({ leaseKey, ownerId, token }) {
    if (![leaseKey, ownerId, token].every(nonEmpty)) {
      throw new TypeError("lease ownership identity is required");
    }
    const target = paths(leaseKey);
    const activeState = await readOwner(target.owner);
    const owner = activeState.owner;
    if (
      activeState.state !== "PRESENT"
      || !ownerRecordValid(owner)
      || owner.token !== token
      || owner.ownerId !== ownerId
      || owner.hostId !== localHostId
      || owner.processId !== localProcessId
    ) {
      throw new Error("paper scheduler lease ownership lost");
    }
    return Object.freeze({ ...owner });
  }

  async function complete({ leaseKey, cycleId, ownerId, token, completedAtMs, summary }) {
    if (!finiteNumber(completedAtMs)) throw new TypeError("completedAtMs must be finite");
    await assertOwned({ leaseKey, ownerId, token });
    const target = paths(leaseKey);
    const completion = {
      cycleId,
      ownerId,
      completedAtMs,
      summary,
    };
    try {
      await writeJsonExclusive(target.completed, completion);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readJson(target.completed);
      if (existing?.cycleId !== cycleId) {
        throw new Error("paper scheduler completion CAS mismatch");
      }
      await rm(target.lease, { recursive: true, force: true });
      return Object.freeze(existing);
    }
    await rm(target.lease, { recursive: true, force: true });
    return Object.freeze(completion);
  }

  async function release({ leaseKey, ownerId, token }) {
    if (![leaseKey, ownerId, token].every(nonEmpty)) return;
    const target = paths(leaseKey);
    const activeState = await readOwner(target.owner);
    const owner = activeState.owner;
    if (
      activeState.state === "PRESENT"
      && ownerRecordValid(owner)
      && owner.token === token
      && owner.ownerId === ownerId
      && owner.hostId === localHostId
      && owner.processId === localProcessId
    ) {
      await rm(target.lease, { recursive: true, force: true });
    }
  }

  return Object.freeze({ acquire, assertOwned, complete, release });
}

function retryableProviderError(error) {
  return error?.status === 429
    || error?.code === "PROVIDER_RATE_LIMITED"
    || error?.code === "PROVIDER_TIMEOUT";
}

function cycleIdentityFor(state, cycle) {
  const payload = Object.freeze({
    cycleId: cycle.cycleId,
    identityFingerprint: state.identityFingerprint,
    scheduledAtMs: cycle.scheduledAtMs,
    startedAtMs: cycle.startedAtMs,
  });
  return Object.freeze({ ...payload, identityDigest: hash(JSON.stringify(payload)) });
}

function accountIdentityFor(state) {
  const binding = state?.ledger?.accountBinding;
  if (!binding
    || !digest64(binding.publisherAccountIdSha256)
    || !immutableSha(binding.sourceSha)
    || !nonEmpty(binding.accountId)) return null;
  const payload = Object.freeze({
    publisherAccountIdSha256: binding.publisherAccountIdSha256.toLowerCase(),
    sourceSha: binding.sourceSha.toLowerCase(),
    accountIdSha256: hash(binding.accountId),
  });
  return Object.freeze({ ...payload, identityDigest: hash(JSON.stringify(payload)) });
}

function positionIdentityFor(position) {
  const sample = position?.sample?.identity ?? {};
  const value = {
    positionId: position?.positionId,
    paperSampleId: position?.paperSampleId,
    signalId: position?.signalId ?? sample.signalId,
    market: position?.market ?? sample.market,
    symbol: position?.symbol ?? sample.symbol,
    direction: position?.direction ?? sample.executionDirection,
    strategyId: position?.strategyId ?? sample.strategyId,
    strategyVersion: position?.strategyVersion ?? sample.strategyVersion,
    parameterHash: position?.parameterHash ?? sample.parameterHash,
    researchCodeSha: position?.researchCodeSha ?? sample.researchCodeSha,
    costPolicyVersion: position?.costPolicyVersion ?? position?.sample?.profitEvidence?.costPolicyId,
  };
  if ([
    value.positionId, value.paperSampleId, value.signalId, value.market, value.symbol, value.direction,
    value.strategyId, value.strategyVersion, value.parameterHash, value.costPolicyVersion,
  ].some((item) => !nonEmpty(item)) || !immutableSha(value.researchCodeSha)) return null;
  return Object.freeze({ ...value, researchCodeSha: value.researchCodeSha.toLowerCase() });
}

function entryProvenanceFor(position) {
  const value = position?.sample?.entryEvidenceProvenance;
  if (!value || value.schemaVersion !== "paper-evidence-provenance-v1"
    || !digest64(value.provenanceDigest) || !digest64(value.evidenceSnapshotDigest)) return null;
  return frozenClone(value);
}

function riskPolicyIdentityFor(position) {
  const value = position?.riskPolicyIdentity
    ?? position?.lifecycle?.riskPolicyIdentity
    ?? position?.sample?.riskPolicyIdentity;
  if (!value || !nonEmpty(value.policyId) || !nonEmpty(value.policyVersion)
    || !nonEmpty(value.source) || !immutableSha(value.researchCodeSha)) return null;
  const payload = Object.freeze({
    policyId: value.policyId,
    policyVersion: value.policyVersion,
    source: value.source,
    researchCodeSha: value.researchCodeSha.toLowerCase(),
  });
  return Object.freeze({ ...payload, identityDigest: hash(JSON.stringify(payload)) });
}

function positionAccountBound(state, identity, accountIdentity) {
  if (!accountIdentity || !Array.isArray(state?.ledger?.reservations)) return false;
  const matches = state.ledger.reservations.filter((row) => row?.status === "OPEN"
    && row.positionId === identity.positionId
    && row.paperSampleId === identity.paperSampleId);
  return matches.length === 1;
}

function positionBindingFor(state, position, cycleIdentity, accountIdentity) {
  const identity = positionIdentityFor(position);
  if (!identity) return null;
  const entryProvenance = entryProvenanceFor(position);
  const riskPolicyIdentity = riskPolicyIdentityFor(position);
  return Object.freeze({
    schemaVersion: POSITION_OBSERVATION_HANDOFF_VERSION,
    positionIdentity: identity,
    cycleIdentity,
    accountIdentity,
    accountBound: positionAccountBound(state, identity, accountIdentity),
    entryProvenance,
    costPolicyIdentity: Object.freeze({ version: identity.costPolicyVersion }),
    riskPolicyIdentity,
    executionAuthority: "NONE",
    liveTrading: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
  });
}

function positionContextForMarket(state, market, cycleIdentity, accountIdentity) {
  if (!Array.isArray(state?.positions)) {
    return Object.freeze({ openPositions: null, positionBindings: null });
  }
  const positions = state.positions.filter((position) => (position?.market ?? position?.sample?.identity?.market) === market);
  const openPositions = Object.freeze(positions.map((position) => frozenClone(position)));
  const positionBindings = Object.freeze(positions.map((position) => positionBindingFor(
    state,
    position,
    cycleIdentity,
    accountIdentity,
  )));
  return Object.freeze({ openPositions, positionBindings });
}

async function collectLane({
  provider,
  market,
  cycle,
  cycleIdentity,
  accountIdentity,
  openPositions,
  positionBindings,
  retry,
  sleep,
}) {
  let lastError;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    try {
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error("public evidence provider timed out"), {
            code: "PROVIDER_TIMEOUT",
          }));
        }, retry.timeoutMs);
      });
      const result = await Promise.race([
        provider.collectPublicEvidence({
          market,
          cycle,
          cycleIdentity,
          accountIdentity,
          openPositions,
          positionBindings,
          attempt,
          signal: controller.signal,
        }),
        timeout,
      ]).finally(() => clearTimeout(timer));
      if (!result || result.publicOnly !== true) {
        throw new Error("provider evidence is not explicitly public-only");
      }
      return { market, result };
    } catch (error) {
      lastError = error;
      if (!retryableProviderError(error) || attempt === retry.maxAttempts) break;
      await sleep(retry.baseBackoffMs * attempt);
    }
  }
  return { market, error: lastError };
}

function evidenceBlock(lane, evaluatedAtMs) {
  if (lane.error?.status === 429 || lane.error?.code === "PROVIDER_RATE_LIMITED") {
    return "PROVIDER_RATE_LIMITED";
  }
  if (lane.error?.code === "PROVIDER_TIMEOUT") return "PROVIDER_TIMEOUT";
  if (lane.error) return "PROVIDER_FAILED";
  const evidence = lane.result;
  if (evidence.status === "BLOCKED_DATA") return "BLOCKED_DATA";
  if (evidence.status !== "READY") return "INVALID_PROVIDER_STATUS";
  if (!finiteNumber(evidence.observedAtMs) || !positiveInteger(evidence.maxAgeMs)) {
    return "INVALID_EVIDENCE_TIME";
  }
  if (evidence.observedAtMs > evaluatedAtMs) return "FUTURE_EVIDENCE";
  if (evaluatedAtMs - evidence.observedAtMs > evidence.maxAgeMs) return "STALE_EVIDENCE";
  if (!Array.isArray(evidence.candidates) || !Array.isArray(evidence.exits)) {
    return "INVALID_EVIDENCE_PAYLOAD";
  }
  return null;
}

function canonicalStageTrace(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value
    .filter((row) => nonEmpty(row?.stage) && nonEmpty(row?.status))
    .map((row) => Object.freeze({
      stage: row.stage,
      status: row.status,
      count: nonNegativeInteger(row.count) ? row.count : null,
      blocker: nonEmpty(row.blocker) ? row.blocker : null,
      provenance: nonEmpty(row.provenance) ? row.provenance : null,
      measuredAtMs: finiteNumber(row.measuredAtMs) ? row.measuredAtMs : null,
    })));
}

function authoritativeFirstZeroTrace(value) {
  const evidence = value?.EVIDENCE_COMPLETE;
  if (!evidence || typeof evidence !== "object") return null;
  return Object.freeze({
    authoritative: evidence.authoritative === true,
    freshness: nonEmpty(evidence.freshness) ? evidence.freshness : null,
    reasonCode: nonEmpty(evidence.reasonCode) ? evidence.reasonCode : null,
    sourceCodes: Object.freeze(Array.isArray(evidence.sourceCodes)
      ? evidence.sourceCodes.filter(nonEmpty)
      : []),
    strategySha: nonEmpty(evidence.strategySha) ? evidence.strategySha : null,
    runtimeSha: nonEmpty(evidence.runtimeSha) ? evidence.runtimeSha : null,
    datasetIdentity: nonEmpty(evidence.datasetIdentity) ? evidence.datasetIdentity : null,
    synthetic: evidence.synthetic === true,
    testFixture: evidence.testFixture === true,
    historical: evidence.historical === true,
    replay: evidence.replay === true,
    duplicateReplay: evidence.duplicateReplay === true,
  });
}

function entryAdmissionBlockerEvidence(evidence) {
  if (evidence?.status !== "BLOCKED_DATA") return null;
  const source = evidence?.paperCandidateSource;
  const sourceBlocker = nonEmpty(evidence?.blocker)
    ? evidence.blocker
    : nonEmpty(source?.blocker)
      ? source.blocker
      : null;
  if (!sourceBlocker && (!source || typeof source !== "object")) return null;
  return Object.freeze({
    classification: "BLOCKED_DATA",
    sourceBlocker,
    producerStatus: nonEmpty(source?.status) ? source.status : null,
    searchOutcome: nonEmpty(source?.searchOutcome) ? source.searchOutcome : null,
    firstZeroStage: nonEmpty(source?.firstZeroStage) ? source.firstZeroStage : null,
    firstZeroReason: nonEmpty(source?.firstZeroReason) ? source.firstZeroReason : null,
    naturalFirstZeroStage: nonEmpty(source?.naturalFirstZeroStage)
      ? source.naturalFirstZeroStage
      : null,
    naturalFirstZeroReason: nonEmpty(source?.naturalFirstZeroReason)
      ? source.naturalFirstZeroReason
      : null,
    stageMeasurements: canonicalStageTrace(source?.stageMeasurements),
    naturalFunnelMeasurements: canonicalStageTrace(source?.naturalFunnelMeasurements),
    authoritativeFirstZeroReasonEvidence: authoritativeFirstZeroTrace(
      source?.authoritativeFirstZeroReasonEvidenceByStage,
    ),
    provenance: Object.freeze({
      schemaVersion: nonEmpty(source?.schemaVersion) ? source.schemaVersion : null,
      naturalEvidenceIdentity: nonEmpty(source?.naturalEvidenceIdentity)
        ? source.naturalEvidenceIdentity
        : null,
      naturalRuntimeSha: nonEmpty(source?.naturalRuntimeSha) ? source.naturalRuntimeSha : null,
    }),
  });
}

function naturalObservationBlockers({ observation, binding, laneMarket, cycleIdentity, accountIdentity, evaluatedAtMs }) {
  const blockers = [];
  const identity = binding?.positionIdentity;
  if (!identity) return ["POSITION_OBSERVATION_OPEN_POSITION_IDENTITY_MISSING"];
  if (!nonEmpty(observation?.observationId)) blockers.push("POSITION_OBSERVATION_ID_REQUIRED");
  for (const key of [
    "positionId", "paperSampleId", "signalId", "market", "symbol", "direction",
    "strategyId", "strategyVersion", "parameterHash", "costPolicyVersion",
  ]) {
    if (observation?.[key] !== identity[key]) blockers.push(`POSITION_OBSERVATION_${key.toUpperCase()}_MISMATCH`);
  }
  if (!immutableSha(observation?.researchCodeSha)
    || observation.researchCodeSha.toLowerCase() !== identity.researchCodeSha) {
    blockers.push("POSITION_OBSERVATION_RESEARCH_SHA_MISMATCH");
  }
  if (observation?.market !== laneMarket) blockers.push("POSITION_OBSERVATION_LANE_MARKET_MISMATCH");
  if (observation?.publicOnly !== true || !nonEmpty(observation?.source) || !nonEmpty(observation?.provenance)) {
    blockers.push("POSITION_OBSERVATION_PUBLIC_PROVENANCE_REQUIRED");
  }
  if (!Number.isSafeInteger(observation?.observedAtMs)
    || observation.observedAtMs <= 0
    || observation.observedAtMs > evaluatedAtMs) {
    blockers.push("POSITION_OBSERVATION_TIME_INVALID");
  } else if (!positiveInteger(observation?.maxAgeMs)
    || evaluatedAtMs - observation.observedAtMs > observation.maxAgeMs) {
    blockers.push("POSITION_OBSERVATION_STALE");
  }

  const natural = observation?.naturalEvidence;
  if (natural?.provenanceClass === "NATURAL_FORWARD") {
    if (natural.synthetic !== false || natural.replay !== false || natural.testOnly !== false
      || natural.backfill !== false || natural.historical !== false || natural.duplicate !== false) {
      blockers.push("POSITION_OBSERVATION_GENUINE_PROVENANCE_REQUIRED");
    }
    if (natural.observationId !== observation.observationId
      || natural.observedAtMs !== observation.observedAtMs
      || !nonEmpty(natural.source) || !nonEmpty(natural.provenance)) {
      blockers.push("POSITION_OBSERVATION_NATURAL_EVIDENCE_MISMATCH");
    }
    if (observation.cycleIdentityDigest !== cycleIdentity.identityDigest) {
      blockers.push("POSITION_OBSERVATION_CYCLE_IDENTITY_MISMATCH");
    }
    if (!accountIdentity || binding.accountBound !== true
      || observation.accountIdentityDigest !== accountIdentity.identityDigest) {
      blockers.push("POSITION_OBSERVATION_ACCOUNT_IDENTITY_MISMATCH");
    }
    if (!binding.entryProvenance
      || observation.entryEvidenceDigest !== binding.entryProvenance.evidenceSnapshotDigest) {
      blockers.push("POSITION_OBSERVATION_ENTRY_PROVENANCE_MISMATCH");
    }
    if (!binding.riskPolicyIdentity
      || observation.riskPolicyIdentityDigest !== binding.riskPolicyIdentity.identityDigest) {
      blockers.push("POSITION_OBSERVATION_RISK_POLICY_IDENTITY_MISSING_OR_MISMATCH");
    }
  }
  return [...new Set(blockers)];
}

function buildPositionObservationHandoff({ lanes, state, cycleIdentity, accountIdentity, evaluatedAtMs }) {
  const explicit = lanes.filter((lane) => Object.prototype.hasOwnProperty.call(lane.result ?? {}, "positionObservations"));
  const openPositionCount = Array.isArray(state?.positions) ? state.positions.length : null;
  if (explicit.length === 0) {
    return Object.freeze({
      schemaVersion: POSITION_OBSERVATION_HANDOFF_VERSION,
      status: "MISSING",
      openPositionCount,
      observationCount: null,
      observations: null,
      blockers: Object.freeze(["POSITION_OBSERVATIONS_MISSING"]),
      executionAuthority: "NONE",
    });
  }
  const malformed = explicit.filter((lane) => !Array.isArray(lane.result.positionObservations));
  if (malformed.length > 0) {
    return Object.freeze({
      schemaVersion: POSITION_OBSERVATION_HANDOFF_VERSION,
      status: "BLOCKED_DATA",
      openPositionCount,
      observationCount: null,
      observations: null,
      blockers: Object.freeze(["POSITION_OBSERVATIONS_PAYLOAD_INVALID"]),
      executionAuthority: "NONE",
    });
  }

  const bindings = Array.isArray(state?.positions)
    ? state.positions.map((position) => positionBindingFor(state, position, cycleIdentity, accountIdentity))
    : [];
  const normalized = [];
  const blockers = [];
  const seenObservationIds = new Set();
  for (const lane of explicit) {
    for (const observation of lane.result.positionObservations) {
      const matching = bindings.filter((binding) => binding?.positionIdentity?.positionId === observation?.positionId);
      if (matching.length !== 1) {
        blockers.push(matching.length === 0
          ? "POSITION_OBSERVATION_OPEN_POSITION_NOT_FOUND"
          : "POSITION_OBSERVATION_OPEN_POSITION_AMBIGUOUS");
        continue;
      }
      if (nonEmpty(observation?.observationId)) {
        if (seenObservationIds.has(observation.observationId)) {
          blockers.push("POSITION_OBSERVATION_DUPLICATE_ID");
          continue;
        }
        seenObservationIds.add(observation.observationId);
      }
      const binding = matching[0];
      const rowBlockers = naturalObservationBlockers({
        observation,
        binding,
        laneMarket: lane.market,
        cycleIdentity,
        accountIdentity,
        evaluatedAtMs,
      });
      if (rowBlockers.length > 0) {
        blockers.push(...rowBlockers);
        continue;
      }
      normalized.push(deepFreeze({
        ...structuredClone(observation),
        schedulerHandoff: {
          schemaVersion: POSITION_OBSERVATION_HANDOFF_VERSION,
          cycleIdentity,
          accountIdentity,
          positionIdentity: binding.positionIdentity,
          entryProvenance: binding.entryProvenance,
          costPolicyIdentity: binding.costPolicyIdentity,
          riskPolicyIdentity: binding.riskPolicyIdentity,
          naturalSampleCreditAuthority: observation?.naturalEvidence?.provenanceClass === "NATURAL_FORWARD"
            ? "IDENTITY_GATES_PASSED"
            : "NO_GENUINE_CREDIT",
          executionAuthority: "NONE",
        },
      }));
    }
  }
  if (blockers.length > 0) {
    return Object.freeze({
      schemaVersion: POSITION_OBSERVATION_HANDOFF_VERSION,
      status: "BLOCKED_DATA",
      openPositionCount,
      observationCount: null,
      observations: null,
      blockers: Object.freeze([...new Set(blockers)]),
      executionAuthority: "NONE",
    });
  }
  return Object.freeze({
    schemaVersion: POSITION_OBSERVATION_HANDOFF_VERSION,
    status: "PRESENT",
    openPositionCount,
    observationCount: normalized.length,
    observations: Object.freeze(normalized),
    blockers: Object.freeze([]),
    executionAuthority: "NONE",
  });
}

export async function runScheduledPaperCycle({
  state,
  cadence,
  nowMs,
  ownerId,
  leaseStore,
  leaseDurationMs,
  publicEvidenceProvider,
  ledgerAdapter,
  learningAdapter,
  stateStore,
  retry = { maxAttempts: 3, baseBackoffMs: 250, timeoutMs: 5_000 },
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  clock = Date.now,
  runCycle = runRecurringPaperCycle,
} = {}) {
  if (!state || !nonEmpty(state.identityFingerprint)) {
    throw new TypeError("canonical Paper state is required");
  }
  if (
    !nonEmpty(ownerId)
    || !leaseStore
    || typeof leaseStore.acquire !== "function"
    || typeof leaseStore.assertOwned !== "function"
    || typeof leaseStore.complete !== "function"
    || typeof leaseStore.release !== "function"
    || !publicEvidenceProvider
  ) {
    throw new TypeError("owner, lease store, and public provider are required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (
    !positiveInteger(leaseDurationMs)
    || !positiveInteger(retry?.maxAttempts)
    || !positiveInteger(retry?.baseBackoffMs)
    || !positiveInteger(retry?.timeoutMs)
  ) {
    throw new TypeError("bounded lease and retry configuration are required");
  }

  const providerBudgetMs = retry.maxAttempts * retry.timeoutMs
    + retry.baseBackoffMs * ((retry.maxAttempts - 1) * retry.maxAttempts / 2);
  if (leaseDurationMs <= providerBudgetMs) {
    throw new TypeError("leaseDurationMs must exceed the bounded provider retry budget");
  }

  const cycle = cycleFor({
    cadence,
    identityFingerprint: state.identityFingerprint,
    nowMs,
  });
  const cycleIdentity = cycleIdentityFor(state, cycle);
  const accountIdentity = accountIdentityFor(state);
  const leaseNowMs = clock();
  if (!finiteNumber(leaseNowMs)) throw new TypeError("clock must return a finite number");

  const lease = await leaseStore.acquire({
    ...cycle,
    ownerId,
    nowMs: leaseNowMs,
    leaseDurationMs,
  });
  if (!lease.acquired) {
    return Object.freeze({
      status: lease.status === "COMPLETED" ? "REPLAYED" : "SKIPPED_BUSY",
      cycleId: cycle.cycleId,
      mutationCount: 0,
      busyOwnerId: lease.ownerId ?? null,
      busyReason: lease.reason ?? null,
      safety: PAPER_SCHEDULER_CONTRACT,
    });
  }

  try {
    const lanes = await Promise.all(RECURRING_PAPER_MARKETS.map((market) => {
      const positionContext = positionContextForMarket(state, market, cycleIdentity, accountIdentity);
      return collectLane({
        provider: publicEvidenceProvider,
        market,
        cycle,
        cycleIdentity,
        accountIdentity,
        ...positionContext,
        retry,
        sleep,
      });
    }));

    const evidenceEvaluatedAtMs = clock();
    if (!finiteNumber(evidenceEvaluatedAtMs)) {
      throw new TypeError("clock must return a finite number");
    }
    const blockers = lanes
      .map((lane) => {
        const reason = evidenceBlock(lane, evidenceEvaluatedAtMs);
        const entryAdmissionEvidence = reason === "BLOCKED_DATA"
          ? entryAdmissionBlockerEvidence(lane.result)
          : null;
        return Object.freeze({
          market: lane.market,
          reason,
          ...(entryAdmissionEvidence ? { entryAdmissionEvidence } : {}),
        });
      })
      .filter((row) => row.reason);

    if (blockers.length > 0) {
      return Object.freeze({
        status: "BLOCKED_DATA",
        cycleId: cycle.cycleId,
        mutationCount: 0,
        blockers: Object.freeze(blockers),
        evidenceEvaluatedAtMs,
        safety: PAPER_SCHEDULER_CONTRACT,
      });
    }

    const positionObservationHandoff = buildPositionObservationHandoff({
      lanes,
      state,
      cycleIdentity,
      accountIdentity,
      evaluatedAtMs: evidenceEvaluatedAtMs,
    });
    if (positionObservationHandoff.status === "BLOCKED_DATA") {
      return Object.freeze({
        status: "BLOCKED_DATA",
        cycleId: cycle.cycleId,
        mutationCount: 0,
        blockers: Object.freeze([Object.freeze({
          market: "POSITION_OBSERVATION",
          reason: "BLOCKED_DATA",
          details: positionObservationHandoff.blockers,
        })]),
        evidenceEvaluatedAtMs,
        positionObservationHandoff,
        safety: PAPER_SCHEDULER_CONTRACT,
      });
    }

    await leaseStore.assertOwned({
      leaseKey: cycle.leaseKey,
      ownerId,
      token: lease.token,
    });
    const result = await runCycle({
      state,
      cycle: {
        cycleId: cycle.cycleId,
        evaluatedAtMs: evidenceEvaluatedAtMs,
      },
      candidates: lanes.flatMap((lane) => lane.result.candidates),
      exits: lanes.flatMap((lane) => lane.result.exits),
      ...(positionObservationHandoff.status === "PRESENT"
        ? { positionObservations: positionObservationHandoff.observations }
        : {}),
      ledgerAdapter,
      learningAdapter,
      stateStore,
    });

    const completedAtMs = clock();
    if (!finiteNumber(completedAtMs)) throw new TypeError("clock must return a finite number");
    await leaseStore.complete({
      leaseKey: cycle.leaseKey,
      cycleId: cycle.cycleId,
      ownerId,
      token: lease.token,
      completedAtMs,
      summary: result.summary,
    });
    return Object.freeze({
      status: "COMPLETED",
      cycleId: cycle.cycleId,
      mutationCount: 1,
      evidenceEvaluatedAtMs,
      completedAtMs,
      ...result,
      positionObservationHandoff,
      safety: PAPER_SCHEDULER_CONTRACT,
    });
  } finally {
    await leaseStore.release({
      leaseKey: cycle.leaseKey,
      ownerId,
      token: lease.token,
    });
  }
}
