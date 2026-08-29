import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";

const COUNTER_KEYS = Object.freeze([
  "suffixV1Verifications",
  "suffixV1CandleTraversals",
  "onePassExecutions",
  "onePassCandleTraversals",
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function normalizeIdentity(value) {
  if (Array.isArray(value)) return value.map(normalizeIdentity);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      ["researchCodeSha", "researchSHA", "collectionCodeSHA"].includes(key)
        && typeof child === "string"
        && /^[0-9a-f]{40}$/u.test(child)
        ? "<CURRENT_SHA>"
        : normalizeIdentity(child),
    ]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stable(normalizeIdentity(value))))
    .digest("hex");
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`instrumentation target mismatch: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

async function instrument() {
  const preload = `import { writeFileSync } from "node:fs";\n\nconst output = process.env.BENCHMARK_STATS_PATH;\nif (!output) throw new Error("BENCHMARK_STATS_PATH is required");\nglobalThis.__V34_BENCHMARK_STATS__ = {\n  suffixV1Verifications: 0,\n  suffixV1CandleTraversals: 0,\n  onePassExecutions: 0,\n  onePassCandleTraversals: 0,\n};\nprocess.on("exit", () => {\n  writeFileSync(\n    \`${"${output}"}.${"${process.pid}"}.json\`,\n    \`${"${JSON.stringify(globalThis.__V34_BENCHMARK_STATS__, null, 2)}"}\\n\`,\n    "utf8",\n  );\n});\n`;
  await writeFile("scripts/v34-benchmark-preload.js", preload, "utf8");

  for (const file of [
    "src/v3-market-filter-optimizer.js",
    "src/v4-momentum-regime-optimizer.js",
  ]) {
    let source = await readFile(file, "utf8");
    source = replaceOnce(
      source,
      "  const onePass = runIndependentSignalBacktest({",
      "  globalThis.__V34_BENCHMARK_STATS__.onePassExecutions += 1;\n  globalThis.__V34_BENCHMARK_STATS__.onePassCandleTraversals += candles.length;\n  const onePass = runIndependentSignalBacktest({",
      `${file}:one-pass`,
    );
    source = replaceOnce(
      source,
      "        const continuation = runV1Backtest({",
      "        globalThis.__V34_BENCHMARK_STATS__.suffixV1Verifications += 1;\n        globalThis.__V34_BENCHMARK_STATS__.suffixV1CandleTraversals += executionCandles.length - index;\n        const continuation = runV1Backtest({",
      `${file}:suffix-v1`,
    );
    await writeFile(file, source, "utf8");
  }
}

async function verifyDataset(path) {
  const bundle = JSON.parse(await readFile(path, "utf8"));
  const expectedCount = Number(requireEnv("EXPECTED_CANDLE_COUNT"));
  if (bundle.candles?.length !== expectedCount) throw new Error(`candle count mismatch: ${bundle.candles?.length}`);
  if (bundle.audit?.normalizedCandleDigest !== requireEnv("EXPECTED_SOURCE_DIGEST")) throw new Error("source digest mismatch");
  if (bundle.audit?.normalizedFundingDigest !== requireEnv("EXPECTED_FUNDING_DIGEST")) throw new Error("funding digest mismatch");
  if (bundle.audit?.selectionDataStatus !== "DATA_READY") throw new Error("selection data not ready");
  if (bundle.audit?.finalHoldoutRead !== false) throw new Error("Final Holdout was read");
  if (bundle.audit?.crossVenueMix !== false) throw new Error("cross-venue mix detected");
}

function parseMaxRss(text, label) {
  const match = text.match(/Maximum resident set size \(kbytes\):\s*(\d+)/u);
  if (!match) throw new Error(`peak RSS missing: ${label}`);
  return Number(match[1]);
}

async function aggregateStats(root, version) {
  const prefix = `${version}.stats.json.`;
  const names = (await readdir(root))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort();
  if (names.length === 0) throw new Error(`${version} benchmark stats shards missing`);
  const totals = Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0]));
  for (const name of names) {
    const row = JSON.parse(await readFile(`${root}/${name}`, "utf8"));
    for (const key of COUNTER_KEYS) {
      if (!Number.isFinite(row[key]) || row[key] < 0) {
        throw new Error(`${version} invalid benchmark counter ${key} in ${name}`);
      }
      totals[key] += row[key];
    }
  }
  return Object.freeze({ ...totals, statsShardCount: names.length });
}

async function summarize(root) {
  const rows = [];
  for (const version of ["V3", "V4"]) {
    const raw = JSON.parse(await readFile(`${root}/${version}.raw.json`, "utf8"));
    const stats = await aggregateStats(root, version);
    const wall = JSON.parse(await readFile(`${root}/${version}.wall.json`, "utf8"));
    const timeText = await readFile(`${root}/${version}.time.txt`, "utf8");
    const actualDigest = digest(raw);
    const expectedDigest = requireEnv(`EXPECTED_${version}_RESULT_DIGEST`);
    if (actualDigest !== expectedDigest) throw new Error(`${version} legacy-result digest mismatch: ${actualDigest}`);
    if (raw.finalHoldoutUsed !== false || raw.finalHoldoutRead !== false) throw new Error(`${version} Final Holdout isolation failed`);
    if (raw.privateApiUsed !== false || raw.orderSubmitted !== false) throw new Error(`${version} safety flags failed`);
    const stageCount = Number(requireEnv("EXPECTED_STAGE_COUNT"));
    if (stats.onePassExecutions !== stageCount) throw new Error(`${version} stage count mismatch: ${stats.onePassExecutions}`);
    if (stats.suffixV1Verifications > stageCount) throw new Error(`${version} more than one suffix V1 verification per stage`);

    const baselineSeconds = Number(requireEnv(`BASELINE_${version}_SECONDS`));
    const baselineCalls = Number(requireEnv(`BASELINE_${version}_SUFFIX_V1_CALLS`));
    const baselineVisits = Number(requireEnv(`BASELINE_${version}_CANDLE_VISITS`));
    const totalTraversalsAfter = stats.onePassCandleTraversals + stats.suffixV1CandleTraversals;
    rows.push(Object.freeze({
      version,
      targetSha: requireEnv("TARGET_SHA"),
      candleCount: Number(requireEnv("EXPECTED_CANDLE_COUNT")),
      sourceDigest: requireEnv("EXPECTED_SOURCE_DIGEST"),
      fundingDigest: requireEnv("EXPECTED_FUNDING_DIGEST"),
      legacyResultDigest: expectedDigest,
      currentResultDigest: actualDigest,
      resultDifferenceCount: 0,
      stageCount: stats.onePassExecutions,
      statsShardCount: stats.statsShardCount,
      suffixV1ExecutionsBefore: baselineCalls,
      suffixV1ExecutionsAfter: stats.suffixV1Verifications,
      onePassCandleTraversals: stats.onePassCandleTraversals,
      suffixV1CandleTraversals: stats.suffixV1CandleTraversals,
      totalCandleTraversalsAfter: totalTraversalsAfter,
      legacyWeightedCandleVisits: baselineVisits,
      wallClockSecondsBefore: baselineSeconds,
      wallClockSecondsAfter: wall.wallClockSeconds,
      speedup: baselineSeconds / wall.wallClockSeconds,
      runtimeReductionPercent: (1 - wall.wallClockSeconds / baselineSeconds) * 100,
      suffixV1ReductionPercent: (1 - stats.suffixV1Verifications / baselineCalls) * 100,
      traversalReductionPercent: (1 - totalTraversalsAfter / baselineVisits) * 100,
      peakRssKiB: parseMaxRss(timeText, version),
      finalHoldoutUsed: false,
      privateApiUsed: false,
      orderSubmitted: false,
    }));
  }

  const summary = Object.freeze({
    schemaVersion: 1,
    contract: "v34-one-pass-same-dataset-benchmark-v1",
    exactHead: requireEnv("TARGET_SHA"),
    historicalHarnessSha: requireEnv("HISTORICAL_HARNESS_SHA"),
    fullTradeRegression: "tests/v34-one-pass-runtime-equivalence.test.js deepEqual legacy vs one-pass",
    rows: Object.freeze(rows),
    strategySemanticChange: "NONE",
    costAssumptionChange: "NONE",
    riskAssumptionChange: "NONE",
    finalHoldoutUsed: false,
    productionMutation: false,
    privateApiUsed: false,
    orderSubmitted: false,
  });
  await writeFile(`${root}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

const [mode, argument] = process.argv.slice(2);
if (mode === "instrument") await instrument();
else if (mode === "verify-dataset") await verifyDataset(argument);
else if (mode === "summarize") await summarize(argument);
else throw new Error(`unsupported mode: ${mode ?? "<missing>"}`);
