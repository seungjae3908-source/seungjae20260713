import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  BITGET_STANDARD_TAKER_RESEARCH_COSTS,
  HISTORICAL_V1_CRYPTO_SPECS,
} from "../src/historical-backtest-data.js";
import { runAutomatedV1Research } from "../src/automated-v1-research.js";

const inputRoot = resolve(process.argv[2] ?? "long-history-v1");
const outputPath = resolve(process.argv[3] ?? "artifacts/automated-research/v1-long-history.json");
const researchCodeSha = process.env.RESEARCH_CODE_SHA;
if (!/^[0-9a-f]{40}$/i.test(researchCodeSha ?? "")) throw new TypeError("RESEARCH_CODE_SHA must be an immutable 40-character SHA");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function coverageFor(raw) {
  const coverage = raw?.coverage ?? {};
  const ratio = coverage.coverageThroughAsOf === true ? 1 : null;
  return Object.freeze({
    sufficient: coverage.coverageThroughAsOf === true,
    ratio,
    status: coverage.status ?? "unknown",
    actualStartTime: coverage.actualStartTime ?? null,
    actualEndTime: coverage.actualEndTime ?? null,
  });
}

function rankingGroup(spec, side) {
  if (spec.market === "CRYPTO_SPOT") return "CRYPTO_SPOT_SWING";
  return side === "short" ? "CRYPTO_FUTURES_SWING_SHORT" : "CRYPTO_FUTURES_SWING_LONG";
}

const results = [];
const blocked = [];
for (const spec of HISTORICAL_V1_CRYPTO_SPECS) {
  let candleBundle;
  try {
    candleBundle = await readJson(resolve(inputRoot, `${spec.id}.candles.json`));
  } catch (error) {
    blocked.push(Object.freeze({ id: spec.id, market: spec.market, status: "blocked_missing_long_history_cache", message: String(error?.message ?? error) }));
    continue;
  }

  let fundingRates = [];
  if (spec.market === "CRYPTO_FUTURES") {
    try {
      const fundingBundle = await readJson(resolve(inputRoot, `${spec.id}.funding.json`));
      fundingRates = fundingBundle.records ?? [];
    } catch (error) {
      blocked.push(Object.freeze({ id: spec.id, market: spec.market, status: "blocked_missing_funding_cache", message: String(error?.message ?? error) }));
      continue;
    }
  }

  const sides = spec.market === "CRYPTO_FUTURES" ? ["long", "short"] : ["long"];
  for (const side of sides) {
    const result = runAutomatedV1Research({
      backtestInput: {
        market: spec.market,
        symbol: spec.researchSymbol,
        side,
        timeframe: spec.timeframe,
        initialCapital: 1_000_000,
        candles: candleBundle.candles,
        fundingRates,
        costModel: BITGET_STANDARD_TAKER_RESEARCH_COSTS[spec.market],
        riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 },
        dataCoverage: coverageFor(candleBundle),
      },
    });
    results.push(Object.freeze({
      rankingGroup: rankingGroup(spec, side),
      datasetId: spec.id,
      provider: spec.provider,
      crossVenueProxy: spec.market === "CRYPTO_FUTURES" && spec.provider !== "bitget-public-v2",
      result,
    }));
  }
}

const artifact = Object.freeze({
  schemaVersion: 1,
  mode: "automated-v1-long-history",
  researchCodeSha,
  generatedAt: new Date().toISOString(),
  dataSource: "existing-long-history-v1-cache",
  cacheProvenanceRequired: true,
  realHistoricalDataOnly: true,
  syntheticResearchDataAllowed: false,
  automatedGroups: Object.freeze([...new Set(results.map((row) => row.rankingGroup))]),
  pendingGroups: Object.freeze([
    "CRYPTO_SPOT_SCALPING",
    "CRYPTO_FUTURES_SCALPING_LONG",
    "CRYPTO_FUTURES_SCALPING_SHORT",
    "KR_STOCK_SCALPING",
    "KR_STOCK_SWING",
    "US_STOCK_SCALPING",
    "US_STOCK_SWING",
  ]),
  results: Object.freeze(results),
  blocked: Object.freeze(blocked),
  safety: Object.freeze({
    branchWrite: false,
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
    orderSubmitted: false,
    finalHoldoutUsedForSelection: false,
    finalHoldoutRetuningAllowed: false,
  }),
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  status: blocked.length === 0 ? "ok" : "partial",
  researchCodeSha,
  automatedGroups: artifact.automatedGroups,
  results: results.length,
  blocked: blocked.length,
  liveOrderAllowed: false,
  privateAccountRequestAllowed: false,
  orderSubmitted: false,
}));
