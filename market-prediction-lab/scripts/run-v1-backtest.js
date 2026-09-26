import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildBacktestTable,
  runV1Backtest,
  runV1UniverseBacktest,
} from "../src/multi-market-backtest-engine.js";

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function markdownTable(headers, rows) {
  const header = `| ${headers.join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return [header, divider, body].filter(Boolean).join("\n");
}

function mainSummary(result) {
  return markdownTable(
    ["시장", "방향", "버전", "시작금", "최종금", "순수익률", "성공률", "PF", "MDD", "거래수"],
    buildBacktestTable([result]).map((row) => [
      row.market,
      row.side,
      row.version,
      `${formatNumber(row.initialCapital, 0)}원`,
      `${formatNumber(row.finalCapital, 0)}원`,
      `${formatNumber(row.netReturnPercent)}%`,
      `${formatNumber(row.successRatePercent)}%`,
      formatNumber(row.profitFactor),
      `${formatNumber(row.maximumDrawdownPercent)}%`,
      formatNumber(row.trades, 0),
    ]),
  );
}

function singleMarkdown(result) {
  const years = markdownTable(
    ["연도", "시작자산", "종료자산", "거래", "성공률", "순수익률", "PF", "MDD"],
    result.byYear.map((row) => [
      String(row.year),
      `${formatNumber(row.startingEquity, 0)}원`,
      `${formatNumber(row.endingEquity, 0)}원`,
      formatNumber(row.trades, 0),
      `${formatNumber(row.successRate * 100)}%`,
      `${formatNumber(row.returnPercent)}%`,
      formatNumber(row.profitFactor),
      `${formatNumber(row.maximumDrawdownPercent)}%`,
    ]),
  );
  const phases = markdownTable(
    ["구간", "거래", "성공률", "순손익", "PF", "MDD"],
    Object.entries(result.byPhase).map(([phase, summary]) => [
      phase,
      formatNumber(summary.sampleCount, 0),
      `${formatNumber(summary.winRate * 100)}%`,
      `${formatNumber(summary.netPnl, 0)}원`,
      formatNumber(summary.profitFactor),
      `${formatNumber(summary.maximumDrawdownPercent * 100)}%`,
    ]),
  );
  return `# V1 백테스트 결과\n\n${mainSummary(result)}\n\n## 연도별\n\n${years}\n\n## 개발/검증/최종 홀드아웃\n\n${phases}\n\n- 실제 주문 전송: ${result.orderSubmitted ? "예" : "아니오"}\n- 2026 최종 홀드아웃 잠금: ${result.period.finalHoldoutLocked ? "잠김" : "해제"}\n`;
}

function universeMarkdown(result) {
  const symbols = markdownTable(
    ["종목", "시작금", "최종금", "순수익률", "성공률", "PF", "MDD", "거래수"],
    Object.entries(result.bySymbol).map(([symbol, row]) => [
      symbol,
      `${formatNumber(row.initialCapital, 0)}원`,
      `${formatNumber(row.finalCapital, 0)}원`,
      `${formatNumber(row.totalReturnPercent)}%`,
      `${formatNumber(row.successRatePercent)}%`,
      formatNumber(row.profitFactor),
      `${formatNumber(row.maximumDrawdownPercent)}%`,
      formatNumber(row.totalTrades, 0),
    ]),
  );
  return `# V1 유니버스 백테스트 결과\n\n${mainSummary(result)}\n\n## 종목별\n\n${symbols}\n\n- 자금 배분: ${result.allocationMode}\n- 종목별 초기 슬리브: ${formatNumber(result.sleeveCapital, 0)}원\n- 실제 주문 전송: ${result.orderSubmitted ? "예" : "아니오"}\n`;
}

async function main() {
  const [, , inputArg, outputJsonArg, outputMarkdownArg] = process.argv;
  if (!inputArg) {
    console.error("Usage: node scripts/run-v1-backtest.js <input.json> [output.json] [output.md]");
    process.exitCode = 2;
    return;
  }
  const inputPath = resolve(inputArg);
  const raw = JSON.parse(await readFile(inputPath, "utf8"));
  const universe = Array.isArray(raw.datasets) && raw.datasets.length > 0;
  const result = universe ? runV1UniverseBacktest(raw) : runV1Backtest(raw);
  const markdown = universe ? universeMarkdown(result) : singleMarkdown(result);

  console.log(markdown);
  if (outputJsonArg) await writeFile(resolve(outputJsonArg), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  if (outputMarkdownArg) await writeFile(resolve(outputMarkdownArg), markdown, "utf8");
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    name: error?.name ?? "Error",
    code: error?.code ?? null,
    message: error?.message ?? String(error),
  }, null, 2));
  process.exitCode = 1;
});
