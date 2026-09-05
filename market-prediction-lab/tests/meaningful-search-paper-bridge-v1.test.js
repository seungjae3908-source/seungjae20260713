import assert from "node:assert/strict";
import test from "node:test";
import { meaningfulSearchPaperCandidates, prepareMeaningfulSearchPaperCandidate } from "../src/meaningful-search-paper-bridge-v1.js";
import { createRecurringPaperLoopState, runRecurringPaperCycle } from "../src/recurring-paper-loop-v1.js";
import { FOUR_MARKET_EXECUTION_PROFILES } from "../src/four-market-execution-v2.js";

const T0 = 1_800_000_000_000;
const SHA = "b".repeat(40);
const identity = Object.freeze({ strategyId: "meaningful-search-profit-first-v1", strategyVersion: "v1", parameterHash: "params-v1", researchCodeSha: SHA, costPolicyVersion: "cost-v1", executionPolicyVersion: "execution-v1" });
function ledger() { return { status: "READY", initialCapitalKrw: 1_000_000, baseCurrency: "KRW", knownEquityKrw: 1_000_000, totalEquityKrw: 1_000_000, simulatedOnly: true, liveOrderAllowed: false, privateTradingApiAllowed: false, orderSubmitted: false, exchangeRequestSent: false }; }
function execution(market, now = T0) {
  const profile = FOUR_MARKET_EXECUTION_PROFILES[market];
  const dataEvidence = { provider: profile.provider, publicOnly: true, dataQuality: "READY", provenance: "meaningful-search-public-fixture", asOfMs: now - 1, maxAgeMs: 60_000, quoteEvidence: { available: true, bid: 99, ask: 100, asOfMs: now - 1, maxAgeMs: 60_000 } };
  if (market === "KR_STOCK") Object.assign(dataEvidence, { tickSize: 1, taxPolicyKnown: true, session: { version: "krx-v1", status: "OPEN" }, volatilityInterruptionKnown: true, volatilityInterruptionActive: false });
  if (market === "US_STOCK") Object.assign(dataEvidence, { tickSize: 0.01, taxPolicyKnown: true, session: { version: "us-v1", status: "OPEN", kind: "REGULAR" } });
  if (market === "CRYPTO_SPOT") Object.assign(dataEvidence, { marketStatus: "TRADABLE", tickSize: 1, minOrderNotional: 5_000 });
  if (market === "CRYPTO_FUTURES") Object.assign(dataEvidence, { contractStatus: "TRADABLE", tickSize: 0.1, minQty: 0.001, qtyStep: 0.001, markPrice: 100, indexPrice: 100, fundingRate: 0, openInterest: 1, leverage: 2, maxLeverage: 20, marginMode: "ISOLATED", liquidationDistancePct: 20 });
  return { marketAdapterIdentity: profile.marketAdapter, strategyIdentity: identity, costPolicy: { version: "cost-v1", commissionRate: 0.001, taxRate: 0, spreadRate: 0, slippageRate: 0, latencyRate: 0, liquidityImpactRate: 0, partialFillImpactRate: 0, fundingRate: 0 }, executionPolicy: { version: "execution-v1", fillModel: "TOP_OF_BOOK", sameBarPolicy: "STOP_FIRST", allowPartialFill: true, maxParticipationRate: 1 }, dataEvidence };
}
function learningSnapshot(market, id, direction, now = T0) {
  const timestampMs = now - 2;
  return { signalId: id, timestamp: new Date(timestampMs).toISOString(), market, symbol: `${market}:${id}`, symbolName: null, strategyHorizon: "SWING", direction, signalScore: 75, displayConfidence: null, referencePrice: 100, entryPrice: 100, stopLoss: null, target1: null, target2: null, riskReward: null, timeframes: ["1h"], strategyProfileVersion: identity.strategyVersion, indicatorSnapshot: {}, indicatorScores: {}, patternSnapshot: {}, volumeContext: {}, volatilityContext: {}, trendContext: {}, marketRegime: "UNKNOWN", liquidityContext: {}, aiValidatorResult: null, riskEngineResult: null, dataProvenance: ["meaningful-search-public-fixture"], dataTimestamp: new Date(timestampMs - 1).toISOString(), immutable: true, executionAuthority: "NONE" };
}
function candidate(market, id, direction = market === "CRYPTO_FUTURES" ? "LONG" : "BUY") {
  return { signal: { signalId: id, market, symbol: `${market}:${id}`, timestampMs: T0 - 2, style: "SWING", timeframe: "1h", horizon: 4, direction, strategyIdentity: identity, learningSnapshot: learningSnapshot(market, id, direction) }, riskEvidence: { status: "APPROVED", evaluatedAtMs: T0 - 1, simulatedOnly: true }, execution: execution(market), order: { type: "MARKET", quantity: 1, direction }, quote: { bid: 99, ask: 100, bidSize: 10, askSize: 10, asOfMs: T0 - 1, maxAgeMs: 60_000 } };
}
function eligibleDecision(market, id) { return { searchOutcome: "TRADE_CANDIDATES", candidate: candidate(market, id), profitGate: { decision: "ELIGIBLE", eligible: true, reasons: [], executionAuthority: "NONE" }, profitEvidence: { status: "READY", expectedNetEdge: 0.5, expectedNetReturn: 0.8, riskRewardRatio: 1.5, sampleSize: 30, costPolicyId: "cost-v1", executionAuthority: "NONE" } }; }
function harness() {
  let entries = 0; let learned = 0;
  const state = createRecurringPaperLoopState({ identity, ledger: ledger(), createdAtMs: T0 - 10 });
  return { state, ledgerAdapter: { async applyEntry({ ledger: current }) { entries += 1; return current; }, async applySettlement({ ledger: current }) { return current; } }, learningAdapter: { async persistSignal() { learned += 1; }, async persistOutcome() {} }, stateStore: { async save() {} }, counts: () => ({ entries, learned }) };
}

test("SEARCH_FAILURE never enters Paper", () => { const row = prepareMeaningfulSearchPaperCandidate({ searchOutcome: "SEARCH_FAILURE" }); assert.equal(row.status, "BLOCKED"); assert.equal(row.submitToPaper, false); assert.deepEqual(row.blockers, ["SEARCH_FAILURE"]); });
test("VALID_NO_TRADE and Profit Gate rejection create zero Paper candidates", () => {
  const result = meaningfulSearchPaperCandidates([{ searchOutcome: "VALID_NO_TRADE" }, { searchOutcome: "TRADE_CANDIDATES", candidate: candidate("KR_STOCK", "cost-missing"), profitGate: { decision: "NO_TRADE", eligible: false, reasons: ["COST_NOT_EVIDENCED"], executionAuthority: "NONE" }, profitEvidence: { status: "NOT_EVIDENCED" } }, { searchOutcome: "TRADE_CANDIDATES", candidate: candidate("US_STOCK", "uncalibrated"), profitGate: { decision: "NO_TRADE", eligible: false, reasons: ["UNCALIBRATED_PROBABILITY"], executionAuthority: "NONE" }, profitEvidence: { status: "INSUFFICIENT_SAMPLE" } }]);
  assert.equal(result.candidates.length, 0); assert.equal(result.noTrade, 3); assert.equal(result.eligible, 0); assert.equal(result.liveTrading, false);
});
test("READY evidence with non-positive edge cannot bypass the bridge", () => { const row = prepareMeaningfulSearchPaperCandidate({ ...eligibleDecision("CRYPTO_SPOT", "bad-edge"), profitEvidence: { status: "READY", expectedNetEdge: 0, expectedNetReturn: 0.8, riskRewardRatio: 1.5, sampleSize: 30, costPolicyId: "cost-v1", executionAuthority: "NONE" } }); assert.equal(row.status, "BLOCKED"); assert.ok(row.blockers.includes("POSITIVE_NET_EDGE_EVIDENCE_REQUIRED")); });
test("four-market ELIGIBLE decisions feed the canonical recurring Paper loop exactly once", async () => {
  const bridged = meaningfulSearchPaperCandidates([eligibleDecision("KR_STOCK", "kr"), eligibleDecision("US_STOCK", "us"), eligibleDecision("CRYPTO_SPOT", "spot"), eligibleDecision("CRYPTO_FUTURES", "futures")]); assert.equal(bridged.candidates.length, 4); const h = harness();
  const first = await runRecurringPaperCycle({ state: h.state, cycle: { cycleId: "meaningful-search-cycle-1", evaluatedAtMs: T0, identity }, candidates: bridged.candidates, ledgerAdapter: h.ledgerAdapter, learningAdapter: h.learningAdapter, stateStore: h.stateStore }); assert.equal(first.summary.entries, 4); assert.deepEqual(h.counts(), { entries: 4, learned: 4 });
  const replay = await runRecurringPaperCycle({ state: first.state, cycle: { cycleId: "meaningful-search-cycle-2", evaluatedAtMs: T0 + 1, identity }, candidates: bridged.candidates, ledgerAdapter: h.ledgerAdapter, learningAdapter: h.learningAdapter, stateStore: h.stateStore }); assert.equal(replay.summary.entries, 0); assert.deepEqual(h.counts(), { entries: 4, learned: 4 });
});
test("private/live execution markers fail closed before Paper", () => { const unsafe = eligibleDecision("CRYPTO_FUTURES", "unsafe"); unsafe.candidate.privateApiUsed = true; unsafe.candidate.liveTrading = true; const row = prepareMeaningfulSearchPaperCandidate(unsafe); assert.equal(row.status, "BLOCKED"); assert.equal(row.submitToPaper, false); assert.ok(row.blockers.includes("CANDIDATE_PRIVATE_API_FORBIDDEN")); assert.ok(row.blockers.includes("CANDIDATE_LIVE_TRADING_FORBIDDEN")); });
