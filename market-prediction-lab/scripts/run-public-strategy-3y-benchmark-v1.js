import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles } from "../src/bitget-candle-collector.js";
import { collectFundingRateHistory } from "../src/derivatives-history.js";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import {
  BENCHMARK_END_TIME,
  BENCHMARK_HORIZONS_V1,
  BENCHMARK_START_TIME,
  PUBLIC_REFERENCE_REPLICATION_READINESS_V1,
  buildPublicStrategyBenchmarkPlanV1,
  simulateRelativeMomentumProxyV1,
  simulateTimeSeriesMomentumProxyV1,
  summarizeTsmomUniverseV1,
} from "../src/public-strategy-benchmark-v1.js";

const BRANCH_WRITE = false;
const CRYPTO_SYMBOLS = Object.freeze(["BTCUSDT", "ETHUSDT"]);
const STOCK_SYMBOLS = Object.freeze({
  KR_STOCK: Object.freeze(["005930", "000660", "035420"]),
  US_STOCK: Object.freeze(["AAPL", "MSFT", "NVDA"]),
});

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: String(error?.message ?? error).slice(0, 1200),
    details: error?.details ?? null,
  };
}

async function save(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function date(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function number(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "-";
}

function maxCandlesFor(horizon) {
  if (horizon === "SHORT") return 120_000;
  if (horizon === "SWING") return 35_000;
  return 2_000;
}

async function collectCryptoProfile({ client, market, horizon }) {
  const timeframe = BENCHMARK_HORIZONS_V1[horizon].timeframe;
  const datasets = [];
  for (const symbol of CRYPTO_SYMBOLS) {
    const collected = await collectBitgetCandles({
      client,
      market,
      symbol,
      timeframe,
      startTime: BENCHMARK_START_TIME,
      endTime: BENCHMARK_END_TIME,
      maxCandles: maxCandlesFor(horizon),
    });
    datasets.push({
      symbol,
      candles: collected.candles,
      source: collected.provider,
      candleCount: collected.candles.length,
      firstTimestamp: collected.candles[0]?.timestamp ?? null,
      lastTimestamp: collected.candles.at(-1)?.timestamp ?? null,
    });
  }
  return datasets;
}

async function collectStockPosition(market) {
  const datasets = [];
  for (const symbol of STOCK_SYMBOLS[market]) {
    const collected = await collectYahooStockHistory({
      market,
      symbol,
      startTime: BENCHMARK_START_TIME,
      endTime: BENCHMARK_END_TIME,
      timeoutMs: 20_000,
    });
    datasets.push({
      symbol,
      candles: collected.candles,
      source: collected.source,
      providerSymbol: collected.providerSymbol,
      candleCount: collected.candles.length,
      firstTimestamp: collected.candles[0]?.timestamp ?? null,
      lastTimestamp: collected.candles.at(-1)?.timestamp ?? null,
    });
  }
  return datasets;
}

async function collectFuturesFunding(client) {
  const funding = {};
  for (const symbol of CRYPTO_SYMBOLS) {
    const result = await collectFundingRateHistory({
      client,
      symbol,
      startTime: BENCHMARK_START_TIME,
      endTime: BENCHMARK_END_TIME,
      pageSize: 100,
      maxPages: 60,
    });
    funding[symbol] = result.records;
  }
  return funding;
}

function compactTsmom(result) {
  if (result?.status !== "EXECUTED_PROXY") return result;
  return {
    status: result.status,
    recipeId: result.recipeId,
    strategy: result.strategy,
    market: result.market,
    symbol: result.symbol,
    horizon: result.horizon,
    timeframe: result.timeframe,
    costMultiplier: result.costMultiplier,
    performance: result.performance,
    walkForward: result.walkForward,
    parameters: result.parameters,
    safeguards: result.safeguards,
  };
}

function compactRelative(result) {
  if (result?.status !== "EXECUTED_PROXY") return result;
  return {
    status: result.status,
    recipeId: result.recipeId,
    strategy: result.strategy,
    market: result.market,
    horizon: result.horizon,
    timeframe: result.timeframe,
    symbols: result.symbols,
    costMultiplier: result.costMultiplier,
    performance: result.performance,
    walkForward: result.walkForward,
    parameters: result.parameters,
    safeguards: result.safeguards,
  };
}

function benchmarkProfile({ market, horizon, datasets, fundingRatesBySymbol = {}, providerRisk = null }) {
  const tsmomBase = datasets.map((dataset) => simulateTimeSeriesMomentumProxyV1({
    market,
    symbol: dataset.symbol,
    horizon,
    candles: dataset.candles,
    fundingRates: fundingRatesBySymbol[dataset.symbol] ?? [],
    costMultiplier: 1,
  }));
  const tsmomStress = datasets.map((dataset) => simulateTimeSeriesMomentumProxyV1({
    market,
    symbol: dataset.symbol,
    horizon,
    candles: dataset.candles,
    fundingRates: fundingRatesBySymbol[dataset.symbol] ?? [],
    costMultiplier: 1.5,
  }));
  const relativeBase = simulateRelativeMomentumProxyV1({
    market,
    horizon,
    datasets,
    fundingRatesBySymbol,
    costMultiplier: 1,
  });
  const relativeStress = simulateRelativeMomentumProxyV1({
    market,
    horizon,
    datasets,
    fundingRatesBySymbol,
    costMultiplier: 1.5,
  });
  return {
    status: "EXECUTED_PROXY",
    profileId: `${market}:${horizon}`,
    market,
    horizon,
    timeframe: BENCHMARK_HORIZONS_V1[horizon].timeframe,
    data: datasets.map(({ candles: ignored, ...metadata }) => metadata),
    providerRisk,
    tsmom: {
      base: tsmomBase.map(compactTsmom),
      stress15x: tsmomStress.map(compactTsmom),
      baseSummary: summarizeTsmomUniverseV1(tsmomBase),
      stressSummary: summarizeTsmomUniverseV1(tsmomStress),
    },
    relativeMomentum: {
      base: compactRelative(relativeBase),
      stress15x: compactRelative(relativeStress),
    },
    economicCreditAllowed: false,
    promotionAllowed: false,
  };
}

function blockedProfile(market, horizon, reason) {
  return {
    status: "BLOCKED_DATA",
    profileId: `${market}:${horizon}`,
    market,
    horizon,
    timeframe: BENCHMARK_HORIZONS_V1[horizon].timeframe,
    reason,
    economicCreditAllowed: false,
    promotionAllowed: false,
  };
}

function profileScoreRows(profiles) {
  const rows = [];
  for (const profile of profiles) {
    if (profile.status !== "EXECUTED_PROXY") continue;
    if (profile.tsmom?.baseSummary?.status === "EXECUTED_PROXY_SUMMARY") {
      rows.push({
        profileId: profile.profileId,
        strategy: "TSMOM_PROXY",
        totalReturnPercent: profile.tsmom.baseSummary.medianTotalReturnPercent,
        stressReturnPercent: profile.tsmom.stressSummary?.medianTotalReturnPercent ?? null,
        tradeSharpe: profile.tsmom.baseSummary.medianTradeSharpe,
        profitFactor: profile.tsmom.baseSummary.medianProfitFactor,
        maximumDrawdownPercent: profile.tsmom.baseSummary.worstMaximumDrawdownPercent,
        walkForwardPositiveFolds: profile.tsmom.baseSummary.minimumPositiveFoldCount,
        proxyOnly: true,
      });
    }
    if (profile.relativeMomentum?.base?.status === "EXECUTED_PROXY") {
      rows.push({
        profileId: profile.profileId,
        strategy: "RELATIVE_MOMENTUM_PROXY",
        totalReturnPercent: profile.relativeMomentum.base.performance.totalReturnPercent,
        stressReturnPercent: profile.relativeMomentum.stress15x?.performance?.totalReturnPercent ?? null,
        tradeSharpe: profile.relativeMomentum.base.performance.tradeSharpe,
        profitFactor: profile.relativeMomentum.base.performance.profitFactor,
        maximumDrawdownPercent: profile.relativeMomentum.base.performance.maximumDrawdownPercent,
        walkForwardPositiveFolds: profile.relativeMomentum.base.walkForward.positiveFoldCount,
        proxyOnly: true,
      });
    }
  }
  return rows.sort((a, b) => (b.totalReturnPercent ?? -Infinity) - (a.totalReturnPercent ?? -Infinity));
}

function markdown(report) {
  const lines = [
    "# Public Strategy 3Y Benchmark V1",
    "",
    `- window: ${date(report.window.startTime)} ~ ${date(report.window.endTimeExclusive - 1)} (end exclusive)`,
    "- research-only proxy benchmark; no winner/promotion/profitability claim",
    "- base costs + 1.5x cost stress; next-bar-open execution semantics inside proxy",
    "- public source failures remain BLOCKED/TECHNICAL instead of synthetic substitution",
    "",
    "## 12-profile coverage",
    "",
    "| Profile | Status | TSMOM median return | Relative momentum return | Note |",
    "| --- | --- | ---: | ---: | --- |",
  ];
  for (const profile of report.profiles) {
    const tsmom = profile.tsmom?.baseSummary?.medianTotalReturnPercent;
    const rel = profile.relativeMomentum?.base?.performance?.totalReturnPercent;
    lines.push(`| ${profile.profileId} | ${profile.status} | ${number(tsmom)}% | ${number(rel)}% | ${profile.reason ?? profile.providerRisk ?? "-"} |`);
  }
  lines.push("", "## Executed proxy ordering (descriptive only)", "",
    "| Profile | Strategy | Return | 1.5x cost return | Trade Sharpe | PF | MDD | Positive 6m folds |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of report.proxyOrdering) {
    lines.push(`| ${row.profileId} | ${row.strategy} | ${number(row.totalReturnPercent)}% | ${number(row.stressReturnPercent)}% | ${number(row.tradeSharpe)} | ${number(row.profitFactor)} | ${number(row.maximumDrawdownPercent)}% | ${row.walkForwardPositiveFolds ?? "-"} |`);
  }
  lines.push("", "## Reference recipe replication readiness", "",
    "| Recipe | Status | Blocker |",
    "| --- | --- | --- |");
  for (const row of report.referenceReplicationReadiness) {
    lines.push(`| ${row.recipeId} | ${row.status} | ${row.blocker ?? "-"} |`);
  }
  lines.push("",
    "## Safety",
    "",
    "- PROFITABILITY_PROVEN=false",
    "- winnerDeclared=false",
    "- economicCreditAllowed=false for every proxy row",
    "- no runtime activation / no live trading / no private trading API / no order authority",
  );
  return `${lines.join("\n")}\n`;
}

const outputJson = resolve(process.argv[2] ?? "docs/public-strategy-3y-benchmark-v1.json");
const outputMd = resolve(process.argv[3] ?? "docs/public-strategy-3y-benchmark-v1.md");
const plan = buildPublicStrategyBenchmarkPlanV1();
const client = new BitgetPublicClient({ minIntervalMs: 110, maxRetries: 5, timeoutMs: 12_000 });
const profiles = [];
let futuresFunding = null;

for (const market of ["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]) {
  for (const horizon of ["SHORT", "SWING", "POSITION"]) {
    try {
      if ((market === "KR_STOCK" || market === "US_STOCK") && horizon !== "POSITION") {
        profiles.push(blockedProfile(market, horizon, "THREE_YEAR_INTRADAY_STOCK_PUBLIC_PROVIDER_NOT_INTEGRATED"));
        continue;
      }
      if (market === "KR_STOCK" || market === "US_STOCK") {
        const datasets = await collectStockPosition(market);
        profiles.push(benchmarkProfile({
          market,
          horizon,
          datasets,
          providerRisk: "DIAGNOSTIC_ONLY_CURRENT_SURVIVOR_SYMBOLS_NO_PIT_DELISTED_UNIVERSE_CREDIT",
        }));
        continue;
      }
      if (market === "CRYPTO_FUTURES" && futuresFunding === null) {
        futuresFunding = await collectFuturesFunding(client);
      }
      const datasets = await collectCryptoProfile({ client, market, horizon });
      profiles.push(benchmarkProfile({
        market,
        horizon,
        datasets,
        fundingRatesBySymbol: market === "CRYPTO_FUTURES" ? futuresFunding : {},
        providerRisk: null,
      }));
    } catch (error) {
      profiles.push({
        ...blockedProfile(market, horizon, "PUBLIC_DATA_COLLECTION_OR_PROXY_EXECUTION_FAILED"),
        status: "TECHNICAL_FAILURE",
        error: serializeError(error),
      });
    }
  }
}

const report = {
  schemaVersion: 1,
  contract: "public-strategy-3y-benchmark-report/v1",
  generatedAt: Date.now(),
  researchOnly: true,
  branchWrite: BRANCH_WRITE,
  window: {
    startTime: BENCHMARK_START_TIME,
    endTimeExclusive: BENCHMARK_END_TIME,
    exactThreeYearWindow: true,
  },
  plan,
  profiles,
  proxyOrdering: profileScoreRows(profiles),
  referenceReplicationReadiness: PUBLIC_REFERENCE_REPLICATION_READINESS_V1,
  safety: {
    profitabilityProven: false,
    winnerDeclared: false,
    economicCreditAllowed: false,
    automaticActivationAllowed: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  },
  limitations: [
    "Executed TSMOM and relative-momentum rows are fixed local proxies, not source-faithful replications of every paper.",
    "Stock POSITION rows use current survivor symbols from Yahoo and therefore receive no economic/profitability credit.",
    "Stock SHORT/SWING remain blocked until a reproducible three-year point-in-time intraday stock provider is integrated.",
    "Charting-by-Machines, Stocks-in-Play ORB, risk-managed crypto momentum, CEX-DEX funding arbitrage, and MLLM chart strategies remain blocked until their exact required evidence exists.",
    "Descriptive proxyOrdering is not a promotion ranking and cannot set app defaults.",
  ],
};

await save(outputJson, report);
await save(outputMd, markdown(report));
console.log(markdown(report));
console.log(JSON.stringify({
  status: profiles.some((row) => row.status === "EXECUTED_PROXY") ? "COMPLETE_WITH_BLOCKERS" : "BLOCKED",
  outputJson,
  outputMd,
  executedProfiles: profiles.filter((row) => row.status === "EXECUTED_PROXY").length,
  blockedProfiles: profiles.filter((row) => row.status === "BLOCKED_DATA").length,
  technicalFailures: profiles.filter((row) => row.status === "TECHNICAL_FAILURE").map((row) => ({ profileId: row.profileId, error: row.error })),
  proxyOrdering: report.proxyOrdering,
  safety: report.safety,
}, null, 2));
