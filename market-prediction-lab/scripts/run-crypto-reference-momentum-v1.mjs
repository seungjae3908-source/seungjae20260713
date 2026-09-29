import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles } from "../src/bitget-candle-collector.js";
import { repairBitgetCandleGaps } from "../src/candle-gap-repair.js";
import { BITGET_STANDARD_TAKER_RESEARCH_COSTS } from "../src/historical-backtest-data.js";

const DAY = 86_400_000;
const START = Date.parse("2020-01-01T00:00:00.000Z");
const END = Date.parse("2026-09-30T00:00:00.000Z");
const SYMBOLS = Object.freeze(["BTCUSDT", "ETHUSDT", "XRPUSDT"]);
const CALIBRATION_WEEKS = 104;
const LIU_HORIZONS = Object.freeze([1, 2, 3, 4]);
const LIU_PRIOR_END_EXCLUSIVE = "2024-01-01";
const COST = BITGET_STANDARD_TAKER_RESEARCH_COSTS.CRYPTO_SPOT;
const ROUND_TRIP_COST_FRACTION = 2 * (COST.entryFeeRate + COST.slippageRate + COST.spreadRate);
const MOP_DOI = "10.1016/j.jfineco.2011.11.003";
const MOP_REEXAM_DOI = "10.1016/j.jfineco.2019.08.004";
const MOP_VOL_SCALING_DOI = "10.1016/j.finmar.2016.05.003";
const LIU_TSYVINSKI_DOI = "10.3386/w24877";
const LIU_TSYVINSKI_PUBLISHED = "Review of Financial Studies 34(6), 2021";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function median(values) {
  if (!values.length) return null;
  const copy = [...values].sort((a, b) => a - b);
  const mid = Math.floor(copy.length / 2);
  return copy.length % 2 ? copy[mid] : (copy[mid - 1] + copy[mid]) / 2;
}
function compound(values) {
  return values.reduce((equity, value) => equity * (1 + value), 1) - 1;
}
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}
function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function monthKey(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}
function weekEndKey(ms) {
  const date = new Date(ms);
  const day = date.getUTCDay();
  const shift = (7 - day) % 7;
  const sunday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + shift));
  return sunday.toISOString().slice(0, 10);
}
function summarize(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return {
    n: 0, mean: null, median: null, winRate: null, compoundSequential: null,
    maxReturn: null, leaveBest1Mean: null, leaveBest3Mean: null, top3PositiveReturnShare: null,
  };
  const ordered = [...clean].sort((a, b) => b - a);
  const positives = ordered.filter((value) => value > 0);
  const positiveSum = positives.reduce((sum, value) => sum + value, 0);
  return {
    n: clean.length,
    mean: mean(clean),
    median: median(clean),
    winRate: clean.filter((value) => value > 0).length / clean.length,
    compoundSequential: compound(clean),
    maxReturn: ordered[0] ?? null,
    leaveBest1Mean: ordered.length > 1 ? mean(ordered.slice(1)) : null,
    leaveBest3Mean: ordered.length > 3 ? mean(ordered.slice(3)) : null,
    top3PositiveReturnShare: positiveSum > 0
      ? positives.slice(0, 3).reduce((sum, value) => sum + value, 0) / positiveSum
      : null,
  };
}
function liuWindow(weekEnd) {
  return weekEnd < LIU_PRIOR_END_EXCLUSIVE ? "PRIOR" : "RECENT";
}
function liuSummaryBlock(rows) {
  const top = rows.filter((row) => row.quintile === 5);
  const bottom = rows.filter((row) => row.quintile === 1);
  const topSummary = summarize(top.map((row) => row.futureReturn));
  const bottomSummary = summarize(bottom.map((row) => row.futureReturn));
  return {
    all: summarize(rows.map((row) => row.futureReturn)),
    topQuintile: topSummary,
    bottomQuintile: bottomSummary,
    topMinusBottomMean: topSummary.mean != null && bottomSummary.mean != null
      ? topSummary.mean - bottomSummary.mean
      : null,
    leaveBest1TopMinusBottomMean: topSummary.leaveBest1Mean != null && bottomSummary.mean != null
      ? topSummary.leaveBest1Mean - bottomSummary.mean
      : null,
    leaveBest3TopMinusBottomMean: topSummary.leaveBest3Mean != null && bottomSummary.mean != null
      ? topSummary.leaveBest3Mean - bottomSummary.mean
      : null,
    executionAwareTopQuintileLong: summarize(top.map((row) => row.topQuintileLongNetDiagnostic)),
  };
}
async function collectSpot(client, symbol) {
  const raw = await collectBitgetCandles({
    client,
    market: "CRYPTO_SPOT",
    symbol,
    timeframe: "1d",
    startTime: START,
    endTime: END,
    maxCandles: 20_000,
  });
  const repaired = await repairBitgetCandleGaps({
    client,
    market: "CRYPTO_SPOT",
    symbol,
    timeframe: "1d",
    candles: raw.candles,
  });
  if (repaired.remainingMissingCandleCount > 0) {
    throw new Error(`${symbol}_UNRESOLVED_DAILY_GAPS_${repaired.remainingMissingCandleCount}`);
  }
  const candles = repaired.candles.filter((row) => row.timestamp >= START && row.timestamp < END);
  if (candles.length < 1_500) throw new Error(`${symbol}_INSUFFICIENT_DAILY_HISTORY_${candles.length}`);
  return {
    symbol,
    candles,
    report: {
      symbol,
      provider: raw.provider,
      candleCount: candles.length,
      firstDate: isoDate(candles[0].timestamp),
      lastDate: isoDate(candles.at(-1).timestamp),
      repairedCandleCount: repaired.repairedCandleCount,
      remainingMissingCandleCount: repaired.remainingMissingCandleCount,
    },
  };
}
function weeklySeries(candles) {
  const byWeek = new Map();
  for (const candle of candles) byWeek.set(weekEndKey(candle.timestamp), candle);
  const rows = [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([weekEnd, candle]) => ({
    weekEnd,
    timestamp: candle.timestamp,
    close: candle.close,
  }));
  return rows.slice(1).map((row, index) => ({
    ...row,
    return: row.close / rows[index].close - 1,
  }));
}
function monthEndSeries(candles) {
  const byMonth = new Map();
  for (const candle of candles) byMonth.set(monthKey(candle.timestamp), candle);
  return [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, candle]) => ({
    month,
    timestamp: candle.timestamp,
    close: candle.close,
  }));
}
function liuCutoffs(weekly) {
  if (weekly.length < CALIBRATION_WEEKS + 20) throw new Error("LIU_WEEKLY_HISTORY_INSUFFICIENT");
  const calibration = weekly.slice(0, CALIBRATION_WEEKS).map((row) => row.return).sort((a, b) => a - b);
  return Object.freeze({
    p20: quantile(calibration, 0.20),
    p40: quantile(calibration, 0.40),
    p60: quantile(calibration, 0.60),
    p80: quantile(calibration, 0.80),
    calibrationStart: weekly[0].weekEnd,
    calibrationEnd: weekly[CALIBRATION_WEEKS - 1].weekEnd,
  });
}
function quintile(value, cutoffs) {
  if (value <= cutoffs.p20) return 1;
  if (value <= cutoffs.p40) return 2;
  if (value <= cutoffs.p60) return 3;
  if (value <= cutoffs.p80) return 4;
  return 5;
}
function liuMomentumForSymbol(symbol, candles) {
  const weekly = weeklySeries(candles);
  const cutoffs = liuCutoffs(weekly);
  const evaluation = [];
  for (let index = CALIBRATION_WEEKS; index < weekly.length; index += 1) {
    const signal = weekly[index];
    const q = quintile(signal.return, cutoffs);
    for (const horizon of LIU_HORIZONS) {
      const future = weekly[index + horizon];
      if (!future) continue;
      const gross = future.close / signal.close - 1;
      const executionAwareLong = q === 5 ? gross - ROUND_TRIP_COST_FRACTION : null;
      evaluation.push({
        symbol,
        signalWeekEnd: signal.weekEnd,
        validationWindow: liuWindow(signal.weekEnd),
        signalReturn: signal.return,
        quintile: q,
        horizonWeeks: horizon,
        futureReturn: gross,
        topQuintileLongNetDiagnostic: executionAwareLong,
      });
    }
  }
  const horizons = {};
  for (const horizon of LIU_HORIZONS) {
    const rows = evaluation.filter((row) => row.horizonWeeks === horizon);
    horizons[horizon] = {
      ...liuSummaryBlock(rows),
      windows: {
        PRIOR: liuSummaryBlock(rows.filter((row) => row.validationWindow === "PRIOR")),
        RECENT: liuSummaryBlock(rows.filter((row) => row.validationWindow === "RECENT")),
      },
    };
  }
  return {
    symbol,
    cutoffs,
    calibrationWeeks: CALIBRATION_WEEKS,
    evaluationStart: weekly[CALIBRATION_WEEKS]?.weekEnd ?? null,
    evaluationEnd: weekly.at(-1)?.weekEnd ?? null,
    horizons,
    rows: evaluation,
  };
}
function pooledLiu(results) {
  const output = {};
  for (const horizon of LIU_HORIZONS) {
    const rows = results.flatMap((result) => result.rows.filter((row) => row.horizonWeeks === horizon));
    output[horizon] = {
      symbols: results.map((row) => row.symbol),
      ...liuSummaryBlock(rows),
      windows: {
        PRIOR: liuSummaryBlock(rows.filter((row) => row.validationWindow === "PRIOR")),
        RECENT: liuSummaryBlock(rows.filter((row) => row.validationWindow === "RECENT")),
      },
      positiveSpreadSymbols: results.filter((result) => result.horizons[horizon]?.topMinusBottomMean > 0).map((result) => result.symbol),
      nonPositiveSpreadSymbols: results.filter((result) => !(result.horizons[horizon]?.topMinusBottomMean > 0)).map((result) => result.symbol),
    };
  }
  return output;
}
function mop12mForSymbol(symbol, candles) {
  const monthly = monthEndSeries(candles);
  const rows = [];
  for (let index = 12; index < monthly.length - 1; index += 1) {
    const signalMonth = monthly[index];
    const past = monthly[index - 12];
    const next = monthly[index + 1];
    const past12mReturn = signalMonth.close / past.close - 1;
    const next1mReturn = next.close / signalMonth.close - 1;
    const direction = past12mReturn > 0 ? 1 : past12mReturn < 0 ? -1 : 0;
    rows.push({
      symbol,
      signalMonth: signalMonth.month,
      past12mReturn,
      direction,
      nextMonth: next.month,
      next1mReturn,
      tsmReturn: direction * next1mReturn,
      buyHoldReturn: next1mReturn,
    });
  }
  return {
    symbol,
    rows,
    tsm: summarize(rows.map((row) => row.tsmReturn)),
    buyHold: summarize(rows.map((row) => row.buyHoldReturn)),
    positiveSignalRate: rows.length ? rows.filter((row) => row.direction > 0).length / rows.length : null,
  };
}
function pooledMop(results) {
  const byMonth = new Map();
  for (const result of results) {
    for (const row of result.rows) {
      const list = byMonth.get(row.signalMonth) ?? [];
      list.push(row);
      byMonth.set(row.signalMonth, list);
    }
  }
  const months = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, rows]) => ({
    month,
    assets: rows.length,
    equalWeightTsmReturn: mean(rows.map((row) => row.tsmReturn)),
    equalWeightBuyHoldReturn: mean(rows.map((row) => row.buyHoldReturn)),
  }));
  return {
    months: months.length,
    equalWeightTsm: summarize(months.map((row) => row.equalWeightTsmReturn)),
    equalWeightBuyHold: summarize(months.map((row) => row.equalWeightBuyHoldReturn)),
    tsmMinusBuyHoldMean: months.length
      ? mean(months.map((row) => row.equalWeightTsmReturn - row.equalWeightBuyHoldReturn))
      : null,
    rows: months,
  };
}
function selfTest() {
  const weekly = Array.from({ length: 150 }, (_, index) => ({
    weekEnd: `2024-W${String(index).padStart(3, "0")}`,
    return: (index % 10 - 5) / 100,
    close: 100 * (1 + index / 1000),
  }));
  const cuts = liuCutoffs(weekly);
  if (!(cuts.p20 <= cuts.p40 && cuts.p40 <= cuts.p60 && cuts.p60 <= cuts.p80)) throw new Error("SELFTEST_QUINTILES");
  if (quintile(cuts.p80 + 1, cuts) !== 5) throw new Error("SELFTEST_TOP_QUINTILE");
  const months = Array.from({ length: 20 }, (_, index) => ({ month: `M${index}`, close: 100 + index }));
  const fakeCandles = months.flatMap((row, index) => [{ timestamp: Date.UTC(2020, index, 28), open: row.close, high: row.close, low: row.close, close: row.close, volume: 1 }]);
  if (monthEndSeries(fakeCandles).length < 12) throw new Error("SELFTEST_MONTHS");
  console.log("CRYPTO_REFERENCE_MOMENTUM_SELF_TEST_OK");
}
async function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const client = new BitgetPublicClient({ minIntervalMs: 170, maxRetries: 4, timeoutMs: 15_000 });
  const collected = [];
  const failures = [];
  for (const symbol of SYMBOLS) {
    try {
      collected.push(await collectSpot(client, symbol));
    } catch (error) {
      failures.push({ symbol, error: String(error?.message ?? error) });
    }
    await sleep(300);
  }
  if (collected.length < 2) throw new Error(`CRYPTO_REFERENCE_DATA_INSUFFICIENT_${collected.length}`);

  const liu = collected.map((dataset) => liuMomentumForSymbol(dataset.symbol, dataset.candles));
  const mop = collected.map((dataset) => mop12mForSymbol(dataset.symbol, dataset.candles));
  const pooledLiuResult = pooledLiu(liu);
  const pooledMopResult = pooledMop(mop);

  const report = {
    schemaVersion: 1,
    status: "pass",
    market: "CRYPTO_SPOT",
    purpose: "source-first crypto momentum replication before regime/wave/candle/AI overlays",
    data: {
      provider: "Bitget public daily spot candles",
      requestedStart: new Date(START).toISOString(),
      requestedEnd: new Date(END).toISOString(),
      symbolsRequested: SYMBOLS,
      symbolsReady: collected.map((row) => row.symbol),
      failures,
      datasets: collected.map((row) => row.report),
    },
    recipes: {
      LIU_TSYVINSKI_CRYPTO_WEEKLY_MOMENTUM_V1: {
        sourceDoi: LIU_TSYVINSKI_DOI,
        publishedVersion: LIU_TSYVINSKI_PUBLISHED,
        sourceRule: "current weekly return grouped into quintiles; evaluate 1-4 week ahead returns",
        localOosRule: "first 104 weeks fix per-symbol quintile cutoffs; all later weeks are evaluation only",
        parameterSearch: false,
        result: { perSymbol: liu, pooled: pooledLiuResult },
        exactHistoricalDatasetClaimAllowed: false,
        tradableLongShortClaimAllowed: false,
      },
      MOP_TSMOM_12M_1M_SPOT_PROXY_V1: {
        sourceDoi: MOP_DOI,
        reexaminationDoi: MOP_REEXAM_DOI,
        volatilityScalingCritiqueDoi: MOP_VOL_SCALING_DOI,
        sourceRule: "sign of prior 12-month own return predicts next one-month return",
        localImplementation: "equal-weight unscaled sign rule on crypto spot monthly closes",
        volatilityScaledCanonicalReplication: false,
        volatilityScalingDeliberatelyExcludedFromPrimaryResult: true,
        parameterSearch: false,
        result: { perSymbol: mop, pooled: pooledMopResult },
        canonicalMopFuturesReplicationClaimAllowed: false,
        tradableClaimAllowed: false,
      },
    },
    comparisons: {
      liuOneWeekTopMinusBottomMean: pooledLiuResult[1]?.topMinusBottomMean ?? null,
      liuFourWeekTopMinusBottomMean: pooledLiuResult[4]?.topMinusBottomMean ?? null,
      liuOneWeekLeaveBest1Spread: pooledLiuResult[1]?.leaveBest1TopMinusBottomMean ?? null,
      liuOneWeekLeaveBest3Spread: pooledLiuResult[1]?.leaveBest3TopMinusBottomMean ?? null,
      liuOneWeekPriorSpread: pooledLiuResult[1]?.windows?.PRIOR?.topMinusBottomMean ?? null,
      liuOneWeekRecentSpread: pooledLiuResult[1]?.windows?.RECENT?.topMinusBottomMean ?? null,
      liuFourWeekPriorSpread: pooledLiuResult[4]?.windows?.PRIOR?.topMinusBottomMean ?? null,
      liuFourWeekRecentSpread: pooledLiuResult[4]?.windows?.RECENT?.topMinusBottomMean ?? null,
      liuOneWeekPositiveSpreadSymbols: pooledLiuResult[1]?.positiveSpreadSymbols ?? [],
      liuFourWeekPositiveSpreadSymbols: pooledLiuResult[4]?.positiveSpreadSymbols ?? [],
      liuOneWeekTopLongAfterResearchCosts: pooledLiuResult[1]?.executionAwareTopQuintileLong ?? null,
      mopEqualWeightTsmMean: pooledMopResult.equalWeightTsm.mean,
      mopEqualWeightBuyHoldMean: pooledMopResult.equalWeightBuyHold.mean,
      mopTsmMinusBuyHoldMean: pooledMopResult.tsmMinusBuyHoldMean,
    },
    promotionAssessment: {
      automaticPromotionAllowed: false,
      economicSampleCredit: 0,
      LIU_TSYVINSKI_CRYPTO_WEEKLY_MOMENTUM_V1: {
        status: "RESEARCH_HOLD_TRANSFER_AND_CONCENTRATION_REVIEW",
        reason: "positive pooled means must be checked against BTC/ETH/XRP transfer, PRIOR/RECENT stability, medians, and leave-best-1/3 concentration before any overlay experiment",
        automaticPromotionAllowed: false,
      },
      MOP_TSMOM_12M_1M_SPOT_PROXY_V1: {
        status: pooledMopResult.tsmMinusBuyHoldMean > 0 ? "RESEARCH_HOLD_SPOT_PROXY_POSITIVE_DIAGNOSTIC" : "RESEARCH_HOLD_SPOT_PROXY_BELOW_BUYHOLD",
        reason: "unscaled crypto spot proxy is descriptive only and is not canonical MOP futures evidence",
        automaticPromotionAllowed: false,
      },
    },
    safeguards: {
      researchOnly: true,
      publicDataOnly: true,
      privateAccountRequestAllowed: false,
      orderRouteCalled: false,
      actualOrders: 0,
      liveExecutionAllowed: false,
      executionAuthority: "NONE",
      profitabilityClaimAllowed: false,
    },
    limitations: [
      "Bitget current symbol availability is used; this is not a point-in-time crypto listing/delisting universe.",
      "The Liu-Tsyvinski local replication uses BTC/ETH/XRP when available and fixes quintile cutoffs from the first 104 local weeks; it does not reproduce their original historical exchange dataset.",
      "The MOP baseline is an unscaled spot-price proxy for the 12-month sign rule, not a canonical diversified futures replication.",
      "MOP volatility scaling is excluded from the primary result because later literature shows scaling can materially drive reported performance.",
      "Close-to-close source replications are predictive diagnostics, not executable fill claims.",
      "Only the top-quintile long diagnostic subtracts the app's explicit spot research round-trip cost assumption.",
      "Liu momentum is reported separately for fixed PRIOR (before 2024-01-01) and RECENT (2024-01-01 onward) evaluation windows and includes leave-best-1/3 concentration stress.",
      "Historical replay is not genuine Forward/OOS economic proof and cannot change PROFITABILITY_PROVEN.",
    ],
  };

  const out = resolve(process.argv[2] ?? "docs/crypto-reference-momentum-v1.json");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({
    status: report.status,
    symbolsReady: report.data.symbolsReady,
    liu1wSpread: report.comparisons.liuOneWeekTopMinusBottomMean,
    liu4wSpread: report.comparisons.liuFourWeekTopMinusBottomMean,
    liu1wTopNetMean: report.comparisons.liuOneWeekTopLongAfterResearchCosts?.mean ?? null,
    liu1wPriorSpread: report.comparisons.liuOneWeekPriorSpread,
    liu1wRecentSpread: report.comparisons.liuOneWeekRecentSpread,
    liu1wLeaveBest1Spread: report.comparisons.liuOneWeekLeaveBest1Spread,
    liu1wLeaveBest3Spread: report.comparisons.liuOneWeekLeaveBest3Spread,
    mopTsmMean: report.comparisons.mopEqualWeightTsmMean,
    mopBuyHoldMean: report.comparisons.mopEqualWeightBuyHoldMean,
    mopMinusBuyHold: report.comparisons.mopTsmMinusBuyHoldMean,
  }));
}
await main();
