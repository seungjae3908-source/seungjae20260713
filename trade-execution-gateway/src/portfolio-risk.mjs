import { GatewayError } from "./gateway.mjs";

const DEFAULT_MAX_AGE_MS = 30_000;

function nonNegative(value, code, message) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new GatewayError(code, message);
  }
  return number;
}

function positive(value, code, message) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new GatewayError(code, message);
  }
  return number;
}

function observedAtMs(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new GatewayError("PORTFOLIO_SNAPSHOT_TIMESTAMP_INVALID", "portfolio observedAt is invalid");
  }
  return parsed;
}

export function evaluatePortfolioRisk({ intent, orderNotional, snapshot, policy, killSwitch }, options = {}) {
  if (!killSwitch || typeof killSwitch !== "object") {
    throw new GatewayError("KILL_SWITCH_STATE_REQUIRED", "explicit paper kill-switch state is required", 503);
  }
  if (killSwitch.engaged !== false) {
    throw new GatewayError("KILL_SWITCH_ENGAGED", "new paper orders are blocked by kill switch", 423);
  }
  if (killSwitch.authority !== "PAPER_CONTROL_PLANE") {
    throw new GatewayError(
      "KILL_SWITCH_AUTHORITY_INVALID",
      "paper kill-switch authority must be PAPER_CONTROL_PLANE",
      503,
    );
  }

  if (!snapshot || snapshot.mode !== "PAPER_EVIDENCE") {
    throw new GatewayError(
      "PORTFOLIO_RISK_EVIDENCE_REQUIRED",
      "paper portfolio risk evidence is required",
      503,
    );
  }

  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const asOfMs = observedAtMs(snapshot.observedAt);
  if (asOfMs > nowMs + 1_000) {
    throw new GatewayError("PORTFOLIO_SNAPSHOT_FUTURE", "portfolio snapshot is from the future");
  }
  if (nowMs - asOfMs > maxAgeMs) {
    throw new GatewayError("PORTFOLIO_SNAPSHOT_STALE", "portfolio snapshot is stale");
  }

  const grossExposure = nonNegative(
    snapshot.grossExposure,
    "GROSS_EXPOSURE_EVIDENCE_INVALID",
    "grossExposure must be non-negative",
  );
  const currentMarketExposure = nonNegative(
    snapshot.marketExposureByMarket?.[intent.market],
    "MARKET_EXPOSURE_EVIDENCE_INVALID",
    `market exposure evidence is required for ${intent.market}`,
  );
  const openOrders = nonNegative(
    snapshot.openOrders,
    "OPEN_ORDER_EVIDENCE_INVALID",
    "openOrders must be non-negative",
  );
  const dailyPnl = Number(snapshot.dailyPnl);
  if (!Number.isFinite(dailyPnl)) {
    throw new GatewayError("DAILY_PNL_EVIDENCE_INVALID", "dailyPnl evidence is required");
  }

  const maxGrossExposure = positive(
    policy?.maxGrossExposure,
    "PORTFOLIO_POLICY_NOT_CONFIGURED",
    "maxGrossExposure policy is required",
  );
  const maxMarketExposure = positive(
    policy?.maxMarketExposureByMarket?.[intent.market],
    "PORTFOLIO_POLICY_NOT_CONFIGURED",
    `market exposure policy is required for ${intent.market}`,
  );
  const maxOpenOrders = positive(
    policy?.maxOpenOrders,
    "PORTFOLIO_POLICY_NOT_CONFIGURED",
    "maxOpenOrders policy is required",
  );
  const maxDailyLoss = positive(
    policy?.maxDailyLoss,
    "PORTFOLIO_POLICY_NOT_CONFIGURED",
    "maxDailyLoss policy is required",
  );

  if (openOrders + 1 > maxOpenOrders) {
    throw new GatewayError("MAX_OPEN_ORDERS_EXCEEDED", "paper open-order limit exceeded");
  }
  if (Math.max(0, -dailyPnl) >= maxDailyLoss) {
    throw new GatewayError("DAILY_LOSS_GUARD_BLOCKED", "paper daily loss limit reached");
  }

  const projectedGrossExposure = grossExposure + orderNotional;
  const projectedMarketExposure = currentMarketExposure + orderNotional;
  if (projectedGrossExposure > maxGrossExposure) {
    throw new GatewayError("MAX_GROSS_EXPOSURE_EXCEEDED", "projected gross exposure exceeds limit");
  }
  if (projectedMarketExposure > maxMarketExposure) {
    throw new GatewayError("MAX_MARKET_EXPOSURE_EXCEEDED", "projected market exposure exceeds limit");
  }

  let maxLeverage = null;
  if (intent.market === "CRYPTO_FUTURES") {
    maxLeverage = positive(
      policy?.maxLeverageByMarket?.CRYPTO_FUTURES,
      "PORTFOLIO_POLICY_NOT_CONFIGURED",
      "futures portfolio leverage limit is required",
    );
    if (intent.leverage > maxLeverage) {
      throw new GatewayError("PORTFOLIO_LEVERAGE_EXCEEDED", "futures leverage exceeds portfolio limit");
    }
  }

  return Object.freeze({
    accepted: true,
    authority: "CALLER_PAPER_ONLY_NON_AUTHORITATIVE",
    observedAt: new Date(asOfMs).toISOString(),
    orderNotional,
    projectedGrossExposure,
    projectedMarketExposure,
    projectedOpenOrders: openOrders + 1,
    maxGrossExposure,
    maxMarketExposure,
    maxOpenOrders,
    maxDailyLoss,
    maxLeverage,
    liveAuthorityGranted: false,
  });
}
