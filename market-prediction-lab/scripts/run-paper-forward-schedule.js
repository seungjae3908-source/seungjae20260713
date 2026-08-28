import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AUTHORITATIVE_PAPER_EVIDENCE_SOURCE_OWNERSHIP } from "../src/authoritative-paper-evidence-source-ownership-v1.js";
import { createAuthoritativePaperForwardDependenciesFromSourceWiring } from "../src/authoritative-paper-runtime-factory-v1.js";
import {
  CANONICAL_NATURAL_PAPER_STAGE_FIELDS,
  CANONICAL_NATURAL_PAPER_STAGE_ORDER,
  createNaturalFunnelObservedPaperRuntimeFromSourceWiring,
} from "../src/authoritative-paper-natural-funnel-v1.js";
import {
  createLosslessPaperStateSnapshotFileOwner,
  loadValidatedAuthoritativePaperRuntimePackage,
} from "../src/authoritative-paper-runtime-package-v1.js";
import {
  isAuthoritativeNaturalPaperLedger,
  paperStateFromAuthoritativeNaturalPaperLedger,
  validateAuthoritativeNaturalPaperLedger,
} from "../src/authoritative-natural-paper-accounting-v1.js";
import { createCanonicalPaperForwardEvidenceProvider } from "../src/paper-forward-evidence-runtime-v1.js";
import { wrapPaperForwardProviderWithMeaningfulSearch } from "../src/meaningful-search-scheduled-paper-provider-v1.js";
import {
  runPaperForwardScheduledInvocation,
} from "../src/paper-forward-schedule-runtime-v1.js";

const TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);
const forbiddenActivationKeys = [
  "LIVE_TRADING",
  "LIVE_TRADING_ENABLED",
  "REAL_ORDER_ENABLED",
  "PRIVATE_API_ENABLED",
  "PRIVATE_ACCOUNT_ACCESS",
  "PRIVATE_TRADING_API_ALLOWED",
];
const PAPER_STATE_BINDING_VERSION = "paper-state-publisher-runtime-binding-v1";
const PAPER_STATE_SNAPSHOT_VERSION = "paper-trading-state-snapshot-v2";

function truthy(value) {
  return TRUTHY.has(String(value ?? "").trim().toLowerCase());
}

function immutableSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function digest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function safePaperEnvelope(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.immutable === true
    && value.executionAuthority === "NONE"
    && value.privateApiAllowed === false
    && value.liveTrading === false
    && value.financialMutationAllowed === false;
}

function paperStateSnapshotFailureState(error) {
  const code = String(error?.code ?? error?.message ?? "").trim();
  if (code === "PAPER_STATE_STALE" || code === "PAPER_STATE_SNAPSHOT_STALE_OR_FUTURE") {
    return "STALE";
  }
  if (code === "PAPER_STATE_PUBLISHER_ACCOUNT_BINDING_MISMATCH") return "WRONG_ACCOUNT";
  if (code === "PAPER_STATE_SOURCE_SHA_MISMATCH") return "WRONG_CYCLE";
  return "INVALID";
}

function paperStateFailureReason(availability) {
  if (availability === "STALE") return "PAPER_STATE_SNAPSHOT_STALE_OR_FUTURE";
  if (availability === "WRONG_ACCOUNT") return "PAPER_STATE_PUBLISHER_ACCOUNT_BINDING_MISMATCH";
  if (availability === "WRONG_CYCLE") return "PAPER_STATE_SOURCE_SHA_MISMATCH";
  return "PAPER_STATE_SNAPSHOT_INVALID";
}

async function resolvePaperStateTransportConfiguration({
  env,
  researchCodeSha,
  runtimePackage,
  nowMs = Date.now(),
}) {
  const configuredSnapshotPath = String(env.PAPER_FORWARD_PAPER_STATE_SNAPSHOT_PATH ?? "").trim();
  const configuredPublisherDigest = String(
    env.PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256 ?? "",
  ).trim();
  const bindingPath = String(env.PAPER_FORWARD_PUBLISHER_BINDING_PATH ?? "").trim();

  if (!bindingPath) {
    const snapshotConfigured = configuredSnapshotPath.length > 0;
    const publisherConfigured = configuredPublisherDigest.length > 0;
    const configured = snapshotConfigured && digest(configuredPublisherDigest);
    const availability = configured
      ? "CONFIGURED"
      : !snapshotConfigured && !publisherConfigured
        ? "MISSING"
        : "CONFIG_INCOMPLETE";
    return Object.freeze({
      snapshotPath: configuredSnapshotPath,
      publisherAccountIdSha256: digest(configuredPublisherDigest) ? configuredPublisherDigest : null,
      availability,
      reason: availability === "CONFIGURED"
        ? null
        : availability === "MISSING"
          ? "PAPER_STATE_SNAPSHOT_MISSING"
          : "PAPER_STATE_TRANSPORT_CONFIG_INCOMPLETE",
      observedAtMs: null,
      sourceShaExact: null,
      publisherAccountBound: null,
    });
  }
  if (!isAbsolute(bindingPath) || (configuredSnapshotPath && !isAbsolute(configuredSnapshotPath))) {
    return Object.freeze({
      snapshotPath: "",
      publisherAccountIdSha256: null,
      availability: "INVALID",
      reason: "PAPER_STATE_TRANSPORT_PATH_INVALID",
      observedAtMs: null,
      sourceShaExact: false,
      publisherAccountBound: false,
    });
  }

  const [bindingPresent, snapshotPresent] = await Promise.all([
    exists(bindingPath),
    configuredSnapshotPath ? exists(configuredSnapshotPath) : Promise.resolve(false),
  ]);
  if (!bindingPresent || !snapshotPresent) {
    return Object.freeze({
      snapshotPath: "",
      publisherAccountIdSha256: null,
      availability: bindingPresent === snapshotPresent ? "MISSING" : "CONFIG_INCOMPLETE",
      reason: bindingPresent === snapshotPresent
        ? "PAPER_STATE_SNAPSHOT_MISSING"
        : "PAPER_STATE_TRANSPORT_CONFIG_INCOMPLETE",
      observedAtMs: null,
      sourceShaExact: null,
      publisherAccountBound: null,
    });
  }

  let binding;
  try {
    binding = JSON.parse(await readFile(bindingPath, "utf8"));
  } catch {
    return Object.freeze({
      snapshotPath: "",
      publisherAccountIdSha256: null,
      availability: "INVALID",
      reason: "PAPER_STATE_RUNTIME_BINDING_INVALID",
      observedAtMs: null,
      sourceShaExact: false,
      publisherAccountBound: false,
    });
  }
  if (!safePaperEnvelope(binding)
    || binding.schemaVersion !== PAPER_STATE_BINDING_VERSION
    || !immutableSha(binding.paperRuntimeSourceSha)
    || !digest(binding.publisherAccountIdSha256)
    || typeof binding.snapshotPath !== "string"
    || !isAbsolute(binding.snapshotPath)
    || !/[\\/]publisher[\\/]paper-state-v2\.json$/u.test(binding.snapshotPath)) {
    return Object.freeze({
      snapshotPath: "",
      publisherAccountIdSha256: null,
      availability: "INVALID",
      reason: "PAPER_STATE_RUNTIME_BINDING_INVALID",
      observedAtMs: null,
      sourceShaExact: false,
      publisherAccountBound: false,
    });
  }
  if (binding.paperRuntimeSourceSha !== researchCodeSha) {
    return Object.freeze({
      snapshotPath: "",
      publisherAccountIdSha256: null,
      availability: "WRONG_CYCLE",
      reason: "PAPER_STATE_SOURCE_SHA_MISMATCH",
      observedAtMs: null,
      sourceShaExact: false,
      publisherAccountBound: null,
    });
  }
  if (configuredPublisherDigest && configuredPublisherDigest !== binding.publisherAccountIdSha256) {
    return Object.freeze({
      snapshotPath: "",
      publisherAccountIdSha256: null,
      availability: "WRONG_ACCOUNT",
      reason: "PAPER_STATE_PUBLISHER_ACCOUNT_BINDING_MISMATCH",
      observedAtMs: null,
      sourceShaExact: true,
      publisherAccountBound: false,
    });
  }

  let snapshot;
  try {
    const rawSnapshot = JSON.parse(await readFile(configuredSnapshotPath, "utf8"));
    snapshot = runtimePackage.validateImmutablePaperTradingStateSnapshot(rawSnapshot, nowMs);
  } catch (error) {
    const availability = paperStateSnapshotFailureState(error);
    return Object.freeze({
      snapshotPath: "",
      publisherAccountIdSha256: null,
      availability,
      reason: paperStateFailureReason(availability),
      observedAtMs: null,
      sourceShaExact: null,
      publisherAccountBound: null,
    });
  }
  if (snapshot.schemaVersion !== PAPER_STATE_SNAPSHOT_VERSION
    || snapshot.publisherAccountIdSha256 !== binding.publisherAccountIdSha256) {
    return Object.freeze({
      snapshotPath: "",
      publisherAccountIdSha256: null,
      availability: "WRONG_ACCOUNT",
      reason: "PAPER_STATE_PUBLISHER_ACCOUNT_BINDING_MISMATCH",
      observedAtMs: snapshot.observedAtMs ?? null,
      sourceShaExact: snapshot.sourceSha === researchCodeSha,
      publisherAccountBound: false,
    });
  }
  if (snapshot.sourceSha !== researchCodeSha) {
    return Object.freeze({
      snapshotPath: "",
      publisherAccountIdSha256: null,
      availability: "WRONG_CYCLE",
      reason: "PAPER_STATE_SOURCE_SHA_MISMATCH",
      observedAtMs: snapshot.observedAtMs ?? null,
      sourceShaExact: false,
      publisherAccountBound: true,
    });
  }

  return Object.freeze({
    snapshotPath: configuredSnapshotPath,
    publisherAccountIdSha256: binding.publisherAccountIdSha256,
    availability: "PRESENT",
    reason: null,
    observedAtMs: snapshot.observedAtMs,
    sourceShaExact: true,
    publisherAccountBound: true,
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function expectedStrategyId(outcomeAccumulationEnabled, authoritativeAccountRequired = false) {
  if (!outcomeAccumulationEnabled) return "paper-forward-public-evidence-v1";
  return authoritativeAccountRequired
    ? "paper-forward-authoritative-account-v1"
    : "paper-forward-simulated-outcome-v1";
}

function stageMeasurementCount(stageMeasurements, stage) {
  if (!Array.isArray(stageMeasurements)) return null;
  const measurement = stageMeasurements.find((row) => row?.stage === stage);
  return measurement?.status === "MEASURED" && Number.isInteger(measurement.count)
    ? measurement.count
    : null;
}

function naturalStageMeasurement(stage, count, provenance, blocker = null) {
  const measured = Number.isInteger(count) && count >= 0;
  return Object.freeze({
    stage,
    status: measured ? "MEASURED" : "UNKNOWN",
    count: measured ? count : null,
    blocker: measured ? null : blocker,
    provenance: measured ? provenance : null,
    measuredAtMs: null,
  });
}

function finalizeNaturalFunnel(baseMeasurements, result) {
  if (!Array.isArray(baseMeasurements)) return Object.freeze([]);
  const measurements = baseMeasurements.map((row) => Object.freeze({ ...row }));
  if (result?.invocation?.naturalScheduleInvocation !== true || result?.status === "REPLAYED") {
    return Object.freeze(measurements.map((row) => ["PAPER_ENTRY", "POSITION", "SETTLEMENT", "OUTCOME"].includes(row.stage)
      ? naturalStageMeasurement(row.stage, null, null, result?.status === "REPLAYED" ? "REPLAY_EXCLUDED_FROM_NATURAL_EVIDENCE" : "NON_NATURAL_INVOCATION")
      : row));
  }
  const entries = Number.isInteger(result?.summary?.entries) && result.summary.entries >= 0
    ? result.summary.entries
    : null;
  const settled = Number.isInteger(result?.summary?.tradesSettled) && result.summary.tradesSettled >= 0
    ? result.summary.tradesSettled
    : null;
  return Object.freeze(measurements.map((row) => {
    if (row.stage === "PAPER_ENTRY") {
      return naturalStageMeasurement("PAPER_ENTRY", entries, "recurring-paper-loop-v1.summary.entries", "PAPER_ENTRY_NOT_MEASURED");
    }
    if (row.stage === "POSITION") {
      return naturalStageMeasurement("POSITION", entries, "recurring-paper-loop-v1 successful entry creates OPEN position", "POSITION_NOT_MEASURED");
    }
    if (row.stage === "SETTLEMENT") {
      return naturalStageMeasurement("SETTLEMENT", settled, "recurring-paper-loop-v1.summary.tradesSettled", "SETTLEMENT_NOT_MEASURED");
    }
    if (row.stage === "OUTCOME") {
      return naturalStageMeasurement("OUTCOME", settled, "persistOutcome precedes each accepted recurring settlement", "OUTCOME_NOT_MEASURED");
    }
    return row;
  }));
}

function naturalFirstZero(measurements) {
  for (const measurement of measurements) {
    if (measurement?.status !== "MEASURED") {
      return Object.freeze({ stage: "UNKNOWN", reason: measurement?.blocker ?? `UNMEASURED_${measurement?.stage ?? "STAGE"}` });
    }
    if (measurement.count === 0) return Object.freeze({ stage: measurement.stage, reason: "MEASURED_ZERO" });
  }
  return Object.freeze({ stage: "UNKNOWN", reason: "NO_MEASURED_ZERO" });
}

const CANONICAL_REASON_TAXONOMY = new Set([
  "NO_SIGNAL", "QUALITY_GATE", "RISK_GATE", "DATA_STALE", "DATA_MISSING",
  "MARKET_CLOSED", "PROVIDER_FAILURE", "IDENTITY_MISMATCH", "ACCOUNT_STATE_BLOCK",
  "COOLDOWN", "DUPLICATE", "REPLAY_ONLY", "UNKNOWN",
]);

const REASON_SOURCE_STAGE = Object.freeze({
  SIGNAL_CANDIDATE: "SIGNAL_CANDIDATE",
  QUALITY_PASSED: "QUALITY_GATE",
  RISK_PASSED: "RISK_GATE",
  ENTRY_ELIGIBLE: "ENTRY_ELIGIBLE",
  ENTRY: "ENTRY",
  POSITION: "POSITION",
  EXIT_ELIGIBLE: "EXIT_ELIGIBLE",
  SETTLEMENT: "SETTLEMENT",
});

function canonicalUnknownStage(stage, blocker) {
  return Object.freeze({
    stage,
    field: CANONICAL_NATURAL_PAPER_STAGE_FIELDS[stage],
    status: "UNKNOWN",
    count: null,
    blocker,
    provenance: null,
    observedAt: null,
    observationIds: Object.freeze([]),
    identity: null,
    naturalCredit: 0,
    replayCredit: 0,
    duplicateCredit: 0,
  });
}

function creditedCanonicalStage(stage, source, identity, natural) {
  if (!natural || source?.status !== "MEASURED" || !Number.isInteger(source?.count) || source.count < 0) {
    return canonicalUnknownStage(stage, natural ? source?.blocker ?? `UNMEASURED_${stage}` : "NON_NATURAL_CYCLE");
  }
  const ids = Array.isArray(source.observationIds) ? source.observationIds.filter((value) => typeof value === "string" && value.length > 0) : [];
  if (ids.length !== source.count || new Set(ids).size !== ids.length) {
    return canonicalUnknownStage(stage, "DIRECT_OBSERVATION_ID_COVERAGE_INCOMPLETE");
  }
  return Object.freeze({
    ...structuredClone(source),
    stage,
    field: CANONICAL_NATURAL_PAPER_STAGE_FIELDS[stage],
    status: "MEASURED",
    count: source.count,
    blocker: null,
    identity,
    observationIds: Object.freeze(ids),
    naturalCredit: source.count,
    replayCredit: 0,
    duplicateCredit: 0,
  });
}

function canonicalFirstZero(stageCounts) {
  for (const stage of CANONICAL_NATURAL_PAPER_STAGE_ORDER) {
    const measurement = stageCounts[CANONICAL_NATURAL_PAPER_STAGE_FIELDS[stage]];
    if (measurement?.status !== "MEASURED") return Object.freeze({ stage: "UNKNOWN", reason: "UNKNOWN" });
    if (measurement.count === 0) return Object.freeze({ stage, reason: null });
  }
  return Object.freeze({ stage: "NONE", reason: "UNKNOWN" });
}

function losslessReasonFor(stage, rows) {
  const expectedSourceStage = REASON_SOURCE_STAGE[stage];
  const reasons = rows
    .filter((row) => row?.sourceStage === expectedSourceStage && row?.lossless === true)
    .map((row) => String(row.canonicalReason ?? "UNKNOWN").toUpperCase())
    .filter((reason) => CANONICAL_REASON_TAXONOMY.has(reason) && reason !== "UNKNOWN");
  return reasons.length > 0 && new Set(reasons).size === 1 ? reasons[0] : "UNKNOWN";
}

export function finalizeCanonicalNaturalStageEvidence({
  producerEvidence,
  loopEvidence,
  exitEligibilityEvidence,
  cycleId,
  researchCodeSha,
  datasetIdentity,
  naturalScheduleInvocation,
  replayed,
} = {}) {
  const natural = naturalScheduleInvocation === true && replayed !== true;
  const identity = Object.freeze({
    cycleId: typeof cycleId === "string" && cycleId.length > 0 ? cycleId : null,
    strategySha: immutableSha(researchCodeSha) ? researchCodeSha : null,
    runtimeSha: immutableSha(researchCodeSha) ? researchCodeSha : null,
    datasetIdentity: typeof datasetIdentity === "string" && datasetIdentity.length > 0 ? datasetIdentity : null,
    triggerSource: natural ? "cron" : null,
  });
  const sourceStages = Object.freeze({
    signalCandidate: producerEvidence?.stageCounts?.signalCandidate,
    qualityPassed: producerEvidence?.stageCounts?.qualityPassed,
    riskPassed: producerEvidence?.stageCounts?.riskPassed,
    entryEligible: loopEvidence?.stageCounts?.entryEligible,
    entry: loopEvidence?.stageCounts?.entry,
    position: loopEvidence?.stageCounts?.position,
    exitEligible: exitEligibilityEvidence?.status === "MEASURED"
      ? Object.freeze({
          status: "MEASURED",
          count: exitEligibilityEvidence.exitEligibleCount,
          blocker: null,
          provenance: exitEligibilityEvidence.provenance,
          observedAt: exitEligibilityEvidence.observations?.[0]?.observedAt ?? null,
          observationIds: Object.freeze((exitEligibilityEvidence.observations ?? [])
            .filter((row) => row.exitEligible === true)
            .map((row) => row.observationId)),
        })
      : null,
    settlement: loopEvidence?.stageCounts?.settlement,
  });
  const stageCounts = Object.fromEntries(CANONICAL_NATURAL_PAPER_STAGE_ORDER.map((stage) => {
    const field = CANONICAL_NATURAL_PAPER_STAGE_FIELDS[stage];
    return [field, creditedCanonicalStage(stage, sourceStages[field], identity, natural)];
  }));
  const rawReasons = [
    ...(producerEvidence?.reasonObservations ?? []),
    ...(loopEvidence?.reasonObservations ?? []),
    ...(exitEligibilityEvidence?.reasonObservations ?? []),
  ].map((row) => Object.freeze({
    ...structuredClone(row),
    identity: Object.freeze({ ...identity, observationId: row?.identity?.observationId ?? null }),
    naturalCredit: natural ? 1 : 0,
    replayCredit: 0,
    duplicateCredit: 0,
  }));
  const firstZero = natural ? canonicalFirstZero(stageCounts) : Object.freeze({
    stage: "UNKNOWN",
    reason: replayed === true ? "REPLAY_ONLY" : "UNKNOWN",
  });
  const reason = firstZero.stage === "UNKNOWN" || firstZero.stage === "NONE"
    ? firstZero.reason
    : losslessReasonFor(firstZero.stage, rawReasons);
  return Object.freeze({
    schemaVersion: "canonical-natural-paper-stage-evidence-v1",
    stageOrder: CANONICAL_NATURAL_PAPER_STAGE_ORDER,
    identity,
    stageCounts: Object.freeze(stageCounts),
    exitEvidence: exitEligibilityEvidence ? Object.freeze(structuredClone(exitEligibilityEvidence)) : null,
    reasonObservations: Object.freeze(rawReasons),
    firstZeroStage: firstZero.stage,
    firstZeroReason: reason,
    naturalCredit: natural ? 1 : 0,
    replayCredit: 0,
    duplicateCredit: 0,
    historicalCredit: 0,
    unknownIsZero: false,
  });
}

async function readPersistedAuthoritativeAccountState({
  rootDirectory,
  expectedPublisherAccountIdSha256,
  expectedSourceSha,
} = {}) {
  const stateFile = join(resolve(rootDirectory), "state", "recurring-paper-loop.json");
  if (!(await exists(stateFile))) return null;
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  if (!isAuthoritativeNaturalPaperLedger(state?.ledger)) return null;
  const persistedResearchSha = String(state?.identity?.researchCodeSha ?? "").trim().toLowerCase();
  if (persistedResearchSha !== expectedSourceSha) return null;
  validateAuthoritativeNaturalPaperLedger(state.ledger, {
    expectedPublisherAccountIdSha256,
    expectedSourceSha,
  });
  return Object.freeze({
    paperState: paperStateFromAuthoritativeNaturalPaperLedger(state.ledger, {
      expectedPublisherAccountIdSha256,
      expectedSourceSha,
    }),
    ledgerSchemaVersion: state.ledger.schemaVersion,
    accountBindingVerified: true,
    source: "PERSISTED_RECURRING_AUTHORITATIVE_ACCOUNT",
  });
}

export function resolveOutcomeAccumulationEnabled(env = process.env) {
  if (truthy(env.RESEARCH_PRODUCTION)) return true;
  return truthy(env.PAPER_FORWARD_OUTCOME_ACCUMULATION_ENABLED);
}

export async function prepareResearchProductionIdentityCutover({
  rootDirectory,
  researchCodeSha,
  outcomeAccumulationEnabled,
  authoritativeAccountRequired = false,
  nowMs = Date.now(),
} = {}) {
  if (!immutableSha(researchCodeSha)) throw new Error("Research Production Paper cutover requires an exact research SHA");
  if (typeof outcomeAccumulationEnabled !== "boolean" || typeof authoritativeAccountRequired !== "boolean") {
    throw new Error("Research Production Paper cutover requires explicit mode flags");
  }
  if (authoritativeAccountRequired && !outcomeAccumulationEnabled) {
    throw new Error("Research Production authoritative account requires outcome mode");
  }
  if (!Number.isFinite(nowMs) || nowMs <= 0) throw new Error("Research Production Paper cutover requires a finite timestamp");

  const root = resolve(rootDirectory);
  const disabledSentinel = join(root, "DISABLED");
  if (await exists(disabledSentinel)) {
    throw Object.assign(
      new Error("Paper Forward schedule is disabled; refusing Research Production identity cutover"),
      { code: "PAPER_FORWARD_SCHEDULE_DISABLED" },
    );
  }

  const stateFile = join(root, "state", "recurring-paper-loop.json");
  const desiredStrategyId = expectedStrategyId(outcomeAccumulationEnabled, authoritativeAccountRequired);
  if (!(await exists(stateFile))) {
    return Object.freeze({
      identityCutover: false,
      archivedResearchSha: null,
      archivedStrategyId: null,
      targetResearchSha: researchCodeSha,
      targetStrategyId: desiredStrategyId,
    });
  }

  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const archivedResearchSha = String(state?.identity?.researchCodeSha ?? "").trim().toLowerCase();
  const archivedStrategyId = String(state?.identity?.strategyId ?? "").trim();
  if (!immutableSha(archivedResearchSha) || !archivedStrategyId) {
    throw new Error("Research Production Paper predecessor identity is invalid; refusing cutover");
  }
  if (archivedResearchSha === researchCodeSha && archivedStrategyId === desiredStrategyId) {
    return Object.freeze({
      identityCutover: false,
      archivedResearchSha,
      archivedStrategyId,
      targetResearchSha: researchCodeSha,
      targetStrategyId: desiredStrategyId,
    });
  }

  const parent = dirname(root);
  const archiveRoot = join(parent, "paper-identity-archives");
  const cutoverRoot = join(parent, "paper-identity-cutovers");
  await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
  await mkdir(cutoverRoot, { recursive: true, mode: 0o700 });
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/gu, "-");
  const archivePath = join(archiveRoot, `${archivedResearchSha}-to-${researchCodeSha}-${stamp}`);
  if (await exists(archivePath)) throw new Error("Research Production Paper identity archive path already exists");

  await rename(root, archivePath);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const manifest = Object.freeze({
    schemaVersion: "research-production-paper-identity-cutover-v1",
    cutoverAtMs: nowMs,
    archivedResearchSha,
    archivedStrategyId,
    targetResearchSha: researchCodeSha,
    targetStrategyId: desiredStrategyId,
    archivePath,
    predecessorStatePreserved: true,
    predecessorPerformanceMixed: false,
    newIdentityStartsFromZero: true,
    paperTradeOutcomeAccumulationEnabled: outcomeAccumulationEnabled,
    authoritativeAccountRequired,
    accountCurrency: authoritativeAccountRequired ? "USDT" : null,
    simulatedFinancialAdaptersEnabled: outcomeAccumulationEnabled,
    externalFinancialMutationAllowed: false,
    privateRequestCount: 0,
    financialMutationCount: 0,
    orderCount: 0,
    liveTrading: false,
    privateApi: false,
    orderAuthority: false,
  });
  await atomicJson(join(cutoverRoot, `${researchCodeSha}.json`), manifest);
  return Object.freeze({
    identityCutover: true,
    archivedResearchSha,
    archivedStrategyId,
    targetResearchSha: researchCodeSha,
    targetStrategyId: desiredStrategyId,
    archivePath,
  });
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

export async function runPaperForwardScheduleCli(env = process.env, {
  runScheduledInvocation = runPaperForwardScheduledInvocation,
  publicEvidenceProvider = null,
  meaningfulSearchPaperRuntimeForMarket = null,
  authoritativePaperSourceWiring = null,
  authoritativePaperDependenciesFactory = createAuthoritativePaperForwardDependenciesFromSourceWiring,
  authoritativePaperPackageLoader = loadValidatedAuthoritativePaperRuntimePackage,
  paperStateOwnerFactory = createLosslessPaperStateSnapshotFileOwner,
  paperStateSourceFactory = null,
} = {}) {
  if (!truthy(env.PAPER_FORWARD_SCHEDULE_ACTIVE)) {
    fail("PAPER_FORWARD_SCHEDULE_ACTIVE must be explicitly true", 64);
    return;
  }
  if (forbiddenActivationKeys.some((key) => truthy(env[key]))) {
    fail("Paper Forward schedule refuses live trading or private API activation", 65);
    return;
  }
  if (typeof runScheduledInvocation !== "function") {
    fail("Paper Forward scheduled invocation dependency is invalid", 66);
    return;
  }
  if (meaningfulSearchPaperRuntimeForMarket != null && typeof meaningfulSearchPaperRuntimeForMarket !== "function") {
    fail("Meaningful Search Paper runtime dependency is invalid", 67);
    return;
  }
  if (authoritativePaperSourceWiring != null
    && (typeof authoritativePaperSourceWiring !== "object" || Array.isArray(authoritativePaperSourceWiring))) {
    fail("Authoritative Paper source wiring dependency is invalid", 68);
    return;
  }
  if (typeof authoritativePaperDependenciesFactory !== "function") {
    fail("Authoritative Paper dependency factory is invalid", 69);
    return;
  }
  if (typeof authoritativePaperPackageLoader !== "function"
    || typeof paperStateOwnerFactory !== "function"
    || (paperStateSourceFactory != null && typeof paperStateSourceFactory !== "function")) {
    fail("Authoritative Paper package dependency is invalid", 70);
    return;
  }

  const rootDirectory = env.PAPER_FORWARD_ROOT ?? "/opt/stock-app-data/paper-forward-v1/runtime-state";
  const researchCodeSha = String(env.PAPER_FORWARD_RESEARCH_SHA ?? "").trim().toLowerCase();
  const activationAtMs = Number(env.PAPER_FORWARD_ACTIVATION_AT_MS);
  const triggerSource = env.PAPER_FORWARD_TRIGGER_SOURCE ?? "cron";
  const researchProduction = truthy(env.RESEARCH_PRODUCTION);
  const explicitOutcomeAccumulation = truthy(env.PAPER_FORWARD_OUTCOME_ACCUMULATION_ENABLED);
  const outcomeAccumulationEnabled = resolveOutcomeAccumulationEnabled(env);
  const authoritativeAccountRequired = researchProduction && explicitOutcomeAccumulation;

  try {
    let authoritativeSourceWiringAudit = null;
    let authoritativeRuntimePackageAudit = null;
    let paperStateOwnerAudit = null;
    let authoritativeRuntimeMeasurement = null;
    let paperStateCallbackInvocationCount = 0;
    let paperStateTransportStatus = "BLOCKED_DATA_CONFIG_ABSENT";
    let paperStateAvailability = "MISSING";
    let paperStateTransportReason = "PAPER_STATE_SNAPSHOT_MISSING";
    let paperStateObservedAtMs = null;
    let paperStateSourceShaExact = null;
    let paperStatePublisherAccountBound = null;
    let authoritativeAccountSeedSnapshot = null;
    let expectedPublisherAccountIdSha256 = null;
    let resolvedAuthoritativeSourceWiring = authoritativePaperSourceWiring ?? {};
    let cutover = Object.freeze({ identityCutover: false, archivedResearchSha: null, archivedStrategyId: null });

    if (researchProduction) {
      const runtimePackage = await authoritativePaperPackageLoader();
      const paperStateConfiguration = await resolvePaperStateTransportConfiguration({
        env,
        researchCodeSha,
        runtimePackage,
      });
      const stateSnapshotPath = paperStateConfiguration.snapshotPath;
      const publisherAccountIdSha256 = paperStateConfiguration.publisherAccountIdSha256 ?? "";
      expectedPublisherAccountIdSha256 = paperStateConfiguration.publisherAccountIdSha256;
      paperStateAvailability = paperStateConfiguration.availability;
      paperStateTransportReason = paperStateConfiguration.reason;
      paperStateObservedAtMs = paperStateConfiguration.observedAtMs;
      paperStateSourceShaExact = paperStateConfiguration.sourceShaExact;
      paperStatePublisherAccountBound = paperStateConfiguration.publisherAccountBound;
      if (paperStateAvailability === "CONFIG_INCOMPLETE") {
        paperStateTransportStatus = "BLOCKED_DATA_CONFIG_INCOMPLETE";
      } else if (!["MISSING", "PRESENT", "CONFIGURED"].includes(paperStateAvailability)) {
        paperStateTransportStatus = `BLOCKED_DATA_${paperStateAvailability}`;
      }

      let persistedAccount = null;
      let seedPaperState = null;
      let seedOwner = null;
      if (authoritativeAccountRequired) {
        if (expectedPublisherAccountIdSha256 == null) {
          throw Object.assign(new Error("PAPER_FORWARD_AUTHORITATIVE_ACCOUNT_BINDING_REQUIRED"), {
            code: "PAPER_FORWARD_AUTHORITATIVE_ACCOUNT_BINDING_REQUIRED",
          });
        }
        persistedAccount = await readPersistedAuthoritativeAccountState({
          rootDirectory,
          expectedPublisherAccountIdSha256,
          expectedSourceSha: researchCodeSha,
        });
        if (!persistedAccount) {
          if (!stateSnapshotPath) {
            throw Object.assign(new Error("PAPER_FORWARD_AUTHORITATIVE_ACCOUNT_SEED_REQUIRED"), {
              code: "PAPER_FORWARD_AUTHORITATIVE_ACCOUNT_SEED_REQUIRED",
            });
          }
          seedOwner = paperStateOwnerFactory({
            snapshotPath: stateSnapshotPath,
            runtimePackage,
            expectedPublisherAccountIdSha256,
          });
          const rawSnapshot = JSON.parse(await readFile(stateSnapshotPath, "utf8"));
          const validatedSnapshot = runtimePackage.validateImmutablePaperTradingStateSnapshot(rawSnapshot, Date.now());
          if (validatedSnapshot.publisherAccountIdSha256 !== expectedPublisherAccountIdSha256) {
            throw Object.assign(new Error("PAPER_FORWARD_AUTHORITATIVE_ACCOUNT_BINDING_MISMATCH"), {
              code: "PAPER_FORWARD_AUTHORITATIVE_ACCOUNT_BINDING_MISMATCH",
            });
          }
          if (validatedSnapshot.sourceSha !== researchCodeSha) {
            throw Object.assign(new Error("PAPER_FORWARD_AUTHORITATIVE_ACCOUNT_SOURCE_SHA_MISMATCH"), {
              code: "PAPER_FORWARD_AUTHORITATIVE_ACCOUNT_SOURCE_SHA_MISMATCH",
            });
          }
          authoritativeAccountSeedSnapshot = validatedSnapshot;
          seedPaperState = validatedSnapshot.state;
        }
      }

      cutover = await prepareResearchProductionIdentityCutover({
        rootDirectory,
        researchCodeSha,
        outcomeAccumulationEnabled,
        authoritativeAccountRequired,
      });

      resolvedAuthoritativeSourceWiring = {
        ...runtimePackage.createAuthoritativePaperEvidenceSourceWiring({ researchCodeSha }),
        ...resolvedAuthoritativeSourceWiring,
        createPaperAdmissionEvidenceProducer: runtimePackage.createPaperAdmissionEvidenceProducer,
      };

      if (authoritativeAccountRequired && persistedAccount) {
        const paperState = persistedAccount.paperState;
        const paperStateForCard = async () => {
          paperStateCallbackInvocationCount += 1;
          return paperState;
        };
        resolvedAuthoritativeSourceWiring = {
          ...resolvedAuthoritativeSourceWiring,
          paperStateForCard,
        };
        paperStateTransportStatus = "PERSISTED_AUTHORITATIVE_ACCOUNT_BOUND";
        paperStateAvailability = "PRESENT";
        paperStateTransportReason = null;
        paperStateSourceShaExact = true;
        paperStatePublisherAccountBound = true;
        paperStateOwnerAudit = Object.freeze({
          schemaVersion: persistedAccount.ledgerSchemaVersion,
          snapshotPath: null,
          writerConnected: true,
          writebackOwner: "recurring-paper-loop-atomic-state-store",
          initializesPaperState: false,
          recurringLedgerDerivationAllowed: false,
          authenticatedPublisherRequired: true,
          exactAccountBindingRequired: true,
          accountBindingVerified: true,
          unknownIsZero: false,
        });
      } else if (authoritativeAccountRequired && seedPaperState) {
        const paperStateForCard = async () => {
          paperStateCallbackInvocationCount += 1;
          return seedPaperState;
        };
        resolvedAuthoritativeSourceWiring = {
          ...resolvedAuthoritativeSourceWiring,
          paperStateForCard,
        };
        paperStateTransportStatus = "AUTHENTICATED_SEED_SNAPSHOT_BOUND";
        paperStateAvailability = "PRESENT";
        paperStateTransportReason = null;
        paperStateObservedAtMs = authoritativeAccountSeedSnapshot?.observedAtMs ?? null;
        paperStateSourceShaExact = true;
        paperStatePublisherAccountBound = true;
        paperStateOwnerAudit = Object.freeze({
          schemaVersion: seedOwner.schemaVersion,
          snapshotPath: seedOwner.snapshotPath,
          writerConnected: typeof seedOwner.writePaperStateSnapshot === "function",
          writebackOwner: "recurring-paper-loop-atomic-state-store",
          initializesPaperState: false,
          recurringLedgerDerivationAllowed: false,
          authenticatedPublisherRequired: true,
          exactAccountBindingRequired: true,
          accountBindingVerified: true,
          seedSourceShaExact: true,
          unknownIsZero: false,
        });
      } else if (!authoritativeAccountRequired && stateSnapshotPath && expectedPublisherAccountIdSha256) {
        const paperStateOwner = paperStateSourceFactory == null
          ? paperStateOwnerFactory({
            snapshotPath: stateSnapshotPath,
            runtimePackage,
            expectedPublisherAccountIdSha256,
          })
          : Object.freeze({
            schemaVersion: "paper-state-source-compatibility-override-v2",
            snapshotPath: stateSnapshotPath,
            paperStateForCard: paperStateSourceFactory({
              snapshotPath: stateSnapshotPath,
              runtimePackage,
              expectedPublisherAccountIdSha256,
            }),
            writePaperStateSnapshot: null,
            initializesPaperState: false,
            recurringLedgerDerivationAllowed: false,
            authenticatedPublisherRequired: true,
            exactAccountBindingRequired: true,
            unknownIsZero: false,
          });
        const paperStateForCard = async (...args) => {
          paperStateCallbackInvocationCount += 1;
          try {
            return await paperStateOwner.paperStateForCard(...args);
          } catch (error) {
            paperStateAvailability = paperStateSnapshotFailureState(error);
            paperStateTransportReason = paperStateFailureReason(paperStateAvailability);
            paperStateTransportStatus = `BLOCKED_DATA_${paperStateAvailability}`;
            throw Object.assign(new Error(paperStateTransportReason), {
              code: paperStateTransportReason,
            });
          }
        };
        resolvedAuthoritativeSourceWiring = {
          ...resolvedAuthoritativeSourceWiring,
          paperStateForCard,
        };
        paperStateTransportStatus = "CONFIGURED_EXACT_ACCOUNT_BOUND";
        paperStateAvailability = "PRESENT";
        paperStateTransportReason = null;
        paperStatePublisherAccountBound = true;
        paperStateOwnerAudit = Object.freeze({
          schemaVersion: paperStateOwner.schemaVersion,
          snapshotPath: paperStateOwner.snapshotPath,
          writerConnected: typeof paperStateOwner.writePaperStateSnapshot === "function",
          initializesPaperState: paperStateOwner.initializesPaperState === true,
          recurringLedgerDerivationAllowed: paperStateOwner.recurringLedgerDerivationAllowed === true,
          authenticatedPublisherRequired: paperStateOwner.authenticatedPublisherRequired === true,
          exactAccountBindingRequired: paperStateOwner.exactAccountBindingRequired === true,
          unknownIsZero: paperStateOwner.unknownIsZero === true,
        });
      } else if (!authoritativeAccountRequired
        && paperStateAvailability === "CONFIG_INCOMPLETE") {
        paperStateTransportStatus = "BLOCKED_DATA_CONFIG_INCOMPLETE";
      }

      authoritativeRuntimePackageAudit = Object.freeze({
        schemaVersion: runtimePackage.schemaVersion,
        sourceSha: runtimePackage.sourceSha,
        sourceGraphSha256: runtimePackage.sourceGraphSha256,
        bundleSha256: runtimePackage.bundleSha256,
        admissionBundleSchemaVersion: runtimePackage.admissionBundleSchemaVersion,
        callbackOwnerContractSchemaVersion: runtimePackage.callbackOwnerContractSchemaVersion,
        blockedDataSourceContractSchemaVersion: runtimePackage.blockedDataSourceContractSchemaVersion,
        costPolicyVersion: runtimePackage.costPolicyVersion,
        costPolicyVersionBinding: runtimePackage.costPolicyVersionBinding,
        executionAuthority: runtimePackage.executionAuthority,
        privateApiAllowed: runtimePackage.privateApiAllowed,
        liveTrading: runtimePackage.liveTrading,
        scheduleActivationAuthority: runtimePackage.scheduleActivationAuthority,
        financialMutationAllowed: runtimePackage.financialMutationAllowed,
        paperStateOwner: paperStateOwnerAudit,
      });
    }

    const invocation = {
      rootDirectory,
      researchCodeSha,
      activationAtMs,
      triggerSource,
      outcomeAccumulationEnabled,
      authoritativeAccountRequired,
      authoritativeAccountSeedSnapshot,
      expectedPublisherAccountIdSha256,
    };
    if (publicEvidenceProvider != null) {
      invocation.publicEvidenceProvider = meaningfulSearchPaperRuntimeForMarket == null
        ? publicEvidenceProvider
        : wrapPaperForwardProviderWithMeaningfulSearch({
          provider: publicEvidenceProvider,
          paperRuntimeForMarket: meaningfulSearchPaperRuntimeForMarket,
        });
    } else if (meaningfulSearchPaperRuntimeForMarket != null) {
      invocation.publicEvidenceProvider = researchProduction
        ? createCanonicalPaperForwardEvidenceProvider({
          env,
          paperRuntimeForMarket: meaningfulSearchPaperRuntimeForMarket,
        })
        : wrapPaperForwardProviderWithMeaningfulSearch({
          provider: createCanonicalPaperForwardEvidenceProvider({ env }),
          paperRuntimeForMarket: meaningfulSearchPaperRuntimeForMarket,
        });
    } else if (researchProduction) {
      const dependencies = authoritativePaperDependenciesFactory({
        sourceWiring: resolvedAuthoritativeSourceWiring,
        providerOptions: { env },
        runtimeFactory: createNaturalFunnelObservedPaperRuntimeFromSourceWiring,
      });
      invocation.publicEvidenceProvider = Object.freeze({
        async collectPublicEvidence(input) {
          const evidence = await dependencies.publicEvidenceProvider.collectPublicEvidence(input);
          const paperSource = evidence?.paperCandidateSource;
          if (input?.market === "CRYPTO_FUTURES"
            && (Array.isArray(paperSource?.stageMeasurements) || Array.isArray(paperSource?.naturalFunnelMeasurements))) {
            authoritativeRuntimeMeasurement = Object.freeze({
              stageMeasurements: paperSource?.stageMeasurements ?? [],
              firstZeroStage: paperSource?.firstZeroStage ?? "UNKNOWN",
              firstZeroReason: paperSource?.firstZeroReason ?? evidence.blocker ?? null,
              naturalFunnelMeasurements: paperSource?.naturalFunnelMeasurements ?? [],
              naturalFirstZeroStage: paperSource?.naturalFirstZeroStage ?? "UNKNOWN",
              naturalFirstZeroReason: paperSource?.naturalFirstZeroReason ?? null,
              naturalEvidenceIdentity: paperSource?.naturalEvidenceIdentity ?? null,
              naturalRuntimeSha: paperSource?.naturalRuntimeSha ?? null,
              canonicalNaturalStageEvidence: paperSource?.canonicalNaturalStageEvidence ?? null,
              exitEligibilityEvidence: paperSource?.exitEligibilityEvidence ?? null,
              authoritativeFirstZeroReasonEvidenceByStage:
                paperSource?.authoritativeFirstZeroReasonEvidenceByStage ?? {},
            });
          }
          return evidence;
        },
      });
      authoritativeSourceWiringAudit = dependencies.sourceWiringAudit ?? null;
    }
    const result = await runScheduledInvocation(invocation);
    const stageMeasurements = authoritativeRuntimeMeasurement?.stageMeasurements
      ?? authoritativeSourceWiringAudit?.stageMeasurements
      ?? [];
    const naturalFunnelMeasurements = finalizeNaturalFunnel(
      authoritativeRuntimeMeasurement?.naturalFunnelMeasurements ?? [],
      result,
    );
    const naturalZero = naturalFirstZero(naturalFunnelMeasurements);
    const canonicalNaturalStageEvidence = finalizeCanonicalNaturalStageEvidence({
      producerEvidence: authoritativeRuntimeMeasurement?.canonicalNaturalStageEvidence,
      loopEvidence: result?.summary?.canonicalNaturalStageEvidence,
      exitEligibilityEvidence: authoritativeRuntimeMeasurement?.exitEligibilityEvidence,
      cycleId: result?.cycleId,
      researchCodeSha,
      datasetIdentity: authoritativeRuntimeMeasurement?.naturalEvidenceIdentity,
      naturalScheduleInvocation: result?.invocation?.naturalScheduleInvocation === true,
      replayed: result?.status === "REPLAYED",
    });
    const output = {
      schemaVersion: "paper-forward-schedule-cli-v5",
      status: result.status,
      cycleId: result.cycleId ?? null,
      mutationCount: result.mutationCount ?? 0,
      scheduleActive: true,
      researchProduction,
      authoritativeAccountRequired,
      authoritativeAccount: result.invocation?.authoritativeAccount ?? null,
      identityCutover: cutover.identityCutover === true,
      archivedResearchSha: cutover.archivedResearchSha ?? null,
      archivedStrategyId: cutover.archivedStrategyId ?? null,
      naturalScheduleInvocation: result.invocation?.naturalScheduleInvocation === true,
      publicForwardEvidenceAccumulating: result.invocation?.publicForwardEvidenceAccumulating === true,
      paperTradeOutcomeAccumulationEnabled: result.invocation?.paperTradeOutcomeAccumulationEnabled === true,
      paperTradeOutcomeAccumulating: result.invocation?.paperTradeOutcomeAccumulating === true,
      simulatedFinancialAdaptersEnabled: result.persistedStatus?.simulatedFinancialAdaptersEnabled === true,
      externalFinancialMutationAllowed: false,
      lanes: result.invocation?.providerLanes ?? [],
      authoritativeSourceWiringStatus: authoritativeSourceWiringAudit?.status ?? null,
      firstZeroStage: authoritativeRuntimeMeasurement?.firstZeroStage
        ?? authoritativeSourceWiringAudit?.firstZeroStage
        ?? null,
      firstZeroReason: authoritativeRuntimeMeasurement?.firstZeroReason
        ?? authoritativeSourceWiringAudit?.firstZeroReason
        ?? null,
      authoritativeSourceBlockers: authoritativeSourceWiringAudit?.blockers ?? [],
      authoritativeStageMeasurements: stageMeasurements,
      naturalFunnelMeasurements,
      naturalFirstZeroStage: naturalZero.stage,
      naturalFirstZeroReason: naturalZero.reason,
      canonicalNaturalStageEvidence,
      canonicalNaturalFirstZeroStage: canonicalNaturalStageEvidence.firstZeroStage,
      canonicalNaturalFirstZeroReason: canonicalNaturalStageEvidence.firstZeroReason,
      naturalStrategySha: authoritativeRuntimeMeasurement?.naturalRuntimeSha ?? researchCodeSha,
      naturalRuntimeSha: researchCodeSha,
      naturalDatasetIdentity: authoritativeRuntimeMeasurement?.naturalEvidenceIdentity ?? null,
      authoritativeFirstZeroReasonEvidenceByStage:
        authoritativeRuntimeMeasurement?.authoritativeFirstZeroReasonEvidenceByStage ?? {},
      authoritativeRuntimePackage: authoritativeRuntimePackageAudit,
      paperStateTransport: Object.freeze({
        status: paperStateTransportStatus,
        state: paperStateAvailability,
        reason: paperStateTransportReason,
        observedAtMs: paperStateObservedAtMs,
        sourceShaExact: paperStateSourceShaExact,
        publisherAccountBound: paperStatePublisherAccountBound,
        callbackInvocationCount: paperStateCallbackInvocationCount,
        callbackInvoked: paperStateCallbackInvocationCount > 0,
        authenticatedPublisherRequired: true,
        exactAccountBindingRequired: true,
        recurringStateWritebackAtomic: authoritativeAccountRequired,
        snapshotSchemaVersion: "paper-trading-state-snapshot-v2",
        unknownIsZero: false,
      }),
      authoritativeEvidenceOwners: AUTHORITATIVE_PAPER_EVIDENCE_SOURCE_OWNERSHIP.sevenEvidenceOwnerSummary,
      universeCount: stageMeasurementCount(naturalFunnelMeasurements, "UNIVERSE"),
      scannerEvaluatedCount: stageMeasurementCount(naturalFunnelMeasurements, "SCANNER_EVALUATED"),
      scannerCandidateCount: stageMeasurementCount(naturalFunnelMeasurements, "CANDIDATE")
        ?? stageMeasurementCount(stageMeasurements, "Scanner Candidate"),
      evidenceCompleteCount: stageMeasurementCount(naturalFunnelMeasurements, "EVIDENCE_COMPLETE"),
      admissionPassCount: stageMeasurementCount(naturalFunnelMeasurements, "ADMISSION_PASS"),
      riskPassCount: stageMeasurementCount(naturalFunnelMeasurements, "RISK_PASS"),
      costPassCount: stageMeasurementCount(naturalFunnelMeasurements, "COST_PASS"),
      accountReadyCount: stageMeasurementCount(naturalFunnelMeasurements, "ACCOUNT_READY"),
      entryCount: stageMeasurementCount(naturalFunnelMeasurements, "PAPER_ENTRY")
        ?? stageMeasurementCount(stageMeasurements, "Entry"),
      positionCount: stageMeasurementCount(naturalFunnelMeasurements, "POSITION"),
      settlementCount: stageMeasurementCount(naturalFunnelMeasurements, "SETTLEMENT")
        ?? stageMeasurementCount(stageMeasurements, "Settlement"),
      outcomeCount: stageMeasurementCount(naturalFunnelMeasurements, "OUTCOME"),
      signalCandidateCount: canonicalNaturalStageEvidence.stageCounts.signalCandidate.count,
      qualityPassedCount: canonicalNaturalStageEvidence.stageCounts.qualityPassed.count,
      riskPassedDirectCount: canonicalNaturalStageEvidence.stageCounts.riskPassed.count,
      entryEligibleCount: canonicalNaturalStageEvidence.stageCounts.entryEligible.count,
      canonicalEntryCount: canonicalNaturalStageEvidence.stageCounts.entry.count,
      canonicalPositionCount: canonicalNaturalStageEvidence.stageCounts.position.count,
      exitEligibleCount: canonicalNaturalStageEvidence.stageCounts.exitEligible.count,
      canonicalSettlementCount: canonicalNaturalStageEvidence.stageCounts.settlement.count,
      canonicalPaperCandidateCount: stageMeasurementCount(stageMeasurements, "Identity"),
      privateRequestCount: 0,
      financialMutationCount: 0,
      orderCount: 0,
      liveTrading: false,
      orderAuthority: false,
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    if (result.status === "BLOCKED_DATA") process.exitCode = 2;
    return Object.freeze(output);
  } catch (error) {
    fail(`Paper Forward scheduled invocation failed closed: ${error?.code ?? error?.message ?? "UNKNOWN"}`, 1);
  }
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) await runPaperForwardScheduleCli();
