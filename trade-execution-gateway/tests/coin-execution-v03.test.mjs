import assert from "node:assert/strict";
import test from "node:test";
import {
  PaperMockBrokerAdapter,
  TradeExecutionGateway,
} from "../src/gateway.mjs";
import {
  BitgetDisabledBrokerAdapter,
  UpbitDisabledBrokerAdapter,
} from "../src/disabled-broker-adapters.mjs";
import {
  coinOrderToPaperIntent,
  placeCoinPaperOrder,
  previewCoinPaperOrder,
} from "../src/coin-bridge.mjs";
import { validateMarketRuleEvidence } from "../src/market-rules.mjs";
import { evaluatePortfolioRisk } from "../src/portfolio-risk.mjs";
import { reconcileOrderEvidence } from "../src/reconciliation.mjs";

const NOW = Date.parse("2026-08-24T10:20:00.000Z");

function gatewayPolicy() {
  return {
    maxQuantityByMarket: { CRYPTO_SPOT: 100, CRYPTO_FUTURES: 100 },
    maxNotionalByMarket: { CRYPTO_SPOT: 100_000, CRYPTO_FUTURES: 100_000 },
  };
}

function spotPayload(overrides = {}) {
  return {
    provider: "upbit",
    order: {
      market: "CRYPTO_SPOT",
      symbol: "KRW-BTC",
      side: "BUY",
      orderType: "LIMIT",
      quantity: 0.01,
      price: 100,
    },
    idempotencyKey: "coin-order-0001",
    marketRules: {
      market: "CRYPTO_SPOT",
      provider: "upbit",
      source: "PUBLIC_MARKET_RULES",
      observedAt: "2026-08-24T10:19:50.000Z",
      tickSize: 0.1,
      lotSize: 0.001,
      minNotional: 1,
    },
    portfolioSnapshot: {
      mode: "PAPER_EVIDENCE",
      observedAt: "2026-08-24T10:19:50.000Z",
      grossExposure: 0,
      marketExposureByMarket: { CRYPTO_SPOT: 0 },
      openOrders: 0,
      dailyPnl: 0,
    },
    portfolioPolicy: {
      maxGrossExposure: 100_000,
      maxMarketExposureByMarket: { CRYPTO_SPOT: 50_000 },
      maxOpenOrders: 10,
      maxDailyLoss: 10_000,
    },
    killSwitch: { authority: "PAPER_CONTROL_PLANE", engaged: false },
    ...overrides,
  };
}

function futuresPayload(overrides = {}) {
  return {
    provider: "bitget",
    order: {
      market: "CRYPTO_FUTURES",
      symbol: "BTCUSDT",
      side: "LONG",
      orderType: "LIMIT",
      quantity: 1,
      price: 100,
    },
    leverage: 2,
    marginMode: "ISOLATED",
    reduceOnly: false,
    idempotencyKey: "coin-futures-0001",
    marketRules: {
      market: "CRYPTO_FUTURES",
      provider: "bitget",
      source: "PUBLIC_MARKET_RULES",
      observedAt: "2026-08-24T10:19:50.000Z",
      tickSize: 0.1,
      lotSize: 0.001,
      minNotional: 5,
      maxLeverage: 3,
    },
    portfolioSnapshot: {
      mode: "PAPER_EVIDENCE",
      observedAt: "2026-08-24T10:19:50.000Z",
      grossExposure: 0,
      marketExposureByMarket: { CRYPTO_FUTURES: 0 },
      openOrders: 0,
      dailyPnl: 0,
    },
    portfolioPolicy: {
      maxGrossExposure: 100_000,
      maxMarketExposureByMarket: { CRYPTO_FUTURES: 50_000 },
      maxOpenOrders: 10,
      maxDailyLoss: 10_000,
      maxLeverageByMarket: { CRYPTO_FUTURES: 3 },
    },
    killSwitch: { authority: "PAPER_CONTROL_PLANE", engaged: false },
    ...overrides,
  };
}

test("Upbit spot and Bitget futures canonical providers are fixed without live authority", () => {
  const spot = coinOrderToPaperIntent(spotPayload());
  const futures = coinOrderToPaperIntent(futuresPayload());
  assert.equal(spot.provider, "upbit");
  assert.equal(spot.leverage, 1);
  assert.equal(futures.provider, "bitget");
  assert.equal(futures.leverage, 2);
  assert.equal(futures.marginMode, "ISOLATED");

  for (const adapter of [new UpbitDisabledBrokerAdapter(), new BitgetDisabledBrokerAdapter()]) {
    const capabilities = adapter.getCapabilities();
    assert.equal(capabilities.executionMode, "DISABLED");
    assert.equal(capabilities.privateTradingApiAllowed, false);
    assert.equal(capabilities.outboundNetwork, false);
    assert.throws(
      () => new TradeExecutionGateway({ adapter, policy: gatewayPolicy() }),
      (error) => error.code === "UNSAFE_ADAPTER_REJECTED",
    );
  }
});

test("wrong crypto provider never falls back", () => {
  assert.throws(
    () => coinOrderToPaperIntent(spotPayload({ provider: "bitget" })),
    (error) => error.code === "CANONICAL_PROVIDER_MISMATCH",
  );
});

test("market rules reject stale, misaligned, and excessive leverage evidence", () => {
  const spot = coinOrderToPaperIntent(spotPayload());
  assert.throws(
    () => validateMarketRuleEvidence(
      spot,
      { ...spotPayload().marketRules, observedAt: "2026-08-24T10:00:00.000Z" },
      { nowMs: NOW },
    ),
    (error) => error.code === "MARKET_RULE_EVIDENCE_STALE",
  );
  assert.throws(
    () => validateMarketRuleEvidence(
      { ...spot, limitPrice: 100.05 },
      spotPayload().marketRules,
      { nowMs: NOW },
    ),
    (error) => error.code === "PRICE_TICK_MISALIGNED",
  );

  const futures = coinOrderToPaperIntent(futuresPayload({ leverage: 4 }));
  assert.throws(
    () => validateMarketRuleEvidence(futures, futuresPayload().marketRules, { nowMs: NOW }),
    (error) => error.code === "MAX_LEVERAGE_EXCEEDED",
  );
});

test("portfolio guard enforces explicit kill switch, daily loss, exposure, and leverage", () => {
  const intent = coinOrderToPaperIntent(futuresPayload());
  const args = {
    intent,
    orderNotional: 100,
    snapshot: futuresPayload().portfolioSnapshot,
    policy: futuresPayload().portfolioPolicy,
    killSwitch: futuresPayload().killSwitch,
  };
  const accepted = evaluatePortfolioRisk(args, { nowMs: NOW });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.liveAuthorityGranted, false);

  assert.throws(
    () => evaluatePortfolioRisk(
      { ...args, killSwitch: { authority: "PAPER_CONTROL_PLANE", engaged: true } },
      { nowMs: NOW },
    ),
    (error) => error.code === "KILL_SWITCH_ENGAGED",
  );
  assert.throws(
    () => evaluatePortfolioRisk(
      {
        ...args,
        snapshot: { ...args.snapshot, dailyPnl: -10_000 },
      },
      { nowMs: NOW },
    ),
    (error) => error.code === "DAILY_LOSS_GUARD_BLOCKED",
  );
});

test("coin preview performs full preflight without even paper submission", async () => {
  const adapter = new PaperMockBrokerAdapter();
  const gateway = new TradeExecutionGateway({ adapter, policy: gatewayPolicy() });
  const result = await previewCoinPaperOrder(gateway, spotPayload(), { nowMs: NOW });
  assert.equal(result.accepted, true);
  assert.equal(result.marketRules.accepted, true);
  assert.equal(result.portfolioRisk.accepted, true);
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.realOrderSubmitted, false);
  assert.equal(adapter.submissionCount, 0);
});

test("coin paper placement requires explicit confirmation and stays simulated", async () => {
  const adapter = new PaperMockBrokerAdapter();
  const gateway = new TradeExecutionGateway({ adapter, policy: gatewayPolicy() });

  await assert.rejects(
    placeCoinPaperOrder(gateway, spotPayload(), { nowMs: NOW }),
    (error) => error.code === "PAPER_CONFIRMATION_REQUIRED",
  );
  assert.equal(adapter.submissionCount, 0);

  const result = await placeCoinPaperOrder(
    gateway,
    { ...spotPayload(), confirmPaper: true },
    { nowMs: NOW },
  );
  assert.equal(result.simulated, true);
  assert.equal(result.realOrderSubmitted, false);
  assert.equal(result.privateTradingRequestSent, false);
  assert.equal(adapter.submissionCount, 1);
});

test("generic futures intent is no longer leverage-blind", async () => {
  const gateway = new TradeExecutionGateway({ policy: gatewayPolicy() });
  await assert.rejects(
    gateway.previewOrder({
      mode: "PAPER",
      market: "CRYPTO_FUTURES",
      symbol: "BTCUSDT",
      side: "LONG",
      orderType: "LIMIT",
      quantity: 1,
      limitPrice: 100,
      idempotencyKey: "futures-no-lev-001",
    }),
    (error) => error.code === "FUTURES_LEVERAGE_REQUIRED",
  );
});

test("reconciliation reports missing and missing-fill evidence without mutation", () => {
  const missing = reconcileOrderEvidence({
    provider: "upbit",
    observedAt: "2026-08-24T10:20:00.000Z",
    omsOrder: { orderId: "teg-1", brokerOrderId: "paper-1", status: "ACCEPTED" },
    brokerOrder: null,
  });
  assert.equal(missing.reconciled, false);
  assert.deepEqual(missing.blockers, ["BROKER_ORDER_EVIDENCE_REQUIRED"]);

  const mismatch = reconcileOrderEvidence({
    provider: "bitget",
    observedAt: "2026-08-24T10:20:00.000Z",
    omsOrder: { orderId: "teg-2", brokerOrderId: "paper-2", status: "FILLED" },
    brokerOrder: { brokerOrderId: "paper-2", status: "FILLED", fillEvidence: null },
  });
  assert.equal(mismatch.reconciled, false);
  assert.deepEqual(mismatch.blockers, ["FILL_EVIDENCE_REQUIRED"]);
  assert.equal(mismatch.mutatesOms, false);
  assert.equal(mismatch.brokerNetworkRead, false);
});
