import { createHash } from 'node:crypto';
import { createEvidenceBackedFormulaSignalEvaluatorV1 } from './evidence-backed-formula-entry-evaluator-v1.js';

export const REGISTERED_FORMULA_PROSPECTIVE_WATCH_VERSION = 'registered-formula-prospective-watch/v1';
const MARKETS = new Set(['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES']);
const CASH = new Set(['KR_STOCK','US_STOCK','CRYPTO_SPOT']);
const SHA40 = /^[a-f0-9]{40}$/u;
const SHA64 = /^[a-f0-9]{64}$/u;
const SYMBOL = /^[A-Z0-9][A-Z0-9._-]{0,31}$/u;
const DURATIONS = {'1m':60_000,'3m':180_000,'5m':300_000,'15m':900_000,'30m':1_800_000,'1h':3_600_000,'4h':14_400_000,'1d':86_400_000,'1wk':604_800_000};
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
  const researchPaperCandidate=input?.entry?.source==='FORMULA_RESEARCH_BACKTEST_CANDIDATE';
  return Object.freeze({
    contract:REGISTERED_FORMULA_PROSPECTIVE_WATCH_VERSION,status,reason,
    market:MARKETS.has(input?.market)?input.market:null,
    symbol:SYMBOL.test(input?.symbol??'')?input.symbol:null,
    direction:directionAllowed(input?.market,input?.direction)?input.direction:null,
    registryId:SHA64.test(input?.entry?.registryId??'')?input.entry.registryId:null,
    observedSignalAtMs:signal?.atMs??null,observationId:signal?.id??null,
    observedClosedCandleSignal:status==='OBSERVED_CLOSED_CANDLE_SIGNAL',
    registryTier:researchPaperCandidate?'RESEARCH_EXPERIMENT':'CANONICAL_PASS',
    researchPaperCandidate,genuineS:researchPaperCandidate?false:null,
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
function researchEvidenceValid(entry) {
  const metrics=entry?.historicalEvidence?.metrics;
  const cost=entry?.modeledCostEvidence;
  const risk=entry?.basicRiskEvidence;
  return obj(metrics)&&Number.isSafeInteger(metrics.trades)&&metrics.trades>=30
    &&positive(metrics.return)&&typeof metrics.profitFactor==='number'&&metrics.profitFactor>=1.05
    &&positive(metrics.expectancy)&&typeof metrics.maximumDrawdown==='number'
    &&Number.isFinite(metrics.maximumDrawdown)&&metrics.maximumDrawdown>=0&&metrics.maximumDrawdown<=0.2
    &&obj(cost)&&cost.evidenceClass==='MODEL_ASSUMPTION_NOT_PROVIDER_ATTESTED'
    &&['entryFeeRate','exitFeeRate','taxRate','slippageRate','spreadRate','latencyDriftRate']
      .every(k=>typeof cost[k]==='number'&&Number.isFinite(cost[k])&&cost[k]>=0)
    &&Number.isSafeInteger(cost.latencyBars)&&cost.latencyBars>=0&&cost.liquidityImpact===null
    &&obj(risk)&&risk.basicRiskCheck==='PASS'&&positive(risk.riskPerTrade)&&risk.riskPerTrade<=0.05
    &&positive(risk.maximumCapitalFraction)&&risk.maximumCapitalFraction<=1
    &&(entry.market==='CRYPTO_FUTURES'
      ?positive(risk.leverage)&&risk.leverage<=3
      :risk.leverage===1);
}
function registryEntryValid(entry,sha,market,direction,timeframe) {
  const canonical=entry?.source==='FORMULA_AUTO_BACKTEST_PASS'
    &&entry.paperState==='REGISTERED_WAITING_FUTURE_SIGNAL';
  const research=entry?.source==='FORMULA_RESEARCH_BACKTEST_CANDIDATE'
    &&entry.paperState==='RESEARCH_REGISTERED_WAITING_FUTURE_SIGNAL'
    &&entry.researchStatus==='BACKTEST_CANDIDATE'
    &&entry.experimentalResearchOnly===true&&entry.genuineS===false
    &&entry.activationRequired===true&&entry.actualPaperOperationActive===false
    &&entry.paperDispatchAllowed===false&&researchEvidenceValid(entry);
  if (!obj(entry)||!SHA40.test(sha??'')||entry.researchCodeSha!==sha
    ||(!canonical&&!research)
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
    ...(research?{
      registryTier:'RESEARCH_EXPERIMENT',historicalEvidence:entry.historicalEvidence,
      modeledCostEvidence:entry.modeledCostEvidence,basicRiskEvidence:entry.basicRiskEvidence,
    }:{}),
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
  // Require the *entire* signal bar to begin after registration. Merely
  // closing after registration could falsely count a pre-registry bar as a
  // prospective opportunity (especially intraday crossover signals).
  if (last.timestamp<registeredAt || closedAt<=registeredAt)
    return block('FORMULA_WATCH_HISTORICAL_REPLAY_FORBIDDEN');
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
  // Idempotency key: one formula + market/symbol + side/timeframe + closed bar.
  // Do not include mutable quote timestamps, provider failover, warmup candles
  // or provider corrections: repeated polling must never mint a new signal ID
  // for the same bar. Independent evidence and Paper admission remain separate.
  const id=digest(sorted({
    registryId:entry.registryId,researchCodeSha,market,symbol,direction,timeframe,
    strategyHash:entry.strategyHash,
    signalBarOpenedAtMs:last.timestamp,signalBarClosedAtMs:closedAt,
  }));
  return result(input,'OBSERVED_CLOSED_CANDLE_SIGNAL',
    'PUBLIC_FORMULA_SIGNAL_ONLY_NO_PAPER_ORDER',{atMs:closedAt,id});
}
