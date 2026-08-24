export const MARKETS = Object.freeze([
  "KR_STOCK",
  "US_STOCK",
  "CRYPTO_SPOT",
  "CRYPTO_FUTURES",
]);

export const ORDER_TYPES = Object.freeze(["LIMIT", "MARKET"]);
export const CASH_SIDES = Object.freeze(["BUY", "SELL"]);
export const FUTURES_SIDES = Object.freeze(["LONG", "SHORT"]);

export const ORDER_STATES = Object.freeze({
  CREATED: "CREATED",
  RISK_ACCEPTED: "RISK_ACCEPTED",
  SUBMITTED: "SUBMITTED",
  ACCEPTED: "ACCEPTED",
  PARTIALLY_FILLED: "PARTIALLY_FILLED",
  FILLED: "FILLED",
  CANCELED: "CANCELED",
  REJECTED: "REJECTED",
});

export const SAFETY_CONTRACT = Object.freeze({
  service: "trade-execution-gateway",
  version: "0.1.0",
  executionMode: "PAPER_ONLY",
  liveTrading: false,
  realOrderEnabled: false,
  privateTradingApiAllowed: false,
  accountReadAllowed: false,
  transferAllowed: false,
  withdrawalAllowed: false,
  productionIntegrated: false,
  persistence: "MEMORY_ONLY",
  outboundNetwork: false,
  defaultBind: "127.0.0.1:8792",
});

export function sidesForMarket(market) {
  return market === "CRYPTO_FUTURES" ? FUTURES_SIDES : CASH_SIDES;
}

export function publicContract() {
  return {
    safety: SAFETY_CONTRACT,
    markets: MARKETS,
    orderTypes: ORDER_TYPES,
    sides: {
      cash: CASH_SIDES,
      futures: FUTURES_SIDES,
    },
    states: ORDER_STATES,
    adapterContract: {
      requiredMethods: [
        "getCapabilities",
        "previewOrder",
        "submitOrder",
        "cancelOrder",
        "getOrder",
      ],
      liveAdapterAccepted: false,
      brokerCredentialsAccepted: false,
    },
  };
}
