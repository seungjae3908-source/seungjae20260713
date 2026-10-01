const TERMINAL = new Set(['CLOSED','INVALIDATED','EXPIRED','REJECTED','CANCELLED']);
const LANES = Object.freeze({
  KR_STOCK: Object.freeze({ timeframe:'60m', style:'SWING' }),
  US_STOCK: Object.freeze({ timeframe:'60m', style:'SWING' }),
  CRYPTO_SPOT: Object.freeze({ timeframe:'60m', style:'SWING' }),
  CRYPTO_FUTURES: Object.freeze({ timeframe:'60m', style:'SWING' }),
});

function nonEmpty(v){ return typeof v==='string'&&v.trim().length>0; }
function sha40(v){ return typeof v==='string'&&/^[0-9a-f]{40}$/iu.test(v); }
function positive(v){ return Number.isFinite(v)&&v>0; }
function positiveInteger(v){ return Number.isInteger(v)&&v>0; }
function directionGroup(v){
  const x=String(v??'').toUpperCase();
  if(x==='LONG'||x==='BUY') return 'LONG';
  if(x==='SHORT'||x==='SELL') return 'SHORT';
  return null;
}
function marketOf(card){
  if(card?.assetClass==='coin_spot') return 'CRYPTO_SPOT';
  if(card?.assetClass==='coin_futures') return 'CRYPTO_FUTURES';
  const m=String(card?.market??'').toUpperCase();
  if(card?.assetClass==='stock'&&(m==='KR'||m==='KR_STOCK')) return 'KR_STOCK';
  if(card?.assetClass==='stock'&&(m==='US'||m==='US_STOCK')) return 'US_STOCK';
  return null;
}
function add(out,code,stage,details=null){ out.push(Object.freeze({code,stage,details})); }

export function diagnoseForwardAdmission(card,{ expectedResearchSha=null }={}){
  if(!card||typeof card!=='object') throw new TypeError('scanner card is required');
  const blockers=[];
  const market=marketOf(card);
  const lane=market?LANES[market]:null;

  if(card.signalGrade!=='S'&&card.signalGrade!=='A'){
    add(blockers,'SCANNER_GRADE_NOT_FORWARD_OBSERVABLE','GRADE',{
      signalGrade:card.signalGrade??null,
      backtestStatus:card.backtestQuality?.status??null,
      watchReasons:card.candidateRanking?.watchReasons??[],
    });
  }
  if(card.strongSignalEligible!==true) add(blockers,'SCANNER_SIGNAL_NOT_STRONG','SIGNAL');
  if(TERMINAL.has(card.signalState)) add(blockers,'SCANNER_SIGNAL_TERMINAL','SIGNAL',{signalState:card.signalState});
  if(!market) add(blockers,'MARKET_UNSUPPORTED','IDENTITY');
  if(card.dataState!=='complete') add(blockers,'DATA_STATE_NOT_COMPLETE','DATA',{dataState:card.dataState??null});
  if(card.dataQuality?.state==='DATA_UNTRUSTED'||card.dataQuality?.strongSignalAllowed===false){
    add(blockers,'DATA_QUALITY_BLOCKED','DATA');
  }
  if(!Array.isArray(card.dataSources)||card.dataSources.length===0||card.dataSources.some(x=>!nonEmpty(x))){
    add(blockers,'DATA_PROVENANCE_REQUIRED','DATA');
  }
  if(!nonEmpty(card.signalId)||!nonEmpty(card.symbol)) add(blockers,'SIGNAL_IDENTITY_REQUIRED','IDENTITY');
  if(!nonEmpty(card.observedAt)||!Number.isFinite(Date.parse(card.observedAt))) add(blockers,'SIGNAL_OBSERVED_AT_REQUIRED','TIME');
  if(!nonEmpty(card.expiresAt)||!Number.isFinite(Date.parse(card.expiresAt))) add(blockers,'SIGNAL_EXPIRY_REQUIRED','TIME');
  if(Number.isFinite(Date.parse(card.observedAt))&&Number.isFinite(Date.parse(card.expiresAt))&&Date.parse(card.expiresAt)<=Date.parse(card.observedAt)){
    add(blockers,'INVALID_SIGNAL_EXPIRY','TIME');
  }

  const dir=directionGroup(card.action??card.direction);
  if(!dir) add(blockers,'EXPLICIT_ACTION_REQUIRED','IDENTITY');
  if(card.strategyMode!=='swing') add(blockers,'STRATEGY_HORIZON_REQUIRED','IDENTITY',{strategyMode:card.strategyMode??null});
  if(!positive(card.price)) add(blockers,'REFERENCE_PRICE_REQUIRED','PRICE');
  if(!positive(card.pricePlan?.stopLoss)) add(blockers,'STOP_LOSS_REQUIRED','PRICE');
  if(!positive(card.pricePlan?.targets?.[0])) add(blockers,'TARGET1_REQUIRED','PRICE');

  const candidate=card.paperCandidate;
  if(!candidate||typeof candidate!=='object'){
    add(blockers,'CANONICAL_PAPER_CANDIDATE_REQUIRED','PAPER_IDENTITY');
  } else {
    if(candidate.executionAuthority!=null&&candidate.executionAuthority!=='NONE') add(blockers,'PAPER_CANDIDATE_EXECUTION_AUTHORITY_FORBIDDEN','PAPER_IDENTITY');
    if(candidate.liveOrderAllowed===true) add(blockers,'PAPER_CANDIDATE_LIVE_ORDER_FORBIDDEN','PAPER_IDENTITY');
    if(candidate.privateTradingApiAllowed===true) add(blockers,'PAPER_CANDIDATE_PRIVATE_API_FORBIDDEN','PAPER_IDENTITY');
    if(candidate.orderSubmitted===true) add(blockers,'PAPER_CANDIDATE_REAL_ORDER_FORBIDDEN','PAPER_IDENTITY');
    if(candidate.exchangeRequestSent===true) add(blockers,'PAPER_CANDIDATE_EXCHANGE_REQUEST_FORBIDDEN','PAPER_IDENTITY');

    const signal=candidate.signal;
    const strategy=signal?.strategyIdentity;
    if(!signal||typeof signal!=='object') add(blockers,'CANONICAL_PAPER_SIGNAL_REQUIRED','PAPER_IDENTITY');
    if(!strategy||typeof strategy!=='object') add(blockers,'CANONICAL_STRATEGY_IDENTITY_REQUIRED','PAPER_IDENTITY');
    if(signal){
      if(signal.signalId!==card.signalId) add(blockers,'PAPER_SIGNAL_ID_MISMATCH','PAPER_IDENTITY');
      if(market&&signal.market!==market) add(blockers,'PAPER_MARKET_MISMATCH','PAPER_IDENTITY');
      if(signal.symbol!==card.symbol) add(blockers,'PAPER_SYMBOL_MISMATCH','PAPER_IDENTITY');
      if(lane&&signal.timeframe!==lane.timeframe) add(blockers,'PAPER_TIMEFRAME_MISMATCH','PAPER_IDENTITY',{actual:signal.timeframe??null,expected:lane.timeframe});
      if(!positiveInteger(signal.horizon)) add(blockers,'PAPER_HORIZON_REQUIRED','PAPER_IDENTITY');
      if(signal.style!=null&&String(signal.style).toUpperCase()!==lane?.style) add(blockers,'PAPER_STRATEGY_STYLE_MISMATCH','PAPER_IDENTITY');
      if(directionGroup(signal.signalDirection??signal.direction)!==dir) add(blockers,'PAPER_DIRECTION_MISMATCH','PAPER_IDENTITY');
    }
    if(strategy){
      if(!nonEmpty(strategy.strategyId)) add(blockers,'STRATEGY_ID_REQUIRED','PAPER_IDENTITY');
      if(!nonEmpty(strategy.strategyVersion)) add(blockers,'STRATEGY_VERSION_REQUIRED','PAPER_IDENTITY');
      if(!nonEmpty(strategy.parameterHash)) add(blockers,'PARAMETER_HASH_REQUIRED','PAPER_IDENTITY');
      if(!sha40(strategy.researchCodeSha)) add(blockers,'RESEARCH_CODE_SHA_REQUIRED','PAPER_IDENTITY');
      else if(expectedResearchSha&&strategy.researchCodeSha.toLowerCase()!==String(expectedResearchSha).toLowerCase()){
        add(blockers,'RESEARCH_CODE_SHA_MISMATCH','PAPER_IDENTITY');
      }
    }
  }

  const grouped=Object.freeze(blockers.reduce((acc,row)=>{
    acc[row.stage]=(acc[row.stage]??0)+1;
    return acc;
  },{}));
  const forwardObservable=blockers.length===0;
  return Object.freeze({
    schemaVersion:'move-hunter-forward-admission-preflight/v1',
    market,
    lane,
    forwardObservable,
    blockers:Object.freeze(blockers),
    blockerCountsByStage:grouped,
    diagnostics:Object.freeze({
      signalGrade:card.signalGrade??null,
      strongSignalEligible:card.strongSignalEligible===true,
      backtestQualityStatus:card.backtestQuality?.status??null,
      backtestWatchReasons:Object.freeze([...(card.candidateRanking?.watchReasons??[])]),
      hasCanonicalPaperCandidate:!!candidate,
    }),
    mutatesForward:false,
    orderAuthority:false,
    economicSampleCredit:0,
    profitabilityClaimAllowed:false,
    executionAuthority:'NONE',
  });
}

export function summarizeForwardAdmissionPreflight(rows=[]){
  if(!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const blockerCounts={};
  const stageCounts={};
  let ready=0;
  for(const row of rows){
    if(row?.forwardObservable===true) ready+=1;
    for(const blocker of row?.blockers??[]){
      blockerCounts[blocker.code]=(blockerCounts[blocker.code]??0)+1;
      stageCounts[blocker.stage]=(stageCounts[blocker.stage]??0)+1;
    }
  }
  return Object.freeze({
    schemaVersion:'move-hunter-forward-admission-preflight-summary/v1',
    total:rows.length,
    ready,
    blocked:rows.length-ready,
    blockerCounts:Object.freeze(blockerCounts),
    stageCounts:Object.freeze(stageCounts),
    economicSampleCredit:0,
    executionAuthority:'NONE',
  });
}
