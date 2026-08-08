import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles } from "../src/bitget-candle-collector.js";
import { repairBitgetCandleGaps } from "../src/candle-gap-repair.js";
import { collectFundingRateHistory } from "../src/derivatives-history.js";
import {
  HISTORICAL_V1_CRYPTO_SPECS,
  buildBlockedStockProviderReport,
  buildCryptoV1Cases,
  summarizeHistoricalCoverage,
  toResearchCandles,
} from "../src/historical-backtest-data.js";
import {
  RESEARCH_BACKTEST_PERIOD,
  buildBacktestTable,
  runV1Backtest,
} from "../src/multi-market-backtest-engine.js";

const REQUESTED_START = RESEARCH_BACKTEST_PERIOD.startTime;
const REQUESTED_END = RESEARCH_BACKTEST_PERIOD.defaultEndTime;
const COLLECT_END_EXCLUSIVE = Date.UTC(2026, 7, 10);
const PERIOD = Object.freeze({
  startTime: REQUESTED_START,
  endTime: REQUESTED_END,
  includeFinalHoldout: false,
});

function serializeError(error) {
  return Object.freeze({
    name: error?.name ?? "Error",
    code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 1500),
    details: error?.details ?? null,
  });
}

function iso(timestamp) {
  return Number.isInteger(timestamp) ? new Date(timestamp).toISOString() : null;
}

function round(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function resultSummary(result, coverage, funding) {
  const table = buildBacktestTable([result])[0];
  return Object.freeze({
    market: table.market,
    symbol: result.symbol,
    side: table.side,
    version: table.version,
    initialCapital: table.initialCapital,
    finalCapital: round(table.finalCapital, 2),
    netReturnPercent: round(table.netReturnPercent),
    successRatePercent: round(table.successRatePercent),
    profitFactor: round(table.profitFactor),
    maximumDrawdownPercent: round(table.maximumDrawdownPercent),
    expectancy: round(result.expectancy, 2),
    trades: table.trades,
    executionCost: round(result.totalExecutionCost, 2),
    coverageStatus: coverage.status,
    actualDataStart: iso(coverage.actualStartTime),
    actualDataEnd: iso(coverage.actualEndTime),
    fundingCount: funding?.records?.length ?? 0,
    fundingStart: funding?.records?.length ? iso(funding.records[0].timestamp) : null,
    fundingEnd: funding?.records?.length ? iso(funding.records.at(-1).timestamp) : null,
    finalHoldoutLocked: result.period.finalHoldoutLocked,
    metricsEnd: iso(result.period.effectiveEndTime),
  });
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function buildMarkdown(report) {
  const resultRows = report.results.map((row) => [
    row.market,
    row.symbol,
    row.side,
    `${formatNumber(row.initialCapital, 0)}원`,
    `${formatNumber(row.finalCapital, 0)}원`,
    `${formatNumber(row.netReturnPercent)}%`,
    `${formatNumber(row.successRatePercent)}%`,
    formatNumber(row.profitFactor),
    `${formatNumber(row.maximumDrawdownPercent)}%`,
    formatNumber(row.trades, 0),
    row.coverageStatus,
  ]);
  const coverageRows = report.datasets.map((row) => [
    row.id,
    row.market,
    row.status,
    row.actualStartTime ? iso(row.actualStartTime).slice(0, 10) : "-",
    row.actualEndTime ? iso(row.actualEndTime).slice(0, 10) : "-",
    formatNumber(row.candleCount, 0),
    row.fundingCount === undefined ? "-" : formatNumber(row.fundingCount, 0),
  ]);
  const blockedRows = report.blockedMarkets.map((row) => [row.market, row.status, row.reason]);
  return `# 장기 V1 실제데이터 백테스트\n\n`
    + `- 요청 데이터 범위: ${iso(report.requestedStartTime).slice(0, 10)} ~ ${iso(report.requestedEndTime).slice(0, 10)}\n`
    + `- 전략 최적화용 지표 종료일: ${iso(report.metricsEffectiveEndTime).slice(0, 10)}\n`
    + `- 2026 최종 홀드아웃: 잠금 유지 (V1/V2 튜닝에 사용하지 않음)\n`
    + `- 초기자금: ${formatNumber(report.initialCapital, 0)}원\n`
    + `- 비용 가정: Bitget 표준 taker 기준 연구 가정 + 고정 slippage/spread. 계정별·과거 실제 수수료와 완전히 동일하다고 간주하지 않음.\n\n`
    + `## 결과\n\n${markdownTable(["시장", "종목", "방향", "시작금", "최종금", "순수익률", "성공률", "PF", "MDD", "거래수", "데이터"], resultRows)}\n\n`
    + `## 데이터 커버리지\n\n${markdownTable(["데이터셋", "시장", "상태", "실제 시작", "실제 종료", "캔들", "펀딩"], coverageRows)}\n\n`
    + `## 아직 차단된 시장\n\n${markdownTable(["시장", "상태", "이유"], blockedRows)}\n`;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const outputRoot = resolve(process.argv[2] ?? "long-history-v1");
const reportJsonPath = resolve(process.argv[3] ?? "docs/long-history-v1-result.json");
const reportMarkdownPath = resolve(process.argv[4] ?? "docs/long-history-v1-result.md");
const client = new BitgetPublicClient({ minIntervalMs: 160, maxRetries: 4, timeoutMs: 15_000 });
const datasetReports = [];
const results = [];
const errors = [];

for (const spec of HISTORICAL_V1_CRYPTO_SPECS) {
  try {
    const collected = await collectBitgetCandles({
      client,
      market: spec.market,
      symbol: spec.exchangeSymbol,
      timeframe: spec.timeframe,
      startTime: REQUESTED_START,
      endTime: COLLECT_END_EXCLUSIVE,
      maxCandles: 5_000,
      onPage: ({ page, received, oldest, newest }) => console.log(JSON.stringify({ spec: spec.id, stage: "candles", page, received, oldest, newest })),
    });
    const repaired = await repairBitgetCandleGaps({
      client,
      market: spec.market,
      symbol: spec.exchangeSymbol,
      timeframe: spec.timeframe,
      candles: collected.candles,
      onAttempt: (attempt) => console.log(JSON.stringify({ spec: spec.id, stage: "repair", ...attempt })),
    });
    if (repaired.remainingMissingCandleCount > 0) {
      throw new Error(`unresolved candle gaps: ${repaired.remainingMissingCandleCount}`);
    }
    const candles = toResearchCandles(spec, { candles: repaired.candles });
    const coverage = summarizeHistoricalCoverage({
      spec,
      candles,
      requestedStartTime: REQUESTED_START,
      requestedEndTime: REQUESTED_END,
    });
    let funding = null;
    if (spec.market === "CRYPTO_FUTURES") {
      funding = await collectFundingRateHistory({
        client,
        symbol: spec.exchangeSymbol,
        startTime: REQUESTED_START,
        endTime: REQUESTED_END,
        maxPages: 100,
        onPage: ({ pageNo, received, oldest, newest }) => console.log(JSON.stringify({ spec: spec.id, stage: "funding", pageNo, received, oldest, newest })),
      });
      if (funding.records.length === 0) throw new Error("historical funding data is empty; futures result would understate costs");
    }
    const datasetReport = Object.freeze({
      ...coverage,
      market: spec.market,
      exchangeSymbol: spec.exchangeSymbol,
      researchSymbol: spec.researchSymbol,
      timeframe: spec.timeframe,
      initialGapCount: repaired.initialGapCount,
      remainingGapCount: repaired.remainingGapCount,
      fundingCount: funding?.records?.length,
      fundingStartTime: funding?.records?.[0]?.timestamp ?? null,
      fundingEndTime: funding?.records?.at(-1)?.timestamp ?? null,
    });
    datasetReports.push(datasetReport);
    await writeJson(resolve(outputRoot, `${spec.id}.candles.json`), { spec, coverage, candles });
    if (funding) await writeJson(resolve(outputRoot, `${spec.id}.funding.json`), funding);

    const cases = buildCryptoV1Cases({
      spec,
      candles,
      fundingRates: funding?.records ?? [],
      initialCapital: RESEARCH_BACKTEST_PERIOD.initialCapital,
      period: PERIOD,
    });
    for (const backtestCase of cases) {
      const result = runV1Backtest(backtestCase);
      results.push(resultSummary(result, coverage, funding));
      await writeJson(resolve(outputRoot, `${backtestCase.id}.result.json`), result);
    }
  } catch (error) {
    const serialized = serializeError(error);
    errors.push(Object.freeze({ spec: spec.id, market: spec.market, error: serialized }));
    datasetReports.push(Object.freeze({
      id: spec.id,
      market: spec.market,
      exchangeSymbol: spec.exchangeSymbol,
      researchSymbol: spec.researchSymbol,
      timeframe: spec.timeframe,
      status: "blocked_collection_error",
      requestedStartTime: REQUESTED_START,
      requestedEndTime: REQUESTED_END,
      actualStartTime: null,
      actualEndTime: null,
      candleCount: 0,
      error: serialized,
    }));
  }
}

const report = Object.freeze({
  schemaVersion: 1,
  generatedAt: Date.now(),
  mode: "backtest-only",
  source: "bitget-public-v2",
  requestedStartTime: REQUESTED_START,
  requestedEndTime: REQUESTED_END,
  metricsEffectiveEndTime: RESEARCH_BACKTEST_PERIOD.validationEndTime,
  finalHoldoutStartTime: RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime,
  finalHoldoutLocked: true,
  initialCapital: RESEARCH_BACKTEST_PERIOD.initialCapital,
  dataTimeframe: "1d",
  results: Object.freeze(results),
  datasets: Object.freeze(datasetReports),
  blockedMarkets: buildBlockedStockProviderReport(),
  errors: Object.freeze(errors),
  orderSubmitted: false,
  privateAccountRequestAllowed: false,
});

await writeJson(reportJsonPath, report);
const markdown = buildMarkdown(report);
await mkdir(dirname(reportMarkdownPath), { recursive: true });
await writeFile(reportMarkdownPath, markdown, "utf8");
console.log(markdown);
if (results.length === 0) process.exitCode = 1;
