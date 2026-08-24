export const MARKETS = Object.freeze(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
export const ORDER_TYPES = Object.freeze(["LIMIT", "MARKET"]);
export const CASH_SIDES = Object.freeze(["BUY", "SELL"]);
export const FUTURES_SIDES = Object.freeze(["LONG", "SHORT"]);
export const FUTURES_MARGIN_MODES = Object.freeze(["ISOLATED", "CROSS"]);

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
  version: "0.5.0",
  executionMode: "PAPER_ONLY",
  liveTrading: false,
  realOrderEnabled: false,
  privateTradingApiAllowed: false,
  accountReadAllowed: false,
  transferAllowed: false,
  withdrawalAllowed: false,
  productionIntegrated: false,
  persistence: "LOCAL_FILE_PAPER_ONLY",
  productionDatabaseUsed: false,
  outboundNetwork: false,
  outboundNetworkScope: "ORDER_EXECUTION_AND_DEFAULT_RUNTIME",
  executionOutboundNetwork: false,
  privateTradingOutboundNetwork: false,
  publicMarketDataOutboundCapable: true,
  publicMarketDataOutboundDefault: false,
  publicMarketDataOutboundRequiresExplicitEnable: true,
  publicMarketDataCredentialsAccepted: false,
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
    sides: { cash: CASH_SIDES, futures: FUTURES_SIDES },
    futuresMarginModes: FUTURES_MARGIN_MODES,
    adapterContract: {
      requiredMethods: ["getCapabilities", "previewOrder", "submitOrder", "cancelOrder", "getOrder"],
      liveAdapterAccepted: false,
      brokerCredentialsAccepted: false,
    },
    workspaceBridge: {
      source: "AI_TRADING_WORKSPACE_V1",
      sourcePr: 88,
      supportedMarkets: ["KR", "US"],
      previewEndpoint: "/v1/workspace/orders/preview",
      paperEndpoint: "/v1/workspace/paper/orders",
      explicitPaperConfirmationRequired: true,
      marketReferencePriceRequired: true,
      productionRouteMounted: false,
    },
    coinBridge: {
      source: "COIN_TRADING_WORKSPACE_V1",
      canonicalProviders: { CRYPTO_SPOT: "upbit", CRYPTO_FUTURES: "bitget" },
      previewEndpoint: "/v1/coin/orders/preview",
      paperEndpoint: "/v1/coin/paper/orders",
      explicitPaperConfirmationRequired: true,
      marketRuleEvidenceRequired: true,
      portfolioRiskEvidenceRequired: true,
      killSwitchStateRequired: true,
      privateProviderCalls: false,
      productionRouteMounted: false,
    },
    executionSafety: {
      version: "V0_5",
      callerSuppliedValidationEndpoint: "/v1/execution/market-data/validate",
      callerSuppliedGuardEndpoint: "/v1/execution/guards/preview",
      runtimeHealthEndpoint: "/v1/execution/runtime/health",
      runtimeAttestedGuardEndpoint: "/v1/execution/runtime/guards/preview",
      publicWebSocketProviders: ["upbit", "bitget"],
      publicWebSocketDefaultEnabled: false,
      hardCodedPublicEndpointsOnly: true,
      credentialsAccepted: false,
      serverAttestedMarketDataAvailableOnlyWhenRuntimeEnabled: true,
      liveExecutionEligibleMarketData: false,
      bitgetSequenceGapRecovery: true,
      upbitReconnectSnapshotRequired: true,
      clockSkewGuard: true,
      providerCircuitBreaker: true,
      guards: ["STALE_PRICE", "PRICE_DEVIATION", "SPREAD", "SLIPPAGE", "DEPTH"],
      paperFillEndpoint: "/v1/paper/orders/:orderId/fill",
      partialFillStateMachine: true,
      actualExchangeFillEvidence: false,
      plans: {
        cancelReplace: "/v1/plans/cancel-replace/preview",
        bracketOco: "/v1/plans/bracket/preview",
        trailing: "/v1/plans/trailing/preview",
      },
      planExecutionAuthority: "NONE",
    },
    persistence: {
      mode: "LOCAL_FILE_PAPER_ONLY",
      atomicRename: true,
      fileFsyncBeforeRename: true,
      directoryFsyncAfterRename: true,
      integrityChecksum: "SHA256",
      previousSnapshotBackup: true,
      durableIdempotency: true,
      automaticInterruptedOrderResubmission: false,
      productionDatabaseUsed: false,
      secretsStored: false,
    },
    validation: {
      packageTestCommand: "npm test",
      dedicatedWorkflow: ".github/workflows/trade-execution-gateway-validation.yml",
      exactHeadBridge: ".github/tests/pr-exact-head-trade-execution-gateway.test.mjs",
    },
    reconciliation: {
      endpoint: "/v1/reconciliation/order/preview",
      authority: "READ_ONLY_EVIDENCE",
      mutatesOms: false,
      brokerNetworkRead: false,
    },
  };
}
