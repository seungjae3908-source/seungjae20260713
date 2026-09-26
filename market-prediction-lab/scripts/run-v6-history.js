import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { HISTORICAL_V1_CRYPTO_SPECS, buildCryptoV1Cases } from "../src/historical-backtest-data.js";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";
import { optimizeV6IndependentBreakoutRetest } from "../src/v6-independent-breakout-retest-optimizer.js";

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

function structureText(filter) {
  if (!filter) return "-";
  return `lookback=${filter.structureLookback}, breakout≤${filter.breakoutRecencyBars}bars, retest±${filter.retestToleranceAtr}ATR, confirm=${filter.confirmationMode}`;
}

function markdownTable(headers, rows) {
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
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
      structureText(preferred?.filter),
    ];
  });
  return `# V6 독립 돌파→재테스트 진입전략 검증\n\n`
    + `- 개발/탐색: 2020-01-01 ~ 2024-12-31\n`
    + `- 독립 검증: 2025-01-01 ~ 2025-12-31\n`
    + `- 2026 최종 홀드아웃: 사용 안 함 / 잠금 유지\n`
    + `- BTC V2 채택후보는 재튜닝하지 않음. ETH V2 보류/실패만 V6 독립전략으로 재연구함.\n`
    + `- V6는 V1 EMA 눌림 진입신호를 사용하지 않음. 돌파→재테스트 자체가 진입신호이며 다음 봉 시가 체결을 유지함.\n`
    + `- V2에서 동결한 ATR period/stop/target은 실행·위험 비교를 공정하게 하기 위해 유지하고, 진입 구조만 독립적으로 변경함.\n`
    + `- 후보공간: lookback 3 × breakout recency 3 × retest tolerance 2 × confirmation 2 = 36개. 개발구간에서 사전 정의된 수익률 리더/성공률 리더 최대 2개만 2025에 넘김.\n`
    + `- 수수료·spread·slippage·latency·선물 funding은 공유 실행비용 계산기를 사용하며 수익률과 성공률을 단일 점수로 합치지 않음.\n\n`
    + `${markdownTable(["시장", "종목", "방향", "상태", "판정", "2025 수익률 V2→V6", "성공률", "PF", "MDD", "거래수", "후보수", "선택 구조"], rows)}\n`;
}

const inputRoot = resolve(process.argv[2] ?? "long-history-v1");
const reportJsonPath = resolve(process.argv[3] ?? "docs/long-history-v6-result.json");
const reportMarkdownPath = resolve(process.argv[4] ?? "docs/long-history-v6-result.md");
const optimizations = [];
const errors = [];

for (const spec of HISTORICAL_V1_CRYPTO_SPECS) {
  try {
    const candleArtifact = await readJson(resolve(inputRoot, `${spec.id}.candles.json`));
    const fundingArtifact = spec.market === "CRYPTO_FUTURES" ? await readJson(resolve(inputRoot, `${spec.id}.funding.json`)) : null;
    const cases = buildCryptoV1Cases({
      spec,
      candles: candleArtifact.candles,
      fundingRates: fundingArtifact?.records ?? [],
      initialCapital: RESEARCH_BACKTEST_PERIOD.initialCapital,
      period: { startTime: RESEARCH_BACKTEST_PERIOD.startTime, endTime: RESEARCH_BACKTEST_PERIOD.validationEndTime, includeFinalHoldout: false },
    });
    for (const backtestCase of cases) {
      const v2 = await readJson(resolve(inputRoot, `${backtestCase.id}.v2-optimization.json`));
      const v6 = optimizeV6IndependentBreakoutRetest({ backtestInput: backtestCase, v2Optimization: v2 });
      optimizations.push(v6);
      await writeJson(resolve(inputRoot, `${backtestCase.id}.v6-optimization.json`), v6);
    }
  } catch (error) {
    errors.push({ spec: spec.id, name: error?.name ?? "Error", code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 1200) });
  }
}

const report = Object.freeze({
  schemaVersion: 1,
  generatedAt: Date.now(),
  mode: "backtest-only",
  strategyCandidate: "V6_INDEPENDENT_BREAKOUT_RETEST",
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
