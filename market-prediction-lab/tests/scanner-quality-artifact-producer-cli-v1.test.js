import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { TRANSACTION_COST_COMPONENTS } from "../../market-intelligence-sidecar/src/transaction-cost-evidence.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const CLI = path.join(ROOT, "market-prediction-lab", "scripts", "run-scanner-quality-artifact-producer-v1.js");
const SHA = "a".repeat(40);
const identity = {
  strategyId: "CRYPTO_FUTURES_SWING_V1_LONG",
  strategyVersion: "signal-profile-v1",
  parameterHash: "b".repeat(64),
  researchCodeSha: SHA,
  market: "CRYPTO_FUTURES",
  symbol: "BTCUSDT",
  timeframe: "60m",
  direction: "LONG",
  datasetSnapshotHash: "c".repeat(64),
};

function fold() {
  return {
    fold: 1,
    leakFree: true,
    outOfSample: [
      { anchorTimestamp: 1_700_000_000_000, futureEndTimestamp: 1_700_000_001_000 },
      { anchorTimestamp: 1_700_000_002_000, futureEndTimestamp: 1_700_000_003_000 },
    ],
    walkForwardTest: [
      { anchorTimestamp: 1_700_000_004_000, futureEndTimestamp: 1_700_000_005_000 },
      { anchorTimestamp: 1_700_000_006_000, futureEndTimestamp: 1_700_000_007_000 },
    ],
    report: {
      maxTrainFuture: 1_699_999_999_999,
      maxValidationFuture: 1_700_000_003_999,
      embargoMs: 0,
    },
  };
}
function trade(id, entry, exit, ret, pnl) {
  return {
    id,
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    strategy: "fixture-strategy",
    regime: "fixture-regime",
    timeframe: "60m",
    side: "long",
    action: "LONG",
    entryTime: entry,
    exitTime: exit,
    netPnl: pnl,
    netReturnOnMargin: ret,
    entryNotional: 1000,
    costsIncluded: true,
    costs: { total: 1 },
  };
}
function result(startTime, endTime, prefix) {
  return {
    ok: true,
    mode: "backtest-only",
    orderSubmitted: false,
    privateAccountRequestAllowed: false,
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    timeframe: "60m",
    side: "long",
    initialCapital: 10_000,
    period: { startTime, effectiveEndTime: endTime },
    costModel: {
      entryFeeRate: 0.001,
      exitFeeRate: 0.001,
      taxRate: 0,
      slippageRate: 0.0005,
      spreadRate: 0.0002,
      latencyBars: 1,
      latencyDriftRate: 0.0001,
    },
    safeguards: {
      signalUsesClosedCandle: true,
      entryUsesNextCandleOpen: true,
      stopFirstOnAmbiguousBar: true,
      costsIncluded: true,
    },
    trades: Array.from({ length: 45 }, (_, i) =>
      trade(`${prefix}-${i}`, startTime, endTime, i % 3 ? 0.018 : -0.009, i % 3 ? 18 : -9)),
  };
}
function costs() {
  const components = {};
  const pointCosts = {};
  const conservativeCosts = {};
  for (const component of TRANSACTION_COST_COMPONENTS) {
    components[component] = { status: "READY" };
    pointCosts[component] = 1;
    conservativeCosts[component] = 2;
  }
  return {
    contract: "market-intelligence-transaction-cost-evidence/v1",
    market: "CRYPTO_FUTURES",
    evidenceSetVersion: "cost-v1",
    status: "READY",
    readyForNetAlpha: true,
    components,
    pointCosts,
    conservativeCosts,
    totalPointCostBps: 8,
    totalConservativeCostBps: 16,
    safety: {
      executionAuthority: "NONE",
      promotionAuthority: false,
      orderAllowed: false,
      privateTradingApiAllowed: false,
    },
  };
}
async function fixture(root, invalidCost = false) {
  const f = fold();
  const values = {
    identity,
    folds: [f],
    foldResults: [{
      fold: 1,
      binding: identity,
      outOfSampleResult: result(f.outOfSample[0].anchorTimestamp, f.outOfSample.at(-1).futureEndTimestamp, "o"),
      walkForwardResult: result(f.walkForwardTest[0].anchorTimestamp, f.walkForwardTest.at(-1).futureEndTimestamp, "w"),
    }],
    datasetAudit: {
      eligible: true,
      safeguards: { lookaheadBlocked: true, closedCandlesOnly: true, survivorshipProtected: true },
    },
    transactionCostEvidence: costs(),
  };
  if (invalidCost) values.transactionCostEvidence.components.partialFillImpactBps = { status: "NOT_AVAILABLE" };
  const files = {};
  for (const [name, value] of Object.entries(values)) {
    const file = path.join(root, `${name}.json`);
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
    files[name] = file;
  }
  return files;
}

test("CLI writes create-only quality + manifest and verifies readback digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scanner-quality-cli-"));
  const files = await fixture(root);
  const output = path.join(root, "out");
  const { stdout } = await execFileAsync(process.execPath, [
    CLI,
    "--identity", files.identity,
    "--folds", files.folds,
    "--fold-results", files.foldResults,
    "--dataset-audit", files.datasetAudit,
    "--transaction-cost-evidence", files.transactionCostEvidence,
    "--output-dir", output,
  ]);
  const status = JSON.parse(stdout);
  assert.equal(status.status, "READY");
  assert.equal(status.qualityArtifactWritten, true);
  assert.equal(status.executionAuthority, "NONE");
  const quality = await readFile(path.join(output, "quality.json"), "utf8");
  const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.qualitySha256, status.qualitySha256);
  assert.ok(quality.includes('"forward-observer-scanner-quality-v1"'));

  await assert.rejects(
    execFileAsync(process.execPath, [
      CLI,
      "--identity", files.identity,
      "--folds", files.folds,
      "--fold-results", files.foldResults,
      "--dataset-audit", files.datasetAudit,
      "--transaction-cost-evidence", files.transactionCostEvidence,
      "--output-dir", output,
    ]),
  );
});

test("CLI writes no quality artifact when canonical evidence is blocked", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scanner-quality-cli-"));
  const files = await fixture(root, true);
  const output = path.join(root, "blocked");
  let error;
  try {
    await execFileAsync(process.execPath, [
      CLI,
      "--identity", files.identity,
      "--folds", files.folds,
      "--fold-results", files.foldResults,
      "--dataset-audit", files.datasetAudit,
      "--transaction-cost-evidence", files.transactionCostEvidence,
      "--output-dir", output,
    ]);
  } catch (value) {
    error = value;
  }
  assert.ok(error);
  const status = JSON.parse(error.stdout);
  assert.equal(status.status, "BLOCKED_DATA");
  assert.equal(status.qualityArtifactWritten, false);
  await assert.rejects(readFile(path.join(output, "quality.json"), "utf8"));
});
