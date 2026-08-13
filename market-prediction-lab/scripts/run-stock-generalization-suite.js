import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { auditFrozenStockStrategy } from "../src/stock-generalization-audit.js";

const DAY = 86_400_000;
const SPECS = Object.freeze({
  KR_STOCK: Object.freeze({
    priorOosStatus: "oos_candidate",
    symbols: Object.freeze(["005380", "000270", "051910", "068270", "105560", "055550", "035720"]),
    costRatePerSide: 0.0025,
    params: Object.freeze({
      breakoutLookback: 20,
      maPeriod: 20,
      atrPeriod: 14,
      atrStopMultiplier: 2.5,
      rewardRisk: 1.5,
      maxHoldBars: 20,
      relativeVolumePeriod: 20,
      minRelativeVolume: 1.2,
      maxGapPercent: 5,
    }),
  }),
  US_STOCK: Object.freeze({
    priorOosStatus: "research_hold",
    symbols: Object.freeze(["AMZN", "GOOGL", "META", "JPM", "XOM", "COST", "JNJ"]),
    costRatePerSide: 0.0015,
    params: Object.freeze({
      breakoutLookback: 10,
      maPeriod: 60,
      atrPeriod: 14,
      atrStopMultiplier: 2.5,
      rewardRisk: 2,
      maxHoldBars: 20,
      relativeVolumePeriod: 20,
      minRelativeVolume: 1,
      maxGapPercent: 4,
    }),
  }),
});

async function save(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const output = resolve(process.argv[2] ?? "docs/stock-generalization-suite-result.json");
const endTime = Date.now();
const startTime = endTime - 3650 * DAY;
const markets = {};

for (const [market, spec] of Object.entries(SPECS)) {
  try {
    const datasets = [];
    for (const symbol of spec.symbols) {
      const history = await collectYahooStockHistory({ market, symbol, startTime, endTime });
      datasets.push({ symbol, candles: history.candles });
    }
    const audit = auditFrozenStockStrategy({
      market,
      datasets,
      params: spec.params,
      costRatePerSide: spec.costRatePerSide,
      stressMultiplier: 1.5,
      windowCount: 5,
      startRatio: 0.2,
    });
    const effectiveStatus = spec.priorOosStatus === "oos_candidate" && audit.status === "generalization_candidate"
      ? "generalization_candidate"
      : "research_hold";
    markets[market] = Object.freeze({
      priorOosStatus: spec.priorOosStatus,
      effectiveStatus,
      holdoutSymbols: spec.symbols,
      audit,
    });
  } catch (error) {
    markets[market] = { status: "technical_failure", message: String(error?.message ?? error).slice(0, 700) };
  }
}

const report = {
  schemaVersion: 1,
  status: Object.values(markets).some((value) => value.status === "technical_failure") ? "fail" : "pass",
  researchOnly: true,
  liveExecutionAllowed: false,
  privateAccountRequestAllowed: false,
  methodology: "freeze previously selected params; evaluate on unseen symbols; 1.5x cost stress; fixed-param rolling stability windows; no holdout retuning",
  markets,
  limitations: [
    "Current-symbol holdouts do not reconstruct historical index membership.",
    "Delisted names are not yet included, so survivorship bias remains an explicit blocker.",
    "Rolling windows are stability audits of frozen parameters, not fresh optimization cycles.",
  ],
};

await save(output, report);
console.log(JSON.stringify(report, null, 2));
if (report.status !== "pass") process.exitCode = 1;
