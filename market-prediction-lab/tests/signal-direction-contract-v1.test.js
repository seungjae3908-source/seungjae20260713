import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveExecutionDecision,
  isSignalDirectionAllowedForMarket,
  normalizeSignalDirection,
  resolveSignalLifecycle,
} from "../src/signal-direction-contract-v1.js";

const CASH_MARKETS = ["KR_STOCK", "US_STOCK", "CRYPTO_SPOT"];

test("canonical direction never defaults unknown input to BUY", () => {
  assert.equal(normalizeSignalDirection(undefined), "UNKNOWN");
  assert.equal(normalizeSignalDirection(""), "UNKNOWN");
  assert.equal(normalizeSignalDirection("bull"), "UNKNOWN");
});

test("cash markets allow BUY/SELL/NO_TRADE but never LONG/SHORT", () => {
  for (const market of CASH_MARKETS) {
    assert.equal(isSignalDirectionAllowedForMarket(market, "BUY"), true);
    assert.equal(isSignalDirectionAllowedForMarket(market, "SELL"), true);
    assert.equal(isSignalDirectionAllowedForMarket(market, "NO_TRADE"), true);
    assert.equal(isSignalDirectionAllowedForMarket(market, "LONG"), false);
    assert.equal(isSignalDirectionAllowedForMarket(market, "SHORT"), false);
  }
});

test("futures allows LONG/SHORT/NO_TRADE but never cash BUY/SELL", () => {
  assert.equal(isSignalDirectionAllowedForMarket("CRYPTO_FUTURES", "LONG"), true);
  assert.equal(isSignalDirectionAllowedForMarket("CRYPTO_FUTURES", "SHORT"), true);
  assert.equal(isSignalDirectionAllowedForMarket("CRYPTO_FUTURES", "NO_TRADE"), true);
  assert.equal(isSignalDirectionAllowedForMarket("CRYPTO_FUTURES", "BUY"), false);
  assert.equal(isSignalDirectionAllowedForMarket("CRYPTO_FUTURES", "SELL"), false);
});

test("cash BUY+FLAT enters long; SELL+FLAT is bearish signal only and never opens short", () => {
  for (const market of CASH_MARKETS) {
    const buy = deriveExecutionDecision({ market, direction: "BUY", positionSide: "FLAT" });
    assert.equal(buy.executionIntent, "ENTER");
    assert.equal(buy.nextPositionSide, "LONG");

    const sell = deriveExecutionDecision({ market, direction: "SELL", positionSide: "FLAT" });
    assert.equal(sell.executionIntent, "NONE");
    assert.equal(sell.nextPositionSide, "FLAT");
    assert.equal(sell.reason, "CASH_SELL_FLAT_NO_NAKED_SHORT");
  }
});

test("cash SELL+LONG exits or reduces but is never treated as opening SHORT", () => {
  const exit = deriveExecutionDecision({ market: "KR_STOCK", direction: "SELL", positionSide: "LONG" });
  assert.equal(exit.executionIntent, "EXIT");
  assert.equal(exit.nextPositionSide, "FLAT");
  assert.equal(exit.signalDirection, "SELL");

  const reduce = deriveExecutionDecision({ market: "US_STOCK", direction: "SELL", positionSide: "LONG", reduceOnly: true });
  assert.equal(reduce.executionIntent, "REDUCE");
  assert.equal(reduce.nextPositionSide, "LONG");
});

test("futures LONG and SHORT can enter from FLAT but opposite-position reversal fails closed", () => {
  const long = deriveExecutionDecision({ market: "CRYPTO_FUTURES", direction: "LONG", positionSide: "FLAT" });
  const short = deriveExecutionDecision({ market: "CRYPTO_FUTURES", direction: "SHORT", positionSide: "FLAT" });
  assert.equal(long.executionIntent, "ENTER");
  assert.equal(long.nextPositionSide, "LONG");
  assert.equal(short.executionIntent, "ENTER");
  assert.equal(short.nextPositionSide, "SHORT");

  const reverse = deriveExecutionDecision({ market: "CRYPTO_FUTURES", direction: "SHORT", positionSide: "LONG" });
  assert.equal(reverse.executionIntent, "NONE");
  assert.equal(reverse.allowed, false);
  assert.equal(reverse.reason, "OPPOSITE_POSITION_REQUIRES_RECONCILIATION");
});

test("NO_TRADE and UNKNOWN always map to execution NONE", () => {
  const noTrade = deriveExecutionDecision({ market: "KR_STOCK", direction: "NO_TRADE", positionSide: "FLAT" });
  assert.equal(noTrade.executionIntent, "NONE");
  assert.equal(noTrade.allowed, true);

  const unknown = deriveExecutionDecision({ market: "CRYPTO_FUTURES", direction: "UNKNOWN", positionSide: "FLAT" });
  assert.equal(unknown.executionIntent, "NONE");
  assert.equal(unknown.allowed, false);
});

test("TTL expiration and invalidation fail closed before execution", () => {
  const lifecycle = resolveSignalLifecycle({ lifecycle: "ACTIVE", generatedAtMs: 1_000, ttlMs: 100, evaluatedAtMs: 1_100 });
  assert.equal(lifecycle, "EXPIRED");
  const expired = deriveExecutionDecision({ market: "CRYPTO_FUTURES", direction: "LONG", positionSide: "FLAT", lifecycle });
  assert.equal(expired.executionIntent, "NONE");
  assert.equal(expired.reason, "SIGNAL_EXPIRED");

  assert.equal(resolveSignalLifecycle({ lifecycle: "ACTIVE", invalidated: true }), "INVALIDATED");
});

test("safety metadata remains locked on every execution decision", () => {
  const row = deriveExecutionDecision({ market: "CRYPTO_FUTURES", direction: "SHORT", positionSide: "FLAT" });
  assert.equal(row.liveTrading, false);
  assert.equal(row.realOrder, false);
  assert.equal(row.privateApi, false);
});
