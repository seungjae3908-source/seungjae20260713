import assert from "node:assert/strict";
import test from "node:test";

import { createSafeStrategyDslV1 } from "../src/autonomous-strategy-formula-generator-v1.js";
import { createEvidenceBackedFormulaEntryRuntimeV1 } from "../src/evidence-backed-formula-entry-evaluator-v1.js";

const space = [
  { name: "rsiPeriod", domain: "PERIOD", valueType: "INTEGER", min: 14, max: 14, step: 1 },
  { name: "rsiMax", domain: "RSI_LEVEL", valueType: "NUMBER", min: 28, max: 28, step: 1 },
  { name: "fastPeriod", domain: "PERIOD", valueType: "INTEGER", min: 2, max: 2, step: 1 },
  { name: "trendPeriod", domain: "PERIOD", valueType: "INTEGER", min: 288, max: 288, step: 1 },
  { name: "stopFraction", domain: "PRICE_FRACTION", valueType: "NUMBER", min: 0.015, max: 0.015, step: 0.001 },
  { name: "targetFraction", domain: "PRICE_FRACTION", valueType: "NUMBER", min: 0.03, max: 0.03, step: 0.001 },
  { name: "holdBars", domain: "BAR_COUNT", valueType: "INTEGER", min: 48, max: 48, step: 1 },
];
const exits = { rules: [
  { type: "FIXED_STOP", distanceParameter: "stopFraction" },
  { type: "TARGET", distanceParameter: "targetFraction" },
  { type: "TIME_EXIT", barsParameter: "holdBars" },
] };
const limits = { maxAstDepth: 8, maxIndicatorCount: 16, maxRuleCount: 32, maxAstNodes: 128 };
const rsiRule = { kind: "OPERATOR", operator: "LT", operands: [
  { kind: "INDICATOR", name: "RSI", input: "close", parameters: { period: "rsiPeriod" } }, { kind: "PARAMETER", name: "rsiMax" }] };

test("rule B approximation (indicator-only DSL) keeps its documented hash", () => {
  const dsl = createSafeStrategyDslV1({
    market: "CRYPTO_SPOT", timeframe: "5m", direction: "LONG", availableDataFields: ["close"],
    entryDsl: { action: "LONG", rules: [rsiRule, { kind: "OPERATOR", operator: "GT", operands: [
      { kind: "INDICATOR", name: "EMA", input: "close", parameters: { period: "fastPeriod" } },
      { kind: "INDICATOR", name: "SMA", input: "close", parameters: { period: "trendPeriod" } }] }] },
    exitDsl: exits, parameterSpace: space, limits,
  });
  assert.equal(dsl.dslHash, "79b2ac42c675f62795f9a2dece15c504ee837921956eb7c1367ee795a500445d");
});

test("PRICE operand expresses the original rule B exactly: close > SMA(288)", () => {
  const dsl = createSafeStrategyDslV1({
    market: "CRYPTO_SPOT", timeframe: "5m", direction: "LONG", availableDataFields: ["close"],
    entryDsl: { action: "LONG", rules: [rsiRule, { kind: "OPERATOR", operator: "GT", operands: [
      { kind: "PRICE", field: "close" },
      { kind: "INDICATOR", name: "SMA", input: "close", parameters: { period: "trendPeriod" } }] }] },
    exitDsl: exits, parameterSpace: space.filter((row) => row.name !== "fastPeriod"), limits,
  });
  assert.deepEqual(dsl.entryDsl.rules[1].operands[0], { kind: "PRICE", field: "close", lag: 1 });
  assert.notEqual(dsl.dslHash, "79b2ac42c675f62795f9a2dece15c504ee837921956eb7c1367ee795a500445d");
});

test("PRICE fields must be declared and the lag is system fixed", () => {
  const base = (operand, fields = ["close"]) => ({
    market: "CRYPTO_SPOT", timeframe: "1h", direction: "LONG", availableDataFields: fields,
    entryDsl: { action: "LONG", rules: [{ kind: "OPERATOR", operator: "GT", operands: [operand, { kind: "PARAMETER", name: "rsiMax" }] }] },
    exitDsl: exits, parameterSpace: space, limits,
  });
  assert.throws(() => createSafeStrategyDslV1(base({ kind: "PRICE", field: "high" })), /PRICE_DATA_FIELD_UNAVAILABLE/u);
  assert.throws(() => createSafeStrategyDslV1(base({ kind: "PRICE", field: "close", lag: 0 })), /PRICE_LAG_MUST_BE_SYSTEM_FIXED/u);
  assert.throws(() => createSafeStrategyDslV1(base({ kind: "PRICE", field: "vwap" })), /PRICE_FIELD_INVALID/u);
  assert.throws(() => createSafeStrategyDslV1(base({ kind: "PRICE", field: "close", extra: 1 })), /PRICE_NODE_SHAPE_INVALID/u);
});

test("evaluator reads the closed bar's price for PRICE nodes", () => {
  const runtime = createEvidenceBackedFormulaEntryRuntimeV1({
    entryDsl: { action: "LONG", rules: [{ kind: "OPERATOR", operator: "GT", operands: [
      { kind: "PRICE", field: "close", lag: 1 },
      { kind: "INDICATOR", name: "SMA", input: "close", parameters: { period: "p" }, lag: 1 }] }] },
    selectedParameters: { p: 3 },
  });
  const candles = [100, 101, 102, 90, 120].map((close, i) => ({ timestamp: i * 60_000, open: close, high: close + 1, low: close - 1, close, volume: 1 }));
  assert.equal(runtime.evaluate({ candles, index: 1 }).status, "INSUFFICIENT_HISTORY");
  assert.equal(runtime.evaluate({ candles, index: 3 }).signal, false);
  assert.equal(runtime.evaluate({ candles, index: 4 }).signal, true);
});
