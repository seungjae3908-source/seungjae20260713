import {createHash} from "node:crypto";
import {resolveCanonicalPaperAdmissionBridgeCandidate} from
  "./canonical-paper-admission-bridge-v1.js";
import {evaluateUnifiedProfitabilityPromotion} from
  "./unified-profitability-promotion-gate-v1.js";

/**
 * PURE read-only connector from existing retrospective original-minute
 * PERIOD/SWEEP outputs to existing canonical profitability/Paper gates.
 * In particular, a retrospective candle-price model is NEVER a
 * prospective scanner signal, independently frozen OOS test, authoritative
 * fee/fill cost receipt or an admissible Paper order.
 *
 * No simulated order execution, candidate registry mutation, provider GET,
 * network, Paper Journal, Telegram or broker account access.
 */
const VERSION="four-market-original-minute-candidate-review-v1";
const PERIOD="four-market-original-minute-period-v1";
const SWEEP="four-market-original-minute-sweep-v1";
const SHA=/^[0-9a-f]{64}$/u;
const SYMBOL=/^[A-Z0-9][A-Z0-9._:-]{0,39}$/u;
const MARKETS=new Set(["KR_STOCK","US_STOCK","CRYPTO_SPOT","CRYPTO_FUTURES"]);
const REQUIRED=Object.freeze([
  "INDEPENDENT_WHOLE_VENUE_HISTORICAL_PIT_ROSTER_MISSING",
  "SOURCE_CALENDAR_AND_NATIVE_ONE_MINUTE_ENTITLEMENTS_UNVERIFIED",
  "ORIGINAL_TIME_T_MINUS_SCANNER_SIGNAL_UNVERIFIED",
  "FROZEN_STRATEGY_AND_INDEPENDENT_OOS_UNVERIFIED",
  "DATED_FX_FEES_FUNDING_LIQUIDITY_SLIPPAGE_FILLS_UNVERIFIED",
  "FUTURE_PROSPECTIVE_SIGNAL_UNVERIFIED",
  "AUTOMATIC_PAPER_FILL_SETTLEMENT_JOURNAL_TELEGRAM_UNVERIFIED",
]);
const fail=why=>{throw new TypeError(why);};
const validDay=d=>typeof d==="string"&&/^\d{4}-\d{2}-\d{2}$/u.test(d)
  &&Number.isFinite(Date.parse(d+"T00:00:00Z"))
  &&new Date(d+"T00:00:00Z").toISOString().slice(0,10)===d;
const count=n=>Number.isSafeInteger(n)&&n>=0;
const finite=n=>typeof n==="number"&&Number.isFinite(n);
function assertRetrospectiveSafe(o){
  return o?.executionAuthority==="NONE"
    &&o.profitabilityProven===false
    &&o.paperAdmissionAllowed===false
    &&o.realOrders===false
    &&o.liveTrading===false&&o.autoTrading===false
    &&o.actualFillCount===null&&o.trueMarketWideRecall===null
    &&o.OOSPassCount===0
    &&o.actualMarketWideOpportunityCount===null
    &&o.fullMarketOpportunityDenominatorVerified===false
    &&(o.providerGETCount===undefined||o.providerGETCount===0)
    &&o.orderSubmitted!==true
    &&o.automaticPaperExecution!==true;
}
function validSelection(o,market){
  return o?.market===market
    &&validDay(o.selectedStartDate)
    &&validDay(o.selectedEndDate)
    &&o.selectedStartDate<=o.selectedEndDate
    &&assertRetrospectiveSafe(o);
}
function status({reason,blockers,market,symbol,period,sweep,nowMs}){
  const root={
    market,symbol,period:[period?.selectedStartDate??null,
      period?.selectedEndDate??null],
    periodSourceDigest:period?.sourceSessionIndexDigestSha256??null,
    sweepDigest:sweep?.pageChainSha256??null,
    // The fingerprint is only a local research reference, not a canonical
    // approved formula ID, an order key, or independently verified source.
    schemaVersion:VERSION,
  };
  const diagnosticFingerprint=createHash("sha256")
    .update(JSON.stringify(root)).digest("hex");
  const profit=evaluateUnifiedProfitabilityPromotion({
    strategyFingerprint:diagnosticFingerprint,
    backtest:{
      strategyFingerprint:diagnosticFingerprint,
      lineageValid:false,
      finalHoldoutStatus:"NOT_PROVEN",
      finalHoldoutRetuned:null,
    },
    selectionBias:null,
    shadow:null,
    paper:null,
    policy:null,
  });
  // No canonical current-time risk/data/learning/cost bundle is supplied by
  // the retrospective source archive. Never forge a passing bundle.
  const paper=resolveCanonicalPaperAdmissionBridgeCandidate({
    bundle:null,nowMs,maxEvidenceAgeMs:30_000,
  });
  if(profit.promotionEligible!==false||paper.bridgeReady!==false
    ||paper.candidate!==null)
    fail("ORIGINAL_MODEL_CANONICAL_PAPER_GATE_POLICY_UNEXPECTED");
  return Object.freeze({
    schemaVersion:VERSION,
    market,symbol,
    status:"RESEARCH_HOLD",reason,
    diagnosticFingerprint,
    periodStatus:period?.status??"NOT_CONNECTED",
    sweepStatus:sweep?.status??"NOT_CONNECTED",
    independentBacktestAndOOSPASS:false,
    canonicalProfitabilityStatus:profit.status,
    canonicalProfitabilityEligible:false,
    canonicalProfitabilityBlockers:Object.freeze([...profit.reasons]),
    canonicalPaperBridgeStatus:paper.status,
    canonicalPaperEvidenceReady:false,
    canonicalPaperBridgeBlockers:Object.freeze([...paper.blockers]),
    blockers:Object.freeze([...new Set(blockers)]),
    modelOnly:true,
    paperCandidate:null,
    sampleExecutionReady:false,
    paperAdmissionAllowed:false,
    profitabilityProven:false,
    executionAuthority:"NONE",
    realOrders:false,orderSubmitted:false,
    privateTradingApiAllowed:false,
    paperOrderSubmitted:false,providerGETCount:0,
    financialMutationCount:0,
    actualFillCount:null,netProfitPct:null,
    trueMarketWideRecall:null,OOSPassCount:0,
    simulatedFillEvidenceVerified:false,
  });
}
export function reviewOriginalMinuteForCanonicalPaperV1({
  market,symbol,periodResult=null,sweepResult=null,
  nowMs=Date.now(),
}={}){
  if(!MARKETS.has(market)||!SYMBOL.test(symbol??"")
    ||!Number.isSafeInteger(nowMs)||nowMs<1)
    fail("ORIGINAL_MODEL_PAPER_REVIEW_SCOPE_INVALID");
  const blockers=[...REQUIRED];
  let period=null,sweep=null;
  if(periodResult!==null){
    if(!validSelection(periodResult,market)
      ||periodResult.schemaVersion!==PERIOD
      ||!["SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY","BLOCKED_DATA"]
        .includes(periodResult.status)
      ||periodResult.symbol!==symbol)
      fail("ORIGINAL_MODEL_PAPER_REVIEW_PERIOD_UNSAFE");
    period=periodResult;
    if(period.status!=="SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY")
      blockers.push("ORIGINAL_ONE_MINUTE_PERIOD_SOURCE_BLOCKED");
    else if(!SHA.test(period.sourceSessionIndexDigestSha256??"")
      ||!count(period.indexedPrivateSessions)
      ||period.indexedPrivateSessions===0
      ||period.verifiedNativeMinuteSessions!==period.indexedPrivateSessions
      ||!finite(period.modeledReturnPercent)
      ||!finite(period.modeledNetPnlKRW)
      ||!count(period.modeledTradeCount))
      blockers.push("ORIGINAL_ONE_MINUTE_MODEL_LINEAGE_OR_COUNTER_UNVERIFIED");
  }else blockers.push("ORIGINAL_ONE_MINUTE_PERIOD_REPORT_REQUIRED");
  if(sweepResult!==null){
    if(!validSelection(sweepResult,market)
      ||sweepResult.schemaVersion!==SWEEP
      ||!["LOCAL_HISTORIC_SOURCE_PAGES_TRAVERSED_RESEARCH_ONLY",
        "BLOCKED_DATA"].includes(sweepResult.status))
      fail("ORIGINAL_MODEL_PAPER_REVIEW_SWEEP_UNSAFE");
    sweep=sweepResult;
    if(sweep.status!=="LOCAL_HISTORIC_SOURCE_PAGES_TRAVERSED_RESEARCH_ONLY")
      blockers.push("HISTORIC_WHOLE_VENUE_PIT_SWEEP_BLOCKED");
    else if(!SHA.test(sweep.pageChainSha256??"")
      ||!count(sweep.pageCountSelfAttested)
      ||sweep.pageCountSelfAttested===0
      ||sweep.sourceOnlyCompletePages!==sweep.pageCountSelfAttested
      ||sweep.sourceBlockedPages!==0
      ||!count(sweep.sourceOnlyObservedPriceEventLabels)
      ||sweep.localPageTraversalReachedEnd!==true)
      blockers.push("HISTORIC_PIT_SWEEP_LINEAGE_OR_COMPLETENESS_UNVERIFIED");
  }else blockers.push("HISTORIC_WHOLE_VENUE_PIT_SWEEP_REQUIRED");
  if(period&&sweep
    &&(period.selectedStartDate!==sweep.selectedStartDate
      ||period.selectedEndDate!==sweep.selectedEndDate))
    blockers.push("PERIOD_SWEEP_SELECTED_DATE_WINDOW_MISMATCH");
  return status({
    reason:"RETROSPECTIVE_NATIVE_ONE_MINUTE_IS_NOT_CANONICAL_PAPER_EVIDENCE",
    blockers,market,symbol,period,sweep,nowMs,
  });
}
