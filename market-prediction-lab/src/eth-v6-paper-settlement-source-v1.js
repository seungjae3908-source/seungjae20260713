import { collectBitgetCandles } from "./bitget-candle-collector.js";
import { collectBitgetDerivedCandles } from "./market-structure-history.js";
import { collectFundingRateHistory } from "./derivatives-history.js";
import { BITGET_ENDPOINTS, BitgetPublicClient } from "./bitget-public-client.js";
import { BITGET_STANDARD_TAKER_RESEARCH_COSTS } from "./historical-backtest-data.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_MS = 90 * DAY_MS;
const COST_POLICY_VERSION = "bitget-standard-taker-research-v1";
const EXECUTION_POLICY_VERSION = "eth-v6-natural-forward-next-open-v1";
const CONTRACTS_ENDPOINT = "/api/v2/mix/market/contracts";
const POSITION_TIER_ENDPOINT = "/api/v2/mix/market/query-position-lever";

export const ETH_V6_PAPER_SETTLEMENT_SOURCE_CONTRACT = Object.freeze({
  version: "eth-v6-paper-settlement-source-v1",
  publicDataOnly: true,
  closedHistoricalExitBarRequired: true,
  shadowExitPriceAuthoritative: false,
  fundingHistoryRequired: true,
  liveTrading: false,
  privateApi: false,
  orderAuthority: false,
  profitabilityClaimAllowed: false,
});

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0;
}

function asNumber(value, code) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(code);
  return number;
}

function firstArray(value, code) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(code);
  return value[0];
}

function exactCandle(candles, timestamp, code) {
  const matches = (candles ?? []).filter((row) => row?.timestamp === timestamp);
  if (matches.length !== 1) throw new Error(code);
  return matches[0];
}

function latestFundingAtOrBefore(records, timestamp) {
  const eligible = (records ?? []).filter((row) => row.timestamp <= timestamp);
  const record = eligible.at(-1);
  if (!record || !finite(record.rate)) throw new Error("ETH_V6_PAPER_SETTLEMENT_FUNDING_AT_EXIT_MISSING");
  return record;
}

function contractTickSize(contract) {
  const place = asNumber(contract?.pricePlace, "ETH_V6_PAPER_SETTLEMENT_PRICE_PLACE_INVALID");
  const endStep = asNumber(contract?.priceEndStep, "ETH_V6_PAPER_SETTLEMENT_PRICE_END_STEP_INVALID");
  const tick = endStep * (10 ** (-place));
  if (!positive(tick)) throw new Error("ETH_V6_PAPER_SETTLEMENT_TICK_SIZE_INVALID");
  return tick;
}

function maintenanceMarginRate(tiers, notional) {
  if (!Array.isArray(tiers) || tiers.length === 0) throw new Error("ETH_V6_PAPER_SETTLEMENT_POSITION_TIER_MISSING");
  const usable = tiers
    .map((tier) => ({
      start: asNumber(tier?.startUnit ?? 0, "ETH_V6_PAPER_SETTLEMENT_TIER_START_INVALID"),
      rate: asNumber(tier?.keepMarginRate, "ETH_V6_PAPER_SETTLEMENT_TIER_MMR_INVALID"),
    }))
    .filter((tier) => tier.start <= notional)
    .sort((left, right) => left.start - right.start);
  const tier = usable.at(-1);
  if (!tier || tier.rate < 0 || tier.rate >= 1) throw new Error("ETH_V6_PAPER_SETTLEMENT_POSITION_TIER_INVALID");
  return tier.rate;
}

function validatePosition(position, record, researchCodeSha) {
  if (!position || position.lifecycleState !== "OPEN" || position.market !== "CRYPTO_FUTURES") {
    throw new Error("ETH_V6_PAPER_SETTLEMENT_OPEN_POSITION_REQUIRED");
  }
  if (position.signalId !== record.signalId || position.direction !== "LONG") {
    throw new Error("ETH_V6_PAPER_SETTLEMENT_POSITION_IDENTITY_MISMATCH");
  }
  if (position.researchCodeSha !== researchCodeSha || position.sample?.identity?.researchCodeSha !== researchCodeSha) {
    throw new Error("ETH_V6_PAPER_SETTLEMENT_RESEARCH_SHA_MISMATCH");
  }
  if (!positive(position.sample?.fill?.notional) || !positive(position.sample?.fill?.filledQuantity)) {
    throw new Error("ETH_V6_PAPER_SETTLEMENT_ENTRY_SAMPLE_INVALID");
  }
  if (position.sample.orderSubmitted !== false || position.sample.exchangeRequestSent !== false || position.sample.liveOrderAllowed !== false) {
    throw new Error("ETH_V6_PAPER_SETTLEMENT_ENTRY_SAFETY_INVALID");
  }
}

function validateSettledRecord(record, nowMs) {
  if (record?.status !== "settled" || !record.signalId || record.asset !== "ETHUSDT" || record.market !== "CRYPTO_FUTURES"
    || record.entryPlan?.action !== "LONG" || record.entryPlan?.source !== "bitget-public-forward-paper"
    || record.orderSubmitted !== false || record.privateAccountRequested !== false) {
    throw new Error("ETH_V6_PAPER_SETTLEMENT_SHADOW_RECORD_INVALID");
  }
  const exitTimestamp = Number(record.subsequentMarketResult?.exitTimestamp);
  if (!Number.isInteger(exitTimestamp) || exitTimestamp <= 0 || exitTimestamp > nowMs) {
    throw new Error("ETH_V6_PAPER_SETTLEMENT_EXIT_TIMESTAMP_INVALID");
  }
  const reason = String(record.subsequentMarketResult?.exitReason ?? "");
  if (!new Set(["stop_loss_gap", "stop_loss_same_bar", "stop_loss", "take_profit_gap", "take_profit"]).has(reason)) {
    throw new Error("ETH_V6_PAPER_SETTLEMENT_EXIT_REASON_UNSUPPORTED");
  }
  return Object.freeze({ exitTimestamp, reason });
}

function orderFor(record, reason) {
  if (reason.startsWith("stop_loss")) {
    const stopPrice = asNumber(record.stop, "ETH_V6_PAPER_SETTLEMENT_STOP_INVALID");
    if (!positive(stopPrice)) throw new Error("ETH_V6_PAPER_SETTLEMENT_STOP_INVALID");
    return Object.freeze({ type: "STOP_MARKET", stopPrice });
  }
  const limitPrice = asNumber(record.targets?.[0], "ETH_V6_PAPER_SETTLEMENT_TARGET_INVALID");
  if (!positive(limitPrice)) throw new Error("ETH_V6_PAPER_SETTLEMENT_TARGET_INVALID");
  return Object.freeze({ type: "LIMIT", limitPrice });
}

export async function loadBitgetEthV6PaperSettlement({
  client = new BitgetPublicClient(),
  record,
  position,
  researchCodeSha,
  nowMs,
  collectCandles = collectBitgetCandles,
  collectDerived = collectBitgetDerivedCandles,
  collectFunding = collectFundingRateHistory,
} = {}) {
  if (!client || typeof client.get !== "function") throw new TypeError("Bitget public client is required");
  if (!Number.isInteger(nowMs) || nowMs <= 0) throw new TypeError("positive integer nowMs is required");
  const lifecycle = validateSettledRecord(record, nowMs);
  validatePosition(position, record, researchCodeSha);

  // Shadow can detect a gap from the current open-only daily candle. Paper waits
  // until that same daily candle is closed, then independently verifies its open.
  if (nowMs < lifecycle.exitTimestamp + DAY_MS) {
    return Object.freeze({ status: "WAITING_CLOSED_EXIT_BAR", settlementInput: null });
  }

  const startTime = Math.max(1, lifecycle.exitTimestamp - LOOKBACK_MS);
  const endTime = lifecycle.exitTimestamp + DAY_MS;
  const common = { symbol: "ETHUSDT", productType: "usdt-futures" };
  const [market, mark, index, funding, contracts, tiers, openInterest] = await Promise.all([
    collectCandles({ client, market: "CRYPTO_FUTURES", symbol: "ETHUSDT", timeframe: "1d", startTime, endTime, maxCandles: 120 }),
    collectDerived({ client, kind: "mark", symbol: "ETHUSDT", timeframe: "1d", startTime, endTime, maxCandles: 120 }),
    collectDerived({ client, kind: "index", symbol: "ETHUSDT", timeframe: "1d", startTime, endTime, maxCandles: 120 }),
    collectFunding({ client, symbol: "ETHUSDT", startTime: position.sample.identity.evaluatedAtMs, endTime: lifecycle.exitTimestamp }),
    client.get(CONTRACTS_ENDPOINT, common),
    client.get(POSITION_TIER_ENDPOINT, common),
    client.get(BITGET_ENDPOINTS.openInterest, common),
  ]);

  const exitCandle = exactCandle(market.candles, lifecycle.exitTimestamp, "ETH_V6_PAPER_SETTLEMENT_EXIT_CANDLE_MISSING");
  const markCandle = exactCandle(mark.candles, lifecycle.exitTimestamp, "ETH_V6_PAPER_SETTLEMENT_MARK_CANDLE_MISSING");
  const indexCandle = exactCandle(index.candles, lifecycle.exitTimestamp, "ETH_V6_PAPER_SETTLEMENT_INDEX_CANDLE_MISSING");
  if (funding?.exhausted !== true || !Array.isArray(funding.records)) {
    throw new Error("ETH_V6_PAPER_SETTLEMENT_FUNDING_HISTORY_INCOMPLETE");
  }
  const fundingAtExit = latestFundingAtOrBefore(funding.records, lifecycle.exitTimestamp);
  const contract = firstArray(contracts.data, "ETH_V6_PAPER_SETTLEMENT_CONTRACT_MISSING");
  const oiRow = firstArray(openInterest.data?.openInterestList, "ETH_V6_PAPER_SETTLEMENT_OPEN_INTEREST_MISSING");
  if (contract.symbol !== "ETHUSDT" || String(contract.symbolStatus).toLowerCase() !== "normal") {
    throw new Error("ETH_V6_PAPER_SETTLEMENT_CONTRACT_NOT_TRADABLE");
  }

  const minQty = asNumber(contract.minTradeNum, "ETH_V6_PAPER_SETTLEMENT_MIN_QTY_INVALID");
  const qtyStep = asNumber(contract.sizeMultiplier, "ETH_V6_PAPER_SETTLEMENT_QTY_STEP_INVALID");
  const takerFeeRate = asNumber(contract.takerFeeRate, "ETH_V6_PAPER_SETTLEMENT_TAKER_FEE_INVALID");
  const mmr = maintenanceMarginRate(tiers.data, position.sample.fill.notional);
  const liquidationDistancePct = (1 - mmr - takerFeeRate) * 100;
  if (!positive(liquidationDistancePct)) throw new Error("ETH_V6_PAPER_SETTLEMENT_LIQUIDATION_DISTANCE_INVALID");

  const costs = BITGET_STANDARD_TAKER_RESEARCH_COSTS.CRYPTO_FUTURES;
  const order = orderFor(record, lifecycle.reason);
  const fundingPayments = funding.records
    .filter((row) => row.timestamp > position.sample.identity.evaluatedAtMs && row.timestamp <= lifecycle.exitTimestamp)
    .map((row) => Object.freeze({
      asOfMs: row.timestamp,
      amount: position.sample.fill.notional * row.rate,
      source: "bitget-public-v2",
      provenance: `history-fund-rate:${row.timestamp}:${row.rateRaw}`,
      version: "bitget-history-fund-rate-v2",
    }));
  const pathBars = market.candles
    .filter((row) => row.timestamp > position.sample.identity.evaluatedAtMs && row.timestamp <= lifecycle.exitTimestamp)
    .map((row) => Object.freeze({ timestampMs: row.timestamp, high: row.high, low: row.low }));

  const exitExecution = Object.freeze({
    marketAdapterIdentity: Object.freeze({ id: "crypto-futures-bitget-execution", version: "v2" }),
    costPolicy: Object.freeze({
      version: COST_POLICY_VERSION,
      commissionRate: costs.entryFeeRate,
      taxRate: costs.taxRate,
      spreadRate: costs.spreadRate,
      slippageRate: costs.slippageRate,
      latencyRate: costs.latencyBars * costs.latencyDriftRate,
      liquidityImpactRate: 0,
      partialFillImpactRate: 0,
      fundingRate: 0,
    }),
    executionPolicy: Object.freeze({
      version: EXECUTION_POLICY_VERSION,
      fillModel: "BAR_PROXY",
      sameBarPolicy: "STOP_FIRST",
      allowPartialFill: false,
      maxParticipationRate: 1,
    }),
    dataEvidence: Object.freeze({
      provider: "bitget",
      publicOnly: true,
      dataQuality: "READY",
      provenance: "bitget-public-v2:closed-daily-settlement+mark+index+funding+contract+oi",
      asOfMs: nowMs,
      contractStatus: "TRADABLE",
      tickSize: contractTickSize(contract),
      minQty,
      qtyStep,
      markPrice: markCandle.close,
      indexPrice: indexCandle.close,
      fundingRate: fundingAtExit.rate,
      openInterest: asNumber(oiRow.size, "ETH_V6_PAPER_SETTLEMENT_OPEN_INTEREST_INVALID"),
      leverage: 1,
      maxLeverage: asNumber(contract.maxLever, "ETH_V6_PAPER_SETTLEMENT_MAX_LEVERAGE_INVALID"),
      marginMode: "ISOLATED",
      liquidationDistancePct,
      barProxyRealtimeAllowed: true,
      closedDataOnly: true,
      historicalSettlementEvidence: true,
      historicalSettlementEffectiveAtMs: lifecycle.exitTimestamp,
      shadowExitPriceAuthoritative: false,
    }),
  });

  return Object.freeze({
    status: "READY",
    settlementInput: Object.freeze({
      exitExecution,
      exitOrderType: order.type,
      exitLimitPrice: order.limitPrice ?? null,
      exitStopPrice: order.stopPrice ?? null,
      exitBar: Object.freeze({ nextOpen: exitCandle.open, high: exitCandle.high, low: exitCandle.low }),
      pathBars: Object.freeze(pathBars),
      fundingEvidence: Object.freeze({ complete: true, payments: Object.freeze(fundingPayments) }),
    }),
    evidence: Object.freeze({
      exitReason: lifecycle.reason,
      exitTimestamp: lifecycle.exitTimestamp,
      exitCandleOpen: exitCandle.open,
      shadowExitPriceIgnored: true,
      fundingPayments: fundingPayments.length,
      publicOnly: true,
    }),
    safety: ETH_V6_PAPER_SETTLEMENT_SOURCE_CONTRACT,
  });
}
