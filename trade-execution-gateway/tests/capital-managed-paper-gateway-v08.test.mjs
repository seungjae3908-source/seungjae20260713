import assert from "node:assert/strict";
import test from "node:test";
import { CapitalManagedPaperGateway } from "../src/capital-managed-paper-gateway.mjs";
import { PaperCompoundingCapitalManager } from "../src/paper-capital-manager.mjs";
import { PaperMockBrokerAdapter, TradeExecutionGateway } from "../src/gateway.mjs";
import { SupervisedPaperGateway } from "../src/supervised-paper-gateway.mjs";

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

function build({ capitalGateEnabled = true } = {}) {
  const adapter = new PaperMockBrokerAdapter();
  const base = new TradeExecutionGateway({ adapter, policy: riskPolicy() });
  const supervised = new SupervisedPaperGateway({
    gateway: base,
    supervisionPolicy: { enforceNewEntryGate: false },
  });
  const capitalManager = new PaperCompoundingCapitalManager({ admissionGateEnabled: capitalGateEnabled });
  const gateway = new CapitalManagedPaperGateway({ gateway: supervised, capitalManager });
  return { gateway, adapter, base, capitalManager };
}

function settlement(sequence, equity, overrides = {}) {
  const observedAt = new Date(Date.now() - 60_000 + sequence * 1_000).toISOString();
  return {
    mode: "PAPER",
    settled: true,
    simulated: true,
    source: "PAPER_SETTLEMENT_ENGINE",
    settlementId: `capital-gateway-settlement-${sequence}`,
    sequence,
    settledAccountEquityKrw: equity,
    observedAt,
    privateApiUsed: false,
    realAccountMutation: false,
    externalWithdrawalPerformed: false,
    positionsFlat: true,
    openOrderCount: 0,
    managedExposureKrw: 0,
    ...overrides,
  };
}

function krBuy(key, notionalKrw) {
  return {
    mode: "PAPER",
    market: "KR_STOCK",
    symbol: "005930",
    side: "BUY",
    orderType: "LIMIT",
    quantity: 1,
    limitPrice: notionalKrw,
    idempotencyKey: key,
  };
}

function krSell(key, notionalKrw) {
  return {
    ...krBuy(key, notionalKrw),
    side: "SELL",
  };
}

test("1,000,000 KRW capital gate blocks aggregate new exposure before second broker submission", async () => {
  const { gateway, adapter } = build();
  await gateway.applyCapitalSettlement(settlement(1, 1_000_000));

  const first = await gateway.placeOrder(krBuy("capital-order-700k", 700_000));
  assert.equal(first.capitalAdmission.currentManagedExposureKrw, 0);
  assert.equal(first.capitalAdmission.requestedNewExposureKrw, 700_000);
  assert.equal(adapter.submissionCount, 1);

  await assert.rejects(
    gateway.placeOrder(krBuy("capital-order-400k", 400_000)),
    (error) => error.code === "COMPOUNDING_CAPITAL_LIMIT_EXCEEDED",
  );
  assert.equal(adapter.submissionCount, 1);
  const health = gateway.getCapitalHealth();
  assert.equal(health.currentCommittedExposureKrw, 700_000);
  assert.equal(health.availableNewExposureKrw, 300_000);
});

test("entry admission is serialized so concurrent orders cannot oversubscribe capital", async () => {
  const { gateway, adapter } = build();
  await gateway.applyCapitalSettlement(settlement(1, 1_000_000));

  const results = await Promise.allSettled([
    gateway.placeOrder(krBuy("capital-concurrent-a", 600_000)),
    gateway.placeOrder(krBuy("capital-concurrent-b", 600_000)),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.equal(results.find((item) => item.status === "rejected").reason.code, "COMPOUNDING_CAPITAL_LIMIT_EXCEEDED");
  assert.equal(adapter.submissionCount, 1);
});

test("cash SELL reduction remains allowed even when capital is uninitialized or exhausted", async () => {
  const { gateway, adapter } = build();
  const exit = await gateway.placeOrder(krSell("capital-exit-before-init", 100_000));
  assert.equal(exit.capitalAdmission.reductionOrderExempt, true);
  assert.equal(adapter.submissionCount, 1);
});

test("drawdown contracts the actual entry ceiling while high watermark remains unchanged", async () => {
  const { gateway, adapter } = build();
  await gateway.applyCapitalSettlement(settlement(1, 600_000));
  await gateway.applyCapitalSettlement(settlement(2, 660_000));
  const drawdown = await gateway.applyCapitalSettlement(settlement(3, 630_000));

  assert.equal(drawdown.compoundBaseKrw, 630_000);
  assert.equal(drawdown.highWatermarkBaseKrw, 630_000);
  assert.equal(drawdown.profitReserveKrw, 30_000);
  assert.equal(drawdown.effectiveTradingCapitalKrw, 600_000);

  await gateway.placeOrder(krBuy("capital-drawdown-600k", 600_000));
  await assert.rejects(
    gateway.placeOrder(krBuy("capital-drawdown-plus-one", 1)),
    (error) => error.code === "COMPOUNDING_CAPITAL_LIMIT_EXCEEDED",
  );
  assert.equal(adapter.submissionCount, 1);
});

test("foreign-currency new exposure is fail-closed until authoritative KRW valuation exists", async () => {
  const { gateway, adapter } = build();
  await gateway.applyCapitalSettlement(settlement(1, 1_000_000));
  await assert.rejects(
    gateway.placeOrder({
      mode: "PAPER",
      market: "US_STOCK",
      symbol: "AAPL",
      side: "BUY",
      orderType: "LIMIT",
      quantity: 1,
      limitPrice: 200,
      idempotencyKey: "capital-usd-blocked",
    }),
    (error) => error.code === "CAPITAL_KRW_VALUATION_REQUIRED",
  );
  assert.equal(adapter.submissionCount, 0);
});

test("Upbit KRW spot exposure can use direct KRW notional without inventing FX", async () => {
  const { gateway, adapter } = build();
  await gateway.applyCapitalSettlement(settlement(1, 1_000_000));
  const placed = await gateway.placeOrder({
    mode: "PAPER",
    market: "CRYPTO_SPOT",
    provider: "upbit",
    symbol: "KRW-BTC",
    side: "BUY",
    orderType: "LIMIT",
    quantity: 0.001,
    limitPrice: 100_000_000,
    idempotencyKey: "capital-upbit-krw-spot",
  });
  assert.equal(placed.capitalAdmission.requestedNewExposureKrw, 100_000);
  assert.equal(adapter.submissionCount, 1);
});

test("flat capital settlement is blocked while exposure-increasing Paper order remains open", async () => {
  const { gateway } = build();
  await gateway.applyCapitalSettlement(settlement(1, 1_000_000));
  const placed = await gateway.placeOrder(krBuy("capital-open-before-settlement", 100_000));

  await assert.rejects(
    gateway.applyCapitalSettlement(settlement(2, 1_000_000)),
    (error) => error.code === "CAPITAL_SETTLEMENT_OPEN_ENTRY_ORDERS",
  );

  await gateway.cancelOrder(placed.orderId);
  const settled = await gateway.applyCapitalSettlement(settlement(2, 1_000_000));
  assert.equal(settled.settlementAuthority, "CALLER_SUPPLIED_SIMULATED_FLAT_EVIDENCE_ONLY");
});

test("filled entry exposure stays reserved until a fresh flat settlement releases it", async () => {
  const { gateway, adapter } = build();
  await gateway.applyCapitalSettlement(settlement(1, 1_000_000));

  const buy = await gateway.placeOrder(krBuy("capital-filled-entry", 700_000));
  await gateway.applyPaperFill(buy.orderId, {
    quantity: 1,
    price: 700_000,
    observedAt: new Date().toISOString(),
  });
  const sell = await gateway.placeOrder(krSell("capital-filled-exit", 700_000));
  await gateway.applyPaperFill(sell.orderId, {
    quantity: 1,
    price: 700_000,
    observedAt: new Date().toISOString(),
  });

  await assert.rejects(
    gateway.placeOrder(krBuy("capital-before-fresh-settlement", 400_000)),
    (error) => error.code === "COMPOUNDING_CAPITAL_LIMIT_EXCEEDED",
  );
  assert.equal(gateway.getCapitalHealth().currentCommittedExposureKrw, 700_000);

  await gateway.applyCapitalSettlement(settlement(2, 1_000_000));
  const fresh = await gateway.placeOrder(krBuy("capital-after-fresh-settlement", 1_000_000));
  assert.equal(fresh.capitalAdmission.currentManagedExposureKrw, 0);
  assert.equal(adapter.submissionCount, 4);
});

test("settlement route requires explicit flat simulated evidence", async () => {
  const { gateway } = build();
  await assert.rejects(
    gateway.applyCapitalSettlement(settlement(1, 1_000_000, { positionsFlat: false })),
    (error) => error.code === "CAPITAL_SETTLEMENT_FLAT_EVIDENCE_REQUIRED",
  );
  await assert.rejects(
    gateway.applyCapitalSettlement(settlement(1, 1_000_000, { openOrderCount: 1 })),
    (error) => error.code === "CAPITAL_SETTLEMENT_FLAT_EVIDENCE_REQUIRED",
  );
});

test("disabled capital gate stays Paper-only and never grants live authority", async () => {
  const { gateway } = build({ capitalGateEnabled: false });
  const preview = await gateway.previewOrder(krBuy("capital-disabled-preview", 10_000));
  assert.equal(preview.capitalAdmission.gateEnabled, false);
  assert.equal(preview.capitalAdmission.executionAuthority, "NONE");
  assert.equal(preview.capitalAdmission.liveAuthorityGranted, false);
});
