import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { hostname } from "node:os";
import {
  createRecurringPaperLoopState,
  restoreRecurringPaperLoopState,
  runRecurringPaperCycle,
} from "./recurring-paper-loop-v1.js";
import {
  createCanonicalPaperForwardEvidenceProvider,
  runPaperForwardEvidenceRuntime,
} from "./paper-forward-evidence-runtime-v1.js";
import { createFilePaperLearningStore } from "./paper-forward-persistent-learning-store-v1.js";
import {
  createSimulatedPaperLedgerAdapter,
  createSimulatedPaperLearningAdapter,
} from "./paper-simulated-adapters-v1.js";
import { createFilePaperSchedulerLeaseStore } from "./paper-scheduler-driver-v1.js";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const DEFAULT_LEASE_DURATION_MS = 10 * 60 * 1000;

export const PAPER_FORWARD_SCHEDULE_CADENCE = Object.freeze({
  version: "paper-forward-public-evidence-4h-v1",
  intervalMs: FOUR_HOURS_MS,
});

export const PAPER_FORWARD_SCHEDULE_ACTIVATION_CONTRACT = Object.freeze({
  version: "paper-forward-schedule-activation-v1",
  scheduleActive: true,
  trigger: "USER_CRONTAB_15_MINUTE_POLL",
  canonicalCycleIntervalMs: FOUR_HOURS_MS,
  publicDataOnly: true,
  simulatedOnly: true,
  liveTrading: false,
  privateAccountAccess: false,
  privateTradingApiAllowed: false,
  orderAuthority: false,
  singleHostOnly: true,
  distributedMultiHostSupported: false,
  financialMutationAdaptersEnabled: false,
  simulatedFinancialAdaptersEnabled: false,
  externalFinancialMutationAllowed: false,
  paperTradeOutcomeAccumulationEnabled: false,
  paperTradeOutcomeAccumulating: false,
});

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function immutableSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertRootDirectory(rootDirectory) {
  if (!nonEmpty(rootDirectory) || !isAbsolute(rootDirectory)) {
    throw new TypeError("absolute Paper Forward state root is required");
  }
  const root = resolve(rootDirectory);
  if (root === "/" || root === "/opt/stock-app" || root.startsWith("/opt/stock-app/")) {
    throw new Error("Paper Forward state must remain outside the deploy source tree");
  }
  return root;
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWriteText(filePath, text) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, filePath);
}

async function atomicWriteJson(filePath, value) {
  await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJsonl(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await appendFile(filePath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "a",
    mode: 0o600,
  });
}

async function disabledSentinelPresent(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function activationContract(outcomeAccumulationEnabled) {
  if (!outcomeAccumulationEnabled) return PAPER_FORWARD_SCHEDULE_ACTIVATION_CONTRACT;
  return Object.freeze({
    ...PAPER_FORWARD_SCHEDULE_ACTIVATION_CONTRACT,
    version: "paper-forward-schedule-simulated-outcome-v1",
    financialMutationAdaptersEnabled: true,
    simulatedFinancialAdaptersEnabled: true,
    externalFinancialMutationAllowed: false,
    paperTradeOutcomeAccumulationEnabled: true,
    paperTradeOutcomeAccumulating: false,
  });
}

function buildIdentity(researchCodeSha, outcomeAccumulationEnabled = false) {
  if (!immutableSha(researchCodeSha)) throw new TypeError("immutable Paper Forward research SHA is required");
  const parameterHash = sha256(stableSerialize(outcomeAccumulationEnabled
    ? {
      authority: "canonical-paper-forward-provider-v1",
      cadence: PAPER_FORWARD_SCHEDULE_CADENCE,
      financialMutationAdaptersEnabled: true,
      simulatedOnly: true,
    }
    : {
      authority: "canonical-paper-forward-provider-v1",
      cadence: PAPER_FORWARD_SCHEDULE_CADENCE,
      financialMutationAdaptersEnabled: false,
    }));
  return Object.freeze({
    strategyId: outcomeAccumulationEnabled
      ? "paper-forward-simulated-outcome-v1"
      : "paper-forward-public-evidence-v1",
    strategyVersion: "1.0.0",
    parameterHash,
    researchCodeSha,
    costPolicyVersion: outcomeAccumulationEnabled
      ? "paper-forward-simulated-ledger-v1"
      : "paper-forward-observation-only-v1",
    executionPolicyVersion: outcomeAccumulationEnabled
      ? "public-evidence-simulated-paper-v1"
      : "public-evidence-no-financial-mutation-v1",
  });
}

function initialLedger() {
  return Object.freeze({
    schemaVersion: "paper-forward-observation-ledger-v1",
    status: "READY",
    initialCapitalKrw: 1_000_000,
    baseCurrency: "KRW",
    knownEquityKrw: 1_000_000,
    totalEquityKrw: 1_000_000,
    balances: Object.freeze({ KRW: 1_000_000 }),
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    profitabilityClaimAllowed: false,
  });
}

function failClosedFinancialAdapters() {
  const forbidden = (operation) => {
    throw Object.assign(
      new Error(`Paper Forward financial mutation adapter is disabled: ${operation}`),
      { code: "PAPER_FORWARD_FINANCIAL_MUTATION_DISABLED" },
    );
  };
  return Object.freeze({
    ledgerAdapter: Object.freeze({
      applyEntry: async () => forbidden("applyEntry"),
      applySettlement: async () => forbidden("applySettlement"),
    }),
    learningAdapter: Object.freeze({
      persistSignal: async () => forbidden("persistSignal"),
      persistOutcome: async () => forbidden("persistOutcome"),
    }),
  });
}

function statePaths(root) {
  return Object.freeze({
    root,
    disableSentinel: join(root, "DISABLED"),
    state: join(root, "state", "recurring-paper-loop.json"),
    runtimeStatus: join(root, "status", "runtime-status.json"),
    invocations: join(root, "status", "invocations.jsonl"),
    leases: join(root, "leases"),
    cycleReceipts: join(root, "cycles"),
    learning: join(root, "learning"),
  });
}

async function loadOrCreateState(paths, identity, nowMs) {
  const existing = await readJsonOrNull(paths.state);
  if (existing) return restoreRecurringPaperLoopState(existing, identity);
  const created = createRecurringPaperLoopState({
    identity,
    ledger: initialLedger(),
    createdAtMs: nowMs,
  });
  await atomicWriteJson(paths.state, created);
  return created;
}

function createPersistentStateStore(paths) {
  return Object.freeze({
    async save({ cycleId, idempotencyKey, state }) {
      if (!nonEmpty(cycleId) || idempotencyKey !== `paper-cycle:${cycleId}`) {
        throw new Error("Paper Forward state idempotency key mismatch");
      }
      const parsed = JSON.parse(state);
      await atomicWriteText(paths.state, state);
      await atomicWriteJson(join(paths.cycleReceipts, `${sha256(cycleId)}.json`), {
        schemaVersion: "paper-forward-cycle-receipt-v1",
        cycleId,
        idempotencyKey,
        updatedAtMs: parsed.updatedAtMs,
        stateCycleCount: parsed.cycles?.length ?? 0,
        positionCount: parsed.positions?.length ?? 0,
        settlementCount: parsed.settlements?.length ?? 0,
        privateRequestCount: 0,
        financialMutationCount: 0,
      });
    },
  });
}

function activeRuntimeStatus(value, previous, activationAtMs, outcomeAccumulationEnabled = false) {
  const replayed = value?.status === "REPLAYED";
  const lanes = replayed && Array.isArray(previous?.lanes)
    ? previous.lanes
    : (Array.isArray(value?.lanes) ? value.lanes : []);
  const allReady = lanes.length === 4 && lanes.every((lane) => lane?.status === "READY");
  const outcomeAccumulating = replayed
    ? previous?.paperTradeOutcomeAccumulating === true
    : outcomeAccumulationEnabled
      && value?.status === "COMPLETED"
      && allReady
      && Number(value?.outcomeCount ?? 0) > 0;
  return Object.freeze({
    ...value,
    schemaVersion: "paper-forward-active-runtime-status-v1",
    preparedRuntimeContractScheduleActive: value?.scheduleActive === true,
    scheduleActive: true,
    activationVersion: activationContract(outcomeAccumulationEnabled).version,
    activationAtMs,
    trigger: PAPER_FORWARD_SCHEDULE_ACTIVATION_CONTRACT.trigger,
    canonicalCycleIntervalMs: FOUR_HOURS_MS,
    lanes: Object.freeze(lanes.map((lane) => Object.freeze({ ...lane }))),
    allProvidersReady: allReady,
    publicForwardEvidenceAccumulating: replayed
      ? previous?.publicForwardEvidenceAccumulating === true
      : value?.status === "COMPLETED" && allReady,
    paperTradeOutcomeAccumulationEnabled: outcomeAccumulationEnabled,
    paperTradeOutcomeAccumulating: outcomeAccumulating,
    financialMutationAdaptersEnabled: outcomeAccumulationEnabled,
    simulatedFinancialAdaptersEnabled: outcomeAccumulationEnabled,
    externalFinancialMutationAllowed: false,
    privateRequestCount: 0,
    orderCount: 0,
    financialMutationCount: 0,
    liveTrading: false,
    orderAuthority: false,
  });
}

function createPersistentRuntimeStatusStore(paths, activationAtMs, outcomeAccumulationEnabled) {
  return Object.freeze({
    load: () => readJsonOrNull(paths.runtimeStatus),
    async save(value) {
      const previous = await readJsonOrNull(paths.runtimeStatus);
      await atomicWriteJson(paths.runtimeStatus, activeRuntimeStatus(
        value,
        previous,
        activationAtMs,
        outcomeAccumulationEnabled,
      ));
    },
  });
}

function buildFinancialAdapters({ paths, outcomeAccumulationEnabled, accountingEvidenceForSettlement }) {
  if (!outcomeAccumulationEnabled) return failClosedFinancialAdapters();
  const learningStore = createFilePaperLearningStore({ directory: paths.learning });
  return Object.freeze({
    ledgerAdapter: createSimulatedPaperLedgerAdapter({ accountingEvidenceForSettlement }),
    learningAdapter: createSimulatedPaperLearningAdapter({ learningStore }),
  });
}

export async function runPaperForwardScheduledInvocation({
  rootDirectory,
  researchCodeSha,
  triggerSource = "cron",
  activationAtMs = Date.now(),
  ownerId = `${hostname()}:${process.pid}`,
  clock = Date.now,
  publicEvidenceProvider = createCanonicalPaperForwardEvidenceProvider({ clock }),
  runRuntime = runPaperForwardEvidenceRuntime,
  leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
  outcomeAccumulationEnabled = false,
  accountingEvidenceForSettlement,
} = {}) {
  const root = assertRootDirectory(rootDirectory);
  if (!immutableSha(researchCodeSha)) throw new TypeError("immutable researchCodeSha is required");
  if (!["cron", "manual-readonly-test"].includes(triggerSource)) {
    throw new TypeError("allowed triggerSource is required");
  }
  if (!finite(activationAtMs) || typeof clock !== "function") {
    throw new TypeError("finite activation time and clock are required");
  }
  if (typeof outcomeAccumulationEnabled !== "boolean") {
    throw new TypeError("outcomeAccumulationEnabled must be boolean");
  }

  const paths = statePaths(root);
  if (await disabledSentinelPresent(paths.disableSentinel)) {
    throw Object.assign(new Error("Paper Forward schedule is disabled"), {
      code: "PAPER_FORWARD_SCHEDULE_DISABLED",
    });
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const nowMs = clock();
  if (!finite(nowMs)) throw new TypeError("clock must return a finite number");

  const identity = buildIdentity(researchCodeSha, outcomeAccumulationEnabled);
  const state = await loadOrCreateState(paths, identity, nowMs);
  const stateStore = createPersistentStateStore(paths);
  const runtimeStatusStore = createPersistentRuntimeStatusStore(paths, activationAtMs, outcomeAccumulationEnabled);
  const { ledgerAdapter, learningAdapter } = buildFinancialAdapters({
    paths,
    outcomeAccumulationEnabled,
    accountingEvidenceForSettlement,
  });
  const leaseStore = createFilePaperSchedulerLeaseStore({ directory: paths.leases });

  const result = await runRuntime({
    publicEvidenceProvider,
    runtimeStatusStore,
    runtimeClock: clock,
    state,
    cadence: PAPER_FORWARD_SCHEDULE_CADENCE,
    nowMs,
    ownerId,
    leaseStore,
    leaseDurationMs,
    ledgerAdapter,
    learningAdapter,
    stateStore,
    retry: Object.freeze({
      maxAttempts: 3,
      baseBackoffMs: 500,
      timeoutMs: 30_000,
    }),
    clock,
    runCycle: (input) => runRecurringPaperCycle({
      ...input,
      cycle: Object.freeze({
        ...input.cycle,
        identity,
      }),
    }),
  });

  const persistedStatus = await runtimeStatusStore.load();
  const newPublicEvidenceAccepted = triggerSource === "cron"
    && result?.status === "COMPLETED"
    && persistedStatus?.allProvidersReady === true;
  const publicForwardEvidenceAccumulating = triggerSource === "cron"
    && persistedStatus?.publicForwardEvidenceAccumulating === true;
  const paperTradeOutcomeAccumulating = triggerSource === "cron"
    && persistedStatus?.paperTradeOutcomeAccumulating === true;
  const record = Object.freeze({
    schemaVersion: "paper-forward-schedule-invocation-v1",
    invokedAtMs: nowMs,
    completedAtMs: finite(result?.completedAtMs) ? result.completedAtMs : clock(),
    triggerSource,
    cycleId: result?.cycleId ?? null,
    status: result?.status ?? "FAILED",
    mutationCount: Number(result?.mutationCount ?? 0),
    scheduleActive: true,
    naturalScheduleInvocation: triggerSource === "cron",
    newPublicEvidenceAccepted,
    publicForwardEvidenceAccumulating,
    paperTradeOutcomeAccumulationEnabled: outcomeAccumulationEnabled,
    paperTradeOutcomeAccumulating,
    financialMutationAdaptersEnabled: outcomeAccumulationEnabled,
    simulatedFinancialAdaptersEnabled: outcomeAccumulationEnabled,
    externalFinancialMutationAllowed: false,
    providerLanes: Object.freeze((persistedStatus?.lanes ?? []).map((lane) => Object.freeze({
      market: lane.market,
      provider: lane.provider,
      status: lane.status,
      dataAsOfMs: lane.dataAsOfMs ?? null,
      acceptedEvidenceCount: lane.acceptedEvidenceCount ?? 0,
    }))),
    privateRequestCount: 0,
    financialMutationCount: 0,
    orderCount: 0,
    liveTrading: false,
    orderAuthority: false,
  });
  await appendJsonl(paths.invocations, record);
  return Object.freeze({
    ...result,
    schedule: activationContract(outcomeAccumulationEnabled),
    persistedStatus,
    invocation: record,
    rootDirectory: root,
  });
}

export async function readPaperForwardScheduleSnapshot(rootDirectory) {
  const root = assertRootDirectory(rootDirectory);
  const paths = statePaths(root);
  const state = await readJsonOrNull(paths.state);
  const runtimeStatus = await readJsonOrNull(paths.runtimeStatus);
  let lastInvocation = null;
  try {
    const lines = (await readFile(paths.invocations, "utf8")).trim().split("\n").filter(Boolean);
    if (lines.length > 0) lastInvocation = JSON.parse(lines.at(-1));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Object.freeze({
    schemaVersion: "paper-forward-schedule-snapshot-v1",
    scheduleActive: !(await disabledSentinelPresent(paths.disableSentinel)),
    stateCycleCount: state?.cycles?.length ?? 0,
    positionCount: state?.positions?.length ?? 0,
    settlementCount: state?.settlements?.length ?? 0,
    runtimeStatus,
    lastInvocation,
    privateRequestCount: 0,
    financialMutationCount: 0,
    liveTrading: false,
    orderAuthority: false,
  });
}

export const __paperForwardScheduleTestables = Object.freeze({
  assertRootDirectory,
  buildIdentity,
  failClosedFinancialAdapters,
  initialLedger,
  activeRuntimeStatus,
  activationContract,
});
