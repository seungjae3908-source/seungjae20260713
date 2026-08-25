import assert from "node:assert/strict";
import test from "node:test";
import { CapitalManagedPaperGateway } from "../src/capital-managed-paper-gateway.mjs";
import { coinOrderToPaperIntent } from "../src/coin-bridge.mjs";
import { PaperMockBrokerAdapter, TradeExecutionGateway } from "../src/gateway.mjs";
import {
  KRW_VALUATION_V11_CONTRACT,
  normalizeCapitalValuationEvidence,
  valueForeignQuoteNotionalKrw,
} from "../src/krw-valuation-evidence-v11.mjs";
import { PaperCompoundingCapitalManager } from "../src/paper-capital-manager.mjs";
import { SupervisedPaperGateway } from "../src/supervised-paper-gateway.mjs";
import { workspaceOrderToPaperIntent } from "../src/workspace-bridge.mjs";

function riskPolicy() {
  return {
    maxQuantityByMarket: {
      KR_STOCK: 10_000,
      US_STOCK: 10_000,
      CRYPTO_SPOT: 10_000,
      CRYPTO_FUTURES: 10_000,
    },
    maxNotionalByMarket: {
      KR_STOCK: 100_000_000,
      US_STOCK: 100_000_000,
      CRYPTO_SPOT: 100_000_000,
      CRYPTO_FUTURES: 100_000_000,
    },
  };
}

function build() {
  const adapter = new PaperMockBrokerAdapter();
  const base = new TradeExecutionGateway({ adapter, policy: riskPolicy() });
  const supervised = new SupervisedPaperGateway({
    gateway: base,
    supervisionPolicy: { enforceNewEntryGate: false },
  });
  const capitalManager = new PaperCompoundingCapitalManager({ admissionGateEnabled: true });
  const gateway = new CapitalManagedPaperGateway({ gateway: supervised, capitalManager });
  return { gateway, adapter, base };
}

function settlement(sequence = 1, equity = 1_000_000) {
  return {
    mode: "PAPER",
    settled: true,
    simulated: true,
    source: "PAPER_SETTLEMENT_ENGINE",
    settlementId: `v11-settlement-${sequence}`,
    sequence,
    settledAccountEquityKrw: equity,
    observedAt: new Date(Date.now() - 60_000 + sequence * 1_000).toISOString(),
    privateApiUsed: false,
    realAccountMutation: false,
    externalWithdrawalPerformed: false,
    positionsFlat: true,
    openOrderCount: 0,
    managedExposureKrw: 0,
  };
}

function valuation(market, symbol, quoteCurrency, krwPerQuote = 1_400, overrides = {}) {
  return {
    schemaVersion: 1,
    source: "CALLER_SUPPLIED_PUBLIC_REFERENCE",
    evidenceId: `fx-${market.toLowerCase()}-${symbol.toLowerCase().replace(/[^a-z0-9]/g, "-")}-001`,
    market,
    symbol,
    quoteCurrency,
    valuationCurrency: "KRW",
    krwPerQuote,
    observedAt: new Date(Date.now() - 1_000).toISOString(),
    publicData: true,
    privateApiUsed: false,
    realAccountData: false,
    executionAuthority: "NONE",
    ...overrides,
  };
}

function usBuy(key, price = 200, evidence = valuation("US_STOCK", "AAPL", "USD")) {
  return {
    mode: "PAPER",
    market: "US_STOCK",
    symbol: "AAPL",
    side: "BUY",
    orderType: "LIMIT",
    quantity: 1,
    limitPrice: price,
    capitalValuationEvidence: evidence,
    idempotencyKey: key,
  };
}

function futuresLong(key, evidence = valuation("CRYPTO_FUTURES", "BTCUSDT", "USDT")) {
  return {
    mode: "PAPER",
    market: "CRYPTO_FUTURES",
    provider: "bitget",
    symbol: "BTCUSDT",
    side: "LONG",
    orderType: "LIMIT",
    quantity: 0.01,
    limitPrice: 50_000,
    leverage: 2,
    marginMode: "ISOLATED",
    reduceOnly: false,
    capitalValuationEvidence: evidence,
    idempotencyKey: key,
  };
}

test("v1.1 contract remains public-reference Paper-only with zero execution authority", () => {
  assert.equal(KRW_VALUATION_V11_CONTRACT.source, "CALLER_SUPPLIED_PUBLIC_REFERENCE");
  assert.deepEqual(KRW_VALUATION_V11_CONTRACT.supportedForeignMarkets, ["US_STOCK", "CRYPTO_FUTURES"]);
  assert.equal(KRW_VALUATION_V11_CONTRACT.privateProviderRequestPerformed, false);
  assert.equal(KRW_VALUATION_V11_CONTRACT.realAccountReadPerformed, false);
  assert.equal(KRW_VALUATION_V11_CONTRACT.executionAuthority, "NONE");
  assert.equal(KRW_VALUATION_V11_CONTRACT.liveActivationAllowed, false);
});

test("USD and USDT quote notionals convert to conservative integer KRW", () => {
  const nowMs = Date.now();
  const usd = valueForeignQuoteNotionalKrw({
    intent: { market: "US_STOCK", symbol: "AAPL" },
    quoteNotional: 200.01,
    evidence: valuation("US_STOCK", "AAPL", "USD", 1_400, { observedAt: new Date(nowMs - 1_000).toISOString() }),
    nowMs,
  });
  assert.equal(usd.krwNotional, 280_014);

  const usdt = valueForeignQuoteNotionalKrw({
    intent: { market: "CRYPTO_FUTURES", symbol: "BTCUSDT" },
    quoteNotional: 500,
    evidence: valuation("CRYPTO_FUTURES", "BTCUSDT", "USDT", 1_400, { observedAt: new Date(nowMs - 1_000).toISOString() }),
    nowMs,
  });
  assert.equal(usdt.krwNotional, 700_000);
});

test("missing, stale, and future valuation evidence fail closed", () => {
  const intent = { market: "US_STOCK", symbol: "AAPL" };
  assert.throws(
    () => valueForeignQuoteNotionalKrw({ intent, quoteNotional: 1, evidence: null }),
    (error) => error.code === "CAPITAL_KRW_VALUATION_REQUIRED",
  );
  assert.throws(
    () => normalizeCapitalValuationEvidence(
      valuation("US_STOCK", "AAPL", "USD", 1_400, { observedAt: new Date(Date.now() - 301_000).toISOString() }),
      intent,
    ),
    (error) => error.code === "CAPITAL_KRW_VALUATION_STALE",
  );
  assert.throws(
    () => normalizeCapitalValuationEvidence(
      valuation("US_STOCK", "AAPL", "USD", 1_400, { observedAt: new Date(Date.now() + 60_000).toISOString() }),
      intent,
    ),
    (error) => error.code === "CAPITAL_KRW_VALUATION_FROM_FUTURE",
  );
});

test("zero or negative FX rates fail closed", () => {
  const intent = { market: "US_STOCK", symbol: "AAPL" };
  for (const rate of [0, -1]) {
    assert.throws(
      () => normalizeCapitalValuationEvidence(valuation("US_STOCK", "AAPL", "USD", rate), intent),
      (error) => error.code === "CAPITAL_KRW_VALUATION_RATE_INVALID",
    );
  }
});

test("market, symbol, quote currency, and valuation currency mismatches fail closed", () => {
  const intent = { market: "US_STOCK", symbol: "AAPL" };
  const cases = [
    [valuation("CRYPTO_FUTURES", "AAPL", "USDT"), "CAPITAL_KRW_VALUATION_MARKET_MISMATCH"],
    [valuation("US_STOCK", "MSFT", "USD"), "CAPITAL_KRW_VALUATION_SYMBOL_MISMATCH"],
    [valuation("US_STOCK", "AAPL", "USDT"), "CAPITAL_KRW_VALUATION_QUOTE_CURRENCY_MISMATCH"],
    [valuation("US_STOCK", "AAPL", "USD", 1_400, { valuationCurrency: "USD" }), "CAPITAL_KRW_VALUATION_CURRENCY_MISMATCH"],
  ];
  for (const [evidence, code] of cases) {
    assert.throws(() => normalizeCapitalValuationEvidence(evidence, intent), (error) => error.code === code);
  }
});

test("private/live/order authority claims in valuation evidence are rejected", () => {
  const intent = { market: "US_STOCK", symbol: "AAPL" };
  for (const unsafe of [
    { privateApiUsed: true },
    { realAccountData: true },
    { privateProviderRequestPerformed: true },
    { realAccountReadPerformed: true },
    { realOrderSubmitted: true },
    { liveTrading: true },
    { autoTrading: true },
    { executionAuthority: "LIVE" },
  ]) {
    assert.throws(
      () => normalizeCapitalValuationEvidence(valuation("US_STOCK", "AAPL", "USD", 1_400, unsafe), intent),
      (error) => error.code === "CAPITAL_KRW_VALUATION_UNSAFE_EVIDENCE",
    );
  }
});

test("US stock capital admission converts USD notional to KRW before submission", async () => {
  const { gateway, adapter } = build();
  await gateway.applyCapitalSettlement(settlement());
  const placed = await gateway.placeOrder(usBuy("v11-us-aapl-200"));
  assert.equal(placed.capitalAdmission.requestedNewExposureKrw, 280_000);
  assert.equal(adapter.submissionCount, 1);
  assert.equal(gateway.getCapitalHealth().currentCommittedExposureKrw, 280_000);
});

test("Bitget futures capital admission converts USDT notional to KRW", async () => {
  const { gateway, adapter } = build();
  await gateway.applyCapitalSettlement(settlement());
  const placed = await gateway.placeOrder(futuresLong("v11-futures-btc"));
  assert.equal(placed.capitalAdmission.requestedNewExposureKrw, 700_000);
  assert.equal(adapter.submissionCount, 1);
  assert.equal(gateway.getCapitalHealth().currentCommittedExposureKrw, 700_000);
});

test("aggregate converted foreign exposure shares the same KRW compounding ceiling", async () => {
  const { gateway, adapter } = build();
  await gateway.applyCapitalSettlement(settlement());
  await gateway.placeOrder(usBuy("v11-aggregate-us"));
  await gateway.placeOrder(futuresLong("v11-aggregate-futures"));
  assert.equal(gateway.getCapitalHealth().currentCommittedExposureKrw, 980_000);
  await assert.rejects(
    gateway.placeOrder({
      mode: "PAPER",
      market: "KR_STOCK",
      symbol: "005930",
      side: "BUY",
      orderType: "LIMIT",
      quantity: 1,
      limitPrice: 20_001,
      idempotencyKey: "v11-aggregate-overflow",
    }),
    (error) => error.code === "COMPOUNDING_CAPITAL_LIMIT_EXCEEDED",
  );
  assert.equal(adapter.submissionCount, 2);
});

test("sanitized valuation evidence is persisted with the OMS order intent", async () => {
  const { gateway, base } = build();
  await gateway.applyCapitalSettlement(settlement());
  await gateway.placeOrder(usBuy("v11-persist-evidence"));
  const [order] = base.exportPaperState().orders;
  assert.equal(order.intent.capitalValuationEvidence.market, "US_STOCK");
  assert.equal(order.intent.capitalValuationEvidence.quoteCurrency, "USD");
  assert.equal(order.intent.capitalValuationEvidence.privateApiUsed, false);
  assert.equal(order.intent.capitalValuationEvidence.executionAuthority, "NONE");
});

test("stale persisted foreign valuation blocks additional exposure and reports zero availability", async () => {
  const { gateway } = build();
  await gateway.applyCapitalSettlement(settlement());
  const evidence = valuation("US_STOCK", "AAPL", "USD");
  await gateway.placeOrder(usBuy("v11-stale-existing", 200, evidence));
  const staleNow = Date.parse(evidence.observedAt) + KRW_VALUATION_V11_CONTRACT.maxEvidenceAgeMs + 1;
  const health = gateway.getCapitalHealth(staleNow);
  assert.equal(health.currentCommittedExposureKrw, 0);
  assert.equal(health.availableNewExposureKrw, 0);
  assert.equal(health.valuationBlockers.length, 1);
  assert.match(health.valuationBlockers[0], /^CAPITAL_KRW_VALUATION_STALE:/);
});

test("stock and coin workspace bridges preserve caller-supplied valuation evidence", () => {
  const stockEvidence = valuation("US_STOCK", "AAPL", "USD");
  const stockIntent = workspaceOrderToPaperIntent({
    order: { market: "US", ticker: "AAPL", side: "buy", orderType: "limit", quantity: 1, price: 200 },
    idempotencyKey: "v11-workspace-us",
    capitalValuationEvidence: stockEvidence,
  });
  assert.equal(stockIntent.capitalValuationEvidence, stockEvidence);

  const futuresEvidence = valuation("CRYPTO_FUTURES", "BTCUSDT", "USDT");
  const coinIntent = coinOrderToPaperIntent({
    provider: "bitget",
    order: { market: "CRYPTO_FUTURES", symbol: "BTCUSDT", side: "LONG", orderType: "LIMIT", quantity: 0.01, price: 50_000 },
    leverage: 2,
    marginMode: "ISOLATED",
    reduceOnly: false,
    idempotencyKey: "v11-coin-futures",
    capitalValuationEvidence: futuresEvidence,
  });
  assert.equal(coinIntent.capitalValuationEvidence, futuresEvidence);
});

test("existing KR stock and Upbit KRW spot direct valuation paths remain unchanged", async () => {
  const { gateway, adapter } = build();
  await gateway.applyCapitalSettlement(settlement());
  const kr = await gateway.placeOrder({
    mode: "PAPER",
    market: "KR_STOCK",
    symbol: "005930",
    side: "BUY",
    orderType: "LIMIT",
    quantity: 1,
    limitPrice: 100_000,
    idempotencyKey: "v11-direct-kr-stock",
  });
  assert.equal(kr.capitalAdmission.requestedNewExposureKrw, 100_000);

  const spot = await gateway.placeOrder({
    mode: "PAPER",
    market: "CRYPTO_SPOT",
    provider: "upbit",
    symbol: "KRW-BTC",
    side: "BUY",
    orderType: "LIMIT",
    quantity: 0.001,
    limitPrice: 100_000_000,
    idempotencyKey: "v11-direct-upbit",
  });
  assert.equal(spot.capitalAdmission.requestedNewExposureKrw, 100_000);
  assert.equal(adapter.submissionCount, 2);
});

test("foreign new exposure without valuation remains fail-closed and reduce-only futures stays exempt", async () => {
  const { gateway, adapter } = build();
  await gateway.applyCapitalSettlement(settlement());
  await assert.rejects(
    gateway.placeOrder(usBuy("v11-missing-evidence", 200, null)),
    (error) => error.code === "CAPITAL_KRW_VALUATION_REQUIRED",
  );
  const exit = await gateway.placeOrder({
    mode: "PAPER",
    market: "CRYPTO_FUTURES",
    provider: "bitget",
    symbol: "BTCUSDT",
    side: "SHORT",
    orderType: "LIMIT",
    quantity: 0.01,
    limitPrice: 50_000,
    leverage: 2,
    marginMode: "ISOLATED",
    reduceOnly: true,
    idempotencyKey: "v11-reduce-only-exit",
  });
  assert.equal(exit.capitalAdmission.reductionOrderExempt, true);
  assert.equal(adapter.submissionCount, 1);
});
