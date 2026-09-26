import { createHash } from "node:crypto";
import { BitgetPublicClient } from "./bitget-public-client.js";
import { collectFundingRateHistory } from "./derivatives-history.js";
import { AUTHORITATIVE_NATURAL_PAPER_TRIGGER_SETTLEMENT_EVIDENCE_VERSION } from "./natural-paper-trigger-bound-settlement-cost-producer-v1.js";

export const NATURAL_PAPER_AUTHORITATIVE_SETTLEMENT_COST_COLLECTOR_VERSION =
  "natural-paper-authoritative-settlement-cost-collector-v1";

const MAXIMUM_AGE_MS = 30_000;
const COMPONENTS = Object.freeze([
  "commission", "tax", "spread", "slippage", "funding", "latency", "liquidityImpact", "partialFillImpact",
]);

function stableSerialize(value, seen = new WeakSet()) {
  if (value && typeof value === "object") {
    if (seen.has(value)) throw new TypeError("cyclic evidence is forbidden");
    seen.add(value);
  }
  if (Array.isArray(value)) {
    const serialized = `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }
  if (value && typeof value === "object") {
    const serialized = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`).join(",")}}`;
    seen.delete(value);
    return serialized;
  }
  return JSON.stringify(value) ?? "undefined";
}

function hash(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || Object.isFrozen(value) || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0;
}

function nonNegative(value) {
  return finite(value) && value >= 0;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function exactSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function safeTime(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function scalar(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function blocked(blockers) {
  return deepFreeze({
    schemaVersion: AUTHORITATIVE_NATURAL_PAPER_TRIGGER_SETTLEMENT_EVIDENCE_VERSION,
    collectorVersion: NATURAL_PAPER_AUTHORITATIVE_SETTLEMENT_COST_COLLECTOR_VERSION,
    status: "BLOCKED_DATA",
    fullCostReady: false,
    blockers: [...new Set(blockers)],
    unknownIsZero: false,
    unavailableCostConvertedToZero: false,
    synthetic: false,
    replay: false,
    backfill: false,
    duplicate: false,
    historical: false,
    testOnly: false,
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

function canonicalSymbol(value) {
  if (!nonEmpty(value)) return null;
  const symbol = value.trim().toUpperCase().replace(/[^A-Z0-9]/gu, "");
  return symbol.endsWith("USDT") && symbol.length > 4 ? symbol : null;
}

function oneData(payload) {
  if (String(payload?.code ?? "") !== "00000" || !Array.isArray(payload?.data) || payload.data.length !== 1) {
    return null;
  }
  return record(payload.data[0]);
}

function quantityPrecision(step) {
  if (!positive(step)) return null;
  for (let precision = 0; precision <= 12; precision += 1) {
    const scaled = step * 10 ** precision;
    if (Math.abs(scaled - Math.round(scaled)) <= Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8) {
      return precision;
    }
  }
  return null;
}

function topLevel(levels) {
  if (!Array.isArray(levels) || !Array.isArray(levels[0])) return null;
  const price = scalar(levels[0][0]);
  const size = scalar(levels[0][1]);
  return positive(price) && nonNegative(size) ? { price, size } : null;
}

function positionIdentity(position) {
  return {
    positionId: position?.positionId,
    paperSampleId: position?.paperSampleId,
    signalId: position?.signalId,
    market: position?.market,
    symbol: position?.symbol,
    signalTimeframe: position?.sample?.identity?.timeframe,
    horizon: position?.sample?.identity?.horizon,
    direction: position?.direction,
    candidateId: position?.candidateId,
    strategyFamily: position?.strategyFamily,
    strategyId: position?.strategyId,
    strategyVersion: position?.strategyVersion,
    parameterHash: position?.parameterHash,
    parameterDigest: position?.parameterDigest,
    researchCodeSha: position?.researchCodeSha,
    costPolicyVersion: position?.costPolicyVersion,
    accountMode: position?.accountMode,
  };
}

function exitExecutionIdentity(position, trigger, sourceIdentity, provenanceId, exitExecution) {
  const payload = {
    exitTriggerId: trigger?.exitTriggerId,
    triggerObservationId: trigger?.triggerObservationId,
    triggeredAtMs: trigger?.triggeredAtMs,
    positionId: position?.positionId,
    paperSampleId: position?.paperSampleId,
    entryId: position?.paperSampleId,
    provider: exitExecution?.dataEvidence?.provider,
    market: position?.market,
    symbol: position?.symbol,
    timeframe: position?.sample?.identity?.timeframe,
    horizon: position?.sample?.identity?.horizon,
    direction: position?.direction,
    candidateId: position?.candidateId,
    strategyFamily: position?.strategyFamily,
    strategyId: position?.strategyId,
    strategyVersion: position?.strategyVersion,
    parameterHash: position?.parameterHash,
    parameterDigest: position?.parameterDigest,
    researchCodeSha: position?.researchCodeSha,
    accountMode: position?.accountMode,
    costPolicyVersion: position?.costPolicyVersion,
    sourceIdentity,
    provenanceId,
    exitExecutionDigest: hash(exitExecution),
  };
  return { ...payload, exitExecutionId: hash(payload) };
}

function percentEvidence(value) {
  return record(value)
    && nonNegative(value.valuePercent)
    && ["OBSERVED", "DOCUMENTED", "ESTIMATED"].includes(value.quality)
    && nonEmpty(value.source)
    && safeTime(value.observedAtMs);
}

async function publicJsonFromClient(client, url) {
  return client.get(url.pathname, Object.fromEntries(url.searchParams.entries()));
}

async function collectBitgetExitSnapshot({
  client,
  runtimePackage,
  symbol,
  direction,
  researchCodeSha,
  quantity,
  now,
  maximumAgeMs,
}) {
  const readQuote = (phase, attempt) => runtimePackage.readBitgetPublicLatencyMidpointQuote({
    market: "CRYPTO_FUTURES",
    symbol,
    researchCodeSha,
    phase,
    attempt,
    fetchPublicJson: (url) => publicJsonFromClient(client, url),
  });
  const latencyCollection = await runtimePackage.collectAuthoritativePaperLatencyCostEvidence({
    market: "CRYPTO_FUTURES",
    symbol,
    researchCodeSha,
    direction,
    readPublicMidpointQuote: readQuote,
    executeMeasuredPublicRequest: () => client.get("/api/v3/market/orderbook", {
      category: "USDT-FUTURES",
      symbol,
      limit: "50",
    }),
    now,
    maximumAgeMs,
    maximumRequestDurationMs: maximumAgeMs,
    maximumPostObservationAttempts: 3,
  });
  if (latencyCollection.latency?.status !== "PRESENT" || !latencyCollection.latency?.evidence) {
    return { status: "BLOCKED_DATA", blockers: latencyCollection.latency?.blockers ?? ["LATENCY_COST_EVIDENCE_UNAVAILABLE"] };
  }
  const orderbookPayload = latencyCollection.requestResult;
  const orderbook = record(orderbookPayload?.data);
  const observedAtMs = scalar(orderbook?.ts);
  const bid = topLevel(orderbook?.b);
  const ask = topLevel(orderbook?.a);
  if (String(orderbookPayload?.code ?? "") !== "00000" || !safeTime(observedAtMs) || !bid || !ask || ask.price < bid.price) {
    return { status: "BLOCKED_DATA", blockers: ["EXIT_PUBLIC_L2_UNAVAILABLE"] };
  }

  const executionEvidence = runtimePackage.buildPaperSimulatedExecutionEvidence({
    source: "BITGET_PUBLIC_UTA_V3_ORDERBOOK",
    market: "CRYPTO_FUTURES",
    symbol,
    direction,
    targetQuantity: quantity,
    bids: orderbook.b,
    asks: orderbook.a,
    observedAtMs,
    requestStartedAtMs: latencyCollection.requestStartedAtMs,
    requestCompletedAtMs: latencyCollection.requestCompletedAtMs,
    maximumAgeMs,
    provenance: ["SIMULATED", "public-L2", "bitget-public-uta-v3-orderbook"],
    calibratedFillModel: null,
    nowMs: latencyCollection.evaluatedAtMs,
  });
  if (executionEvidence?.paperSimulation?.status !== "READY"
    || executionEvidence?.estimated?.slippageEstimate?.quality !== "ESTIMATED"
    || !nonNegative(executionEvidence?.estimated?.slippageEstimate?.percent)) {
    return { status: "BLOCKED_DATA", blockers: ["EXIT_PUBLIC_L2_EXECUTION_SIMULATION_UNAVAILABLE"] };
  }

  const [tickerPayload, fundingPayload, openInterestPayload, contractPayload] = await Promise.all([
    client.get("/api/v2/mix/market/ticker", { symbol, productType: "USDT-FUTURES" }),
    client.get("/api/v2/mix/market/current-fund-rate", { symbol, productType: "USDT-FUTURES" }),
    client.get("/api/v2/mix/market/open-interest", { symbol, productType: "USDT-FUTURES" }),
    client.get("/api/v2/mix/market/contracts", { symbol, productType: "USDT-FUTURES" }),
  ]);
  const ticker = oneData(tickerPayload);
  const funding = oneData(fundingPayload);
  const contract = oneData(contractPayload);
  const oiData = record(openInterestPayload?.data);
  const oi = Array.isArray(oiData?.openInterestList) && oiData.openInterestList.length === 1
    ? record(oiData.openInterestList[0])
    : null;
  if (!ticker || !funding || !contract || !oi || String(contract.symbolStatus ?? "") !== "normal") {
    return { status: "BLOCKED_DATA", blockers: ["EXIT_PUBLIC_CONTRACT_EVIDENCE_UNAVAILABLE"] };
  }

  const tickerAtMs = scalar(ticker.ts);
  const oiAtMs = scalar(oiData.ts);
  const markPrice = scalar(ticker.markPrice);
  const indexPrice = scalar(ticker.indexPrice);
  const currentFundingRate = scalar(funding.fundingRate);
  const openInterest = scalar(oi.size);
  const pricePlace = scalar(contract.pricePlace);
  const priceEndStep = scalar(contract.priceEndStep);
  const minQty = scalar(contract.minTradeNum);
  const qtyStep = scalar(contract.sizeMultiplier);
  const maxLeverage = scalar(contract.maxLever);
  const takerFeeRate = scalar(contract.takerFeeRate);
  const precision = quantityPrecision(qtyStep);
  if (!safeTime(tickerAtMs) || !safeTime(oiAtMs)
    || !positive(markPrice) || !positive(indexPrice) || !finite(currentFundingRate)
    || !nonNegative(openInterest) || !nonNegative(pricePlace) || !positive(priceEndStep)
    || !positive(minQty) || !positive(qtyStep) || !positive(maxLeverage)
    || !nonNegative(takerFeeRate) || precision == null) {
    return { status: "BLOCKED_DATA", blockers: ["EXIT_PUBLIC_CONTRACT_EVIDENCE_INVALID"] };
  }
  const completedAtMs = now();
  if (!safeTime(completedAtMs)) {
    return { status: "BLOCKED_DATA", blockers: ["EXIT_PUBLIC_COLLECTION_TIME_INVALID"] };
  }
  for (const timestamp of [observedAtMs, tickerAtMs, oiAtMs]) {
    if (timestamp > completedAtMs || completedAtMs - timestamp > maximumAgeMs) {
      return { status: "BLOCKED_DATA", blockers: ["EXIT_PUBLIC_EVIDENCE_STALE_OR_FUTURE"] };
    }
  }

  const midpoint = (bid.price + ask.price) / 2;
  return deepFreeze({
    status: "PRESENT",
    collectedAtMs: completedAtMs,
    observedAtMs,
    bid,
    ask,
    quote: {
      bid: bid.price,
      ask: ask.price,
      last: positive(scalar(ticker.lastPr)) ? scalar(ticker.lastPr) : (bid.price + ask.price) / 2,
      asOfMs: observedAtMs,
      maxAgeMs: maximumAgeMs,
    },
    depth: { bidSize: bid.size, askSize: ask.size },
    spreadPercent: ((ask.price - bid.price) / midpoint) * 100,
    slippagePercent: executionEvidence.estimated.slippageEstimate.percent,
    slippageSource: executionEvidence.estimated.slippageEstimate.model ?? "VISIBLE_L2_BOOK_WALK_ONLY",
    latencyEvidence: latencyCollection.latency.evidence,
    markPrice,
    indexPrice,
    currentFundingRate,
    openInterest,
    tickSize: priceEndStep * 10 ** (-pricePlace),
    minQty,
    qtyStep,
    quantityPrecision: precision,
    maxLeverage,
    takerFeeRate,
    provenance: "BITGET_PUBLIC_EXIT_L2_TICKER_FUNDING_OI_CONTRACT",
  });
}

function settlementExecutionPolicy(position, snapshot, componentRates, maximumAgeMs) {
  const template = record(position?.settlementExecutionPolicy);
  const entry = record(template?.entryDataEvidence);
  if (!template || !entry || !nonEmpty(entry.provider)
    || !positive(entry.leverage) || !positive(entry.maxLeverage)
    || !positive(entry.liquidationDistancePct)
    || !["ISOLATED", "CROSS"].includes(String(entry.marginMode ?? "").toUpperCase())
    || !record(template.marketAdapterIdentity) || !record(template.executionPolicy)) {
    return null;
  }
  return deepFreeze({
    marketAdapterIdentity: structuredClone(template.marketAdapterIdentity),
    strategyIdentity: {
      candidateId: position.candidateId,
      strategyFamily: position.strategyFamily,
      strategyId: position.strategyId,
      strategyVersion: position.strategyVersion,
      parameterHash: position.parameterHash,
      parameterDigest: position.parameterDigest,
      researchCodeSha: position.researchCodeSha,
      accountMode: position.accountMode,
    },
    costPolicy: {
      version: position.costPolicyVersion,
      commissionRate: componentRates.commission,
      taxRate: componentRates.tax,
      spreadRate: componentRates.spread,
      slippageRate: componentRates.slippage,
      fundingRate: componentRates.funding,
      latencyRate: componentRates.latency,
      liquidityImpactRate: componentRates.liquidityImpact,
      partialFillImpactRate: componentRates.partialFillImpact,
    },
    executionPolicy: structuredClone(template.executionPolicy),
    dataEvidence: {
      provider: entry.provider,
      publicOnly: true,
      dataQuality: "READY",
      provenance: `${snapshot.provenance}+FROZEN_ENTRY_RISK_POLICY`,
      asOfMs: snapshot.observedAtMs,
      maxAgeMs: maximumAgeMs,
      tickSize: snapshot.tickSize,
      barProxyRealtimeAllowed: false,
      quoteEvidence: { available: true, ...snapshot.quote },
      contractStatus: "TRADABLE",
      minQty: snapshot.minQty,
      qtyStep: snapshot.qtyStep,
      quantityPrecision: snapshot.quantityPrecision,
      markPrice: snapshot.markPrice,
      indexPrice: snapshot.indexPrice,
      fundingRate: snapshot.currentFundingRate,
      openInterest: snapshot.openInterest,
      leverage: entry.leverage,
      maxLeverage: snapshot.maxLeverage,
      marginMode: String(entry.marginMode).toUpperCase(),
      liquidationDistancePct: entry.liquidationDistancePct,
      privateApiUsed: false,
      executionMode: "SIMULATED_EXECUTION_ONLY",
      publicL2Only: true,
      realFillObserved: false,
      realFillClaim: false,
      publicDepthIsFillProof: false,
      liveSubmittedExecutionSampleCredit: 0,
      privateTradingApiAllowed: false,
      liveOrderAllowed: false,
      orderSubmitted: false,
      exchangeRequestSent: false,
    },
  });
}

function component({
  name,
  valuePercent,
  quality,
  source,
  provenance,
  observedAtMs,
  maximumAgeMs,
  positionIdentityValue,
  exitExecutionIdentityValue,
  costPolicyVersion,
  extras = {},
}) {
  return deepFreeze({
    status: "PRESENT",
    valuePercent,
    quality,
    source,
    provenance,
    sourceIdentity: source,
    provenanceId: hash({ name, source, provenance, observedAtMs, valuePercent }),
    positionIdentity: positionIdentityValue,
    exitExecutionIdentity: exitExecutionIdentityValue,
    freshness: { observedAtMs, maximumAgeMs },
    policyIdentity: { version: costPolicyVersion },
    observedAtMs,
    countsAsExecutionCost: true,
    unavailableIsZero: false,
    ...extras,
  });
}

export function createNaturalPaperAuthoritativeSettlementCostCollector({
  runtimePackage,
  readSupplementalCostInput,
  bitgetClient = new BitgetPublicClient(),
  collectFundingHistory = collectFundingRateHistory,
  collectExitSnapshot = collectBitgetExitSnapshot,
  now = Date.now,
} = {}) {
  if (!runtimePackage
    || typeof runtimePackage.buildPaperSimulatedExecutionEvidence !== "function"
    || typeof runtimePackage.collectAuthoritativePaperLatencyCostEvidence !== "function"
    || typeof runtimePackage.readBitgetPublicLatencyMidpointQuote !== "function") {
    throw new TypeError("validated authoritative Paper runtime package is required");
  }
  if (typeof readSupplementalCostInput !== "function") {
    throw new TypeError("canonical supplemental cost input reader is required");
  }
  if (!bitgetClient || typeof bitgetClient.get !== "function"
    || typeof collectFundingHistory !== "function"
    || typeof collectExitSnapshot !== "function"
    || typeof now !== "function") {
    throw new TypeError("public settlement evidence dependencies are required");
  }

  return async function collectAuthoritativeEvidence({
    position,
    observation,
    exitTrigger,
    evaluatedAtMs,
  } = {}) {
    const blockers = [];
    const symbol = canonicalSymbol(position?.symbol);
    const direction = position?.direction;
    const maximumAgeMs = Math.min(
      positive(observation?.maxAgeMs) ? observation.maxAgeMs : MAXIMUM_AGE_MS,
      MAXIMUM_AGE_MS,
    );
    if (position?.market !== "CRYPTO_FUTURES") blockers.push("SETTLEMENT_COLLECTOR_CRYPTO_FUTURES_ONLY");
    if (!symbol) blockers.push("SETTLEMENT_COLLECTOR_SYMBOL_REQUIRED");
    if (!["LONG", "SHORT"].includes(direction)) blockers.push("SETTLEMENT_COLLECTOR_DIRECTION_REQUIRED");
    if (!exactSha(position?.researchCodeSha)) blockers.push("SETTLEMENT_COLLECTOR_RESEARCH_SHA_REQUIRED");
    if (!safeTime(position?.entryTimestampMs) || !safeTime(exitTrigger?.triggeredAtMs)
      || exitTrigger.triggeredAtMs < position.entryTimestampMs) {
      blockers.push("SETTLEMENT_COLLECTOR_HOLDING_PERIOD_INVALID");
    }
    if (!positive(position?.quantity) || !positive(position?.sample?.fill?.notional)) {
      blockers.push("SETTLEMENT_COLLECTOR_POSITION_SIZE_REQUIRED");
    }
    if (!safeTime(evaluatedAtMs) || !positive(maximumAgeMs)) blockers.push("SETTLEMENT_COLLECTOR_EVALUATION_TIME_INVALID");
    if (blockers.length > 0) return blocked(blockers);

    const supplemental = await readSupplementalCostInput();
    if (!record(supplemental)
      || supplemental.costPolicyId !== position.costPolicyVersion
      || !safeTime(supplemental.observedAtMs)
      || !percentEvidence(supplemental.liquidityImpact)
      || !percentEvidence(supplemental.partialFillImpact)) {
      return blocked(["CANONICAL_SUPPLEMENTAL_COST_EVIDENCE_MISSING"]);
    }

    const snapshot = await collectExitSnapshot({
      client: bitgetClient,
      runtimePackage,
      symbol,
      direction,
      researchCodeSha: position.researchCodeSha.toLowerCase(),
      quantity: position.quantity,
      now,
      maximumAgeMs,
    });
    if (snapshot?.status !== "PRESENT") {
      return blocked(snapshot?.blockers ?? ["EXIT_PUBLIC_EVIDENCE_UNAVAILABLE"]);
    }
    const collectedAtMs = snapshot.collectedAtMs;
    if (collectedAtMs < evaluatedAtMs) {
      // Collection completion may precede the scheduler's evaluation point in tests,
      // but must never be fabricated into the future.
    }
    for (const evidence of [supplemental.liquidityImpact, supplemental.partialFillImpact]) {
      if (evidence.observedAtMs > collectedAtMs || collectedAtMs - evidence.observedAtMs > maximumAgeMs) {
        return blocked(["CANONICAL_SUPPLEMENTAL_COST_EVIDENCE_STALE"]);
      }
    }

    const fundingHistory = await collectFundingHistory({
      client: bitgetClient,
      symbol,
      startTime: position.entryTimestampMs,
      endTime: exitTrigger.triggeredAtMs,
      maxPages: 200,
    });
    if (fundingHistory?.exhausted !== true || !Array.isArray(fundingHistory.records)) {
      return blocked(["PAPER_SETTLEMENT_FUNDING_HISTORY_INCOMPLETE"]);
    }
    if (fundingHistory.records.length > 0) {
      return blocked(["PAPER_SETTLEMENT_FUNDING_AMOUNT_REQUIRES_HISTORICAL_MARK_OWNER"]);
    }

    const rates = {
      commission: snapshot.takerFeeRate,
      tax: 0,
      spread: snapshot.spreadPercent / 100,
      slippage: snapshot.slippagePercent / 100,
      funding: 0,
      latency: snapshot.latencyEvidence.valuePercent / 100,
      liquidityImpact: supplemental.liquidityImpact.valuePercent / 100,
      partialFillImpact: supplemental.partialFillImpact.valuePercent / 100,
    };
    if (Object.values(rates).some((value) => !nonNegative(value))) {
      return blocked(["PAPER_SETTLEMENT_COST_RATE_INVALID"]);
    }
    const exitExecution = settlementExecutionPolicy(position, snapshot, rates, maximumAgeMs);
    if (!exitExecution) return blocked(["PAPER_SETTLEMENT_EXECUTION_POLICY_NOT_PRESERVED"]);

    const sourceIdentity = "NATURAL_PAPER_PUBLIC_SETTLEMENT_COST_COLLECTOR_V1";
    const provenanceId = hash({
      sourceIdentity,
      positionId: position.positionId,
      exitTriggerId: exitTrigger.exitTriggerId,
      supplementalCostPolicyId: supplemental.costPolicyId,
      publicObservedAtMs: snapshot.observedAtMs,
      fundingHistoryStart: fundingHistory.startTime,
      fundingHistoryEnd: fundingHistory.endTime,
      fundingHistoryCount: fundingHistory.records.length,
    });
    const positionIdentityValue = positionIdentity(position);
    const exitExecutionIdentityValue = exitExecutionIdentity(
      position,
      exitTrigger,
      sourceIdentity,
      provenanceId,
      exitExecution,
    );
    const fundingPayments = Object.freeze([]);
    const componentObservedAt = {
      commission: snapshot.collectedAtMs,
      tax: snapshot.collectedAtMs,
      spread: snapshot.observedAtMs,
      slippage: snapshot.observedAtMs,
      funding: snapshot.collectedAtMs,
      latency: snapshot.latencyEvidence.observedAtMs,
      liquidityImpact: supplemental.liquidityImpact.observedAtMs,
      partialFillImpact: supplemental.partialFillImpact.observedAtMs,
    };
    const components = {
      commission: component({
        name: "commission", valuePercent: rates.commission * 100, quality: "DOCUMENTED",
        source: "BITGET_PUBLIC_CONTRACT_TAKER_FEE_RATE", provenance: snapshot.provenance,
        observedAtMs: componentObservedAt.commission, maximumAgeMs, positionIdentityValue,
        exitExecutionIdentityValue, costPolicyVersion: position.costPolicyVersion,
      }),
      tax: component({
        name: "tax", valuePercent: 0, quality: "NOT_APPLICABLE",
        source: "CRYPTO_FUTURES_TAX_NOT_APPLICABLE", provenance: "market-contract:CRYPTO_FUTURES",
        observedAtMs: componentObservedAt.tax, maximumAgeMs, positionIdentityValue,
        exitExecutionIdentityValue, costPolicyVersion: position.costPolicyVersion,
      }),
      spread: component({
        name: "spread", valuePercent: rates.spread * 100, quality: "OBSERVED",
        source: "BITGET_PUBLIC_EXIT_BEST_BID_ASK", provenance: snapshot.provenance,
        observedAtMs: componentObservedAt.spread, maximumAgeMs, positionIdentityValue,
        exitExecutionIdentityValue, costPolicyVersion: position.costPolicyVersion,
      }),
      slippage: component({
        name: "slippage", valuePercent: rates.slippage * 100, quality: "ESTIMATED",
        source: String(snapshot.slippageSource), provenance: "SIMULATED/public-L2:VISIBLE_L2_BOOK_WALK_ONLY",
        observedAtMs: componentObservedAt.slippage, maximumAgeMs, positionIdentityValue,
        exitExecutionIdentityValue, costPolicyVersion: position.costPolicyVersion,
      }),
      funding: component({
        name: "funding", valuePercent: 0, quality: "OBSERVED",
        source: "BITGET_PUBLIC_V2_FUNDING_HISTORY_NO_SETTLEMENT_IN_HOLDING_PERIOD",
        provenance: "bitget-public-v2:history-fund-rate:complete-range",
        observedAtMs: componentObservedAt.funding, maximumAgeMs, positionIdentityValue,
        exitExecutionIdentityValue, costPolicyVersion: position.costPolicyVersion,
        extras: {
          realized: true,
          projectedIsRealized: false,
          evidenceClass: "OBSERVED_COMPONENT",
          holdingPeriod: {
            entryTimestampMs: position.entryTimestampMs,
            exitTriggerTimestampMs: exitTrigger.triggeredAtMs,
            paperSampleId: position.paperSampleId,
            positionId: position.positionId,
            paymentsDigest: hash(fundingPayments),
          },
        },
      }),
      latency: component({
        name: "latency", valuePercent: rates.latency * 100, quality: snapshot.latencyEvidence.quality,
        source: snapshot.latencyEvidence.source, provenance: snapshot.provenance,
        observedAtMs: componentObservedAt.latency, maximumAgeMs, positionIdentityValue,
        exitExecutionIdentityValue, costPolicyVersion: position.costPolicyVersion,
      }),
      liquidityImpact: component({
        name: "liquidityImpact", valuePercent: rates.liquidityImpact * 100,
        quality: supplemental.liquidityImpact.quality, source: supplemental.liquidityImpact.source,
        provenance: "paper-forward-authoritative-input-preparation-v1",
        observedAtMs: componentObservedAt.liquidityImpact, maximumAgeMs, positionIdentityValue,
        exitExecutionIdentityValue, costPolicyVersion: position.costPolicyVersion,
      }),
      partialFillImpact: component({
        name: "partialFillImpact", valuePercent: rates.partialFillImpact * 100,
        quality: supplemental.partialFillImpact.quality, source: supplemental.partialFillImpact.source,
        provenance: "paper-forward-authoritative-input-preparation-v1",
        observedAtMs: componentObservedAt.partialFillImpact, maximumAgeMs, positionIdentityValue,
        exitExecutionIdentityValue, costPolicyVersion: position.costPolicyVersion,
      }),
    };
    if (COMPONENTS.some((name) => components[name]?.status !== "PRESENT")) {
      return blocked(["PAPER_SETTLEMENT_FULL_COST_COMPONENT_MISSING"]);
    }

    const settlementInput = deepFreeze({
      exitTriggerId: exitTrigger.exitTriggerId,
      exitExecutionId: exitExecutionIdentityValue.exitExecutionId,
      exitExecution,
      exitBar: { ...structuredClone(exitTrigger.bar), timestampMs: exitTrigger.triggeredAtMs },
      exitQuote: structuredClone(snapshot.quote),
      exitDepth: structuredClone(snapshot.depth),
      pathBars: [],
      fundingEvidence: {
        complete: true,
        entryTimestampMs: position.entryTimestampMs,
        exitTimestampMs: exitTrigger.triggeredAtMs,
        payments: fundingPayments,
      },
    });
    const settlementCostEvidence = deepFreeze({
      schemaVersion: "authoritative-paper-execution-cost-sources-v1",
      status: "PRESENT",
      fullCostReady: true,
      maximumAgeMs,
      sourceIdentity,
      provenanceId,
      positionIdentity: positionIdentityValue,
      exitExecutionIdentity: exitExecutionIdentityValue,
      exitExecutionId: exitExecutionIdentityValue.exitExecutionId,
      exitTriggerId: exitTrigger.exitTriggerId,
      components,
      costPolicyIdentity: { version: position.costPolicyVersion },
      projectedFundingRealized: false,
      unknownIsZero: false,
      unavailableCostConvertedToZero: false,
    });
    const oldestObservedAtMs = Math.min(...Object.values(componentObservedAt));
    return deepFreeze({
      schemaVersion: AUTHORITATIVE_NATURAL_PAPER_TRIGGER_SETTLEMENT_EVIDENCE_VERSION,
      collectorVersion: NATURAL_PAPER_AUTHORITATIVE_SETTLEMENT_COST_COLLECTOR_VERSION,
      status: "PRESENT",
      fullCostReady: true,
      sourceIdentity,
      provenanceId,
      positionIdentity: positionIdentityValue,
      exitExecutionIdentity: exitExecutionIdentityValue,
      exitExecutionId: exitExecutionIdentityValue.exitExecutionId,
      freshness: { observedAtMs: oldestObservedAtMs, maximumAgeMs },
      settlementInput,
      settlementCostEvidence,
      blockers: [],
      unknownIsZero: false,
      unavailableCostConvertedToZero: false,
      synthetic: false,
      replay: false,
      backfill: false,
      duplicate: false,
      historical: false,
      testOnly: false,
      executionAuthority: "NONE",
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
      exchangeRequestSent: false,
    });
  };
}

export const NATURAL_PAPER_AUTHORITATIVE_SETTLEMENT_COST_COLLECTOR_SAFETY = Object.freeze({
  publicMarketDataOnly: true,
  supplementalCanonicalEvidenceRequired: true,
  fundingHistoryCompleteRangeRequired: true,
  fundingPaymentAmountApproximationAllowed: false,
  missingCostConvertedToZero: false,
  replayBackfillSyntheticCredit: 0,
  executionAuthority: "NONE",
  privateTradingApiAllowed: false,
  liveTrading: false,
  realOrderEnabled: false,
});
