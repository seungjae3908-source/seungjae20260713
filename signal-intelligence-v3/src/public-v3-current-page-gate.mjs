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

function verifiedCurrentLane(lane){
  const page=lane?.publicExecutionDiagnostic;
  if(!lane||lane.status!=='CANDIDATES_AVAILABLE'
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
  for(const lane of coverage){
    if(!lane||!LANES.includes(lane.laneId)||unique.has(lane.laneId))
      return null;
    unique.set(lane.laneId,lane);
  }
  return unique.size===LANES.length?unique:null;
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
  const permitted=new Set();
  for(const row of snapshot.rows){
    const origin=row?.provenance;
    const lane=lanes.get(origin?.laneId);
    if(!verifiedCurrentLane(lane)||origin.cursor!==lane.cursorBefore
      ||!row?.id||row.state!=='CANDIDATE'||row.dataStatus!=='READY')
      continue;
    permitted.add(row.id);
  }
  const allowedIds=Object.freeze([...permitted].sort());
  const lists={};
  for(const key of Object.keys(empty.lists)){
    const values=snapshot.lists[key];
    if(!Array.isArray(values))return empty;
    lists[key]=Object.freeze(values.filter(row=>permitted.has(row?.id)));
  }
  const events=Object.freeze(snapshot.events.filter(event=>
    event&&event.type==='NEW_CANDIDATE'&&permitted.has(event.id)));
  return Object.freeze({allowedIds,lists:Object.freeze(lists),events,
    fullCoverageProven:false,executionAuthority:'NONE'});
}
