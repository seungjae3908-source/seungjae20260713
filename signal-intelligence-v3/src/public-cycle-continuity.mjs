// Single-head read-only Signal V3 continuation proof. This verifies that
// a real second batch starts where the first finished; it cannot establish
// licensed whole-market feeds, 24-hour uptime, orders, OOS or profitability.
export const PUBLIC_TWO_CYCLE_CONTINUITY_SCHEMA='public-two-cycle-continuity-v1';
const MARKETS=new Set(['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES']);
const MODES=new Set(['SCALPING','SWING','MID_LONG']);
const STATUS=new Set(['CANDIDATES_AVAILABLE','VALID_NO_TRADE','BLOCKED_DATA','SEARCH_FAILURE']);
const int=x=>Number.isSafeInteger(x)&&x>=0;
function validCycle(cycle,state,head,surface){
  if(!cycle||!state||cycle.serviceSha!==head||state.serviceSha!==head
    ||cycle.publicDataOnly!==true||cycle.safety?.executionAuthority!=='NONE'
    ||cycle.profile?.surface!==surface||state.profileMode!==surface
    ||!Array.isArray(cycle.coverage)||cycle.coverage.length!==12
    ||!state.cursors||typeof state.cursors!=='object')
    throw Error('PUBLIC_TWO_CYCLE_UNTRUSTED_SNAPSHOT');
  const keys=new Set();
  for(const lane of cycle.coverage){
    if(!lane||!MARKETS.has(lane.market)||!MODES.has(lane.strategy)
      ||!STATUS.has(lane.status)||typeof lane.laneId!=='string'
      ||!int(lane.cursorBefore)||!int(lane.cursorAfter)
      ||!int(state.cursors[lane.laneId])||lane.cursorAfter!==state.cursors[lane.laneId])
      throw Error('PUBLIC_TWO_CYCLE_LANE_OR_STATE_INVALID');
    const identity=lane.market+'|'+lane.strategy;
    if(keys.has(identity))throw Error('PUBLIC_TWO_CYCLE_DUPLICATE_LANE');
    keys.add(identity);
  }
  if(keys.size!==12)throw Error('PUBLIC_TWO_CYCLE_MISSING_LANES');
  const at=Date.parse(cycle.generatedAt);
  if(!Number.isFinite(at)||at<=0)throw Error('PUBLIC_TWO_CYCLE_INVALID_TIMESTAMP');
  return at;
}
export function verifyPublicTwoCycleContinuity({firstSnapshot,firstState,secondSnapshot,secondState,head,surface='MEMBER_UI'}={}){
  if(typeof head!=='string'||!/^[a-f0-9]{40}$/u.test(head)
    ||!['MEMBER_UI','RESEARCH_V3'].includes(surface))
    throw Error('PUBLIC_TWO_CYCLE_EXPECTATION_INVALID');
  const t1=validCycle(firstSnapshot,firstState,head,surface);
  const t2=validCycle(secondSnapshot,secondState,head,surface);
  if(t2<t1||t2-t1>25*60_000)
    throw Error('PUBLIC_TWO_CYCLE_CLOCK_OR_DELAY_UNVERIFIED');
  const before=new Map(firstSnapshot.coverage.map(x=>[x.laneId,x]));
  const lanes=[],markets=Object.fromEntries([...MARKETS].map(m=>[m,{continued:0,advanced:0,held:0,reset:0,blocked:0,errors:0}]));
  for(const current of secondSnapshot.coverage){
    const prior=before.get(current.laneId);
    if(!prior||prior.market!==current.market||prior.strategy!==current.strategy
      ||prior.timeframe!==current.timeframe
      ||current.cursorBefore!==prior.cursorAfter)
      throw Error('PUBLIC_TWO_CYCLE_CURSOR_MISMATCH');
    const changed=current.cursorAfter!==current.cursorBefore;
    const reset=current.error==='ROSTER_DIGEST_CHANGED_RESET';
    if(reset&&current.cursorAfter!==0)
      throw Error('PUBLIC_TWO_CYCLE_BAD_RESET');
    if(changed&&!reset&&!current.cursorRotatedBlockedOnly
      && !['CANDIDATES_AVAILABLE','VALID_NO_TRADE'].includes(current.status))
      throw Error('PUBLIC_TWO_CYCLE_UNTRUSTED_ADVANCEMENT');
    // A provider failure or timeout is never a completed market page. A
    // separate source-roster reset cannot be disguised as a provider PASS.
    const networkError=Number(current.providerErrors??0)>0
      ||Number(current.timeouts??0)>0;
    if(networkError&&changed&&!reset)
      throw Error('PUBLIC_TWO_CYCLE_NETWORK_FAILURE_SKIPPED');
    if(current.cursorRotatedBlockedOnly===true&&current.status==='CANDIDATES_AVAILABLE')
      throw Error('PUBLIC_TWO_CYCLE_CANDIDATE_ON_BLOCKED_PAGE');
    const group=markets[current.market];
    group.continued++;
    if(reset)group.reset++;
    else if(changed)group.advanced++;
    else group.held++;
    if(current.status==='BLOCKED_DATA')group.blocked++;
    if(current.status==='SEARCH_FAILURE')group.errors++;
    lanes.push(Object.freeze({
      laneId:current.laneId,market:current.market,strategy:current.strategy,
      timeframe:current.timeframe,
      firstCursorAfter:prior.cursorAfter,secondCursorBefore:current.cursorBefore,
      secondCursorAfter:current.cursorAfter,status:current.status,
      blockedObservationOnly:current.cursorRotatedBlockedOnly===true,
      deferredDataRetry:current.deferredDataRetry===true,
      rosterReset:reset,
      providerFailures:networkError,
    }));
  }
  return Object.freeze({
    schemaVersion:PUBLIC_TWO_CYCLE_CONTINUITY_SCHEMA,
    head,surface,firstCycleAt:new Date(t1).toISOString(),
    secondCycleAt:new Date(t2).toISOString(),
    observedTwoConsecutiveSourceCycles:true,
    exactCursorContinuationVerified:true,
    lanes:Object.freeze(lanes),
    markets:Object.freeze(Object.fromEntries(Object.entries(markets)
      .map(([k,v])=>[k,Object.freeze(v)]))),
    // Never upgrade missing symbols/data or attempt counters to acceptance.
    completeSourceIndexAcrossMarketsProven:false,
    realContinuous24hProven:false,
    allInstrumentHistoryVerified:false,
    memberAuthenticatedUiVerified:false,
    economicalOosPassProven:false,
    executionAuthority:'NONE',
    ordersSent:false,
  });
}
