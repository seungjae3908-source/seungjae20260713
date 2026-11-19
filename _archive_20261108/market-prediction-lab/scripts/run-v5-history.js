import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  HISTORICAL_V1_CRYPTO_SPECS,
  buildCryptoV1Cases,
} from "../src/historical-backtest-data.js";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";
import { optimizeV5PriceStructure } from "../src/v5-price-structure-optimizer.js";

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
  return `구조 ${filter.structureLookback}봉, 돌파후≤${filter.breakoutRecencyBars}봉, 재테스트≤${filter.retestToleranceAtr}ATR, ATR%≥${(filter.atrPctMin * 100).toFixed(1)}%`;
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
  return `# V5 가격구조·돌파후 재테스트·ATR 변동성 독립검증\n\n`
    + `- 개발/탐색: 2020-01-01 ~ 2024-12-31\n`
    + `- 독립 검증: 2025-01-01 ~ 2025-12-31\n`
    + `- 2026 최종 홀드아웃: 사용 안 함 / 잠금 유지\n`
    + `- BTC의 V2 채택후보는 재튜닝하지 않음. ETH의 V2 보류·실패 케이스에만 V5 구조 확인을 적용함.\n`
    + `- V5 후보공간: 구조 lookback 2단계 × 돌파 recency 3단계 × 재테스트 ATR 허용 3단계 × ATR% regime 2단계 = 최대 36개.\n`
    + `- Long은 이전 고점 종가돌파 후 해당 레벨 재테스트, Short는 이전 저점 종가이탈 후 해당 레벨 재테스트를 대칭 적용함.\n`
    + `- 수익률·성공률을 단일 점수로 합치지 않고 PF·MDD·거래수까지 독립 검증함.\n`
    + `- 모든 구조·변동성 필터는 신호 시점과 그 이전의 닫힌 봉만 사용하며 기존 V1 실행·비용 엔진을 재사용함.\n\n`
    + `${markdownTable(["시장", "종목", "방향", "상태", "판정", "2025 수익률 V2→V5", "성공률", "PF", "MDD", "거래수", "후보수", "선택 구조"], rows)}\n`;
}

const inputRoot = resolve(process.argv[2] ?? "long-history-v1");
const reportJsonPath = resolve(process.argv[3] ?? "docs/long-history-v5-result.json");
const reportMarkdownPath = resolve(process.argv[4] ?? "docs/long-history-v5-result.md");
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
      const v5 = optimizeV5PriceStructure({ backtestInput: backtestCase, v2Optimization: v2 });
      optimizations.push(v5);
      await writeJson(resolve(inputRoot, `${backtestCase.id}.v5-optimization.json`), v5);
    }
  } catch (error) {
    errors.push({ spec: spec.id, name: error?.name ?? "Error", code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 1200) });
  }
}

const report = Object.freeze({
  schemaVersion: 1,
  generatedAt: Date.now(),
  mode: "backtest-only",
  strategyCandidate: "V5_PRICE_STRUCTURE_RETEST",
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
