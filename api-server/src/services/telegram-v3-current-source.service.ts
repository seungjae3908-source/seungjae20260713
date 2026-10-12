/**
 * Telegram-only runtime intake proof. Safe GET envelopes alone are not
 * evidence of a fresh market event. No Bot API, DB, broker or file actions.
 */
const IDS=['KR','US','SPOT','FUTURES'].flatMap(m=>
 ['SCALPING_15M','SWING_60M','MID_LONG_1D'].map(x=>m+'_'+x));
const SHA=/^[0-9a-f]{40}$/u;
const EPOCH=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OBJ=(x:unknown):Record<string,any>|null=>
 x&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,any>:null;
const NUM=(x:unknown)=>Number.isSafeInteger(x)&&Number(x)>=0;
const STR=(x:unknown,n:number)=>typeof x==='string'&&x.length>0
 &&x.length<=n&&x.trim()===x&&!/[\u0000-\u001f\u007f]/u.test(x);
const SOURCE:Record<string,string[]>={
 KR_STOCK:['krx-symbol-master'],US_STOCK:['nasdaq-trader-public-directory','finnhub-symbol-master'],
 CRYPTO_SPOT:['upbit-public'],CRYPTO_FUTURES:['bitget-public'],
};
const PREFIX:Record<string,string>={KR_STOCK:'KR',US_STOCK:'US',
 CRYPTO_SPOT:'SPOT',CRYPTO_FUTURES:'FUTURES'};
const STATUSES=new Set(['CANDIDATES_AVAILABLE','VALID_NO_TRADE','BLOCKED_DATA','SEARCH_FAILURE']);

/** Independent Telegram safety barrier for the canonical V3 profit chain.
 * Structural provenance checks are NOT authenticated OOS evidence by themselves.
 */
function verifiedTelegramV3ProfitLineage(row:Record<string,any>,origin:Record<string,any>,
  market:string,event:Record<string,any>):boolean{
 const identity=OBJ(origin.paperIdentity),edge=OBJ(row.evidence);
 return row.quantEligible===true&&row.profitEligible===true
   &&row.riskReady===true
   &&edge?.source==='CANONICAL_PROFIT_EVIDENCE_READY'
   &&typeof edge.expectedNetEdgeR==='number'
   &&Number.isFinite(edge.expectedNetEdgeR)&&edge.expectedNetEdgeR>0
   &&origin.edgeSource==='CANONICAL_PROFIT_EVIDENCE_READY'
   &&origin.profitEvidenceStatus==='READY'
   &&origin.backtestQualityStatus==='verified'
   &&origin.blockedPageResearchOnly!==true
   &&origin.publicationEligible!==false
   &&Array.isArray(origin.profitBlockers)&&origin.profitBlockers.length===0
   &&identity!==null
   &&identity.executionAuthority==='NONE'
   &&STR(identity.signalId,256)&&identity.signalId===origin.scannerSignalId
   &&STR(identity.strategyId,200)&&STR(identity.strategyVersion,200)
   &&STR(identity.parameterHash,256)
   &&SHA.test(identity.researchCodeSha??'')
   &&identity.market===market&&identity.symbol===event.symbol
   &&identity.timeframe===event.timeframe
   &&identity.direction===event.direction
   &&STR(identity.costPolicyVersion,200)
   &&identity.costPolicyVersion===origin.costPolicyId;
}
export function validTelegramV3CurrentSource(value:unknown,nowMs=Date.now()):boolean{
 const s=OBJ(value),security=OBJ(s?.safety);
 if(!s||!Number.isSafeInteger(nowMs)||nowMs<=0||!SHA.test(s.serviceSha??'')
  ||s.publicDataOnly!==true||security?.executionAuthority!=='NONE'
  ||security?.privateTradingApiAllowed!==false||security?.realOrderAllowed!==false)
  return false;
 const at=Date.parse(s.generatedAt??'');
 if(!Number.isFinite(at)||at>nowMs+5000||nowMs-at>900000)return false;
 const lanes=s.coverage,rows=s.rows,events=s.events;
 if(!Array.isArray(lanes)||lanes.length!==12||!Array.isArray(events)
  ||events.length>10000||!Array.isArray(rows)||rows.length>100000)return false;
 const epoch=lanes[0]?.sourceCycleId,lookup=new Map<string,Record<string,any>>();
 if(!EPOCH.test(epoch??''))return false;
 for(const raw of lanes){
  const row=OBJ(raw),id=row?.laneId;
  if(!row||!STR(id,50)||!IDS.includes(id)||lookup.has(id)||row.sourceCycleId!==epoch
    ||!STATUSES.has(row.status))return false;
  lookup.set(id,row);
 }
 if(lookup.size!==12)return false;
 if(events.length===0)return true;
 const candidates=new Map<string,Record<string,any>>();
 for(const raw of rows){
  const row=OBJ(raw);
  if(row&&STR(row.id,400)){
    if(candidates.has(row.id))return false;
    candidates.set(row.id,row);
  }
 }
 const sent=new Set<string>(),candidateCountByLane=new Map<string,number>();
 for(const raw of events){
  const event=OBJ(raw);
  if(!event||!['NEW_CANDIDATE','STATE_CHANGED','RESCAN_REQUESTED'].includes(event.type)
    ||!STR(event.id,400)||!STR(event.symbol,128)
    ||!STR(event.strategy,40)||!STR(event.timeframe,20))return false;
  // V3 legitimately emits a rescan request alongside a new candidate
  // (or a state change). Deduplicate by type+identity, not identity alone.
  const eventKey=event.type+':'+event.id;
  if(sent.has(eventKey))return false;
  sent.add(eventKey);
  const market=event.market,dir=event.direction;
  const candidateEvent=event.type==='NEW_CANDIDATE';
  if(!(market==='CRYPTO_FUTURES'
      ? dir==='LONG'||dir==='SHORT'||(!candidateEvent&&dir===null)
      : SOURCE[market]?.length>0&&(dir==='BUY'||(!candidateEvent&&dir===null))))
    return false;
  const expectedId=[market,event.symbol,event.strategy,event.timeframe,dir].join('|');
  const slot=event.timeframe==='15m'?'SCALPING_15M'
    :event.timeframe==='60m'?'SWING_60M'
      :event.timeframe==='1D'?'MID_LONG_1D':null;
  if(event.id!==expectedId||!slot)return false;
  const row=candidates.get(event.id);
  if(!row||row.market!==market||row.symbol!==event.symbol
    ||row.strategy!==event.strategy||row.timeframe!==event.timeframe
    ||row.direction!==dir||row.validationTier!==event.validationTier
    ||row.state!==event.state)return false;
  const origin=OBJ(row.provenance);
  if(!candidateEvent){
    // State/rescan events are informational only; never promote them
    // to a BUY/LONG/SHORT Telegram alert or member digest.
    if(origin&&(origin.sourceCycleId!==epoch
      ||origin.laneId!==PREFIX[market]+'_'+slot))return false;
    if(event.type==='STATE_CHANGED'){
      const states=['CANDIDATE','ABSTAIN','NO_TRADE','BLOCKED_DATA'];
      if(!states.includes(event.previousState)
        ||event.previousState===row.state
        ||JSON.stringify(event.reasons??null)!==JSON.stringify(row.reasons??null))
        return false;
    }else if(OBJ(row.ai)?.rescanRequested!==true)return false;
    continue;
  }
  if(event.state!=='CANDIDATE')return false;
  const lane=lookup.get(origin?.laneId),proof=OBJ(lane?.publicExecutionDiagnostic);
  if(!row||!origin||!lane||!proof
    ||origin.laneId!==PREFIX[market]+'_'+slot
    ||lane.laneId!==origin.laneId
    ||lane.strategy!==slot.split('_').slice(0,-1).join('_')
    ||row.state!=='CANDIDATE'||row.dataStatus!=='READY'
    ||!verifiedTelegramV3ProfitLineage(row,origin,market,event)
    ||row.market!==market||row.symbol!==event.symbol
    ||row.strategy!==event.strategy||row.timeframe!==event.timeframe
    ||row.direction!==dir
    ||!['RESEARCH_CANDIDATE','FORWARD_VALIDATED','CHAMPION']
      .includes(row.validationTier)
    ||event.validationTier!==row.validationTier
    ||typeof row.utilityR!=='number'||!Number.isFinite(row.utilityR)
    ||row.utilityR<=0||event.utilityR!==row.utilityR
    ||event.utilityMode!==row.utilityMode
    ||JSON.stringify(event.leverage??null)!==JSON.stringify(row.leverage??null)
    ||origin.sourceCycleId!==epoch
    ||origin.cursor!==lane.cursorBefore
    ||lane.market!==market||lane.timeframe!==event.timeframe
    ||!SOURCE[market].includes(lane.universeSource)
    ||lane.status!=='CANDIDATES_AVAILABLE'
    ||lane.lastGoodPreserved!==false||lane.cursorRotatedBlockedOnly===true
    ||lane.universePartial!==false||lane.universeStale!==false
    ||lane.responseDataState!=='complete'
    ||lane.providerErrors!==0||lane.timeouts!==0||lane.universeProviderErrors!==0
    ||!NUM(lane.scannedCards)||lane.scannedCards===0
    ||!NUM(lane.retainedFromBatch)||lane.retainedFromBatch===0
    ||lane.retainedFromBatch>lane.scannedCards
    ||proof.state!=='PAGE_EXECUTION_COMPLETE'
    ||proof.partial!==false||proof.timedOut!==false
    ||proof.providerErrors!==0||proof.timeouts!==0||proof.failuresObserved!==0
    ||!NUM(proof.requested)||proof.requested===0
    ||lane.scannedCards>proof.requested
    ||typeof origin.sourceExpiresAt!=='string'
    ||!Number.isFinite(Date.parse(origin.sourceExpiresAt))
    ||Date.parse(origin.sourceExpiresAt)<=nowMs
    ||proof.started!==proof.requested||proof.completed!==proof.requested
    ||!NUM(lane.cursorBefore)||!NUM(lane.cursorAfter)
    ||!NUM(lane.totalUniverse)||lane.totalUniverse===0)return false;
  const end=lane.cursorBefore+proof.requested;
  if(end>lane.totalUniverse||lane.cursorAfter!==(end===lane.totalUniverse?0:end))
    return false;
  const count=(candidateCountByLane.get(lane.laneId)??0)+1;
  if(count>lane.retainedFromBatch)return false;
  candidateCountByLane.set(lane.laneId,count);
 }
 return true;
}
/** A bounded loopback JSON reader. Refuses oversized sources before any alert. */
export async function boundedTelegramV3Json(response:Response,maxBytes=8*1024*1024):Promise<unknown>{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<128||maxBytes>8*1024*1024
  ||!response?.body)throw Error('TELEGRAM_V3_BODY_INVALID');
 const length=response.headers?.get('content-length');
 if(length!==null&&length!==undefined
  &&(!/^\d+$/u.test(length)||Number(length)>maxBytes))
  throw Error('TELEGRAM_V3_BODY_LIMIT');
 const reader=response.body.getReader(),parts:Buffer[]=[];let total=0;
 try{
  while(true){
   const {done,value}=await reader.read();
   if(done)break;
   total+=value.byteLength;
   if(total>maxBytes)throw Error('TELEGRAM_V3_BODY_LIMIT');
   parts.push(Buffer.from(value));
  }
 }finally{reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(parts,total).toString('utf8'));}
 catch{throw Error('TELEGRAM_V3_JSON_INVALID');}
}

/**
 * Number of independently complete current public source pages.
 * This is diagnostic only: a valid 200 envelope with zero NEW_CANDIDATE
 * events and 12 blocked lanes is not source-ready for Telegram.
 * This metric is NEVER a historical all-market coverage or profit PASS.
 */
export function verifiedTelegramV3PageCount(snapshot:unknown):number{
 const s=OBJ(snapshot);
 if(!s||!Array.isArray(s.coverage)||s.coverage.length!==12)return 0;
 return s.coverage.filter((raw:unknown)=>{
  const lane=OBJ(raw),proof=OBJ(lane?.publicExecutionDiagnostic);
  if(!lane||!proof
    ||!['CANDIDATES_AVAILABLE','VALID_NO_TRADE'].includes(lane.status)
    ||lane.lastGoodPreserved!==false||lane.cursorRotatedBlockedOnly===true
    ||lane.universePartial!==false||lane.universeStale!==false
    ||lane.responseDataState!=='complete'
    ||lane.providerErrors!==0||lane.timeouts!==0
    ||lane.universeProviderErrors!==0
    ||proof.state!=='PAGE_EXECUTION_COMPLETE'
    ||proof.partial!==false||proof.timedOut!==false
    ||proof.providerErrors!==0||proof.timeouts!==0
    ||proof.failuresObserved!==0||!NUM(proof.requested)||proof.requested===0
    ||proof.started!==proof.requested||proof.completed!==proof.requested
    ||!NUM(lane.cursorBefore)||!NUM(lane.cursorAfter)
    ||!NUM(lane.totalUniverse)||lane.totalUniverse===0)
    return false;
  const end=lane.cursorBefore+proof.requested;
  return end<=lane.totalUniverse
    &&lane.cursorAfter===(end===lane.totalUniverse?0:end);
 }).length;
}
