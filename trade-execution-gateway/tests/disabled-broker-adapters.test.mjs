import assert from "node:assert/strict";
import test from "node:test";
import {
  KisDisabledBrokerAdapter,
  KiwoomDisabledBrokerAdapter,
  TossDisabledBrokerAdapter,
} from "../src/disabled-broker-adapters.mjs";
import { TradeExecutionGateway } from "../src/gateway.mjs";

const adapters = [
  new TossDisabledBrokerAdapter(),
  new KisDisabledBrokerAdapter(),
  new KiwoomDisabledBrokerAdapter(),
];

test("all real-broker placeholders expose zero execution/network authority", () => {
  for (const adapter of adapters) {
    const capabilities = adapter.getCapabilities();
    assert.equal(capabilities.executionMode, "DISABLED");
    assert.equal(capabilities.liveTrading, false);
    assert.equal(capabilities.privateTradingApiAllowed, false);
    assert.equal(capabilities.outboundNetwork, false);
    assert.equal(capabilities.brokerCredentialsAccepted, false);
    assert.equal(capabilities.accountReadAllowed, false);
    assert.equal(capabilities.orderSubmissionAllowed, false);
    assert.equal(capabilities.cancelAllowed, false);
    assert.equal(capabilities.amendAllowed, false);
  }
});

test("disabled Toss/KIS/Kiwoom placeholders cannot be installed as gateway execution adapters", () => {
  for (const adapter of adapters) {
    assert.throws(
      () => new TradeExecutionGateway({ adapter, policy: {} }),
      (error) => error.code === "UNSAFE_ADAPTER_REJECTED",
    );
  }
});

test("disabled broker methods fail closed without accepting credentials or network work", async () => {
  for (const adapter of adapters) {
    await assert.rejects(adapter.previewOrder({}), (error) => error.code === "BROKER_ADAPTER_DISABLED");
    await assert.rejects(adapter.submitOrder({}), (error) => error.code === "BROKER_ADAPTER_DISABLED");
    await assert.rejects(adapter.cancelOrder("x"), (error) => error.code === "BROKER_ADAPTER_DISABLED");
    await assert.rejects(adapter.getOrder("x"), (error) => error.code === "BROKER_ADAPTER_DISABLED");
  }
});
