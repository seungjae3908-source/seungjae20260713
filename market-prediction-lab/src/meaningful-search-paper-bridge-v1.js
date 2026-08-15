const SEARCH_OUTCOMES = new Set(["SEARCH_FAILURE", "VALID_NO_TRADE", "TRADE_CANDIDATES"]);
const MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);

function freeze(value) { return Object.freeze(value); }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }

function result(status, blockers = [], candidate = null) {
  return freeze({ schemaVersion: "meaningful-search-paper-bridge-v1", status, blockers: freeze([...new Set(blockers)]), candidate,
    submitToPaper: status === "PAPER_ELIGIBLE", executionAuthority: "NONE", simulatedOnly: true, liveOrderAllowed: false,
    privateTradingApiAllowed: false, orderSubmitted: false, exchangeRequestSent: false, productionMutationAllowed: false,
    profitabilityClaimAllowed: false });
}
function validateSafetyEnvelope(value, blockers, prefix) {
  if (value?.executionAuthority != null && value.executionAuthority !== "NONE") blockers.push(`${prefix}_EXECUTION_AUTHORITY_FORBIDDEN`);
  if (value?.orderSubmitted === true) blockers.push(`${prefix}_REAL_ORDER_FORBIDDEN`);
  if (value?.exchangeRequestSent === true) blockers.push(`${prefix}_EXCHANGE_REQUEST_FORBIDDEN`);
  if (value?.privateApiUsed === true || value?.privateTradingApiAllowed === true) blockers.push(`${prefix}_PRIVATE_API_FORBIDDEN`);
  if (value?.liveTrading === true || value?.liveOrderAllowed === true) blockers.push(`${prefix}_LIVE_TRADING_FORBIDDEN`);
}
function validateProfitEvidence(profitEvidence, blockers) {
  if (profitEvidence?.status !== "READY") blockers.push("PROFIT_EVIDENCE_NOT_READY");
  if (!finite(profitEvidence?.expectedNetEdge) || profitEvidence.expectedNetEdge <= 0) blockers.push("POSITIVE_NET_EDGE_EVIDENCE_REQUIRED");
  if (!finite(profitEvidence?.expectedNetReturn) || profitEvidence.expectedNetReturn <= 0) blockers.push("POSITIVE_NET_RETURN_EVIDENCE_REQUIRED");
  if (!finite(profitEvidence?.riskRewardRatio) || profitEvidence.riskRewardRatio < 1) blockers.push("RISK_REWARD_EVIDENCE_REQUIRED");
  if (!Number.isInteger(profitEvidence?.sampleSize) || profitEvidence.sampleSize <= 0) blockers.push("FORWARD_SAMPLE_EVIDENCE_REQUIRED");
  if (!nonEmpty(profitEvidence?.costPolicyId)) blockers.push("COST_POLICY_EVIDENCE_REQUIRED");
  validateSafetyEnvelope(profitEvidence, blockers, "PROFIT_EVIDENCE");
}
function validateCandidate(candidate, blockers) {
  const signal = candidate?.signal;
  if (!signal || !nonEmpty(signal.signalId)) blockers.push("SIGNAL_ID_REQUIRED");
  if (!MARKETS.has(signal?.market)) blockers.push("MARKET_UNSUPPORTED");
  if (!nonEmpty(signal?.symbol)) blockers.push("SYMBOL_REQUIRED");
  if (!finite(signal?.timestampMs)) blockers.push("SIGNAL_TIMESTAMP_REQUIRED");
  if (!signal?.learningSnapshot || signal.learningSnapshot.signalId !== signal.signalId) blockers.push("LEARNING_SNAPSHOT_REQUIRED");
  if (candidate?.riskEvidence?.status !== "APPROVED" || candidate?.riskEvidence?.simulatedOnly !== true) blockers.push("RISK_EVIDENCE_NOT_APPROVED");
  if (candidate?.execution?.dataEvidence?.dataQuality !== "READY") blockers.push("BLOCKED_DATA");
  validateSafetyEnvelope(candidate, blockers, "CANDIDATE");
}
export function prepareMeaningfulSearchPaperCandidate({ searchOutcome, candidate, profitGate, profitEvidence } = {}) {
  if (!SEARCH_OUTCOMES.has(searchOutcome)) throw new TypeError("valid searchOutcome is required");
  if (searchOutcome === "SEARCH_FAILURE") return result("BLOCKED", ["SEARCH_FAILURE"]);
  if (searchOutcome === "VALID_NO_TRADE") return result("NO_TRADE", ["VALID_NO_TRADE"]);
  const gateReasons = Array.isArray(profitGate?.reasons) ? profitGate.reasons.filter(nonEmpty) : [];
  if (profitGate?.decision !== "ELIGIBLE" || profitGate?.eligible !== true) return result("NO_TRADE", gateReasons.length ? gateReasons : ["PROFIT_GATE_NOT_ELIGIBLE"]);
  if (profitGate?.executionAuthority !== "NONE") return result("BLOCKED", ["PROFIT_GATE_EXECUTION_AUTHORITY_FORBIDDEN"]);
  const blockers = [];
  validateProfitEvidence(profitEvidence, blockers); validateCandidate(candidate, blockers);
  if (blockers.length) return result("BLOCKED", blockers);
  const paperCandidate = freeze({ ...candidate, profitGate: freeze({ decision: "ELIGIBLE", eligible: true, reasons: freeze([]), executionAuthority: "NONE" }), profitEvidence: freeze({ ...profitEvidence, executionAuthority: "NONE" }) });
  return result("PAPER_ELIGIBLE", [], paperCandidate);
}
export function meaningfulSearchPaperCandidates(decisions = []) {
  if (!Array.isArray(decisions)) throw new TypeError("decisions array is required");
  const results = decisions.map((decision) => prepareMeaningfulSearchPaperCandidate(decision));
  return freeze({ results: freeze(results), candidates: freeze(results.filter((row) => row.submitToPaper).map((row) => row.candidate)), blocked: results.filter((row) => row.status === "BLOCKED").length, noTrade: results.filter((row) => row.status === "NO_TRADE").length, eligible: results.filter((row) => row.status === "PAPER_ELIGIBLE").length, executionAuthority: "NONE", liveTrading: false, realOrder: false, privateApi: false });
}
