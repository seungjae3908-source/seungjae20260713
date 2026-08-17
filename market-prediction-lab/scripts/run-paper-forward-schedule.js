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

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

if (!truthy(process.env.PAPER_FORWARD_SCHEDULE_ACTIVE)) {
  fail("PAPER_FORWARD_SCHEDULE_ACTIVE must be explicitly true", 64);
} else if (forbiddenActivationKeys.some((key) => truthy(process.env[key]))) {
  fail("Paper Forward schedule refuses live trading or private API activation", 65);
} else {
  const rootDirectory = process.env.PAPER_FORWARD_ROOT ?? "/opt/stock-app-data/paper-forward-v1/runtime-state";
  const researchCodeSha = String(process.env.PAPER_FORWARD_RESEARCH_SHA ?? "").trim().toLowerCase();
  const activationAtMs = Number(process.env.PAPER_FORWARD_ACTIVATION_AT_MS);
  const triggerSource = process.env.PAPER_FORWARD_TRIGGER_SOURCE ?? "cron";

  try {
    const result = await runPaperForwardScheduledInvocation({
      rootDirectory,
      researchCodeSha,
      activationAtMs,
      triggerSource,
    });
    const output = {
      schemaVersion: "paper-forward-schedule-cli-v1",
      status: result.status,
      cycleId: result.cycleId ?? null,
      mutationCount: result.mutationCount ?? 0,
      scheduleActive: true,
      naturalScheduleInvocation: result.invocation?.naturalScheduleInvocation === true,
      publicForwardEvidenceAccumulating: result.invocation?.publicForwardEvidenceAccumulating === true,
      paperTradeOutcomeAccumulating: false,
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
