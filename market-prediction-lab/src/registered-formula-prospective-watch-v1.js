import { createHash } from 'node:crypto';
import { createEvidenceBackedFormulaSignalEvaluatorV1 } from './evidence-backed-formula-entry-evaluator-v1.js';

export const REGISTERED_FORMULA_PROSPECTIVE_WATCH_VERSION = 'registered-formula-prospective-watch/v1';
const MARKETS = new Set(['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES']);
const CASH = new Set(['KR_STOCK','US_STOCK','CRYPTO_SPOT']);
const SHA40 = /^[a-f0-9]{40}$/u;
const SHA64 = /^[a-f0-9]{64}$/u;
const SYMBOL = /^[A-Z0-9][A-Z0-9._-]{0,31}$/u;
const DURATIONS = {'1m':60_000,'3m':180_000,'5m':300_000,'15m':900_000,'60m':3_600_000,'4H':14_400_000,'1D':86_400_000};
const obj = x => x != null && typeof x === 'object' && !Array.isArray(x);
const time = x => Number.isSafeInteger(x) && x > 0;
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const positive = x => typeof x === 'number' && Number.isFinite(x) && x > 0;
function sorted(x) {
  if (Array.isArray(x)) return x.map(sorted);
  if (!obj(x)) return x;
  return Object.fromEntries(Object.keys(x).sort().map(k=>[k,sorted(x[k])]));
}
function directionAllowed(market, direction) {
  return CASH.has(market) ? direction === 'LONG' :
    market === 'CRYPTO_FUTURES' && ['LONG','SHORT'].includes(direction);
}
function result(input,status,reason,signal=null) {
  return Object.freeze({
    contract:REGISTERED_FORMULA_PROSPECTIVE_WATCH_VERSION,status,reason,
    market:MARKETS.has(input?.market)?input.market:null,
    symbol:SYMBOL.test(input?.symbol??'')?input.symbol:null,
    direction:directionAllowed(input?.market,input?.direction)?input.direction:null,
    registryId:SHA64.test(input?.entry?.registryId??'')?input.entry.registryId:null,
    observedSignalAtMs:signal?.atMs??null,observationId:signal?.id??null,
    observedClosedCandleSignal:status==='OBSERVED_CLOSED_CANDLE_SIGNAL',
    // This pure diagnostic does not attest registry file ownership, market
    // source rights, forward profit, canonical admission or any order.
    independentRegistryProvenanceVerified:false,independentProviderProvenanceVerified:false,
    historicalBacktestPassIsEntry:false,oosVerified:false,walkForwardVerified:false,
    fullCostReady:false,canonicalPaperAdmissionVerified:false,paperDispatchAllowed:false,
    autoTrading:false,liveTrading:false,profitabilityProven:false,
    orderCount:0,privateRequestCount:0,financialMutationCount:0,
    candidateCredit:0,economicEvidenceCredit:0,executionAuthority:'NONE',
  });
}
function registryEntryValid(entry,sha,market,direction,timeframe) {
  if (!obj(entry)||!SHA40.test(sha??'')||entry.researchCodeSha!==sha
    ||entry.source!=='FORMULA_AUTO_BACKTEST_PASS'
    ||entry.paperState!=='REGISTERED_WAITING_FUTURE_SIGNAL'
    ||entry.futureSignalRequired!==true||entry.freshPublicEvidenceRequired!==true
    ||entry.canonicalPaperAdmissionRequired!==true||entry.simulationAuthorityRequired!==true
    ||entry.directTradeOnBacktestPass!==false||entry.enabledForPaperEvaluation!==true
    ||entry.liveTrading!==false||entry.autoTrading!==false
    ||entry.realOrder!==false||entry.privateTradingApi!==false
    ||entry.executionAuthority!=='NONE'
    ||!SHA64.test(entry.itemDigest??'')||!SHA64.test(entry.registryId??'')
    ||!SHA64.test(entry.parameterIdentity??'')
    ||entry.market!==market||entry.direction!==direction||entry.timeframe!==timeframe) return false;
  const formula=entry.formulaCandidate,generated=entry.generatedCandidate;
  if (!obj(formula)||!obj(generated)||!directionAllowed(market,direction)
    ||formula.market!==market||formula.direction!==direction||formula.timeframe!==timeframe
    ||formula.entryDsl?.action!==direction||formula.formulaHash!==entry.strategyHash
    ||formula.candidateId!==entry.formulaCandidateId
    ||generated.formulaCandidateId!==formula.candidateId
    ||generated.formulaHash!==formula.formulaHash
    ||generated.generatedCandidateId!==entry.generatedCandidateId
    ||generated.parameterIdentity!==entry.parameterIdentity
    ||generated.safety?.executionAuthority!=='NONE') return false;
  return digest(sorted({
    itemDigest:entry.itemDigest,formulaCandidateId:entry.formulaCandidateId,
    generatedCandidateId:entry.generatedCandidateId,parameterIdentity:entry.parameterIdentity,
  }))===entry.registryId;
}
/** Causal observation only: the last candle must close strictly AFTER
 * registration; no next-open order is created even when the DSL fires. */
export function observeRegisteredFormulaClosedCandleV1(input={}) {
  const {entry,market,direction,symbol,timeframe,researchCodeSha,candles,
    publicEvidence,evaluatedAtMs=Date.now()}=input;
  const block=reason=>result(input,'BLOCKED_DATA',reason);
  if (!MARKETS.has(market)||!directionAllowed(market,direction)
    ||!SYMBOL.test(symbol??'')||!Object.hasOwn(DURATIONS,timeframe??'')) {
    return block('FORMULA_WATCH_SCOPE_INVALID');
  }
  if (!time(evaluatedAtMs)||!registryEntryValid(entry,researchCodeSha,market,direction,timeframe))
    return block('FORMULA_WATCH_REGISTRY_IDENTITY_INVALID');
  const registeredAt=Date.parse(entry.registeredAt??'');
  if (!time(registeredAt)||registeredAt>evaluatedAtMs)
    return block('FORMULA_WATCH_REGISTERED_AT_INVALID');
  if (!obj(publicEvidence)||publicEvidence.publicOnly!==true
    ||publicEvidence.dataQuality!=='READY'
    ||typeof publicEvidence.source!=='string'
    ||!/^[A-Z0-9_-]{3,64}$/iu.test(publicEvidence.source)
    ||!time(publicEvidence.asOfMs)||!time(publicEvidence.maxAgeMs)
    ||publicEvidence.maxAgeMs>600_000
    ||publicEvidence.asOfMs>evaluatedAtMs
    ||evaluatedAtMs-publicEvidence.asOfMs>publicEvidence.maxAgeMs)
    return block('FORMULA_WATCH_PUBLIC_QUOTE_STALE_OR_MISSING');
  if (!Array.isArray(candles)||candles.length<3||candles.length>1000)
    return block('FORMULA_WATCH_CANDLE_WINDOW_UNAVAILABLE');
  const interval=DURATIONS[timeframe];
  let previous=-1;
  for(const candle of candles) {
    if (!obj(candle)||!time(candle.timestamp)||candle.timestamp<=previous
      ||candle.isClosed!==true
      ||!['open','high','low','close'].every(k=>positive(candle[k]))
      ||typeof candle.volume!=='number'||!Number.isFinite(candle.volume)||candle.volume<0
      ||candle.low>candle.high||candle.open<candle.low||candle.open>candle.high
      ||candle.close<candle.low||candle.close>candle.high
      ||candle.timestamp+interval>evaluatedAtMs) {
      return block('FORMULA_WATCH_OPEN_FUTURE_OR_INVALID_CANDLE');
    }
    previous=candle.timestamp;
  }
  const last=candles.at(-1),closedAt=last.timestamp+interval;
  if (closedAt<=registeredAt) return block('FORMULA_WATCH_HISTORICAL_REPLAY_FORBIDDEN');
  if (publicEvidence.asOfMs<closedAt||evaluatedAtMs-closedAt>600_000)
    return block('FORMULA_WATCH_LATEST_CANDLE_STALE');
  let signal;
  try {
    const {signalEvaluator,evaluatorContract}=createEvidenceBackedFormulaSignalEvaluatorV1({
      formulaCandidate:entry.formulaCandidate,generatedCandidate:entry.generatedCandidate,
    });
    if (evaluatorContract.executionAuthority!=='NONE'
      ||evaluatorContract.closedCandleSignalOnly!==true
      ||evaluatorContract.entryUsesNextCandleOpen!==true)
      return block('FORMULA_WATCH_EVALUATOR_AUTHORITY_INVALID');
    signal=signalEvaluator({market,side:direction==='SHORT'?'short':'long',timeframe,
      candles,index:candles.length-1});
  } catch {
    return block('FORMULA_WATCH_CANONICAL_DSL_REJECTED');
  }
  if (!signal) return result(input,'NO_SIGNAL','FORMULA_RULES_NOT_MET');
  if (signal.closedCandleOnly!==true||signal.nextOpenExecutionExpected!==true
    ||signal.signalTimestamp!==last.timestamp
    ||signal.formulaHash!==entry.strategyHash
    ||signal.parameterIdentity!==entry.parameterIdentity)
    return block('FORMULA_WATCH_EVALUATOR_SIGNAL_IDENTITY_INVALID');
  const id=digest(sorted({
    registryId:entry.registryId,researchCodeSha,market,symbol,direction,timeframe,
    source:publicEvidence.source,asOfMs:publicEvidence.asOfMs,
    bars:candles.map(c=>[c.timestamp,c.open,c.high,c.low,c.close,c.volume]),
  }));
  return result(input,'OBSERVED_CLOSED_CANDLE_SIGNAL',
    'PUBLIC_FORMULA_SIGNAL_ONLY_NO_PAPER_ORDER',{atMs:closedAt,id});
}
