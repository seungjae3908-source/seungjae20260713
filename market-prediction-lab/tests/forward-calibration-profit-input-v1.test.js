import test from "node:test";
import assert from "node:assert/strict";
import { resolveForwardCalibrationProfitInput } from "../src/forward-calibration-profit-input-v1.js";
import { evaluateProfitGate } from "../src/meaningful-search-profit-gate-v1.js";

const SHA = "a".repeat(40);
function paperCandidate(overrides = {}) {
  const base = {
    signal: {
      signalId: "sig-1",
      market: "US_STOCK",
      symbol: "AAPL",
      timeframe: "60m",
      horizon: 6,
      direction: "BUY",
      signalDirection: "BUY",
      style: "SWING",
      strategyIdentity: { strategyId: "swing-us-v1", strategyVersion: "1.0.0", parameterHash: "hash-1", researchCodeSha: SHA },
    },
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
  return { ...base, ...overrides, signal: { ...base.signal, ...(overrides.signal ?? {}), strategyIdentity: { ...base.signal.strategyIdentity, ...(overrides.signal?.strategyIdentity ?? {}) } } };
}
function readyCalibration(overrides = {}) {
  const base = {
    schemaVersion: "forward-recommendation-profit-calibration-v2",
    source: "LIVE_RECOMMENDATION",
    status: "READY",
    identity: { strategyId: "swing-us-v1", strategyVersion: "1.0.0", parameterHash: "hash-1", researchCodeSha: SHA, market: "US_STOCK", symbol: "AAPL", timeframe: "60m", horizon: 6, direction: "BUY" },
    calibration: { status: "READY", sampleSize: 40, tpFirstCount: 24 },
    probabilities: { tp: 0.6, sl: 0.25, expire: 0.15 },
    returns: { target: 0.05, stop: -0.02, expire: 0.005 },
    counts: { tp: 24, sl: 10, expire: 6, conservativeConflicts: 0 },
    costAdjusted: false,
    executionAuthority: "NONE",
    financialMutationAllowed: false,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    profitabilityClaimAllowed: false,
  };
  return { ...base, ...overrides, identity: { ...base.identity, ...(overrides.identity ?? {}) }, calibration: { ...base.calibration, ...(overrides.calibration ?? {}) }, probabilities: { ...base.probabilities, ...(overrides.probabilities ?? {}) }, returns: { ...base.returns, ...(overrides.returns ?? {}) }, counts: { ...base.counts, ...(overrides.counts ?? {}) } };
}

test("exact identity maps READY forward calibration into Profit Gate input without costs", () => {
  const resolved = resolveForwardCalibrationProfitInput({ calibration: readyCalibration(), paperCandidate: paperCandidate() });
  assert.equal(resolved.status, "CALIBRATION_READY");
  assert.deepEqual(resolved.blockers, []);
  assert.deepEqual(resolved.profitInput.probabilities, { tp: 0.6, sl: 0.25, expire: 0.15 });
  assert.deepEqual(resolved.profitInput.returns, { target: 0.05, stop: -0.02, expire: 0.005 });
  assert.deepEqual(resolved.profitInput.calibration, { status: "READY", sampleSize: 40, tpFirstCount: 24 });
  assert.deepEqual(resolved.profitInput.costs, { status: "MISSING", components: {} });
  assert.equal(resolved.profitabilityClaimAllowed, false);
  const gate = evaluateProfitGate({ market: "US_STOCK", ...resolved.profitInput });
  assert.equal(gate.decision, "NO_TRADE");
  assert.deepEqual(gate.reasons, ["COST_NOT_EVIDENCED"]);
});

test("all nine identity fields fail closed on mismatch", () => {
  const cases = [
    ["strategyId", "other", "FORWARD_CALIBRATION_STRATEGY_ID_MISMATCH"],
    ["strategyVersion", "2.0.0", "FORWARD_CALIBRATION_STRATEGY_VERSION_MISMATCH"],
    ["parameterHash", "other-hash", "FORWARD_CALIBRATION_PARAMETER_HASH_MISMATCH"],
    ["researchCodeSha", "b".repeat(40), "FORWARD_CALIBRATION_RESEARCH_SHA_MISMATCH"],
    ["market", "KR_STOCK", "FORWARD_CALIBRATION_MARKET_MISMATCH"],
    ["symbol", "MSFT", "FORWARD_CALIBRATION_SYMBOL_MISMATCH"],
    ["timeframe", "15m", "FORWARD_CALIBRATION_TIMEFRAME_MISMATCH"],
    ["horizon", 12, "FORWARD_CALIBRATION_HORIZON_MISMATCH"],
    ["direction", "SELL", "FORWARD_CALIBRATION_DIRECTION_MISMATCH"],
  ];
  for (const [field, value, reason] of cases) {
    const resolved = resolveForwardCalibrationProfitInput({ calibration: readyCalibration({ identity: { [field]: value } }), paperCandidate: paperCandidate() });
    assert.equal(resolved.status, "NO_TRADE", field);
    assert.ok(resolved.blockers.includes(reason), field);
    assert.equal(resolved.profitInput.probabilities.tp, null, field);
    assert.equal(resolved.profitInput.costs.status, "MISSING", field);
  }
});

test("missing or unsafe canonical paper candidate fails closed", () => {
  for (const candidate of [undefined, paperCandidate({ executionAuthority: "ORDER" }), paperCandidate({ signal: { signalDirection: "SELL" } })]) {
    const resolved = resolveForwardCalibrationProfitInput({ calibration: readyCalibration(), paperCandidate: candidate });
    assert.equal(resolved.status, "NO_TRADE");
    assert.equal(resolved.profitInput.probabilities.tp, null);
  }
});

test("non-ready forward calibration preserves evidence status but never probabilities", () => {
  const calibration = readyCalibration({ status: "INSUFFICIENT_SAMPLE", calibration: { status: "INSUFFICIENT_SAMPLE", sampleSize: 12, tpFirstCount: 7 } });
  const resolved = resolveForwardCalibrationProfitInput({ calibration, paperCandidate: paperCandidate() });
  assert.equal(resolved.status, "NO_TRADE");
  assert.ok(resolved.blockers.includes("FORWARD_CALIBRATION_NOT_READY"));
  assert.deepEqual(resolved.profitInput.calibration, { status: "INSUFFICIENT_SAMPLE", sampleSize: 12, tpFirstCount: 7 });
  assert.deepEqual(resolved.profitInput.probabilities, { tp: null, sl: null, expire: null });
});

test("READY calibration requires N>=30 and internally consistent outcome classes", () => {
  const variants = [
    [readyCalibration({ calibration: { sampleSize: 29, tpFirstCount: 17 }, counts: { tp: 17, sl: 8, expire: 4 }, probabilities: { tp: 17/29, sl: 8/29, expire: 4/29 } }), "FORWARD_CALIBRATION_SAMPLE_INVALID"],
    [readyCalibration({ counts: { tp: 24, sl: 16, expire: 0 }, probabilities: { tp: 0.6, sl: 0.4, expire: 0 } }), "FORWARD_CALIBRATION_COUNTS_INVALID"],
    [readyCalibration({ counts: { tp: 23 } }), "FORWARD_CALIBRATION_COUNTS_INVALID"],
    [readyCalibration({ probabilities: { tp: 0.61 } }), "FORWARD_CALIBRATION_PROBABILITY_INVALID"],
    [readyCalibration({ probabilities: { tp: 0.55, sl: 0.3, expire: 0.15 } }), "FORWARD_CALIBRATION_PROBABILITY_COUNT_MISMATCH"],
    [readyCalibration({ returns: { target: -0.05 } }), "FORWARD_CALIBRATION_RETURN_INVALID"],
    [readyCalibration({ returns: { stop: 0.02 } }), "FORWARD_CALIBRATION_RETURN_INVALID"],
  ];
  for (const [calibration, reason] of variants) {
    const resolved = resolveForwardCalibrationProfitInput({ calibration, paperCandidate: paperCandidate() });
    assert.equal(resolved.status, "NO_TRADE", reason);
    assert.ok(resolved.blockers.includes(reason), `${reason}: ${resolved.blockers.join(",")}`);
    assert.equal(resolved.profitInput.calibration.status, "INSUFFICIENT_SAMPLE");
  }
});

test("calibration safety envelope cannot be relaxed", () => {
  const unsafeRows = [
    { executionAuthority: "ORDER" },
    { financialMutationAllowed: true },
    { liveOrderAllowed: true },
    { privateTradingApiAllowed: true },
    { profitabilityClaimAllowed: true },
    { costAdjusted: true },
  ];
  for (const patch of unsafeRows) {
    const resolved = resolveForwardCalibrationProfitInput({ calibration: readyCalibration(patch), paperCandidate: paperCandidate() });
    assert.equal(resolved.status, "NO_TRADE");
    assert.ok(resolved.blockers.includes("FORWARD_CALIBRATION_SAFETY_INVALID"));
  }
});
