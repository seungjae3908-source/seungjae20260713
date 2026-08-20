import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

function expectedStrategyId(outcomeAccumulationEnabled) {
  return outcomeAccumulationEnabled
    ? "paper-forward-simulated-outcome-v1"
    : "paper-forward-public-evidence-v1";
}

export function resolveOutcomeAccumulationEnabled(env = process.env) {
  if (truthy(env.RESEARCH_PRODUCTION)) return true;
  return truthy(env.PAPER_FORWARD_OUTCOME_ACCUMULATION_ENABLED);
}

export async function prepareResearchProductionIdentityCutover({
  rootDirectory,
  researchCodeSha,
  outcomeAccumulationEnabled,
  nowMs = Date.now(),
} = {}) {
  if (!immutableSha(researchCodeSha)) throw new Error("Research Production Paper cutover requires an exact research SHA");
  if (typeof outcomeAccumulationEnabled !== "boolean") throw new Error("Research Production Paper cutover requires an explicit outcome mode");
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
  const desiredStrategyId = expectedStrategyId(outcomeAccumulationEnabled);
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

  const rootDirectory = env.PAPER_FORWARD_ROOT ?? "/opt/stock-app-data/paper-forward-v1/runtime-state";
  const researchCodeSha = String(env.PAPER_FORWARD_RESEARCH_SHA ?? "").trim().toLowerCase();
  const activationAtMs = Number(env.PAPER_FORWARD_ACTIVATION_AT_MS);
  const triggerSource = env.PAPER_FORWARD_TRIGGER_SOURCE ?? "cron";
  const researchProduction = truthy(env.RESEARCH_PRODUCTION);
  const outcomeAccumulationEnabled = resolveOutcomeAccumulationEnabled(env);

  try {
    const cutover = researchProduction
      ? await prepareResearchProductionIdentityCutover({
        rootDirectory,
        researchCodeSha,
        outcomeAccumulationEnabled,
      })
      : Object.freeze({ identityCutover: false, archivedResearchSha: null, archivedStrategyId: null });
    const invocation = {
      rootDirectory,
      researchCodeSha,
      activationAtMs,
      triggerSource,
      outcomeAccumulationEnabled,
    };
    if (publicEvidenceProvider != null || meaningfulSearchPaperRuntimeForMarket != null) {
      const baseProvider = publicEvidenceProvider ?? createCanonicalPaperForwardEvidenceProvider();
      invocation.publicEvidenceProvider = meaningfulSearchPaperRuntimeForMarket == null
        ? baseProvider
        : wrapPaperForwardProviderWithMeaningfulSearch({
          provider: baseProvider,
          paperRuntimeForMarket: meaningfulSearchPaperRuntimeForMarket,
        });
    }
    const result = await runScheduledInvocation(invocation);
    const output = {
      schemaVersion: "paper-forward-schedule-cli-v3",
      status: result.status,
      cycleId: result.cycleId ?? null,
      mutationCount: result.mutationCount ?? 0,
      scheduleActive: true,
      researchProduction,
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
      privateRequestCount: 0,
      financialMutationCount: 0,
      orderCount: 0,
      liveTrading: false,
      orderAuthority: false,
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    if (result.status === "BLOCKED_DATA") process.exitCode = 2;
  } catch (error) {
    fail(`Paper Forward scheduled invocation failed closed: ${error?.code ?? error?.message ?? "UNKNOWN"}`, 1);
  }
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) await runPaperForwardScheduleCli();
