import { createHash } from "node:crypto";
import { FABER_GTAA_10M_FUTURE_HYPOTHESIS_V1 as H } from "./faber-gtaa10m-future-hypothesis-v1.js";

const SYMBOLS = Object.freeze(H.fixedRules.sleeves.map((sleeve) => sleeve.symbol));
const PERIOD = H.fixedRules.movingAverageMonths;
const COST = H.fixedRules.perSideResearchCostFraction;

function monthOrdinal(month) {
  if (!/^\d{4}-\d{2}$/u.test(String(month))) throw new Error(`INVALID_MONTH_${month}`);
  const [year, value] = String(month).split("-").map(Number);
  if (!(value >= 1 && value <= 12)) throw new Error(`INVALID_MONTH_${month}`);
  return year * 12 + value - 1;
}

export function addMonths(month, delta) {
  const ordinal = monthOrdinal(month) + delta;
  const year = Math.floor(ordinal / 12);
  const value = ordinal % 12 + 1;
  return `${year}-${String(value).padStart(2, "0")}`;
}

function canonicalHash(value) {
  return "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeSeries(symbol, rows) {
  if (!Array.isArray(rows) || rows.length < PERIOD + 2) {
    throw new Error(`FABER_FUTURE_${symbol}_MONTHLY_HISTORY_INSUFFICIENT`);
  }
  const normalized = rows.map((row) => {
    const month = String(row?.month ?? "");
    monthOrdinal(month);
    const firstOpen = Number(row?.firstOpen);
    const lastClose = Number(row?.lastClose);
    if (!(firstOpen > 0 && lastClose > 0)) {
      throw new Error(`FABER_FUTURE_${symbol}_PRICE_INVALID_${month}`);
    }
    return Object.freeze({
      month,
      firstOpen,
      lastClose,
      firstDate: row?.firstDate ? String(row.firstDate) : null,
      lastDate: row?.lastDate ? String(row.lastDate) : null,
      dailyCount: Number.isInteger(row?.dailyCount) ? row.dailyCount : null,
    });
  }).sort((a, b) => a.month.localeCompare(b.month));

  if (new Set(normalized.map((row) => row.month)).size !== normalized.length) {
    throw new Error(`FABER_FUTURE_${symbol}_DUPLICATE_MONTH`);
  }
  return normalized;
}

function smaAt(series, month) {
  const index = series.findIndex((row) => row.month === month);
  if (index < PERIOD - 1) return null;
  let sum = 0;
  for (let i = index - PERIOD + 1; i <= index; i += 1) sum += series[i].lastClose;
  return sum / PERIOD;
}

function signalAt(series, month) {
  const row = series.find((candidate) => candidate.month === month);
  const sma = smaAt(series, month);
  if (!row || !(sma > 0)) return null;
  return Object.freeze({
    month,
    adjustedClose: row.lastClose,
    sma10: sma,
    desiredLong: row.lastClose > sma,
  });
}

function rowAt(series, month) {
  return series.find((row) => row.month === month) ?? null;
}

function hasAllMonths(seriesBySymbol, month) {
  return SYMBOLS.every((symbol) => rowAt(seriesBySymbol[symbol], month) !== null);
}

function eligibleSignalMonths(seriesBySymbol) {
  const anchor = H.freezeBoundary.firstEligibleSignalMonth;
  const months = seriesBySymbol[SYMBOLS[0]]
    .map((row) => row.month)
    .filter((month) => month >= anchor);
  return months.filter((signalMonth) => {
    const holdingMonth = addMonths(signalMonth, 1);
    return hasAllMonths(seriesBySymbol, signalMonth) && hasAllMonths(seriesBySymbol, holdingMonth);
  });
}

function cashReturnFor(cashReturnsByMonth, month) {
  const value = cashReturnsByMonth instanceof Map
    ? cashReturnsByMonth.get(month)
    : cashReturnsByMonth?.[month];
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function sleeveOutcome({ priorSignal, signal, holdingRow, cashReturn }) {
  if (signal.desiredLong) {
    const transitionMultiplier = priorSignal.desiredLong ? 1 : 1 / (1 + COST);
    return Object.freeze({
      exposure: "LONG",
      transition: priorSignal.desiredLong ? "HOLD_LONG" : "ENTER_LONG",
      cashReturnApplied: false,
      return: transitionMultiplier * (holdingRow.lastClose / holdingRow.firstOpen) - 1,
    });
  }

  if (cashReturn == null) return null;
  const transitionMultiplier = priorSignal.desiredLong ? (1 - COST) : 1;
  return Object.freeze({
    exposure: "CASH",
    transition: priorSignal.desiredLong ? "EXIT_TO_CASH" : "HOLD_CASH",
    cashReturnApplied: true,
    return: transitionMultiplier * (1 + cashReturn) - 1,
  });
}

function weightedPortfolioReturn(perSleeve) {
  return H.fixedRules.sleeves.reduce((sum, sleeve) => (
    sum + sleeve.targetWeight * perSleeve[sleeve.symbol].outcome.return
  ), 0);
}

export function buildFaberGtaaFutureLedgerV1({
  monthlyBySymbol,
  cashReturnsByMonth = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!monthlyBySymbol || typeof monthlyBySymbol !== "object") {
    throw new Error("FABER_FUTURE_MONTHLY_DATA_REQUIRED");
  }

  const seriesBySymbol = Object.fromEntries(SYMBOLS.map((symbol) => [
    symbol,
    normalizeSeries(symbol, monthlyBySymbol[symbol]),
  ]));

  const ruleIdentity = Object.freeze({
    hypothesisId: H.id,
    declarationCommitSha: H.freezeBoundary.declarationCommitSha,
    sourceResearchHead: H.sourceResearch.exactHead,
    sourceArtifactDigest: H.sourceResearch.artifactDigest,
    observedHistoryThrough: H.freezeBoundary.observedHistoryThrough,
    firstEligibleSignalMonth: H.freezeBoundary.firstEligibleSignalMonth,
    fixedRules: H.fixedRules,
  });
  const ruleIdentityDigest = canonicalHash(ruleIdentity);

  const candidateMonths = eligibleSignalMonths(seriesBySymbol);
  const receipts = [];
  let sequenceBlocked = false;

  for (let i = 0; i < candidateMonths.length; i += 1) {
    const signalMonth = candidateMonths[i];
    const expectedMonth = addMonths(H.freezeBoundary.firstEligibleSignalMonth, i);
    if (signalMonth !== expectedMonth) sequenceBlocked = true;

    const priorSignalMonth = addMonths(signalMonth, -1);
    const holdingMonth = addMonths(signalMonth, 1);
    const completionProofMonth = addMonths(signalMonth, 2);
    const settlementComplete = hasAllMonths(seriesBySymbol, completionProofMonth);

    const perSleeve = {};
    let cashProxyMissing = false;
    for (const symbol of SYMBOLS) {
      const series = seriesBySymbol[symbol];
      const signal = signalAt(series, signalMonth);
      const priorSignal = signalAt(series, priorSignalMonth);
      const holdingRow = rowAt(series, holdingMonth);
      if (!signal || !priorSignal || !holdingRow) {
        throw new Error(`FABER_FUTURE_${symbol}_SIGNAL_LINEAGE_MISSING_${signalMonth}`);
      }

      const cashReturn = cashReturnFor(cashReturnsByMonth, holdingMonth);
      const outcome = settlementComplete
        ? sleeveOutcome({ priorSignal, signal, holdingRow, cashReturn })
        : null;
      if (settlementComplete && !signal.desiredLong && outcome === null) cashProxyMissing = true;

      perSleeve[symbol] = Object.freeze({
        targetWeight: H.fixedRules.sleeves.find((sleeve) => sleeve.symbol === symbol).targetWeight,
        priorSignal,
        signal,
        entry: Object.freeze({
          month: holdingMonth,
          adjustedOpen: holdingRow.firstOpen,
          firstDate: holdingRow.firstDate,
        }),
        settlement: settlementComplete ? Object.freeze({
          month: holdingMonth,
          adjustedClose: holdingRow.lastClose,
          lastDate: holdingRow.lastDate,
          completionProofMonth,
        }) : null,
        outcome,
      });
    }

    const hardBlocked = sequenceBlocked || (settlementComplete && cashProxyMissing);
    const settled = settlementComplete && !hardBlocked;
    const status = sequenceBlocked
      ? "BLOCKED_FUTURE_MONTH_SEQUENCE_GAP"
      : (settlementComplete && cashProxyMissing)
        ? "BLOCKED_CASH_PROXY_MISSING"
        : settlementComplete
          ? "SETTLED_FUTURE_OOS"
          : "SIGNAL_LOCKED_ENTRY_OBSERVED_OUTCOME_PENDING";

    const portfolioReturn = settled ? weightedPortfolioReturn(perSleeve) : null;
    const receiptCore = {
      schemaVersion: 1,
      hypothesisId: H.id,
      ruleIdentityDigest,
      signalMonth,
      priorSignalMonth,
      holdingMonth,
      completionProofMonth,
      status,
      perSleeve,
      portfolioReturn,
      historicalBackfillCredit: 0,
      futureOosEconomicSampleCredit: settled ? 1 : 0,
      profitabilityClaimAllowed: false,
      automaticPromotionAllowed: false,
      executionAuthority: "NONE",
      liveExecutionAllowed: false,
      actualOrders: 0,
    };
    receipts.push(Object.freeze({
      ...receiptCore,
      receiptDigest: canonicalHash(receiptCore),
    }));
  }

  const settledReceipts = receipts.filter((receipt) => receipt.status === "SETTLED_FUTURE_OOS");
  const latest = receipts.at(-1) ?? null;
  return Object.freeze({
    schemaVersion: 1,
    generatedAt,
    hypothesisId: H.id,
    declarationCommitSha: H.freezeBoundary.declarationCommitSha,
    ruleIdentityDigest,
    observedHistoryThrough: H.freezeBoundary.observedHistoryThrough,
    firstEligibleSignalMonth: H.freezeBoundary.firstEligibleSignalMonth,
    status: latest?.status ?? "AWAITING_FIRST_ELIGIBLE_SIGNAL_ENTRY",
    latestSignalMonth: latest?.signalMonth ?? null,
    settledFutureOosSamples: settledReceipts.length,
    economicSampleCredit: settledReceipts.length,
    profitabilityClaimAllowed: false,
    automaticPromotionAllowed: false,
    executionAuthority: "NONE",
    historicalBackfillCredit: 0,
    receipts: Object.freeze(receipts),
    safeguards: Object.freeze({
      publicDataOnly: true,
      observedHistoryMayCountAsOos: false,
      observedHistoryMayCountAsForward: false,
      observedHistoryMayCountAsEconomicSample: false,
      observedHistoryMayCountAsProfitabilityProof: false,
      parameterRetuningAllowed: false,
      assetReplacementAllowed: false,
      sleeveWeightRetuningAllowed: false,
      cashProxyPolicyChangeAllowed: false,
      executionTimingChangeAllowed: false,
      liveExecutionAllowed: false,
      orderSubmissionAllowed: false,
    }),
  });
}
