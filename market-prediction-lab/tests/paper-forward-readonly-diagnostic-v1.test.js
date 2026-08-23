import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectPaperForwardReadonlyRuntime,
} from "../src/paper-forward-readonly-diagnostic-v1.js";

const SHA = "1".repeat(40);
const PUBLISHER_DIGEST = "2".repeat(64);
const NOW = Date.UTC(2026, 7, 24, 0, 0, 0);
const TAG = "# stock-app-paper-forward-v1";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function makeRoot() {
  return mkdtemp(join(tmpdir(), "paper-readonly-diagnostic-"));
}

function flatPaperState({ open = false, pending = false } = {}) {
  const at = new Date(NOW - 1_000).toISOString();
  return {
    schemaVersion: 1,
    account: {
      id: "sensitive-account-id-must-not-leak",
      initialBalance: 10_000,
      cashBalance: 10_000,
      realizedPnl: 0,
      unrealizedPnl: open ? 5 : 0,
      equity: 10_000,
      usedMargin: open ? 100 : 0,
      availableMargin: open ? 9_900 : 10_000,
      createdAt: at,
      updatedAt: at,
    },
    orders: pending ? [{ id: "order-1", status: "pending" }] : [],
    positions: open ? [{ id: "position-1", status: "open", notionalValue: 200 }] : [],
    fills: [],
    journal: [],
    processedEventIds: [],
    riskState: {
      dayKey: "2026-08-24",
      weekKey: "2026-W35",
      dailyRealizedPnl: 0,
      weeklyRealizedPnl: 0,
      consecutiveLosses: 0,
    },
    createdAt: at,
    updatedAt: at,
  };
}

async function seedFixture(root, {
  state = flatPaperState(),
  active = true,
  disabled = false,
  natural = true,
  runtimeScheduleActive = true,
} = {}) {
  const activationAtMs = NOW - 120_000;
  const snapshotPath = join(root, "publisher", "paper-state-v2.json");
  await writeJson(join(root, "activation.json"), {
    schemaVersion: "paper-forward-schedule-no-deploy-activation-v2",
    status: "ACTIVE_WAITING_FOR_NATURAL_CYCLE",
    targetSha: SHA,
    paperRuntimeSourceSha: SHA,
    productionAppShaBefore: "3".repeat(40),
    productionAppDeployPerformed: false,
    productionAppMutationAllowed: false,
    activationAtMs,
    scheduleActive: active,
    liveTrading: false,
    privateAccountAccess: false,
    orderAuthority: false,
  });
  await writeJson(join(root, "publisher-binding.json"), {
    schemaVersion: "paper-state-publisher-runtime-binding-v1",
    paperRuntimeSourceSha: SHA,
    snapshotPath,
    publisherAccountIdSha256: PUBLISHER_DIGEST,
    immutable: true,
    executionAuthority: "NONE",
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
  });
  await writeJson(snapshotPath, {
    schemaVersion: "paper-trading-state-snapshot-v2",
    paperStateSchemaVersion: 1,
    sourceOwner: "authenticated-paper-trading-evaluate-v2",
    sourceSha: SHA,
    market: "CRYPTO_FUTURES",
    currency: "USDT",
    provenance: ["authenticated-member-session"],
    publisherAccountIdSha256: PUBLISHER_DIGEST,
    observedAtMs: NOW - 500,
    stateUpdatedAtMs: NOW - 1_000,
    maximumAgeMs: 3_600_000,
    accountId: state.account.id,
    equity: state.account.equity,
    openPositionCount: state.positions.filter((position) => position.status !== "closed").length,
    stateDigestSha256: createHash("sha256").update(canonicalJson(state)).digest("hex"),
    state,
    immutable: true,
    executionAuthority: "NONE",
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
  });
  await writeJson(join(root, "runtime-state", "status", "runtime-status.json"), {
    scheduleActive: runtimeScheduleActive,
    simulatedFinancialAdaptersEnabled: true,
    externalFinancialMutationAllowed: false,
  });
  await writeJson(join(root, "runtime-state", "state", "recurring-paper-loop.json"), {
    identity: { researchCodeSha: SHA },
    cycles: natural ? [{ id: "cycle-1" }] : [],
    positions: [],
    settlements: [],
  });
  await mkdir(join(root, "runtime-state", "status"), { recursive: true });
  if (natural) {
    await writeFile(
      join(root, "runtime-state", "status", "invocations.jsonl"),
      `${JSON.stringify({
        cycleId: "cycle-1",
        triggerSource: "cron",
        naturalScheduleInvocation: true,
        invokedAtMs: activationAtMs + 10_000,
        completedAtMs: activationAtMs + 20_000,
        status: "COMPLETED",
        mutationCount: 1,
        publicForwardEvidenceAccumulating: true,
        paperTradeOutcomeAccumulationEnabled: true,
        providerLanes: ["KR", "US", "SPOT", "FUTURES"].map(
          (market) => ({ market, status: "READY" }),
        ),
        privateRequestCount: 0,
        financialMutationCount: 0,
        orderCount: 0,
        liveTrading: false,
        orderAuthority: false,
      })}\n`,
      "utf8",
    );
  }
  if (disabled) {
    await writeFile(join(root, "DISABLED"), "", "utf8");
    await mkdir(join(root, "runtime-state"), { recursive: true });
    await writeFile(join(root, "runtime-state", "DISABLED"), "", "utf8");
    await writeJson(join(root, "disabled.json"), {
      schemaVersion: "paper-forward-schedule-disable-v1",
      status: "DISABLED",
      scheduleActive: false,
      statePreserved: true,
      liveTrading: false,
      privateAccountAccess: false,
      orderAuthority: false,
    });
  }
}

test("active runtime reports verified natural cycle and sanitized flat seed", async () => {
  const root = await makeRoot();
  try {
    await seedFixture(root);
    const result = inspectPaperForwardReadonlyRuntime({
      stateRoot: root,
      crontabText: `*/15 * * * * /usr/bin/flock -n /tmp/lock /tmp/run ${TAG}\n`,
      nowMs: NOW,
    });
    assert.equal(result.schedule.verdict, "ACTIVE");
    assert.equal(result.schedule.managedCronCount, 1);
    assert.equal(result.publisher.seedEligibility, "READY");
    assert.equal(result.publisher.snapshot.flatSeed, true);
    assert.equal(result.naturalCycle.verdict, "VERIFIED");
    assert.equal(result.naturalCycle.privateRequestCount, 0);
    assert.equal(result.naturalCycle.financialMutationCount, 0);
    assert.equal(result.naturalCycle.orderCount, 0);
    assert.equal(result.safety.liveTrading, false);
    assert.equal(result.safety.orderAuthority, false);
    assert.equal(result.stateCounts.cycleCount, 1);
    assert.equal(result.firstZero.stage, "UNKNOWN");
    assert.equal(result.firstZero.derived, false);

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(PUBLISHER_DIGEST), false);
    assert.equal(serialized.includes("sensitive-account-id-must-not-leak"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic-disable evidence reports disabled without inventing a natural cycle", async () => {
  const root = await makeRoot();
  try {
    await seedFixture(root, { disabled: true, natural: false });
    const result = inspectPaperForwardReadonlyRuntime({
      stateRoot: root,
      crontabText: "",
      nowMs: NOW,
    });
    assert.equal(result.schedule.verdict, "DISABLED");
    assert.equal(result.schedule.managedCronCount, 0);
    assert.equal(result.schedule.disabledRootSentinel, true);
    assert.equal(result.naturalCycle.verdict, "NOT_VERIFIED_DISABLED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-flat authenticated snapshot exposes only blocker and aggregate counts", async () => {
  const root = await makeRoot();
  try {
    await seedFixture(root, {
      state: flatPaperState({ open: true, pending: true }),
      natural: false,
    });
    const result = inspectPaperForwardReadonlyRuntime({
      stateRoot: root,
      crontabText: `*/15 * * * * /tmp/run ${TAG}\n`,
      nowMs: NOW,
    });
    assert.equal(result.publisher.seedEligibility, "BLOCKED_OR_UNKNOWN");
    assert.equal(result.publisher.snapshot.flatSeed, false);
    assert.ok(
      result.publisher.seedBlockers.includes("AUTHORITATIVE_NATURAL_PAPER_SEED_NOT_FLAT"),
    );
    assert.equal(result.publisher.snapshot.openPositionCount, 1);
    assert.equal(result.publisher.snapshot.pendingOrderCount, 1);

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(PUBLISHER_DIGEST), false);
    assert.equal(serialized.includes("sensitive-account-id-must-not-leak"), false);
    assert.equal(serialized.includes("position-1"), false);
    assert.equal(serialized.includes("order-1"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing snapshot never becomes a ready authoritative seed", async () => {
  const root = await makeRoot();
  try {
    await seedFixture(root, { natural: false });
    await rm(join(root, "publisher", "paper-state-v2.json"));
    const result = inspectPaperForwardReadonlyRuntime({
      stateRoot: root,
      crontabText: `*/15 * * * * /tmp/run ${TAG}\n`,
      nowMs: NOW,
    });
    assert.equal(result.publisher.snapshot.present, false);
    assert.equal(result.publisher.seedEligibility, "BLOCKED_OR_UNKNOWN");
    assert.ok(result.publisher.seedBlockers.includes("SNAPSHOT_MISSING"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled sentinel with a managed cron entry is fail-closed inconsistent", async () => {
  const root = await makeRoot();
  try {
    await seedFixture(root, { disabled: true, natural: false });
    const result = inspectPaperForwardReadonlyRuntime({
      stateRoot: root,
      crontabText: `*/15 * * * * /tmp/run ${TAG}\n`,
      nowMs: NOW,
    });
    assert.equal(result.schedule.verdict, "INCONSISTENT");
    assert.ok(result.warnings.includes("SCHEDULE_EVIDENCE_INCONSISTENT"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed evidence fails closed and remains read-only", async () => {
  const root = await makeRoot();
  try {
    await mkdir(join(root, "runtime-state", "status"), { recursive: true });
    await writeFile(join(root, "activation.json"), "{broken", "utf8");
    await writeFile(
      join(root, "runtime-state", "status", "invocations.jsonl"),
      "{broken\n",
      "utf8",
    );
    const result = inspectPaperForwardReadonlyRuntime({
      stateRoot: root,
      crontabText: "",
      nowMs: NOW,
    });
    assert.equal(result.schedule.verdict, "UNKNOWN");
    assert.equal(result.readOnly, true);
    assert.equal(result.sensitiveValuesEmitted, false);
    assert.equal(result.networkAccessUsed, false);
    assert.equal(result.privateApiUsed, false);
    assert.equal(result.financialMutationPerformed, false);
    assert.ok(result.warnings.includes("ACTIVATION_EVIDENCE_MALFORMED"));
    assert.ok(result.warnings.includes("INVOCATION_ROWS_MALFORMED"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production diagnostic source contains no mutation or network primitive", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const moduleSource = await readFile(
    join(here, "..", "src", "paper-forward-readonly-diagnostic-v1.js"),
    "utf8",
  );
  const cliSource = await readFile(
    join(here, "..", "scripts", "run-paper-forward-readonly-diagnostic.js"),
    "utf8",
  );
  const source = `${moduleSource}\n${cliSource}`;
  for (const forbidden of [
    "writeFileSync",
    "writeFile(",
    "appendFile",
    "rename(",
    "unlink(",
    "rm(",
    "mkdir(",
    "chmod(",
    "chown(",
    "systemctl",
    "curl ",
    "wget ",
    "fetch(",
    "crontab -",
    "REAL_ORDER_ENABLED='true'",
    "PRIVATE_TRADING_API_ALLOWED='true'",
    "LIVE_TRADING='true'",
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden primitive found: ${forbidden}`);
  }
  assert.match(cliSource, /execFileSync\("crontab", \["-l"\]/u);
});
