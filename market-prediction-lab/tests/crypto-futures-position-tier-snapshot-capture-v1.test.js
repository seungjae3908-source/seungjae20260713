import test from "node:test";
import assert from "node:assert/strict";
import {
  BITGET_POSITION_TIER_PATH,
  BITGET_USDT_FUTURES_CONTRACTS_PATH,
  buildCryptoFuturesPositionTierCaptureManifestV1,
  captureBitgetPositionTierSnapshotForSymbolV1,
  captureBitgetUsdtFuturesPositionTierUniverseV1,
  discoverBitgetUsdtFuturesSymbolsV1,
} from "../src/crypto-futures-position-tier-snapshot-capture-v1.js";

const BASE_TIME = Date.UTC(2026, 7, 27, 1, 0, 0, 0);

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function contract(symbol, overrides = {}) {
  return {
    symbol,
    quoteCoin: "USDT",
    symbolType: "perpetual",
    symbolStatus: "normal",
    ...overrides,
  };
}

function tierRows(multiplier = 1) {
  return [
    { tier: "1", minTierValue: "0", maxTierValue: String(100_000 * multiplier), leverage: "125", mmr: "0.004" },
    { tier: "2", minTierValue: String(100_000 * multiplier), maxTierValue: String(300_000 * multiplier), leverage: "100", mmr: "0.005" },
  ];
}

function makeFetch({ contracts, tiersBySymbol, requestTimeBySymbol = {}, statusBySymbol = {} }) {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === BITGET_USDT_FUTURES_CONTRACTS_PATH) {
      return response({ code: "00000", msg: "success", requestTime: BASE_TIME, data: contracts });
    }
    if (parsed.pathname === BITGET_POSITION_TIER_PATH) {
      const symbol = parsed.searchParams.get("symbol");
      if (statusBySymbol[symbol]) return response({ code: "50000", data: [] }, statusBySymbol[symbol]);
      const rows = tiersBySymbol[symbol];
      if (!rows) return response({ code: "40017", msg: "Parameter verification failed", data: [] });
      return response({
        code: "00000",
        msg: "success",
        requestTime: requestTimeBySymbol[symbol] ?? BASE_TIME,
        data: rows,
      });
    }
    throw new Error(`UNEXPECTED_URL:${url}`);
  };
}

test("discovers only normal perpetual USDT futures and sorts symbols", async () => {
  const fetchFn = makeFetch({
    contracts: [
      contract("ETHUSDT"),
      contract("BTCUSDT"),
      contract("OFFUSDT", { symbolStatus: "off" }),
      contract("DELIVERYUSDT", { symbolType: "delivery" }),
      contract("BTCUSD", { quoteCoin: "USD" }),
    ],
    tiersBySymbol: {},
  });
  const symbols = await discoverBitgetUsdtFuturesSymbolsV1({ fetchFn });
  assert.deepEqual(symbols, ["BTCUSDT", "ETHUSDT"]);
  assert.ok(Object.isFrozen(symbols));
});

test("rejects duplicate active symbols instead of silently deduplicating provider data", async () => {
  const fetchFn = makeFetch({
    contracts: [contract("BTCUSDT"), contract("BTCUSDT")],
    tiersBySymbol: {},
  });
  await assert.rejects(
    discoverBitgetUsdtFuturesSymbolsV1({ fetchFn }),
    /POSITION_TIER_CAPTURE_DUPLICATE_SYMBOL:BTCUSDT/u,
  );
});

test("fails closed when the active futures universe exceeds the configured bound", async () => {
  const fetchFn = makeFetch({
    contracts: [contract("BTCUSDT"), contract("ETHUSDT")],
    tiersBySymbol: {},
  });
  await assert.rejects(
    discoverBitgetUsdtFuturesSymbolsV1({ fetchFn, maxSymbols: 1 }),
    /POSITION_TIER_CAPTURE_UNIVERSE_CAP_EXCEEDED:2>1/u,
  );
});

test("captures one symbol through the canonical prospective provenance builder", async () => {
  const fetchFn = makeFetch({
    contracts: [],
    tiersBySymbol: { BTCUSDT: tierRows() },
    requestTimeBySymbol: { BTCUSDT: BASE_TIME },
  });
  const snapshot = await captureBitgetPositionTierSnapshotForSymbolV1({
    symbol: "btcusdt",
    fetchFn,
    nowFn: () => BASE_TIME + 1_000,
  });
  assert.equal(snapshot.symbol, "BTCUSDT");
  assert.equal(snapshot.observedAt, BASE_TIME);
  assert.equal(snapshot.capturedAt, BASE_TIME + 1_000);
  assert.equal(snapshot.evidenceType, "BITGET_PUBLIC_POSITION_TIER_SNAPSHOT");
  assert.equal(snapshot.publicDataOnly, true);
  assert.equal(snapshot.executionAuthority, "NONE");
  assert.match(snapshot.evidenceDigest, /^[0-9a-f]{64}$/u);
});

test("provider timestamps in the future are rejected and never converted into historical evidence", async () => {
  const fetchFn = makeFetch({
    contracts: [],
    tiersBySymbol: { BTCUSDT: tierRows() },
    requestTimeBySymbol: { BTCUSDT: BASE_TIME + 60_000 },
  });
  await assert.rejects(
    captureBitgetPositionTierSnapshotForSymbolV1({
      symbol: "BTCUSDT",
      fetchFn,
      nowFn: () => BASE_TIME,
    }),
    /POSITION_TIER_HISTORY_SNAPSHOT_FUTURE_PROVIDER_TIME/u,
  );
});

test("complete public universe capture produces exact-time evidence but never unlocks continuous history", async () => {
  let clock = BASE_TIME;
  const fetchFn = makeFetch({
    contracts: [contract("ETHUSDT"), contract("BTCUSDT")],
    tiersBySymbol: {
      BTCUSDT: tierRows(1),
      ETHUSDT: tierRows(2),
    },
    requestTimeBySymbol: {
      BTCUSDT: BASE_TIME,
      ETHUSDT: BASE_TIME,
    },
  });
  const manifest = await captureBitgetUsdtFuturesPositionTierUniverseV1({
    fetchFn,
    nowFn: () => {
      clock += 1_000;
      return clock;
    },
    requestDelayMs: 0,
    maxAttempts: 1,
  });
  assert.deepEqual(manifest.universeSymbols, ["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(manifest.snapshots.map((item) => item.symbol), ["BTCUSDT", "ETHUSDT"]);
  assert.equal(manifest.requestedSymbolCount, 2);
  assert.equal(manifest.capturedSymbolCount, 2);
  assert.equal(manifest.failedSymbolCount, 0);
  assert.equal(manifest.completeUniverseCapture, true);
  assert.equal(manifest.historicalCoverageMode, "EXACT_EVIDENCE_TIMESTAMPS_ONLY");
  assert.equal(manifest.continuousHistoricalCoverage, false);
  assert.equal(manifest.formulaTournamentUnblocked, false);
  assert.equal(manifest.profitabilityClaimAllowed, false);
  assert.equal(manifest.finalHoldoutAccessAllowed, false);
  assert.equal(manifest.privateAccountDataUsed, false);
  assert.equal(manifest.executionAuthority, "NONE");
  assert.match(manifest.manifestDigest, /^[0-9a-f]{64}$/u);
});

test("a missed symbol makes the universe capture incomplete and no fake snapshot is inserted", async () => {
  let clock = BASE_TIME;
  const fetchFn = makeFetch({
    contracts: [contract("BTCUSDT"), contract("ETHUSDT")],
    tiersBySymbol: { BTCUSDT: tierRows(1) },
  });
  const manifest = await captureBitgetUsdtFuturesPositionTierUniverseV1({
    fetchFn,
    nowFn: () => {
      clock += 1_000;
      return clock;
    },
    requestDelayMs: 0,
    maxAttempts: 1,
  });
  assert.equal(manifest.completeUniverseCapture, false);
  assert.equal(manifest.capturedSymbolCount, 1);
  assert.equal(manifest.failedSymbolCount, 1);
  assert.deepEqual(manifest.snapshots.map((item) => item.symbol), ["BTCUSDT"]);
  assert.equal(manifest.failures[0].symbol, "ETHUSDT");
  assert.match(manifest.failures[0].error, /POSITION_TIER_CAPTURE_TIER_PROVIDER_ERROR/u);
  assert.equal(manifest.formulaTournamentUnblocked, false);
});

test("manifest requires exactly one result per discovered symbol", () => {
  assert.throws(
    () => buildCryptoFuturesPositionTierCaptureManifestV1({
      startedAt: BASE_TIME,
      completedAt: BASE_TIME + 1,
      universeSymbols: ["BTCUSDT"],
      snapshots: [],
      failures: [],
    }),
    /POSITION_TIER_CAPTURE_MANIFEST_MISSING_RESULT/u,
  );
});
