import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles } from "../src/bitget-candle-collector.js";
import { repairBitgetCandleGaps } from "../src/candle-gap-repair.js";
import {
  BinanceFuturesPublicClient,
  collectBinanceFuturesDailyKlines,
  collectBinanceFuturesFundingRates,
} from "../src/binance-futures-history.js";
import {
  BITGET_STANDARD_TAKER_RESEARCH_COSTS,
  HISTORICAL_V1_CRYPTO_SPECS,
  toResearchCandles,
} from "../src/historical-backtest-data.js";
import {
  FINAL_HOLDOUT_END,
  FINAL_HOLDOUT_START,
  FINAL_HOLDOUT_WARMUP_START,
  FROZEN_CANDIDATE_MANIFEST_SHA256,
  FROZEN_FINAL_HOLDOUT_CANDIDATES,
  runFrozenFinalHoldout,
} from "../src/final-holdout-evaluator.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const INITIAL_CAPITAL = 1_000_000;
const outputJson = resolve(process.argv[2] ?? "docs/final-holdout-2026-result.json");
const outputMarkdown = resolve(process.argv[3] ?? "docs/final-holdout-2026-result.md");

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function format(value, digits = 2) {
  if (value === Number.POSITIVE_INFINITY) return "∞";
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return Number(value).toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function specFor(candidate) {
  const spec = HISTORICAL_V1_CRYPTO_SPECS.find((row) => row.market === candidate.market && row.exchangeSymbol === candidate.exchangeSymbol);
  if (!spec) throw new Error(`historical spec missing for ${candidate.id}`);
  return spec;
}

function assertDailyContinuity(candles, label) {
  for (let index = 1; index < candles.length; index += 1) {
    const delta = candles[index].timestamp - candles[index - 1].timestamp;
    if (delta !== DAY_MS) throw new Error(`${label} daily gap at ${candles[index - 1].timestamp}: ${delta}`);
  }
}

function assertWarmupAndHoldoutCoverage(candles, label) {
  if (!Array.isArray(candles) || candles.length === 0) throw new Error(`${label} candles are empty`);
  assertDailyContinuity(candles, label);
  const first = candles[0].timestamp;
  const last = candles.at(-1).timestamp;
  const lastRequiredOpen = Date.UTC(2026, 7, 7);
  // Daily providers need not anchor candles at 00:00 UTC. Bitget spot daily
  // bars are currently anchored at 16:00 UTC, so accept any provider anchor
  // within one daily interval of the predeclared warmup date. This changes
  // only coverage validation; the frozen strategies and 2026 holdout window
  // are untouched.
  const warmupAnchorOffsetMs = first - FINAL_HOLDOUT_WARMUP_START;
  if (warmupAnchorOffsetMs > DAY_MS) throw new Error(`${label} warmup begins too late: ${iso(first)}`);
  if (last < lastRequiredOpen) throw new Error(`${label} final holdout ends too early: ${iso(last)}`);
  return Object.freeze({
    first,
    last,
    candles: candles.length,
    warmupAnchorOffsetMs,
    dailyAnchorUtcHour: new Date(first).getUTCHours(),
    dailyAnchorUtcMinute: new Date(first).getUTCMinutes(),
  });
}

async function collectSpot(candidate, bitget) {
  const spec = specFor(candidate);
  const collected = await collectBitgetCandles({
    client: bitget,
    market: spec.market,
    symbol: spec.exchangeSymbol,
    timeframe: "1d",
    startTime: FINAL_HOLDOUT_WARMUP_START,
    endTime: FINAL_HOLDOUT_END + 1,
    maxCandles: 1000,
  });
  const repaired = await repairBitgetCandleGaps({
    client: bitget,
    market: spec.market,
    symbol: spec.exchangeSymbol,
    timeframe: "1d",
    candles: collected.candles,
  });
  if ((repaired.remainingMissingCandleCount ?? repaired.remainingGapCount ?? 0) > 0) {
    throw new Error(`${candidate.id} has unresolved Bitget candle gaps`);
  }
  const candles = toResearchCandles(spec, { candles: repaired.candles });
  const coverage = assertWarmupAndHoldoutCoverage(candles, candidate.id);
  return Object.freeze({
    provider: "bitget-public-v2",
    priceProvider: "bitget-public-v2",
    fundingProvider: null,
    candles,
    fundingRates: Object.freeze([]),
    coverage,
  });
}

async function collectFutures(candidate, binance) {
  const spec = specFor(candidate);
  const prices = await collectBinanceFuturesDailyKlines({
    client: binance,
    symbol: spec.exchangeSymbol,
    startTime: FINAL_HOLDOUT_WARMUP_START,
    endTime: FINAL_HOLDOUT_END,
  });
  const funding = await collectBinanceFuturesFundingRates({
    client: binance,
    symbol: spec.exchangeSymbol,
    startTime: FINAL_HOLDOUT_WARMUP_START,
    endTime: FINAL_HOLDOUT_END,
  });
  const candles = toResearchCandles(spec, prices);
  const coverage = assertWarmupAndHoldoutCoverage(candles, candidate.id);
  if (funding.records.length === 0 || funding.records.at(-1).timestamp < Date.UTC(2026, 7, 7)) {
    throw new Error(`${candidate.id} funding does not cover the final holdout end`);
  }
  return Object.freeze({
    provider: "binance-usdm-public-rest",
    priceProvider: prices.provider,
    fundingProvider: funding.provider,
    candles,
    fundingRates: funding.records,
    coverage: Object.freeze({ ...coverage, fundingRecords: funding.records.length, fundingFirst: funding.records[0].timestamp, fundingLast: funding.records.at(-1).timestamp }),
  });
}

function backtestInput(candidate, prepared) {
  return Object.freeze({
    market: candidate.market,
    symbol: candidate.symbol,
    side: candidate.side,
    timeframe: "1d",
    initialCapital: INITIAL_CAPITAL,
    candles: prepared.candles,
    fundingRates: prepared.fundingRates,
    costModel: BITGET_STANDARD_TAKER_RESEARCH_COSTS[candidate.market],
    riskModel: Object.freeze({ riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 }),
  });
}

function summarize(evaluation, prepared) {
  const metrics = evaluation.metrics;
  return Object.freeze({
    id: evaluation.candidate.id,
    market: evaluation.candidate.market,
    symbol: evaluation.candidate.symbol,
    side: evaluation.candidate.side,
    frozenVersion: evaluation.candidate.version,
    entryModel: evaluation.candidate.entryModel,
    provider: prepared.provider,
    priceProvider: prepared.priceProvider,
    fundingProvider: prepared.fundingProvider,
    dataStart: prepared.coverage.first,
    dataEnd: prepared.coverage.last,
    dailyAnchorUtcHour: prepared.coverage.dailyAnchorUtcHour,
    dailyAnchorUtcMinute: prepared.coverage.dailyAnchorUtcMinute,
    holdoutStart: FINAL_HOLDOUT_START,
    holdoutEnd: FINAL_HOLDOUT_END,
    initialCapital: metrics.initialCapital,
    finalCapital: metrics.finalCapital,
    returnPercent: metrics.returnPercent,
    successRatePercent: metrics.successRatePercent,
    profitFactor: metrics.profitFactor,
    maximumDrawdownPercent: metrics.maximumDrawdownPercent,
    expectancy: metrics.expectancy,
    trades: metrics.trades,
    effect: evaluation.assessment.effect,
    sample: evaluation.assessment.sample,
    promotionEvidence: evaluation.assessment.promotionEvidence,
    candidateManifestSha256: evaluation.candidateManifestSha256,
    safeguards: evaluation.safeguards,
  });
}

function buildMarkdown(report) {
  const rows = report.results.map((row) => [
    row.market,
    row.symbol,
    row.side,
    row.frozenVersion,
    row.dataEnd ? iso(row.dataEnd).slice(0, 10) : "-",
    `${format(row.initialCapital, 0)}원`,
    `${format(row.finalCapital, 0)}원`,
    `${format(row.returnPercent)}%`,
    `${format(row.successRatePercent)}%`,
    format(row.profitFactor),
    `${format(row.maximumDrawdownPercent)}%`,
    format(row.trades, 0),
    row.effect,
    row.sample,
  ]);
  return `# 2026 최종 홀드아웃 — 동결 후보 1회 평가\n\n`
    + `- 평가 구간: ${iso(report.holdoutStart).slice(0, 10)} ~ ${iso(report.holdoutEnd).slice(0, 10)} (UTC 일봉, 완전히 닫힌 공통 데이터까지만)\n`
    + `- 초기자금: ${format(report.initialCapital, 0)}원 / 후보별 독립 평가\n`
    + `- 후보 manifest SHA-256: \`${report.candidateManifestSha256}\`\n`
    + `- 2026 데이터로 후보 탐색·파라미터 수정·재튜닝: **0건**\n`
    + `- V2/V6 후보는 2020~2024 개발 + 2025 독립검증에서 이미 동결된 값만 사용함.\n`
    + `- 일봉 anchor는 공급자 원본을 유지함(Bitget spot과 Binance futures의 UTC anchor가 다를 수 있음).\n`
    + `- 선물 가격·펀딩은 Binance USD-M public REST, 실행비용은 기존 Bitget 연구 가정을 그대로 사용함.\n`
    + `- effect=positive는 순수익>0, expectancy>0, PF>1을 동시에 뜻함. 표본 30회 미만은 promotionEvidence=false로 유지함.\n\n`
    + markdownTable(["시장", "종목", "방향", "동결버전", "데이터종료", "시작금", "최종금", "순수익률", "성공률", "PF", "MDD", "거래수", "효과", "표본"], rows)
    + `\n`;
}

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

const bitget = new BitgetPublicClient({ minIntervalMs: 160, maxRetries: 4, timeoutMs: 15_000 });
const binance = new BinanceFuturesPublicClient({ timeoutMs: 15_000, maxRetries: 4 });
const preparedCache = new Map();
const results = [];

for (const candidate of FROZEN_FINAL_HOLDOUT_CANDIDATES) {
  const cacheKey = `${candidate.market}:${candidate.exchangeSymbol}`;
  let prepared = preparedCache.get(cacheKey);
  if (!prepared) {
    prepared = candidate.market === "CRYPTO_SPOT"
      ? await collectSpot(candidate, bitget)
      : await collectFutures(candidate, binance);
    preparedCache.set(cacheKey, prepared);
  }
  const evaluation = runFrozenFinalHoldout({
    candidate,
    backtestInput: backtestInput(candidate, prepared),
    endTime: FINAL_HOLDOUT_END,
  });
  results.push(summarize(evaluation, prepared));
}

const report = Object.freeze({
  schemaVersion: 1,
  generatedAt: Date.now(),
  mode: "backtest-only",
  evaluation: "one-shot-final-holdout",
  holdoutStart: FINAL_HOLDOUT_START,
  holdoutEnd: FINAL_HOLDOUT_END,
  initialCapital: INITIAL_CAPITAL,
  candidateManifestSha256: FROZEN_CANDIDATE_MANIFEST_SHA256,
  candidateCount: FROZEN_FINAL_HOLDOUT_CANDIDATES.length,
  finalHoldoutRetuningAllowed: false,
  liveOrderAllowed: false,
  privateAccountRequestAllowed: false,
  results: Object.freeze(results),
});

await write(outputJson, `${JSON.stringify(report, (_key, value) => value === Number.POSITIVE_INFINITY ? "Infinity" : value, 2)}\n`);
await write(outputMarkdown, buildMarkdown(report));
console.log(buildMarkdown(report));
