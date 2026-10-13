import test from "node:test";
import assert from "node:assert/strict";
import { buildFaberGtaaFutureLedgerV1 } from "../src/faber-gtaa10m-future-receipt-v1.js";

const MONTHS = [
  "2025-11","2025-12","2026-01","2026-02","2026-03","2026-04","2026-05",
  "2026-06","2026-07","2026-08","2026-09","2026-10","2026-11",
];

function series(base, { bearish = false, through = "2026-11" } = {}) {
  return MONTHS.filter((month) => month <= through).map((month, index) => {
    const direction = bearish ? -1 : 1;
    const level = base + direction * index * 2;
    return {
      month,
      firstOpen: level,
      lastClose: bearish ? level - 0.5 : level + 0.5,
      firstDate: `${month}-01`,
      lastDate: `${month}-28`,
      dailyCount: 20,
    };
  });
}

function data({ through = "2026-11", dbcBearish = false } = {}) {
  return {
    SPY: series(100, { through }),
    EFA: series(80, { through }),
    IEF: series(90, { through }),
    VNQ: series(70, { through }),
    DBC: series(120, { through, bearish: dbcBearish }),
  };
}

test("before the first eligible entry month there is zero future credit", () => {
  const ledger = buildFaberGtaaFutureLedgerV1({
    monthlyBySymbol: data({ through: "2026-09" }),
    generatedAt: "2026-09-30T12:00:00.000Z",
  });
  assert.equal(ledger.status, "AWAITING_FIRST_ELIGIBLE_SIGNAL_ENTRY");
  assert.equal(ledger.latestSignalMonth, null);
  assert.equal(ledger.settledFutureOosSamples, 0);
  assert.equal(ledger.economicSampleCredit, 0);
  assert.equal(ledger.receipts.length, 0);
});

test("September signal plus October first open locks entry but cannot create economic credit", () => {
  const ledger = buildFaberGtaaFutureLedgerV1({
    monthlyBySymbol: data({ through: "2026-10" }),
    generatedAt: "2026-10-05T23:30:00.000Z",
  });
  assert.equal(ledger.latestSignalMonth, "2026-09");
  assert.equal(ledger.status, "SIGNAL_LOCKED_ENTRY_OBSERVED_OUTCOME_PENDING");
  assert.equal(ledger.settledFutureOosSamples, 0);
  assert.equal(ledger.economicSampleCredit, 0);
  assert.equal(ledger.receipts[0].signalMonth, "2026-09");
  assert.equal(ledger.receipts[0].holdingMonth, "2026-10");
  assert.equal(ledger.receipts[0].futureOosEconomicSampleCredit, 0);
  assert.equal(ledger.receipts[0].historicalBackfillCredit, 0);
});

test("only a naturally completed holding month becomes one future OOS economic sample", () => {
  const ledger = buildFaberGtaaFutureLedgerV1({
    monthlyBySymbol: data(),
    generatedAt: "2026-11-05T23:30:00.000Z",
  });
  assert.equal(ledger.latestSignalMonth, "2026-10");
  assert.equal(ledger.receipts[0].signalMonth, "2026-09");
  assert.equal(ledger.receipts[0].status, "SETTLED_FUTURE_OOS");
  assert.equal(ledger.receipts[0].futureOosEconomicSampleCredit, 1);
  assert.ok(Number.isFinite(ledger.receipts[0].portfolioReturn));
  assert.equal(ledger.settledFutureOosSamples, 1);
  assert.equal(ledger.economicSampleCredit, 1);
  assert.equal(ledger.profitabilityClaimAllowed, false);
  assert.equal(ledger.executionAuthority, "NONE");
});

test("cash sleeve settlement fails closed when the frozen TB3MS proxy is unavailable", () => {
  const blocked = buildFaberGtaaFutureLedgerV1({
    monthlyBySymbol: data({ dbcBearish: true }),
    generatedAt: "2026-11-05T23:30:00.000Z",
  });
  assert.equal(blocked.receipts[0].status, "BLOCKED_CASH_PROXY_MISSING");
  assert.equal(blocked.receipts[0].futureOosEconomicSampleCredit, 0);
  assert.equal(blocked.economicSampleCredit, 0);

  const settled = buildFaberGtaaFutureLedgerV1({
    monthlyBySymbol: data({ dbcBearish: true }),
    cashReturnsByMonth: { "2026-10": 0.003 },
    generatedAt: "2026-11-05T23:30:00.000Z",
  });
  assert.equal(settled.receipts[0].status, "SETTLED_FUTURE_OOS");
  assert.equal(settled.receipts[0].futureOosEconomicSampleCredit, 1);
  assert.equal(settled.economicSampleCredit, 1);
});

test("ledger preserves frozen safety and historical truth boundaries", () => {
  const ledger = buildFaberGtaaFutureLedgerV1({
    monthlyBySymbol: data({ through: "2026-10" }),
    generatedAt: "2026-10-05T23:30:00.000Z",
  });
  assert.equal(ledger.declarationCommitSha, "1b541e27e32332af63fe0255d257aac152f46dbf");
  assert.equal(ledger.observedHistoryThrough, "2026-08");
  assert.equal(ledger.firstEligibleSignalMonth, "2026-09");
  assert.equal(ledger.historicalBackfillCredit, 0);
  assert.equal(ledger.safeguards.observedHistoryMayCountAsOos, false);
  assert.equal(ledger.safeguards.parameterRetuningAllowed, false);
  assert.equal(ledger.safeguards.assetReplacementAllowed, false);
  assert.equal(ledger.safeguards.liveExecutionAllowed, false);
  assert.equal(ledger.safeguards.orderSubmissionAllowed, false);
});
