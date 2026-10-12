/**
 * Independent boundary check for V3 current-page public CANDIDATE rows.
 * The upstream engine computes decisions; this reader must not trust a
 * deserialized state/id alone. Structural proof is NOT authenticated OOS,
 * profitable history, member permission or trading authority.
 */
const SHA=/^[a-f0-9]{40}$/iu;
const VALIDATION=new Set(['RESEARCH_CANDIDATE','FORWARD_VALIDATED','CHAMPION']);
const CONTEXT=Object.freeze({
 KR_STOCK:{prefix:'KR',direction:'BUY',source:'yahoo-public'},
 US_STOCK:{prefix:'US',direction:'BUY',source:'yahoo-public'},
 CRYPTO_SPOT:{prefix:'SPOT',direction:'BUY',source:'upbit-public-candles'},
 CRYPTO_FUTURES:{prefix:'FUTURES',direction:null,source:'bitget-public-candles'},
});
const STRATEGY_FRAME=Object.freeze({
 '15m':'SCALPING_15M','60m':'SWING_60M','1D':'MID_LONG_1D',
});
const nonEmpty=(value,max)=>typeof value==='string'
 &&value.trim().length>0&&value.length<=max;
const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
const natural=x=>Number.isSafeInteger(x)&&x>0;
const record=x=>x&&typeof x==='object'&&!Array.isArray(x)?x:null;

export function verifiedV3CurrentPublicationRow(row,lane,nowMs=Date.now()){
 const input=record(row),receipt=record(lane);
 if(!input||!receipt||input.state!=='CANDIDATE'
   ||input.dataStatus!=='READY'||input.quantEligible!==true
   ||input.profitEligible!==true||input.riskReady!==true
   ||!positive(input.utilityR)
   ||!['NET_EDGE_ONLY_RISK_SEPARATE','FULL_EXPECTED_UTILITY'].includes(input.utilityMode)
   ||!VALIDATION.has(input.validationTier))
   return false;
 const market=CONTEXT[input.market],slot=STRATEGY_FRAME[input.timeframe];
 if(!market||!slot||receipt.market!==input.market
   ||receipt.timeframe!==input.timeframe
   ||receipt.laneId!==market.prefix+'_'+slot
   ||!nonEmpty(input.symbol,128)||!nonEmpty(input.strategy,200)
   ||input.symbol!==input.symbol.toUpperCase()
   ||input.strategy!==input.strategy.toUpperCase()
   ||(market.direction!==null
     ?input.direction!==market.direction
     :!['LONG','SHORT'].includes(input.direction))
   ||input.id!==[input.market,input.symbol,input.strategy,input.timeframe,input.direction].join('|'))
   return false;
 const proof=record(input.provenance),identity=record(proof?.paperIdentity),
       edge=record(input.evidence);
 // A card that was fresh when its page was scanned is not necessarily fresh
 // when twelve lanes finish, when HTTP serves it, or when Telegram polls.
 const sourceExpiresAt=typeof proof?.sourceExpiresAt==='string'
   ?Date.parse(proof.sourceExpiresAt):NaN;
 if(!Number.isSafeInteger(nowMs)||nowMs<=0
   ||!Number.isFinite(sourceExpiresAt)||sourceExpiresAt<=nowMs
   ||!proof||proof.blockedPageResearchOnly===true
   ||proof.publicationEligible===false
   ||!Array.isArray(proof.profitBlockers)||proof.profitBlockers.length!==0
   ||!Array.isArray(proof.scannerSources)
   ||!proof.scannerSources.includes(market.source)
   ||proof.sourceCycleId!==receipt.sourceCycleId
   ||proof.cursor!==receipt.cursorBefore
   ||proof.edgeSource!=='CANONICAL_PROFIT_EVIDENCE_READY'
   ||proof.profitEvidenceStatus!=='READY'
   ||proof.backtestQualityStatus!=='verified'
   ||!edge||edge.source!=='CANONICAL_PROFIT_EVIDENCE_READY'
   ||!positive(edge.expectedNetEdgeR)
   ||!positive(edge.expectedNetEdgePercent)
   ||!positive(edge.expectedNetReturnPercent)
   ||!positive(edge.riskRewardRatio)||edge.riskRewardRatio<1
   ||!natural(edge.sampleSize)
   ||!nonEmpty(edge.costPolicyId,200)
   ||proof.costPolicyId!==edge.costPolicyId
   ||!identity||identity.executionAuthority!=='NONE'
   ||!nonEmpty(identity.signalId,256)
   ||identity.signalId!==proof.scannerSignalId
   ||!nonEmpty(identity.strategyId,200)
   ||identity.strategyId.toUpperCase()!==input.strategy
   ||!nonEmpty(identity.strategyVersion,200)
   ||!nonEmpty(identity.parameterHash,256)
   ||!SHA.test(identity.researchCodeSha??'')
   ||identity.market!==input.market
   ||identity.symbol!==input.symbol
   ||identity.timeframe!==input.timeframe
   ||identity.direction!==input.direction
   ||identity.costPolicyVersion!==edge.costPolicyId
   ||!natural(identity.horizon))
   return false;
 return true;
}

/** Event attributes and economic risk are a single immutable candidate fact. */
export function verifiedV3CurrentCandidateEvent(event,row){
 const e=record(event),r=record(row);
 if(!e||!r||e.type!=='NEW_CANDIDATE'
   ||e.id!==r.id||e.market!==r.market||e.symbol!==r.symbol
   ||e.strategy!==r.strategy||e.timeframe!==r.timeframe
   ||e.direction!==r.direction||e.state!=='CANDIDATE'
   ||e.validationTier!==r.validationTier
   ||e.utilityR!==r.utilityR||e.utilityMode!==r.utilityMode
   ||JSON.stringify(e.leverage??null)!==JSON.stringify(r.leverage??null))
   return false;
 return true;
}
