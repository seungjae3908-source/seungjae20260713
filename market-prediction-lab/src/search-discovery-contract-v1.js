const MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const BLOCKED_DATA_STATES = new Set(["unavailable", "untrusted"]);
const NON_DISCOVERY_ACTIONS = new Set(["NO_TRADE", "NONE", "UNKNOWN"]);

function freeze(value) { return Object.freeze(value); }
function text(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function upper(value) { return text(value)?.toUpperCase() ?? null; }

function directionFromCard(card) {
  const action = upper(card?.action ?? card?.signalDirection ?? card?.direction);
  if (action === "BUY" || action === "LONG") return "LONG";
  if (action === "SHORT") return "SHORT";
  if (action === "SELL") return "SELL";
  if (action === "NEUTRAL") return "NEUTRAL";
  return "UNSPECIFIED";
}

function uniqueReasons(values) {
  return freeze([...new Set((values ?? []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))]);
}

export function buildSearchDiscoveryCandidate({ market, card, profitGate = null, profitEvidence = null } = {}) {
  if (!MARKETS.has(market)) throw new TypeError("supported market is required");
  if (!card || typeof card !== "object") throw new TypeError("card is required");

  const action = upper(card.action ?? card.signalDirection ?? card.direction);
  const dataState = text(card.dataState)?.toLowerCase() ?? null;
  const hardFilterPassed = card?.candidateRanking?.hardFilterPassed !== false;
  const dataTrusted = !BLOCKED_DATA_STATES.has(dataState) && card?.dataQuality?.state !== "DATA_UNTRUSTED";
  const explicitNoSignal = action != null && NON_DISCOVERY_ACTIONS.has(action);
  const visibleInSearch = hardFilterPassed && dataTrusted && !explicitNoSignal;

  const tradingBlockers = [];
  if (profitGate?.eligible !== true) {
    const gateReasons = Array.isArray(profitGate?.reasons) ? profitGate.reasons : [];
    tradingBlockers.push(...(gateReasons.length ? gateReasons : ["PROFIT_GATE_NOT_ELIGIBLE"]));
  }
  if (profitEvidence && profitEvidence.status !== "READY") tradingBlockers.push("PROFIT_EVIDENCE_NOT_READY");

  return freeze({
    schemaVersion: "search-discovery-contract-v1",
    status: visibleInSearch ? "DISCOVERED" : "NOT_DISCOVERABLE",
    visibleInSearch,
    market,
    symbol: text(card.symbol ?? card.ticker),
    signalId: text(card.signalId),
    strategyMode: upper(card.strategyMode),
    signalGrade: upper(card.signalGrade),
    direction: directionFromCard(card),
    score: Number.isFinite(card.score) ? card.score : null,
    confidence: Number.isFinite(card.confidence) ? card.confidence : null,
    observedAt: text(card.observedAt),
    expiresAt: text(card.expiresAt),
    discoveryBlockers: uniqueReasons([
      ...(hardFilterPassed ? [] : ["HARD_FILTER_NOT_PASSED"]),
      ...(dataTrusted ? [] : ["DATA_NOT_TRUSTED"]),
      ...(explicitNoSignal ? ["EXPLICIT_NO_SIGNAL"] : []),
    ]),
    tradingBlockers: uniqueReasons(tradingBlockers),
    paperEligible: visibleInSearch && profitGate?.eligible === true,
    autoTradeEligible: false,
    searchVisibilityDependsOnProfitGate: false,
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveTrading: false,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    profitabilityClaimAllowed: false,
  });
}

export function buildSearchDiscoverySnapshot(rows = []) {
  if (!Array.isArray(rows)) throw new TypeError("rows array is required");
  const candidates = rows.filter((row) => row?.visibleInSearch === true);
  return freeze({
    schemaVersion: "search-discovery-snapshot-v1",
    candidates: freeze([...candidates]),
    discoveryCandidateCount: candidates.length,
    paperEligibleCount: candidates.filter((row) => row.paperEligible === true).length,
    autoTradeEligibleCount: 0,
    searchVisibilityDependsOnProfitGate: false,
    executionAuthority: "NONE",
    liveTrading: false,
    realOrder: false,
    privateApi: false,
  });
}
