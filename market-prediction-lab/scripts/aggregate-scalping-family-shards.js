import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SCALPING_ADAPTER_CONTRACTS } from "../src/scalping-family-research.js";

const inputRoot = resolve(process.argv[2] ?? "artifacts/scalping-family-shards");
const rawOutput = resolve(process.argv[3] ?? "artifacts/automated-research/scalping-family-raw-results.json");
const rankingOutput = resolve(process.argv[4] ?? "artifacts/automated-research/scalping-family-ranking.json");
const researchCodeSha = process.env.RESEARCH_CODE_SHA;
if (!/^[0-9a-f]{40}$/iu.test(researchCodeSha ?? "")) throw new Error("RESEARCH_CODE_SHA must be immutable SHA");

const DATASET_KEYS = Object.freeze([
  "spot-btc-long", "spot-eth-long",
  "futures-btc-long", "futures-eth-long",
  "futures-btc-short", "futures-eth-short",
]);
const FAMILY_VERSIONS = Object.freeze(["V2", "V3", "V4", "V5", "V6"]);
const EXPECTED_SHARDS = Object.freeze(DATASET_KEYS.flatMap((datasetKey) => FAMILY_VERSIONS.map((familyVersion) => `${datasetKey}|${familyVersion}`)));

async function listFiles(root) {
  const rows = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) rows.push(...await listFiles(path));
    else rows.push(path);
  }
  return rows;
}
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function candidateKey(row) {
  return [row.group, row.version, row.family, row.symbol, row.direction, row.candidateId].join("|");
}
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function comparable(row) {
  const stress = row.executionCostStress?.stressed;
  const values = [
    row.expectancy, row.profitFactor, row.totalReturn, row.MDD, row.oosTradeCount, row.wfStability?.stabilityScore,
    stress?.expectancy, stress?.profitFactor, stress?.totalReturn, stress?.maximumDrawdown,
  ];
  return values.every(finite);
}
function objectiveValues(row) {
  const stress = row.executionCostStress.stressed;
  return [
    row.expectancy,
    row.profitFactor,
    row.totalReturn,
    -Math.abs(row.MDD),
    row.oosTradeCount,
    row.wfStability.stabilityScore,
    stress.expectancy,
    stress.profitFactor,
    stress.totalReturn,
    -Math.abs(stress.maximumDrawdown),
  ];
}
function dominates(left, right) {
  if (!comparable(left) || !comparable(right)) return false;
  const a = objectiveValues(left);
  const b = objectiveValues(right);
  return a.every((value, index) => value >= b[index]) && a.some((value, index) => value > b[index]);
}
function paretoTop10(rows) {
  const remaining = rows.filter(comparable);
  const ordered = [];
  let paretoFront = 1;
  while (remaining.length > 0) {
    const front = remaining.filter((candidate) => !remaining.some((other) => other !== candidate && dominates(other, candidate)))
      .sort((left, right) => candidateKey(left).localeCompare(candidateKey(right)));
    if (front.length === 0) break;
    for (const row of front) ordered.push(Object.freeze({
      rank: ordered.length + 1,
      paretoFront,
      artifactKey: candidateKey(row),
      market: row.market,
      group: row.group,
      family: row.family,
      version: row.version,
      symbol: row.symbol,
      direction: row.direction,
      actionContract: row.market === "CRYPTO_FUTURES" ? "LONG_SHORT" : "BUY_SELL",
      entryAction: row.market === "CRYPTO_FUTURES" ? row.direction : "BUY",
      candidateId: row.candidateId,
      oosTradeCount: row.oosTradeCount,
      expectancy: row.expectancy,
      profitFactor: row.profitFactor,
      netReturn: row.totalReturn,
      MDD: row.MDD,
      walkForwardStability: row.wfStability?.stabilityScore ?? null,
      executionCostStress: row.executionCostStress,
      researchStatus: row.researchStatus,
      promotionEligible: false,
      promotionBlockReasons: Object.freeze(["empirical_promotion_thresholds_uncalibrated"]),
    }));
    const frontKeys = new Set(front.map(candidateKey));
    for (let index = remaining.length - 1; index >= 0; index -= 1) if (frontKeys.has(candidateKey(remaining[index]))) remaining.splice(index, 1);
    paretoFront += 1;
  }
  return Object.freeze(ordered.slice(0, 10));
}

const shardFiles = (await listFiles(inputRoot)).filter((path) => path.endsWith(".raw.json")).sort();
const shards = [];
for (const path of shardFiles) {
  const artifact = await readJson(path);
  if (artifact.mode !== "scalping-v2-v6-bounded-family-raw-results") throw new Error(`INVALID_SCALPING_SHARD_MODE:${path}`);
  if (artifact.researchCodeSha !== researchCodeSha) throw new Error(`SCALPING_SHARD_SHA_MISMATCH:${path}`);
  const datasetKey = artifact.shard?.datasetKey;
  const familyVersion = artifact.shard?.familyVersion;
  if (!DATASET_KEYS.includes(datasetKey) || !FAMILY_VERSIONS.includes(familyVersion)) throw new Error(`INVALID_SCALPING_SHARD_ID:${path}`);
  shards.push(Object.freeze({ path, key: `${datasetKey}|${familyVersion}`, artifact }));
}
const observed = shards.map((row) => row.key).sort();
const duplicates = observed.filter((key, index) => observed.indexOf(key) !== index);
const missing = EXPECTED_SHARDS.filter((key) => !observed.includes(key));
if (duplicates.length > 0) throw new Error(`DUPLICATE_SCALPING_SHARDS:${[...new Set(duplicates)].join(",")}`);
if (missing.length > 0) throw new Error(`MISSING_SCALPING_SHARDS:${missing.join(",")}`);

const results = Object.freeze(shards.flatMap((row) => row.artifact.results ?? []));
const candidates = Object.freeze(shards.flatMap((row) => row.artifact.candidates ?? []));
const byFamily = Object.freeze(shards.flatMap((row) => row.artifact.multipleTesting?.byFamily ?? []));
const global = Object.freeze({
  strategyFamilyCount: new Set(byFamily.map((row) => row.strategyFamily)).size,
  structuralFamilyCount: new Set(byFamily.map((row) => row.structuralFamily)).size,
  developmentAttempts: byFamily.reduce((sum, row) => sum + (row.developmentAttempts ?? 0), 0),
  oosAdmissions: byFamily.reduce((sum, row) => sum + (row.oosAdmissions ?? 0), 0),
  wfAdmissions: byFamily.reduce((sum, row) => sum + (row.wfAdmissions ?? 0), 0),
  totalCandidatesTested: byFamily.reduce((sum, row) => sum + (row.totalCandidatesTested ?? 0), 0),
  dataSnoopingRisk: "bounded_family_search_recorded; exact shard matrix; no search-until-positive loop; final holdout locked",
});
const groupNames = Object.freeze(["CRYPTO_SPOT_SCALPING", "BINANCE_FUTURES_SCALPING_LONG", "BINANCE_FUTURES_SCALPING_SHORT"]);
const crossSymbolValidation = Object.freeze(groupNames.flatMap((group) => FAMILY_VERSIONS.map((version) => {
  const rows = candidates.filter((row) => row.group === group && row.version === version);
  const symbols = [...new Set(rows.map((row) => row.symbol).filter(Boolean))].sort();
  const positive = rows.filter((row) => row.totalReturn > 0 && row.expectancy > 0 && row.executionCostStress?.positiveAfterStress === true).length;
  return Object.freeze({
    group, version, validation: "preliminary", symbolCount: symbols.length, symbols: Object.freeze(symbols),
    candidateObservations: rows.length, positiveObservationRatio: rows.length ? positive / rows.length : null,
    executionCostStressIncluded: rows.length > 0 && rows.every((row) => ["survived", "failed"].includes(row.executionCostStress?.status)),
    fullMarketStabilityValidated: false, candidateFreezeAllowed: false, finalHoldoutQueueAllowed: false,
  });
})));
const first = shards[0].artifact;
const rawArtifact = Object.freeze({
  schemaVersion: 2,
  mode: "scalping-v2-v6-bounded-family-raw-results",
  researchCodeSha,
  shardMatrix: Object.freeze({ expected: EXPECTED_SHARDS.length, observed: observed.length, complete: true, keys: Object.freeze(observed) }),
  selectionPeriod: first.selectionPeriod,
  finalHoldoutPeriod: first.finalHoldoutPeriod,
  adapterContracts: SCALPING_ADAPTER_CONTRACTS,
  results,
  candidates,
  multipleTesting: Object.freeze({ byFamily, global }),
  crossSymbolValidation,
  finalHoldoutUsed: false,
  finalHoldoutRead: false,
  topStrategy: "NONE",
  syntheticDataUsedAsReal: false,
  privateApiUsed: false,
  orderSubmitted: false,
});
const cryptoGroups = groupNames.map((group) => {
  const rows = candidates.filter((row) => row.group === group);
  const top10 = paretoTop10(rows);
  return Object.freeze({
    group,
    status: top10.length > 0 ? "research_ranked" : "fail_closed",
    rankingBasis: "Pareto non-dominated OOS/WF/sample/MDD/net-return/execution-cost-stress; no empirical promotion threshold",
    availableCandidateCount: rows.length,
    excludedIncompleteMetricCount: rows.filter((row) => !comparable(row)).length,
    rows: top10,
    top10,
    topStrategy: "NONE",
    promotionAllowed: false,
    candidateFreezeAllowed: false,
    finalHoldoutQueueAllowed: false,
  });
});
const blockedStockGroups = ["KR_STOCK_SCALPING", "US_STOCK_SCALPING"].map((group) => Object.freeze({
  group,
  status: "blocked_provider",
  rankingBasis: "none",
  availableCandidateCount: 0,
  excludedIncompleteMetricCount: 0,
  rows: Object.freeze([]),
  top10: Object.freeze([]),
  topStrategy: "NONE",
  promotionAllowed: false,
  candidateFreezeAllowed: false,
  finalHoldoutQueueAllowed: false,
  blocker: "reproducible_public_historical_provider_with_corporate_action_and_survivorship_provenance_not_available",
}));
const rankingArtifact = Object.freeze({
  schema: "scalping-strategy-ranking-v2",
  schemaVersion: 2,
  mode: "historical-research-ranking-not-live-signal-score",
  researchCodeSha,
  rawResultsPath: rawOutput,
  groups: Object.freeze([...cryptoGroups, ...blockedStockGroups]),
  rankingMethod: "pareto_non_dominated_multi_metric_no_empirical_threshold",
  gateCalibrationStatus: "RESEARCH_ONLY_NOT_FINAL_PROMOTION_GATE",
  topStrategy: "NONE",
  finalHoldoutUsed: false,
  finalHoldoutRead: false,
  candidateFreezeAllowed: false,
  finalHoldoutQueueAllowed: false,
  automaticLivePromotion: false,
  productionMutationAllowed: false,
  privateApiUsed: false,
  orderSubmitted: false,
});
await writeJson(rawOutput, rawArtifact);
await writeJson(rankingOutput, rankingArtifact);
console.log(JSON.stringify({
  status: "ok", researchCodeSha, shardCount: observed.length,
  groups: rankingArtifact.groups.map((row) => ({ group: row.group, status: row.status, top10: row.top10.length })),
  multipleTesting: global, topStrategy: "NONE", finalHoldoutUsed: false, privateApiUsed: false, orderSubmitted: false,
}));
