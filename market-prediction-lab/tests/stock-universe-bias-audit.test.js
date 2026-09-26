import test from "node:test";
import assert from "node:assert/strict";
import { auditStockUniverseBias } from "../src/stock-universe-bias-audit.js";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2020, 0, 1);
const END = Date.UTC(2025, 0, 1);

function memberships(count = 24) {
  return Array.from({ length: count }, (_, index) => ({
    symbol: `T${String(index).padStart(2, "0")}`,
    activeFrom: START - 365 * DAY,
    activeTo: index < 4 ? Date.UTC(2023, 0, 1) + index * 30 * DAY : null,
    exitReason: index < 4 ? "removed" : null,
    sourceId: "fixture-point-in-time-index-history",
  }));
}

function histories(rows, { omit = new Set() } = {}) {
  return [...new Set(rows.map((row) => row.symbol))].filter((symbol) => !omit.has(symbol)).map((symbol) => ({
    symbol,
    firstTimestamp: START - 30 * DAY,
    lastTimestamp: END + 30 * DAY,
    source: "fixture-history",
  }));
}

test("current-survivor-only universe fails closed", () => {
  const rows = memberships().filter((row) => row.activeTo == null);
  const result = auditStockUniverseBias({
    market: "US_STOCK",
    evaluationStartTime: START,
    evaluationEndTime: END,
    frozenAt: START - DAY,
    memberships: rows,
    histories: histories(rows),
  });
  assert.equal(result.status, "research_hold");
  assert.equal(result.gates.removedNamesPresent, false);
  assert.ok(result.reasons.includes("delisted_or_removed_names_missing"));
  assert.equal(result.executionPromotionAllowed, false);
});

test("point-in-time memberships with removed-name history can pass the bias research gate", () => {
  const rows = memberships();
  const result = auditStockUniverseBias({
    market: "US_STOCK",
    evaluationStartTime: START,
    evaluationEndTime: END,
    frozenAt: START - DAY,
    memberships: rows,
    histories: histories(rows),
  });
  assert.equal(result.status, "point_in_time_bias_gate_passed");
  assert.equal(result.gates.pointInTimeMembershipsPresent, true);
  assert.equal(result.gates.removedNamesPresent, true);
  assert.equal(result.gates.membershipHistoryCoveragePassed, true);
  assert.equal(result.gates.removedNameHistoryCoveragePassed, true);
  assert.equal(result.executionPromotionAllowed, false);
});

test("missing removed-name price history blocks the gate even when memberships exist", () => {
  const rows = memberships();
  const removed = new Set(rows.filter((row) => row.activeTo != null).map((row) => row.symbol));
  const result = auditStockUniverseBias({
    market: "US_STOCK",
    evaluationStartTime: START,
    evaluationEndTime: END,
    frozenAt: START - DAY,
    memberships: rows,
    histories: histories(rows, { omit: removed }),
  });
  assert.equal(result.status, "research_hold");
  assert.equal(result.gates.removedNameHistoryCoveragePassed, false);
  assert.ok(result.reasons.includes("removed_name_history_coverage_below_gate"));
});

test("overlapping membership intervals for one symbol are rejected", () => {
  assert.throws(() => auditStockUniverseBias({
    market: "US_STOCK",
    evaluationStartTime: START,
    evaluationEndTime: END,
    frozenAt: START - DAY,
    memberships: [
      { symbol: "ABC", activeFrom: START - 10 * DAY, activeTo: START + 10 * DAY, sourceId: "a" },
      { symbol: "ABC", activeFrom: START + 5 * DAY, activeTo: null, sourceId: "b" },
    ],
    histories: [{ symbol: "ABC", firstTimestamp: START - 30 * DAY, lastTimestamp: END, source: "fixture" }],
  }), /must not overlap/);
});
