import assert from "node:assert/strict";
import test from "node:test";
import { assessAttestedExecutionGuards } from "../src/execution-guards.mjs";
import { PublicMarketDataWebSocketRuntime } from "../src/public-websocket-runtime.mjs";

const NOW = Date.parse("2026-08-24T11:00:00.000Z");

class MockSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = new Map();
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  send(payload) { this.sent.push(payload); }
  close() { void this.emit("close", {}); }
  async emit(type, event) {
    for (const handler of this.listeners.get(type) ?? []) await handler(event);
  }
}

function factoryHarness() {
  const sockets = [];
  return {
    sockets,
    factory(url) {
      const socket = new MockSocket(url);
      sockets.push(socket);
      return socket;
    },
  };
}

function timers() {
  return { setTimeoutFn: () => 1, clearTimeoutFn: () => undefined };
}

function guardPolicy() {
  return {
    marketData: { maxQuoteAgeMs: 2_000, maxTradeAgeMs: 2_000, maxFutureSkewMs: 100, nowMs: NOW },
    maxSpreadBps: 100,
    maxPriceDeviationBps: 100,
    maxSlippageBps: 100,
    requireFullDepth: true,
  };
}

test("v0.5 Upbit public transport creates server-attested Paper-only evidence without credentials", async () => {
  const harness = factoryHarness();
  const runtime = new PublicMarketDataWebSocketRuntime({
    provider: "upbit",
    market: "CRYPTO_SPOT",
    symbol: "KRW-BTC",
    webSocketFactory: harness.factory,
    now: () => NOW,
    ...timers(),
  });
  runtime.start();
  const socket = harness.sockets[0];
  assert.equal(socket.url, "wss://api.upbit.com/websocket/v1");
  await socket.emit("open", {});
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].includes("private"), false);
  assert.equal(socket.sent[0].toLowerCase().includes("authorization"), false);

  await socket.emit("message", { data: JSON.stringify({
    type: "orderbook",
    code: "KRW-BTC",
    timestamp: NOW - 100,
    stream_type: "SNAPSHOT",
    orderbook_units: [
      { ask_price: 100.1, ask_size: 2, bid_price: 99.9, bid_size: 2 },
      { ask_price: 100.2, ask_size: 3, bid_price: 99.8, bid_size: 3 },
    ],
  }) });
  await socket.emit("message", { data: JSON.stringify({
    type: "trade",
    code: "KRW-BTC",
    timestamp: NOW - 80,
    trade_timestamp: NOW - 90,
    trade_price: 100,
    sequential_id: "1787569200000000",
    stream_type: "REALTIME",
  }) });

  const evidence = runtime.getLatestEvidence();
  assert.equal(evidence.serverAttested, true);
  assert.equal(evidence.transportObservedByGateway, true);
  assert.equal(evidence.callerSuppliedEvidence, false);
  assert.equal(evidence.liveExecutionEligible, false);
  assert.equal(evidence.privateApiUsed, false);
  assert.equal(evidence.transport.privateChannel, false);

  const guarded = assessAttestedExecutionGuards({
    intent: { market: "CRYPTO_SPOT", symbol: "KRW-BTC", side: "BUY", orderType: "MARKET", quantity: 1, referencePrice: 100 },
    evidence,
    policy: guardPolicy(),
  });
  assert.equal(guarded.state, "PASS");
  assert.equal(guarded.evidenceTrust, "GATEWAY_TRANSPORT_OBSERVED_PUBLIC");
  assert.equal(guarded.orderSubmissionAllowed, false);
  runtime.stop();
});

test("v0.5 Bitget first update accepts snapshot range then later seq/pseq gap requires resync", async () => {
  const harness = factoryHarness();
  const runtime = new PublicMarketDataWebSocketRuntime({
    provider: "bitget",
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    webSocketFactory: harness.factory,
    now: () => NOW,
    ...timers(),
  });
  runtime.start();
  const socket = harness.sockets[0];
  assert.equal(socket.url, "wss://ws.bitget.com/v2/ws/public");
  await socket.emit("open", {});
  await socket.emit("message", { data: JSON.stringify({
    action: "snapshot",
    arg: { instType: "usdt-futures", topic: "books", symbol: "BTCUSDT" },
    data: [{ a: [["100.1", "2"], ["100.2", "3"]], b: [["99.9", "2"], ["99.8", "3"]], pseq: "0", seq: "100", ts: String(NOW - 100) }],
    ts: NOW - 90,
  }) });
  await socket.emit("message", { data: JSON.stringify({
    action: "snapshot",
    arg: { instType: "usdt-futures", topic: "publicTrade", symbol: "BTCUSDT" },
    data: [{ p: "100", v: "0.1", S: "buy", T: String(NOW - 80), i: "trade-1" }],
    ts: NOW - 70,
  }) });
  assert.equal(runtime.getLatestEvidence()?.serverAttested, true);

  await socket.emit("message", { data: JSON.stringify({
    action: "update",
    arg: { instType: "usdt-futures", topic: "books", symbol: "BTCUSDT" },
    data: [{ a: [["100.1", "1.5"]], b: [], pseq: "99", seq: "101", ts: String(NOW - 60) }],
    ts: NOW - 50,
  }) });
  assert.equal(runtime.getLatestEvidence()?.serverAttested, true);

  await socket.emit("message", { data: JSON.stringify({
    action: "update",
    arg: { instType: "usdt-futures", topic: "books", symbol: "BTCUSDT" },
    data: [{ a: [["100.1", "1"]], b: [], pseq: "99", seq: "102", ts: String(NOW - 40) }],
    ts: NOW - 30,
  }) });
  assert.equal(runtime.getLatestEvidence(), null);
  assert.equal(runtime.getHealth().resyncRequired, true);
  assert.equal(runtime.getHealth().liveExecutionEligible, false);
  runtime.stop();
});

test("v0.5 clock skew and credential-bearing public runtime config fail closed", async () => {
  assert.throws(
    () => new PublicMarketDataWebSocketRuntime({ provider: "upbit", market: "CRYPTO_SPOT", symbol: "KRW-BTC", apiKey: "forbidden" }),
    (error) => error.code === "PUBLIC_RUNTIME_CREDENTIALS_REJECTED",
  );

  const harness = factoryHarness();
  const runtime = new PublicMarketDataWebSocketRuntime({
    provider: "upbit",
    market: "CRYPTO_SPOT",
    symbol: "KRW-BTC",
    webSocketFactory: harness.factory,
    now: () => NOW,
    healthPolicy: { maxClockSkewMs: 500 },
    ...timers(),
  });
  runtime.start();
  const socket = harness.sockets[0];
  await socket.emit("open", {});
  await socket.emit("message", { data: JSON.stringify({
    type: "orderbook",
    code: "KRW-BTC",
    timestamp: NOW - 10_000,
    stream_type: "SNAPSHOT",
    orderbook_units: [{ ask_price: 100.1, ask_size: 1, bid_price: 99.9, bid_size: 1 }],
  }) });
  assert.equal(runtime.getLatestEvidence(), null);
  assert.equal(runtime.getHealth().lastFailureCode, "PROVIDER_CLOCK_SKEW_EXCEEDED");
  runtime.stop();
});
