import { verifiedV3CurrentPublicationRow, verifiedV3CurrentCandidateEvent } from './public-v3-publication-proof.mjs';

/**
 * The twelve latest source page receipts and the persisted rolling research
 * history represent DIFFERENT trust levels. Old rows are useful for research
 * review but never count as freshly verified source events.
 *
 * Read-only/pure: no exchange requests, Telegram API, orders, files, DB,
 * deployment or privilege changes.
 */
const LANES = Object.freeze([
  'KR_SCALPING_15M','KR_SWING_60M','KR_MID_LONG_1D',
  'US_SCALPING_15M','US_SWING_60M','US_MID_LONG_1D',
  'SPOT_SCALPING_15M','SPOT_SWING_60M','SPOT_MID_LONG_1D',
  'FUTURES_SCALPING_15M','FUTURES_SWING_60M','FUTURES_MID_LONG_1D',
]);
const isCount=x=>Number.isSafeInteger(x)&&x>=0;
const CYCLE_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function verifiedCurrentLane(lane){
  const page=lane?.publicExecutionDiagnostic;
  if(!lane||!CYCLE_ID.test(lane.sourceCycleId??'')
    ||lane.status!=='CANDIDATES_AVAILABLE'
    ||lane.lastGoodPreserved!==false
    ||lane.cursorRotatedBlockedOnly===true
    ||lane.responseDataState!=='complete'
    ||lane.universePartial!==false||lane.universeStale!==false
    ||lane.providerErrors!==0||lane.timeouts!==0
    ||lane.universeProviderErrors!==0
    ||!page||page.state!=='PAGE_EXECUTION_COMPLETE'
    ||page.partial!==false||page.timedOut!==false
    ||page.providerErrors!==0||page.timeouts!==0
    ||page.failuresObserved!==0
    ||!isCount(page.requested)||page.requested===0
    ||page.started!==page.requested||page.completed!==page.requested
    ||!isCount(lane.cursorBefore)||!isCount(lane.cursorAfter)
    ||!isCount(lane.totalUniverse)||lane.totalUniverse===0)return false;
  const end=lane.cursorBefore+page.requested;
  return end<=lane.totalUniverse
    &&lane.cursorAfter===(end===lane.totalUniverse?0:end);
}

function verifiedLanes(coverage){
  if(!Array.isArray(coverage)||coverage.length!==LANES.length)return null;
  const unique=new Map();
  const sourceCycleId=coverage[0]?.sourceCycleId;
  if(!CYCLE_ID.test(sourceCycleId??''))return null;
  for(const lane of coverage){
    if(!lane||!LANES.includes(lane.laneId)||unique.has(lane.laneId)
      ||lane.sourceCycleId!==sourceCycleId)return null;
    unique.set(lane.laneId,lane);
  }
  return unique.size===LANES.length?unique:null;
}


const VALID_SOURCE = Object.freeze({
  KR: new Set(['krx-symbol-master']),
  US: new Set(['nasdaq-trader-public-directory','finnhub-symbol-master']),
  SPOT: new Set(['upbit-public']),
  FUTURES: new Set(['bitget-public']),
});
function validSource(lane){
  const key=String(lane?.laneId??'').split('_')[0];
  return VALID_SOURCE[key]?.has(lane?.universeSource)===true;
}
/** One canonical *page* check for source-readiness summaries and alerts.
 * A nominal status without an exact completed source page is not evidence.
 */
export function verifiedCurrentPublicV3Page(lane){
  if(!validSource(lane)||lane.lastGoodPreserved!==false
    ||lane.cursorRotatedBlockedOnly===true
    ||lane.responseDataState!=='complete'
    ||lane.universePartial!==false||lane.universeStale!==false
    ||lane.status!=='VALID_NO_TRADE'&&lane.status!=='CANDIDATES_AVAILABLE'
    ||!isCount(lane.scannedCards)||!isCount(lane.retainedFromBatch)
    ||lane.retainedFromBatch>lane.scannedCards)return false;
  const page={...lane,status:'CANDIDATES_AVAILABLE'};
  return verifiedCurrentLane(page) &&
    (lane.status!=='VALID_NO_TRADE'||
      (lane.scannedCards===0&&lane.retainedFromBatch===0)) &&
    (lane.status!=='CANDIDATES_AVAILABLE'||
      (lane.scannedCards>0&&lane.retainedFromBatch>0));
}
/** All source-backed *current pages* are healthy; does not prove every
 * symbol in each full roster has ever been scanned. */
export function currentPublicV3CycleReady(coverage){
  const lanes=verifiedLanes(coverage);
  return Boolean(lanes && [...lanes.values()].every(verifiedCurrentPublicV3Page));
}

/** Conservative fresh publication view. Prior research rows are kept only in
 * snapshot.rows/stateById; lists and notifications require exact current page.
 */
export function currentPagePublication(snapshot,coverage){
  const empty=Object.freeze({allowedIds:Object.freeze([]),
    lists:Object.freeze({krBuy:Object.freeze([]),usBuy:Object.freeze([]),
      spotBuy:Object.freeze([]),futuresLong:Object.freeze([]),
      futuresShort:Object.freeze([])}),events:Object.freeze([]),
    fullCoverageProven:false,executionAuthority:'NONE'});
  const lanes=verifiedLanes(coverage);
  if(!lanes||!snapshot||!Array.isArray(snapshot.rows)
    ||!Array.isArray(snapshot.events)||!snapshot.lists)return empty;

  // All visible candidates must come from a unique immutable normalized
  // engine row. A deserialized list or event can never mint a different row.
  const known=new Set(),permitted=new Map();
  for(const row of snapshot.rows){
    if(!row||typeof row.id!=='string'||!row.id)continue;
    if(known.has(row.id))return empty;
    known.add(row.id);
    const origin=row.provenance;
    const lane=lanes.get(origin?.laneId);
    if(!validSource(lane)||!verifiedCurrentLane(lane)
      ||origin?.sourceCycleId!==lane.sourceCycleId
      ||origin?.cursor!==lane.cursorBefore
      ||!verifiedV3CurrentPublicationRow(row,lane))
      continue;
    permitted.set(row.id,row);
  }

  const expected=Object.freeze({
    krBuy:['KR_STOCK','BUY'],usBuy:['US_STOCK','BUY'],
    spotBuy:['CRYPTO_SPOT','BUY'],futuresLong:['CRYPTO_FUTURES','LONG'],
    futuresShort:['CRYPTO_FUTURES','SHORT'],
  });
  const lists={},listedIds=new Set();
  for(const [name,[market,direction]] of Object.entries(expected)){
    const values=snapshot.lists[name];
    if(!Array.isArray(values))return empty;
    const clean=[],seen=new Set();
    for(const value of values){
      const row=permitted.get(value?.id);
      if(!row||seen.has(row.id)
        ||row.market!==market||row.direction!==direction
        // Do not re-publish an altered list copy with the same trusted id.
        ||JSON.stringify(value)!==JSON.stringify(row))continue;
      clean.push(row);seen.add(row.id);listedIds.add(row.id);
    }
    lists[name]=Object.freeze(clean);
  }

  const unique=new Set(),events=[];
  for(const event of snapshot.events){
    if(event?.type!=='NEW_CANDIDATE'||!listedIds.has(event.id)
      ||unique.has(event.id))continue;
    const row=permitted.get(event.id);
    if(!verifiedV3CurrentCandidateEvent(event,row))continue;
    events.push(event);unique.add(event.id);
  }
  return Object.freeze({
    allowedIds:Object.freeze([...permitted.keys()].sort()),
    lists:Object.freeze(lists),events:Object.freeze(events),
    fullCoverageProven:false,executionAuthority:'NONE',
  });
}
