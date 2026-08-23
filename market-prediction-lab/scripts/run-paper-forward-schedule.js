import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AUTHORITATIVE_PAPER_EVIDENCE_SOURCE_OWNERSHIP } from "../src/authoritative-paper-evidence-source-ownership-v1.js";
import { createAuthoritativePaperForwardDependenciesFromSourceWiring } from "../src/authoritative-paper-runtime-factory-v1.js";
import { createNaturalFunnelObservedPaperRuntimeFromSourceWiring } from "../src/authoritative-paper-natural-funnel-v1.js";
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

function truthy(value) {
  return TRUTHY.has(String(value ?? "").trim().toLowerCase());
}

function immutableSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function digest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
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
    let authoritativeAccountSeedSnapshot = null;
    let expectedPublisherAccountIdSha256 = null;
    let resolvedAuthoritativeSourceWiring = authoritativePaperSourceWiring ?? {};
    let cutover = Object.freeze({ identityCutover: false, archivedResearchSha: null, archivedStrategyId: null });

    if (researchProduction) {
      const runtimePackage = await authoritativePaperPackageLoader();
      const stateSnapshotPath = String(env.PAPER_FORWARD_PAPER_STATE_SNAPSHOT_PATH ?? "").trim();
      const publisherAccountIdSha256 = String(
        env.PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256 ?? "",
      ).trim();
      expectedPublisherAccountIdSha256 = digest(publisherAccountIdSha256)
        ? publisherAccountIdSha256
        : null;

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
          return paperStateOwner.paperStateForCard(...args);
        };
        resolvedAuthoritativeSourceWiring = {
          ...resolvedAuthoritativeSourceWiring,
          paperStateForCard,
        };
        paperStateTransportStatus = "CONFIGURED_EXACT_ACCOUNT_BOUND";
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
      } else if (!authoritativeAccountRequired && (stateSnapshotPath || publisherAccountIdSha256)) {
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
      naturalStrategySha: authoritativeRuntimeMeasurement?.naturalRuntimeSha ?? researchCodeSha,
      naturalRuntimeSha: researchCodeSha,
      naturalDatasetIdentity: authoritativeRuntimeMeasurement?.naturalEvidenceIdentity ?? null,
      authoritativeRuntimePackage: authoritativeRuntimePackageAudit,
      paperStateTransport: Object.freeze({
        status: paperStateTransportStatus,
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
