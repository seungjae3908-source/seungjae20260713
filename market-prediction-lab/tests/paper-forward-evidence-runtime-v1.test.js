import assert from "node:assert/strict";
import test from "node:test";
import {
  PAPER_FORWARD_PROVIDER_AUTHORITY,
  createCanonicalPaperForwardEvidenceProvider,
  runPaperForwardEvidenceRuntime,
  validateCanonicalPaperForwardEvidence,
} from "../src/paper-forward-evidence-runtime-v1.js";

const NOW = Date.UTC(2026, 7, 15, 8);

function candles(intervalMs, count = 120, endMs = NOW) {
  const lastOpen = Math.floor(endMs / intervalMs) * intervalMs - intervalMs;
  return Array.from({ length: count }, (_, index) => ({
    timestamp: lastOpen - (count - 1 - index) * intervalMs,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
  }));
}

function provider(overrides = {}) {
  return createCanonicalPaperForwardEvidenceProvider({
    clock: () => NOW,
    bitgetClient: {},
    collectYahoo: async ({ market, symbol }) => ({ market, symbol, source: "yahoo-public-chart", timeframe: "1d", candles: candles(86_400_000) }),
    collectUpbit: async () => ({ market: "CRYPTO_SPOT", source: "upbit-public-candles", timeframe: "4h", candles: candles(14_400_000) }),
    collectBitget: async () => ({ market: "CRYPTO_FUTURES", provider: "bitget-public-v2", timeframe: "4h", candles: candles(14_400_000) }),
    ...overrides,
  });
}

test("canonical public authorities accept only fresh closed candles for four markets", async () => {
  const report = await validateCanonicalPaperForwardEvidence({ provider: provider(), nowMs: NOW });
  assert.equal(report.ready, true);
  assert.deepEqual(report.lanes.map((lane) => lane.market), Object.keys(PAPER_FORWARD_PROVIDER_AUTHORITY));
  assert.ok(report.lanes.every((lane) => lane.acceptedEvidenceCount === 1 && lane.blocker === null));
  assert.equal(report.privateRequestCount, 0);
  assert.equal(report.financialMutationCount, 0);
});

for (const [name, overrides, expected] of [
  ["provider mismatch", { collectUpbit: async () => ({ market: "CRYPTO_SPOT", source: "fixture", timeframe: "4h", candles: candles(14_400_000) }) }, "PROVIDER_MISMATCH"],
  ["market mismatch", { collectYahoo: async () => ({ market: "US_STOCK", source: "yahoo-public-chart", timeframe: "1d", candles: candles(86_400_000) }) }, "MARKET_MISMATCH"],
  ["unclosed candle", { collectBitget: async () => ({ market: "CRYPTO_FUTURES", provider: "bitget-public-v2", timeframe: "4h", candles: [{ timestamp: NOW, open: 100, high: 101, low: 99, close: 100, volume: 1 }] }) }, "UNCLOSED_CANDLE"],
  ["stale candle", { collectUpbit: async () => ({ market: "CRYPTO_SPOT", source: "upbit-public-candles", timeframe: "4h", candles: candles(14_400_000, 120, NOW - 24 * 60 * 60 * 1000) }) }, "STALE_EVIDENCE"],
] ) {
  test(`${name} fails closed without fabricated evidence`, async () => {
    const report = await validateCanonicalPaperForwardEvidence({ provider: provider(overrides), nowMs: NOW });
    assert.equal(report.ready, false);
    assert.ok(report.lanes.some((lane) => lane.blocker === expected));
    assert.equal(report.financialMutationCount, 0);
  });
}

test("partial provider failure remains an explicit per-market blocker", async () => {
  const report = await validateCanonicalPaperForwardEvidence({
    provider: provider({ collectYahoo: async ({ market }) => {
      if (market === "KR_STOCK") throw new Error("network unavailable");
      return { market, source: "yahoo-public-chart", timeframe: "1d", candles: candles(86_400_000) };
    } }),
    nowMs: NOW,
  });
  assert.equal(report.ready, false);
  assert.equal(report.lanes.find((lane) => lane.market === "KR_STOCK").blocker, "PROVIDER_FAILED");
  assert.equal(report.lanes.filter((lane) => lane.status === "READY").length, 3);
});

test("runtime delegates one canonical mutation boundary and persists sanitized status", async () => {
  const saved = [];
  const result = await runPaperForwardEvidenceRuntime({
    publicEvidenceProvider: provider(),
    runtimeStatusStore: { async save(value) { saved.push(value); } },
    runScheduled: async ({ publicEvidenceProvider }) => {
      for (const market of Object.keys(PAPER_FORWARD_PROVIDER_AUTHORITY)) await publicEvidenceProvider.collectPublicEvidence({ market });
      return { status: "COMPLETED", cycleId: "cycle:1", mutationCount: 1, summary: { tradesSettled: 0, noTrade: 0 } };
    },
  });
  assert.equal(result.runtimeStatus.mutationCount, 1);
  assert.equal(result.runtimeStatus.orderCount, 0);
  assert.equal(result.runtimeStatus.privateRequestCount, 0);
  assert.equal(result.runtimeStatus.settlementCount, 0);
  assert.equal(saved.length, 1);
  assert.doesNotMatch(JSON.stringify(saved[0]), /secret|token|credential/i);
});

test("same-cycle replay reports zero mutation and one replay", async () => {
  const result = await runPaperForwardEvidenceRuntime({
    publicEvidenceProvider: provider(),
    runScheduled: async () => ({ status: "REPLAYED", cycleId: "cycle:1", mutationCount: 0 }),
  });
  assert.equal(result.runtimeStatus.mutationCount, 0);
  assert.equal(result.runtimeStatus.replayCount, 1);
  assert.equal(result.runtimeStatus.orderCount, 0);
});

test("rate-limit and timeout errors remain retry-classified without mutation", async () => {
  for (const error of [Object.assign(new Error("429"), { status: 429 }), Object.assign(new Error("timeout"), { code: "PROVIDER_TIMEOUT" })]) {
    const report = await validateCanonicalPaperForwardEvidence({
      provider: { async collectPublicEvidence() { throw error; } },
      nowMs: NOW,
    });
    assert.equal(report.ready, false);
    assert.ok(report.lanes.every((lane) => ["PROVIDER_RATE_LIMITED", "PROVIDER_TIMEOUT"].includes(lane.blocker)));
    assert.equal(report.financialMutationCount, 0);
  }
});

test("bounded 5xx retry honors Retry-After and accepts evidence exactly once", async () => {
  let attempts = 0;
  const delays = [];
  const candidate = provider({
    providerRetry: { maxAttempts: 3, baseBackoffMs: 10 },
    sleep: async (delayMs) => { delays.push(delayMs); },
    collectUpbit: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("UPBIT_HISTORY_HTTP_503"), { status: 503, retryAfterMs: 75 });
      return { market: "CRYPTO_SPOT", source: "upbit-public-candles", timeframe: "4h", candles: candles(14_400_000) };
    },
  });
  const evidence = await candidate.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  assert.equal(evidence.status, "READY");
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [75]);
  assert.equal(evidence.candidates.length, 0);
  assert.equal(evidence.exits.length, 0);
});
