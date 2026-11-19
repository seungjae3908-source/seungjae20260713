import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  HISTORICAL_V1_CRYPTO_SPECS,
  buildCryptoV1Cases,
} from "../src/historical-backtest-data.js";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";
import { optimizeV3MarketFilters } from "../src/v3-market-filter-optimizer.js";

function round(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function filterText(filter) {
  if (!filter) return "-";
  return `RVOL≥${filter.rvolMin}, VolExp≥${filter.volumeExpansionMin}, Trend/ATR≥${filter.trendStrengthMin}`;
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function buildMarkdown(report) {
  const rows = report.optimizations.map((row) => {
    if (row.status === "v2_frozen_not_retested") {
      return [row.market, row.symbol, row.side, row.status, "V2 유지", "-", "-", "-", "-", "-", "0", "동결 후보 재튜닝 안 함"];
    }
    const baseline = row.baseline?.validation;
    const preferred = row.preferred;
    const candidate = preferred?.validation;
    return [
      row.market,
      row.symbol,
      row.side,
      row.status,
      preferred?.comparison?.verdict ?? "no_candidate",
      `${fmt(baseline?.returnPercent)}% → ${fmt(candidate?.returnPercent)}%`,
      `${fmt(baseline?.successRatePercent)}% → ${fmt(candidate?.successRatePercent)}%`,
      `${fmt(baseline?.profitFactor)} → ${fmt(candidate?.profitFactor)}`,
      `${fmt(baseline?.maximumDrawdownPercent)}% → ${fmt(candidate?.maximumDrawdownPercent)}%`,
      `${fmt(baseline?.trades, 0)} → ${fmt(candidate?.trades, 0)}`,
      fmt(row.candidateCount, 0),
      filterText(preferred?.filter),
    ];
  });
  return `# V3 거래량·추세강도 필터 독립검증\n\n`
    + `- 개발/탐색: 2020-01-01 ~ 2024-12-31\n`
    + `- 독립 검증: 2025-01-01 ~ 2025-12-31\n`
    + `- 2026 최종 홀드아웃: 사용 안 함 / 잠금 유지\n`
    + `- BTC의 V2 채택후보는 재튜닝하지 않음. V2 보류·실패 케이스에만 V3 필터 탐색을 수행함.\n`
    + `- V3 후보공간: RVOL × 단기 거래량확장 × |EMA fast-slow|/ATR = 최대 27개. 수익률·성공률은 단일 가중점수로 합치지 않음.\n`
    + `- V3는 기존 V1 진입신호와 실행/비용 엔진을 재사용하며 필터는 신호시점까지의 닫힌 과거 데이터만 사용함.\n\n`
    + `${markdownTable(["시장", "종목", "방향", "상태", "판정", "2025 수익률 V2→V3", "성공률", "PF", "MDD", "거래수", "후보수", "선택 필터"], rows)}\n`;
}

const inputRoot = resolve(process.argv[2] ?? "long-history-v1");
const reportJsonPath = resolve(process.argv[3] ?? "docs/long-history-v3-result.json");
const reportMarkdownPath = resolve(process.argv[4] ?? "docs/long-history-v3-result.md");
const optimizations = [];
const errors = [];

for (const spec of HISTORICAL_V1_CRYPTO_SPECS) {
  try {
    const candleArtifact = await readJson(resolve(inputRoot, `${spec.id}.candles.json`));
    const fundingArtifact = spec.market === "CRYPTO_FUTURES"
      ? await readJson(resolve(inputRoot, `${spec.id}.funding.json`))
      : null;
    const cases = buildCryptoV1Cases({
      spec,
      candles: candleArtifact.candles,
      fundingRates: fundingArtifact?.records ?? [],
      initialCapital: RESEARCH_BACKTEST_PERIOD.initialCapital,
      period: {
        startTime: RESEARCH_BACKTEST_PERIOD.startTime,
        endTime: RESEARCH_BACKTEST_PERIOD.validationEndTime,
        includeFinalHoldout: false,
      },
    });
    for (const backtestCase of cases) {
      const v2 = await readJson(resolve(inputRoot, `${backtestCase.id}.v2-optimization.json`));
      const v3 = optimizeV3MarketFilters({ backtestInput: backtestCase, v2Optimization: v2 });
      optimizations.push(v3);
      await writeJson(resolve(inputRoot, `${backtestCase.id}.v3-optimization.json`), v3);
    }
  } catch (error) {
    errors.push({ spec: spec.id, name: error?.name ?? "Error", code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 1200) });
  }
}

const report = Object.freeze({
  schemaVersion: 1,
  generatedAt: Date.now(),
  mode: "backtest-only",
  strategyCandidate: "V3_VOLUME_TREND_FILTER",
  developmentStartTime: RESEARCH_BACKTEST_PERIOD.startTime,
  developmentEndTime: RESEARCH_BACKTEST_PERIOD.developmentEndTime,
  validationStartTime: RESEARCH_BACKTEST_PERIOD.validationStartTime,
  validationEndTime: RESEARCH_BACKTEST_PERIOD.validationEndTime,
  finalHoldoutStartTime: RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime,
  finalHoldoutUsedForSelection: false,
  initialCapital: RESEARCH_BACKTEST_PERIOD.initialCapital,
  optimizations: Object.freeze(optimizations),
  errors: Object.freeze(errors),
  orderSubmitted: false,
  privateAccountRequestAllowed: false,
});

await writeJson(reportJsonPath, report);
const markdown = buildMarkdown(report);
await mkdir(dirname(reportMarkdownPath), { recursive: true });
await writeFile(reportMarkdownPath, markdown, "utf8");
console.log(markdown);
const expected = HISTORICAL_V1_CRYPTO_SPECS.reduce((count, spec) => count + (spec.market === "CRYPTO_FUTURES" ? 2 : 1), 0);
if (optimizations.length !== expected || errors.length > 0) process.exitCode = 1;
