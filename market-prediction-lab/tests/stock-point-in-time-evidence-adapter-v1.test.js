import test from "node:test";
import assert from "node:assert/strict";
import {
  createStockPointInTimeEvidenceAdapter,
  settleHistoricalStockDiscoveryWithPointInTimeEvidence,
} from "../src/stock-point-in-time-evidence-adapter-v1.js";

const DAY = 24 * 60 * 60 * 1000;
const AS_OF = 1_700_000_000_000;
const EVAL_END = AS_OF + 2 * DAY;
const COVERAGE_END = AS_OF + 7 * DAY;

function observations({ entry = 100, oneDay = 103, threeDay = 105, fiveDay = 107, endAt = AS_OF + 5 * DAY } = {}) {
  return [
    { timestampMs: AS_OF - DAY, price: entry - 1 },
    { timestampMs: AS_OF, price: entry },
    { timestampMs: AS_OF + DAY, price: oneDay },
    { timestampMs: AS_OF + 3 * DAY, price: threeDay },
    { timestampMs: AS_OF + 5 * DAY, price: fiveDay },
  ].filter((row) => row.timestampMs <= endAt);
}

function evidence(overrides = {}) {
  const memberships = [];
  const priceHistories = [];
  for (let index = 0; index < 19; index += 1) {
    const symbol = `LIVE${String(index + 1).padStart(2, "0")}`;
    const listingId = `KR-${symbol}-PRIMARY`;
    memberships.push({
      listingId,
      symbol,
      activeFrom: AS_OF - 100 * DAY,
      activeTo: null,
      sourceId: "krx-membership-archive-v1",
      exchange: "KRX",
    });
    priceHistories.push({
      listingId,
      symbol,
      sourceId: "adjusted-daily-history-v1",
      adjustmentPolicy: "SPLIT_ADJUSTED",
      observations: observations({
        entry: 100 + index,
        oneDay: 103 + index,
        threeDay: 105 + index,
        fiveDay: 107 + index,
      }),
    });
  }

  memberships.push({
    listingId: "KR-DEAD-PRIMARY",
    symbol: "DEAD",
    activeFrom: AS_OF - 200 * DAY,
    activeTo: AS_OF + DAY,
    sourceId: "krx-membership-archive-v1",
    exchange: "KRX",
    exitReason: "delisted",
  });
  priceHistories.push({
    listingId: "KR-DEAD-PRIMARY",
    symbol: "DEAD",
    sourceId: "adjusted-daily-history-v1",
    adjustmentPolicy: "SPLIT_ADJUSTED",
    terminalEventPolicy: "LAST_TRADABLE_PRICE",
    observations: observations({ entry: 100, oneDay: 104, threeDay: 104, fiveDay: 104, endAt: AS_OF + DAY }),
  });

  const base = {
    market: "KR_STOCK",
    evaluationStartTime: AS_OF,
    evaluationEndTime: EVAL_END,
    frozenAt: AS_OF - DAY,
    memberships,
    priceHistories,
    corporateActions: [{
      listingId: "KR-DEAD-PRIMARY",
      symbol: "DEAD",
      type: "DELISTING",
      effectiveAt: AS_OF + DAY,
      sourceId: "krx-corporate-actions-v1",
    }],
    corporateActionCoverage: {
      startTime: AS_OF - DAY,
      endTime: COVERAGE_END,
      sourceId: "krx-corporate-actions-v1",
      complete: true,
    },
  };
  return { ...base, ...overrides };
}

function replay(candidates = [{ signalId: "dead-long", symbol: "DEAD", direction: "LONG" }]) {
  return {
    schemaVersion: "historical-market-replay-v1",
    status: "READY",
    market: "KR_STOCK",
    strategyMode: "SWING",
    replayRows: [{
      asOfMs: AS_OF,
      discoveryCandidates: candidates,
      discoveryCandidateCount: candidates.length,
      searchOutcome: candidates.length ? "DISCOVERY_CANDIDATES" : "VALID_ZERO_DISCOVERY",
    }],
    pointInTimeOnly: true,
    executionAuthority: "NONE",
    liveTrading: false,
    realOrder: false,
    privateApi: false,
  };
}

test("point-in-time adapter keeps a later-delisted listing in the historical universe", async () => {
  const adapter = createStockPointInTimeEvidenceAdapter(evidence());
  assert.equal(adapter.status, "READY");
  assert.equal(adapter.biasAudit.status, "point_in_time_bias_gate_passed");
  assert.ok(adapter.metrics.removedListingCount >= 1);

  const oneDay = await adapter.loadGroundTruthUniverse({ asOfMs: AS_OF, settleAtMs: AS_OF + DAY });
  assert.equal(oneDay.pointInTimeOnly, true);
  assert.equal(oneDay.syntheticHistoricalData, false);
  assert.equal(oneDay.entries.length, 20);
  const removed = oneDay.entries.find((entry) => entry.listingId === "KR-DEAD-PRIMARY");
  assert.ok(removed);
  assert.equal(removed.symbol, "DEAD");
  assert.equal(removed.provenance.terminalEventPolicy, "LAST_TRADABLE_PRICE");
  assert.deepEqual(removed.provenance.corporateActionSourceIds, ["krx-corporate-actions-v1"]);
});

test("#479 historical discovery settlement consumes the adapter without survivorship backfill", async () => {
  const result = await settleHistoricalStockDiscoveryWithPointInTimeEvidence({
    replayResult: replay(),
    evidence: evidence(),
    successThresholdPctByHorizon: { "1D": 2, "3D": 2, "5D": 2 },
  });

  assert.equal(result.status, "READY");
  assert.equal(result.profitabilityClaimAllowed, false);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(typeof result.pointInTimeEvidenceSha256, "string");
  assert.ok(result.pointInTimeEvidenceSha256.length >= 32);
  assert.equal(result.metrics.byHorizon["1D"].signalCount, 1);
  assert.equal(result.metrics.byHorizon["1D"].hitCount, 1);
  assert.ok(result.metrics.byHorizon["1D"].groundTruthOpportunityCount >= 1);
});

test("current membership backfill and synthetic historical data fail closed with N/A metrics", () => {
  const currentBackfill = createStockPointInTimeEvidenceAdapter(evidence({ currentMembershipBackfill: true }));
  assert.equal(currentBackfill.status, "BLOCKED_DATA");
  assert.equal(currentBackfill.reason, "CURRENT_MEMBERSHIP_BACKFILL_FORBIDDEN");
  assert.equal(currentBackfill.metrics, null);

  const synthetic = createStockPointInTimeEvidenceAdapter(evidence({ syntheticHistoricalData: true }));
  assert.equal(synthetic.status, "BLOCKED_DATA");
  assert.equal(synthetic.reason, "SYNTHETIC_HISTORICAL_DATA_FORBIDDEN");
  assert.equal(synthetic.metrics, null);
});

test("missing corporate-action coverage fails closed instead of pretending zero evidence", async () => {
  const adapter = createStockPointInTimeEvidenceAdapter(evidence({
    corporateActionCoverage: {
      startTime: AS_OF,
      endTime: EVAL_END,
      sourceId: "partial-actions",
      complete: false,
    },
  }));
  assert.equal(adapter.status, "BLOCKED_DATA");
  assert.equal(adapter.reason, "CORPORATE_ACTION_COVERAGE_MISSING");
  assert.equal(adapter.metrics, null);

  const result = await settleHistoricalStockDiscoveryWithPointInTimeEvidence({
    replayResult: replay(),
    evidence: evidence({ corporateActionCoverage: null }),
    successThresholdPctByHorizon: { "1D": 2, "3D": 2, "5D": 2 },
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.dataStatus, "BLOCKED_DATA");
  assert.equal(result.reason, "CORPORATE_ACTION_COVERAGE_MISSING");
  assert.equal(result.metrics, null);
  assert.equal(result.settledSignalCount, null);
});

test("raw prices cannot cross a corporate action without an explicit adjustment policy", () => {
  const base = evidence();
  const priceHistories = base.priceHistories.map((history) => history.listingId === "KR-LIVE01-PRIMARY"
    ? { ...history, adjustmentPolicy: "RAW" }
    : history);
  const corporateActions = [
    ...base.corporateActions,
    {
      listingId: "KR-LIVE01-PRIMARY",
      symbol: "LIVE01",
      type: "SPLIT",
      effectiveAt: AS_OF + DAY,
      sourceId: "krx-corporate-actions-v1",
      ratio: 2,
    },
  ];
  const adapter = createStockPointInTimeEvidenceAdapter(evidence({ priceHistories, corporateActions }));
  assert.equal(adapter.status, "BLOCKED_DATA");
  assert.equal(adapter.reason, "CORPORATE_ACTION_ADJUSTMENT_NOT_PROVEN");
  assert.equal(adapter.metrics, null);
});

test("a discovery symbol that was not a member at the historical timestamp is blocked", async () => {
  const base = evidence();
  const futureMembership = {
    listingId: "KR-FUTURE-PRIMARY",
    symbol: "FUTURE",
    activeFrom: AS_OF + DAY,
    activeTo: null,
    sourceId: "krx-membership-archive-v1",
    exchange: "KRX",
  };
  const futureHistory = {
    listingId: "KR-FUTURE-PRIMARY",
    symbol: "FUTURE",
    sourceId: "adjusted-daily-history-v1",
    adjustmentPolicy: "SPLIT_ADJUSTED",
    observations: observations({ entry: 50, oneDay: 51, threeDay: 52, fiveDay: 53 }),
  };
  const result = await settleHistoricalStockDiscoveryWithPointInTimeEvidence({
    replayResult: replay([{ signalId: "future-long", symbol: "FUTURE", direction: "LONG" }]),
    evidence: evidence({
      memberships: [...base.memberships, futureMembership],
      priceHistories: [...base.priceHistories, futureHistory],
    }),
    successThresholdPctByHorizon: { "1D": 2, "3D": 2, "5D": 2 },
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "DISCOVERY_SYMBOL_MISSING_FROM_POINT_IN_TIME_UNIVERSE");
  assert.equal(result.metrics, null);
});
