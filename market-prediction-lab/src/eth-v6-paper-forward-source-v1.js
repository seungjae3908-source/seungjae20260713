import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ETH_V6_FORWARD_CANDIDATE,
  ETH_V6_FORWARD_MAX_ENTRY_LAG_MS,
} from "./eth-v6-forward-validation.js";
import { FROZEN_CANDIDATE_MANIFEST_SHA256 } from "./final-holdout-evaluator.js";
import { BITGET_STANDARD_TAKER_RESEARCH_COSTS } from "./historical-backtest-data.js";
import { BITGET_ENDPOINTS, BitgetPublicClient } from "./bitget-public-client.js";
import {
  PAPER_KRW_USDT_SIZING_CONTRACT,
  loadUpbitPublicKrwPerUsdt,
  sizeOnePercentRiskKrwFuturesPosition,
} from "./paper-krw-usdt-sizing-v1.js";

const MARKET_CONTEXT_MAX_AGE_MS = 5 * 60 * 1000;
const SHADOW_TO_PAPER_MAX_DELAY_MS = 45 * 60 * 1000;
const COST_POLICY_VERSION = "bitget-standard-taker-research-v1";
const EXECUTION_POLICY_VERSION = "eth-v6-natural-forward-next-open-v1";
const STRATEGY_VERSION = "V6_FROZEN_FINAL_HOLDOUT";
const SHADOW_KEY = "eth-futures-long-v6";
const CONTRACTS_ENDPOINT = "/api/v2/mix/market/contracts";
const POSITION_TIER_ENDPOINT = "/api/v2/mix/market/query-position-lever";

export const ETH_V6_PAPER_FORWARD_SOURCE_CONTRACT = Object.freeze({
  version: "eth-v6-paper-forward-source-v1",
  candidateId: SHADOW_KEY,
  publicDataOnly: true,
  frozenCandidateOnly: true,
  retainedNaturalForwardOnly: true,
  maximumEntryLagMs: ETH_V6_FORWARD_MAX_ENTRY_LAG_MS,
  maximumSourceAgeMs: SHADOW_TO_PAPER_MAX_DELAY_MS,
  sizing: PAPER_KRW_USDT_SIZING_CONTRACT,
  settlementBridgeReady: false,
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

function exactSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function asNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`ETH_V6_PAPER_${label}_INVALID`);
  return number;
}

function firstArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`ETH_V6_PAPER_${label}_MISSING`);
  return value[0];
}

function parameterHash() {
  return createHash("sha256").update(JSON.stringify({
    id: ETH_V6_FORWARD_CANDIDATE.id,
    version: ETH_V6_FORWARD_CANDIDATE.version,
    strategy: ETH_V6_FORWARD_CANDIDATE.strategy,
    parameters: ETH_V6_FORWARD_CANDIDATE.parameters,
    filter: ETH_V6_FORWARD_CANDIDATE.filter,
    manifest: FROZEN_CANDIDATE_MANIFEST_SHA256,
  })).digest("hex");
}

function contractTickSize(contract) {
  const place = asNumber(contract?.pricePlace, "PRICE_PLACE");
  const endStep = asNumber(contract?.priceEndStep, "PRICE_END_STEP");
  const tick = endStep * (10 ** (-place));
  if (!positive(tick)) throw new Error("ETH_V6_PAPER_TICK_SIZE_INVALID");
  return tick;
}

function maintenanceMarginRate(tiers, notional) {
  if (!Array.isArray(tiers) || tiers.length === 0) throw new Error("ETH_V6_PAPER_POSITION_TIER_MISSING");
  const usable = tiers
    .map((tier) => ({
      start: asNumber(tier?.startUnit ?? 0, "TIER_START"),
      end: asNumber(tier?.endUnit, "TIER_END"),
      rate: asNumber(tier?.keepMarginRate, "TIER_MMR"),
    }))
    .filter((tier) => tier.start <= notional)
    .sort((left, right) => left.start - right.start);
  const tier = usable.at(-1);
  if (!tier || tier.rate < 0 || tier.rate >= 1) throw new Error("ETH_V6_PAPER_POSITION_TIER_INVALID");
  return tier.rate;
}

async function readJsonOptional(pathOrUrl) {
  try {
    return JSON.parse(await readFile(pathOrUrl, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function validateShadowState(root) {
  if (!root) return null;
  if (root.schemaVersion !== 3) throw new Error("ETH_V6_PAPER_SHADOW_SCHEMA_UNSUPPORTED");
  const state = root.forwardStrategies?.[SHADOW_KEY] ?? null;
  if (!state) return null;
  if (state.candidateId !== ETH_V6_FORWARD_CANDIDATE.id
    || state.candidateManifestSha256 !== FROZEN_CANDIDATE_MANIFEST_SHA256) {
    throw new Error("ETH_V6_PAPER_FROZEN_IDENTITY_MISMATCH");
  }
  if (state.safeguards?.frozenCandidateOnly !== true
    || state.safeguards?.parametersRetunedAfterHoldout !== false
    || state.safeguards?.forwardSignalsOnly !== true
    || state.safeguards?.publicMarketDataOnly !== true
    || state.safeguards?.orderSubmitted !== false
    || state.safeguards?.liveOrderAllowed !== false) {
    throw new Error("ETH_V6_PAPER_SHADOW_SAFETY_INVALID");
  }
  return state;
}

function validateTrackingRecord(record, forwardState, nowMs) {
  if (record?.status !== "tracking") return false;
  if (record.signalId == null || record.strategy !== ETH_V6_FORWARD_CANDIDATE.strategy
    || record.asset !== "ETHUSDT" || record.market !== "CRYPTO_FUTURES"
    || record.entryPlan?.action !== "LONG" || record.entryPlan?.source !== "bitget-public-forward-paper"
    || record.orderSubmitted !== false || record.privateAccountRequested !== false) {
    throw new Error("ETH_V6_PAPER_TRACKING_RECORD_INVALID");
  }
  const entryTime = Number(record.entryPlan?.entryTime);
  const observedAtMs = Number(forwardState?.updatedAt);
  if (!Number.isInteger(entryTime) || entryTime <= 0 || entryTime > nowMs) throw new Error("ETH_V6_PAPER_ENTRY_TIME_INVALID");
  if (!Number.isInteger(observedAtMs) || observedAtMs < entryTime || observedAtMs > nowMs) {
    throw new Error("ETH_V6_PAPER_SHADOW_OBSERVATION_TIME_INVALID");
  }
  if (observedAtMs - entryTime > ETH_V6_PAPER_FORWARD_SOURCE_CONTRACT.maximumEntryLagMs) {
    throw new Error("ETH_V6_PAPER_ORIGINAL_ENTRY_LAG_EXCEEDED");
  }
  return nowMs - observedAtMs <= ETH_V6_PAPER_FORWARD_SOURCE_CONTRACT.maximumSourceAgeMs;
}

function holdoutEvidence(document) {
  if (!document || document.schemaVersion !== 1
    || document.candidateManifestSha256 !== FROZEN_CANDIDATE_MANIFEST_SHA256
    || document.finalHoldoutRetuningAllowed !== false
    || document.liveOrderAllowed !== false) {
    throw new Error("ETH_V6_PAPER_HOLDOUT_DOCUMENT_INVALID");
  }
  const result = document.results?.find?.((row) => row.id === ETH_V6_FORWARD_CANDIDATE.id);
  if (!result || result.candidateManifestSha256 !== FROZEN_CANDIDATE_MANIFEST_SHA256
    || result.effect !== "positive" || result.promotionEvidence !== false
    || result.safeguards?.parametersChangedFromFrozenSelection !== false
    || result.safeguards?.finalHoldoutUsedForSelection !== false
    || result.safeguards?.orderSubmitted !== false) {
    throw new Error("ETH_V6_PAPER_HOLDOUT_EVIDENCE_INVALID");
  }
  const initialCapital = asNumber(result.initialCapital, "HOLDOUT_INITIAL_CAPITAL");
  const expectancy = asNumber(result.expectancy, "HOLDOUT_EXPECTANCY");
  const returnPercent = asNumber(result.returnPercent, "HOLDOUT_RETURN");
  const trades = Number(result.trades);
  if (!positive(initialCapital) || !(expectancy > 0) || !(returnPercent > 0) || !Number.isInteger(trades) || trades <= 0) {
    throw new Error("ETH_V6_PAPER_HOLDOUT_NOT_POSITIVE");
  }
  return Object.freeze({
    expectedNetEdge: expectancy / initialCapital,
    expectedNetReturn: returnPercent / 100,
    riskRewardRatio: ETH_V6_FORWARD_CANDIDATE.parameters.targetRiskMultiple,
    sampleSize: trades,
    sampleClass: result.sample,
    promotionEvidence: false,
    source: "final-holdout-2026-result",
  });
}

export async function loadBitgetEthV6PaperContext({
  client = new BitgetPublicClient(),
  record,
  nowMs,
  sourceObservedAtMs,
  loadFx = loadUpbitPublicKrwPerUsdt,
} = {}) {
  if (!client || typeof client.get !== "function") throw new TypeError("Bitget public client is required");
  if (!record || !Number.isInteger(nowMs) || !Number.isInteger(sourceObservedAtMs) || typeof loadFx !== "function") {
    throw new TypeError("ETH V6 tracking record, timestamps, and loadFx are required");
  }
  const common = { productType: "usdt-futures", symbol: "ETHUSDT" };
  const [contracts, tiers, openInterest, funding, price, fx] = await Promise.all([
    client.get(CONTRACTS_ENDPOINT, common),
    client.get(POSITION_TIER_ENDPOINT, common),
    client.get(BITGET_ENDPOINTS.openInterest, common),
    client.get(BITGET_ENDPOINTS.currentFunding, common),
    client.get(BITGET_ENDPOINTS.symbolPrice, common),
    loadFx({ nowMs }),
  ]);
  const contract = firstArray(contracts.data, "CONTRACT");
  const fundingRow = firstArray(funding.data, "FUNDING");
  const priceRow = firstArray(price.data, "PRICE");
  const oiRow = firstArray(openInterest.data?.openInterestList, "OPEN_INTEREST");
  if (contract.symbol !== "ETHUSDT" || String(contract.symbolStatus).toLowerCase() !== "normal") {
    throw new Error("ETH_V6_PAPER_CONTRACT_NOT_TRADABLE");
  }
  const asOfMs = asNumber(priceRow.ts, "MARKET_TIMESTAMP");
  if (asOfMs > nowMs || nowMs - asOfMs > MARKET_CONTEXT_MAX_AGE_MS) throw new Error("ETH_V6_PAPER_MARKET_CONTEXT_STALE");
  if (fx?.status !== "READY" || !positive(fx.krwPerUsdt) || !finite(fx.asOfMs) || !positive(fx.maxAgeMs)) {
    throw new Error("ETH_V6_PAPER_KRW_USDT_FX_NOT_READY");
  }

  const entryPrice = asNumber(record.entryPlan?.entryPrice, "ENTRY_PRICE");
  const stopPrice = asNumber(record.stop, "STOP_PRICE");
  const minQty = asNumber(contract.minTradeNum, "MIN_QTY");
  const qtyStep = asNumber(contract.sizeMultiplier, "QTY_STEP");
  const minTradeUsdt = asNumber(contract.minTradeUSDT ?? 0, "MIN_TRADE_USDT");
  const maxMarketQty = asNumber(contract.maxMarketOrderQty, "MAX_MARKET_QTY");
  const sizing = sizeOnePercentRiskKrwFuturesPosition({
    entryPrice,
    stopPrice,
    krwPerUsdt: fx.krwPerUsdt,
    qtyStep,
    minQty,
    minNotionalUsdt: minTradeUsdt,
    maxMarketQty,
  });
  const notional = sizing.entryNotionalUsdt;
  const takerFeeRate = asNumber(contract.takerFeeRate, "TAKER_FEE");
  const mmr = maintenanceMarginRate(tiers.data, notional);
  const liquidationDistancePct = (1 - mmr - takerFeeRate) * 100;
  if (!positive(liquidationDistancePct)) throw new Error("ETH_V6_PAPER_LIQUIDATION_DISTANCE_INVALID");

  return Object.freeze({
    quantity: sizing.quantity,
    sizing,
    fx,
    dataEvidence: Object.freeze({
      provider: "bitget",
      publicOnly: true,
      dataQuality: "READY",
      provenance: "bitget-public-v2:contracts+position-tier+symbol-price+funding+open-interest+natural-eth-v6-forward+upbit-public-cross-fx",
      asOfMs: Math.min(asOfMs, fx.asOfMs),
      maxAgeMs: Math.min(MARKET_CONTEXT_MAX_AGE_MS, fx.maxAgeMs),
      contractStatus: "TRADABLE",
      tickSize: contractTickSize(contract),
      minQty,
      qtyStep,
      markPrice: asNumber(priceRow.markPrice, "MARK_PRICE"),
      indexPrice: asNumber(priceRow.indexPrice, "INDEX_PRICE"),
      fundingRate: asNumber(fundingRow.fundingRate, "FUNDING_RATE"),
      openInterest: asNumber(oiRow.size, "OPEN_INTEREST"),
      leverage: 1,
      maxLeverage: asNumber(contract.maxLever, "MAX_LEVERAGE"),
      marginMode: "ISOLATED",
      liquidationDistancePct,
      barProxyRealtimeAllowed: true,
      retainedForwardObservedAtMs: sourceObservedAtMs,
      retainedForwardMaximumEntryLagMs: ETH_V6_PAPER_FORWARD_SOURCE_CONTRACT.maximumEntryLagMs,
      retainedForwardMaximumSourceAgeMs: ETH_V6_PAPER_FORWARD_SOURCE_CONTRACT.maximumSourceAgeMs,
      liquidationDistanceModel: "conservative-1x-minus-public-mmr-and-taker-v1",
      fxEvidence: Object.freeze({
        source: fx.source,
        markets: fx.markets,
        krwPerUsdt: fx.krwPerUsdt,
        asOfMs: fx.asOfMs,
        maxAgeMs: fx.maxAgeMs,
        publicOnly: true,
      }),
    }),
  });
}

function buildCandidate({ record, researchCodeSha, nowMs, sourceObservedAtMs, context, holdout }) {
  const costs = BITGET_STANDARD_TAKER_RESEARCH_COSTS.CRYPTO_FUTURES;
  return Object.freeze({
    signal: Object.freeze({
      signalId: record.signalId,
      market: "CRYPTO_FUTURES",
      symbol: "ETHUSDT",
      timestampMs: record.timestamp,
      style: "SWING",
      timeframe: "1d",
      horizon: 1,
      direction: "LONG",
      strategyIdentity: Object.freeze({
        strategyId: ETH_V6_FORWARD_CANDIDATE.strategy,
        strategyVersion: STRATEGY_VERSION,
        parameterHash: parameterHash(),
        researchCodeSha,
      }),
    }),
    riskEvidence: Object.freeze({
      status: "APPROVED",
      evaluatedAtMs: nowMs,
      simulatedOnly: true,
      riskPerTrade: context.sizing.riskFraction,
      riskBudgetKrw: context.sizing.riskBudgetKrw,
      estimatedStopRiskKrw: context.sizing.stopRiskKrw,
      estimatedEntryNotionalKrw: context.sizing.entryNotionalKrw,
      leverage: 1,
      source: "frozen-eth-v6-forward+paper-krw-usdt-sizing-v1",
    }),
    profitGate: Object.freeze({
      decision: "ELIGIBLE",
      eligible: true,
      reasons: Object.freeze([]),
      executionAuthority: "NONE",
      policy: "frozen-candidate-paper-admission-v1",
    }),
    profitEvidence: Object.freeze({
      status: "READY",
      market: "CRYPTO_FUTURES",
      expectedNetEdge: holdout.expectedNetEdge,
      expectedNetReturn: holdout.expectedNetReturn,
      riskRewardRatio: holdout.riskRewardRatio,
      sampleSize: holdout.sampleSize,
      costPolicyId: COST_POLICY_VERSION,
      executionAuthority: "NONE",
      sampleClass: holdout.sampleClass,
      promotionEvidence: false,
      profitabilityClaimAllowed: false,
      source: holdout.source,
      candidateManifestSha256: FROZEN_CANDIDATE_MANIFEST_SHA256,
    }),
    execution: Object.freeze({
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
      dataEvidence: context.dataEvidence,
    }),
    order: Object.freeze({ type: "MARKET", quantity: context.quantity, direction: "LONG" }),
    bar: Object.freeze({ nextOpen: record.entryPlan.entryPrice }),
    retainedForwardEvidence: Object.freeze({
      candidateId: ETH_V6_FORWARD_CANDIDATE.id,
      candidateManifestSha256: FROZEN_CANDIDATE_MANIFEST_SHA256,
      shadowRecordId: record.id,
      entryTime: record.entryPlan.entryTime,
      observedAtMs: sourceObservedAtMs,
      stop: record.stop,
      target: record.targets?.[0] ?? null,
      source: record.entryPlan.source,
      sizingVersion: PAPER_KRW_USDT_SIZING_CONTRACT.version,
      riskBudgetKrw: context.sizing.riskBudgetKrw,
      estimatedStopRiskKrw: context.sizing.stopRiskKrw,
      estimatedEntryNotionalKrw: context.sizing.entryNotionalKrw,
      krwPerUsdt: context.fx.krwPerUsdt,
      fxSource: context.fx.source,
      orderSubmitted: false,
      privateAccountRequested: false,
      liveOrderAllowed: false,
    }),
  });
}

export function createEthV6PaperForwardSource({
  shadowStatePath,
  researchCodeSha,
  client = new BitgetPublicClient(),
  clock = Date.now,
  holdoutDocumentUrl = new URL("../docs/final-holdout-2026-result.json", import.meta.url),
  loadContext = loadBitgetEthV6PaperContext,
} = {}) {
  if (!shadowStatePath) throw new TypeError("shadowStatePath is required");
  if (!exactSha(researchCodeSha)) throw new TypeError("exact researchCodeSha is required");
  if (typeof clock !== "function" || typeof loadContext !== "function") throw new TypeError("clock and loadContext are required");
  return Object.freeze({
    async collect() {
      const nowMs = clock();
      if (!Number.isInteger(nowMs) || nowMs <= 0) throw new TypeError("clock must return a positive integer");
      const shadowRoot = await readJsonOptional(shadowStatePath);
      const forwardState = validateShadowState(shadowRoot);
      if (!forwardState) return Object.freeze({ status: "NO_SOURCE_STATE", candidates: Object.freeze([]), exits: Object.freeze([]), blocker: null });
      const sourceObservedAtMs = Number(forwardState.updatedAt);
      const records = (forwardState.ledger?.records ?? []).filter((record) => validateTrackingRecord(record, forwardState, nowMs));
      if (records.length === 0) return Object.freeze({ status: "NO_FRESH_TRACKING_SIGNAL", candidates: Object.freeze([]), exits: Object.freeze([]), blocker: null });
      if (records.length > 1) throw new Error("ETH_V6_PAPER_MULTIPLE_TRACKING_RECORDS_FORBIDDEN");
      const holdout = holdoutEvidence(await readJsonOptional(holdoutDocumentUrl));
      const context = await loadContext({ client, record: records[0], nowMs, sourceObservedAtMs });
      return Object.freeze({
        status: "READY",
        candidates: Object.freeze([buildCandidate({ record: records[0], researchCodeSha, nowMs, sourceObservedAtMs, context, holdout })]),
        exits: Object.freeze([]),
        blocker: null,
        safety: ETH_V6_PAPER_FORWARD_SOURCE_CONTRACT,
      });
    },
  });
}

export function wrapPaperForwardProviderWithEthV6Source({ provider, source } = {}) {
  if (!provider || typeof provider.collectPublicEvidence !== "function") throw new TypeError("base Paper provider is required");
  if (!source || typeof source.collect !== "function") throw new TypeError("ETH V6 Paper source is required");
  return Object.freeze({
    async collectPublicEvidence(input) {
      const base = await provider.collectPublicEvidence(input);
      if (input?.market !== "CRYPTO_FUTURES" || base?.status !== "READY") return base;
      try {
        const natural = await source.collect();
        return Object.freeze({
          ...base,
          candidates: Object.freeze([...(base.candidates ?? []), ...(natural.candidates ?? [])]),
          exits: Object.freeze([...(base.exits ?? []), ...(natural.exits ?? [])]),
          naturalCandidateSource: Object.freeze({
            version: ETH_V6_PAPER_FORWARD_SOURCE_CONTRACT.version,
            status: natural.status,
            blocker: natural.blocker ?? null,
            candidateCount: natural.candidates?.length ?? 0,
            settlementBridgeReady: false,
          }),
        });
      } catch (error) {
        return Object.freeze({
          ...base,
          candidates: Object.freeze([...(base.candidates ?? [])]),
          exits: Object.freeze([...(base.exits ?? [])]),
          naturalCandidateSource: Object.freeze({
            version: ETH_V6_PAPER_FORWARD_SOURCE_CONTRACT.version,
            status: "BLOCKED",
            blocker: String(error?.code ?? error?.message ?? "ETH_V6_PAPER_SOURCE_FAILED").slice(0, 200),
            candidateCount: 0,
            settlementBridgeReady: false,
          }),
        });
      }
    },
  });
}
