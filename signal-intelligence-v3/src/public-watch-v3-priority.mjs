/** Validated, read-only Stage-1 Research Watch --> public Signal V3
 * Stage-2 WITHIN-CURRENT-PAGE priority. No skipped cursor positions, extra
 * provider calls, candidate promotion, Telegram messages or trading authority.
 */
import {createHash} from 'node:crypto';
import {summarizeLightweightMarketWatch} from '../../research-production/src/lightweight-market-watch-readback.mjs';

const MARKETS=['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES'];
const SHA=/^[0-9a-f]{40}$/u;
const DIGEST=/^[0-9a-f]{64}$/u;
const SYMBOL=/^[A-Z0-9][A-Z0-9._-]{0,31}$/u;
const STOCK_KR=/^[A-Z0-9]{6}$/u;
const STOCK_US=/^[A-Z][A-Z0-9]{0,14}(?:[.-][A-Z0-9]{1,6})?$/u;
const SOURCE=/^[A-Za-z0-9_-]{1,80}$/u;
const MAX_AGE_MS=180_000;
const validCount=x=>Number.isSafeInteger(x)&&x>=0;
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
let active=Object.freeze({spot:new Map(),futures:new Map()});
let matched={spot:0,futures:0};
let verifiedInPage={spot:new Set(),futures:new Set()};

export function emptyV3WatchHandoff(status='DISABLED'){
  const byMarket=Object.freeze(Object.fromEntries(MARKETS.map(m=>[m,Object.freeze({
    observed:0,stageTwoEligible:0,downsideContextOnly:0,sourcePartial:true,
  })])));
  return Object.freeze({
    status,priorities:Object.freeze([]),
    report:Object.freeze({schemaVersion:'public-v3-stage-one-watch-handoff-v1',
      status,byMarket,verifiedWatchCandidates:0,priorityReviewCandidates:0,
      exactResearchSourceValidated:false,currentWatchReadyMarketCount:0,
      fullMarketCoverageProven:false,
      stageTwoOutsideCursorInjected:false,additionalProviderRequests:0,
      oosPassProven:false,executionAuthority:'NONE',tradingSignalCount:0}),
  });
}
function expectedDigest(event){
  return createHash('sha256').update(JSON.stringify({
    researchSha:event.researchSha,market:event.market,symbol:event.symbol,
    direction:event.direction,source:event.source,
    sourceAtMs:event.sourceAtMs,priorSourceAtMs:event.priorSourceAtMs,
  })).digest('hex');
}
function validEvent(event,marketSummary,watchAt,nowMs,researchSha){
  if(!object(event)||event.schemaVersion!=='lightweight-market-opportunity-watch-v1'
    ||event.kind!=='PROVISIONAL_PRICE_ACCELERATION'
    ||event.executionAuthority!=='NONE'||event.isTradingSignal!==false
    ||event.oosPassed!==false||event.paperAdmitted!==false
    ||event.aiReviewed!==false
    ||event.researchSha!==researchSha||!DIGEST.test(event.eventId??'')
    ||event.eventId!==expectedDigest(event)
    ||event.market!==marketSummary.market||event.source!==marketSummary.source
    ||event.universeStatus!==marketSummary.status
    ||!SOURCE.test(event.source??'')||!SYMBOL.test(event.symbol??'')
    ||!['UP','DOWN'].includes(event.direction)
    ||(event.market==='KR_STOCK'&&!STOCK_KR.test(event.symbol))
    ||(event.market==='US_STOCK'&&!STOCK_US.test(event.symbol))
    ||event.observedAt!==new Date(watchAt).toISOString()
    ||typeof event.priorObservedAt!=='string'
    ||!Number.isFinite(Date.parse(event.priorObservedAt))
    ||!validCount(event.sourceAtMs)||!validCount(event.priorSourceAtMs)
    ||event.sourceAtMs<=event.priorSourceAtMs
    ||event.sourceAtMs>watchAt+5000||event.sourceAtMs>nowMs+5000
    ||nowMs-event.sourceAtMs>MAX_AGE_MS
    ||event.priorSourceAtMs>watchAt
    ||typeof event.movePercent!=='number'||!Number.isFinite(event.movePercent)
    ||Math.abs(event.movePercent)<0.7
    ||(event.direction==='UP')!==(event.movePercent>0)
    ||typeof event.score!=='number'||!Number.isFinite(event.score)
    ||Math.abs(event.score-Math.abs(event.movePercent))>0.00011
    ||typeof event.comparisonMinutes!=='number'
    ||event.comparisonMinutes<0.25||event.comparisonMinutes>5
    ||watchAt-Date.parse(event.priorObservedAt)<15_000
    ||watchAt-Date.parse(event.priorObservedAt)>300_000
    ||Math.abs(event.comparisonMinutes
      -(watchAt-Date.parse(event.priorObservedAt))/60_000)>0.011
    ||typeof event.turnover24h!=='number'
    ||!Number.isFinite(event.turnover24h)||event.turnover24h<0)
    return false;
  return true;
}
export function verifyV3WatchHandoff(raw,events,{
  nowMs=Date.now(),expectedResearchSha,
}={}){
  if(!SHA.test(expectedResearchSha??'')||!Number.isSafeInteger(nowMs)||nowMs<=0)
    return emptyV3WatchHandoff('UNCONFIGURED');
  const validated=summarizeLightweightMarketWatch(raw,nowMs,expectedResearchSha);
  if(!validated.present||validated.status==='INVALID')
    return emptyV3WatchHandoff('SOURCE_INVALID');
  if(validated.status==='STALE')return emptyV3WatchHandoff('SOURCE_STALE');
  if(!['OBSERVING','PARTIAL'].includes(validated.status))
    return emptyV3WatchHandoff('SOURCE_BLOCKED');
  if(!Array.isArray(events)||events.length>1024
    ||!validCount(raw?.newCandidateCount)||raw.newCandidateCount>48
    ||raw.observedAt!==new Date(validated.observedAt).toISOString())
    return emptyV3WatchHandoff('EVENT_LOG_INVALID');
  const latest=new Map();
  for(const event of events){
    if(!object(event))return emptyV3WatchHandoff('EVENT_LOG_INVALID');
    if(event.observedAt!==raw.observedAt)continue;
    const key=event.eventId;
    if(!DIGEST.test(key??''))return emptyV3WatchHandoff('EVENT_LOG_INVALID');
    if(latest.has(key)&&JSON.stringify(latest.get(key))!==JSON.stringify(event))
      return emptyV3WatchHandoff('EVENT_LOG_INVALID');
    latest.set(key,event);
  }
  if(latest.size!==raw.newCandidateCount)
    return emptyV3WatchHandoff('EVENT_COUNT_MISMATCH');
  const markets=Object.fromEntries(raw.markets.map(m=>[m.market,m]));
  const counts=Object.fromEntries(MARKETS.map(m=>[m,{
    observed:0,stageTwoEligible:0,downsideContextOnly:0,
    sourcePartial:markets[m].status!=='READY',
  }]));
  const eligible=[];
  for(const ev of latest.values()){
    const source=markets[ev.market];
    if(!source||!['READY','PARTIAL_UNIVERSE','PARTIAL_TICKERS'].includes(source.status)
      ||!validEvent(ev,source,validated.observedAt,nowMs,expectedResearchSha))
      return emptyV3WatchHandoff('EVENT_PROOF_INVALID');
    counts[ev.market].observed++;
    if(ev.direction==='DOWN'&&ev.market!=='CRYPTO_FUTURES'){
      counts[ev.market].downsideContextOnly++;
      continue;
    }
    counts[ev.market].stageTwoEligible++;
    eligible.push(Object.freeze({
      market:ev.market,symbol:ev.symbol,direction:ev.direction,
      score:ev.score,sourceAtMs:ev.sourceAtMs,watchEventId:ev.eventId,
      status:'RESEARCH_OBSERVATION_ONLY',executionAuthority:'NONE',
    }));
  }
  if(MARKETS.some(m=>counts[m].observed!==markets[m].newCandidates))
    return emptyV3WatchHandoff('MARKET_COUNT_MISMATCH');
  eligible.sort((a,b)=>b.score-a.score||a.market.localeCompare(b.market)
    ||a.symbol.localeCompare(b.symbol));
  const limited=[],limit=Object.fromEntries(MARKETS.map(m=>[m,0]));
  for(const ev of eligible){
    if(limit[ev.market]>=12)continue;
    limited.push(ev);limit[ev.market]++;
  }
  const byMarket=Object.freeze(Object.fromEntries(MARKETS.map(m=>[
    m,Object.freeze(counts[m]),
  ])));
  return Object.freeze({
    status:validated.status==='OBSERVING'?'VALIDATED':'PARTIAL_SOURCE',
    priorities:Object.freeze(limited),
    report:Object.freeze({
      schemaVersion:'public-v3-stage-one-watch-handoff-v1',
      status:validated.status==='OBSERVING'?'VALIDATED':'PARTIAL_SOURCE',
      byMarket,verifiedWatchCandidates:latest.size,
      priorityReviewCandidates:limited.length,
      exactResearchSourceValidated:true,
      // A current roster of four READY feeds is NOT independent listed,
      // delisted, licensed or historical full-market coverage evidence.
      currentWatchReadyMarketCount:validated.marketCoverageCount,
      fullMarketCoverageProven:false,
      stageTwoOutsideCursorInjected:false,
      additionalProviderRequests:0,oosPassProven:false,
      executionAuthority:'NONE',tradingSignalCount:0,
    }),
  });
}
export function installV3WithinPageWatchPriority(handoff){
  const empty={spot:new Map(),futures:new Map()};
  if(handoff&&['VALIDATED','PARTIAL_SOURCE'].includes(handoff.status)
    &&Array.isArray(handoff.priorities)){
    for(const row of handoff.priorities){
      const key=row?.market==='CRYPTO_SPOT'?'spot'
        :row?.market==='CRYPTO_FUTURES'?'futures':null;
      if(key&&SYMBOL.test(row.symbol??'')
        &&typeof row.score==='number'&&Number.isFinite(row.score)
        &&row.status==='RESEARCH_OBSERVATION_ONLY'
        &&row.executionAuthority==='NONE')
        empty[key].set(row.symbol,row.score);
    }
  }
  active=Object.freeze(empty);
  matched={spot:0,futures:0};
  verifiedInPage={spot:new Set(),futures:new Set()};
}
export function prioritizeV3CurrentCryptoPage(rows,market){
  if(!Array.isArray(rows)||!['spot','futures'].includes(market))
    throw Error('PUBLIC_V3_PRIORITY_PAGE_INVALID');
  const priorities=active[market];
  if(!priorities.size)return rows;
  const ranked=rows.map((row,i)=>({row,i,priority:priorities.get(row.symbol)??null}));
  // Reorder ONLY the fixed, already-selected cursor page; never inject an
  // out-of-window symbol, advance cursor, inflate or double-count coverage.
  for(const row of ranked)if(row.priority!==null)
    verifiedInPage[market].add(row.row.symbol);
  matched[market]+=ranked.filter(x=>x.priority!==null).length;
  ranked.sort((a,b)=>(b.priority??-1)-(a.priority??-1)||a.i-b.i);
  return ranked.map(x=>x.row);
}
export function v3WithinPagePriorityDiagnostic(){
  return Object.freeze({schemaVersion:'public-v3-stage-two-priority-v1',
    matchedWithinCursorPages:matched.spot+matched.futures,
    spotMatches:matched.spot,futuresMatches:matched.futures,
    extraProviderRequests:0,cursorSkipped:0,
    outsideCursorPriorityScans:0,
    profitabilityCredit:0,executionAuthority:'NONE'});
}


/** Choose at most one per crypto market that is NOT in the current cursor
 * pages scanned this cycle. No source query here and no cursor advancement.
 * The resulting symbols are ephemeral inputs to a separately gated,
 * zero-economic-authority public-data review (never normal V3 publication).
 */
export function selectV3OutOfCursorResearch(handoff){
  const none=()=>Object.freeze([]);
  if(!handoff||!['VALIDATED','PARTIAL_SOURCE'].includes(handoff.status)
    ||!Array.isArray(handoff.priorities)||handoff.priorities.length>48)
    return none();
  const out=[],used=new Set();
  for(const row of handoff.priorities){
    const market=row?.market==='CRYPTO_SPOT'?'spot'
      :row?.market==='CRYPTO_FUTURES'?'futures':null;
    if(!market||used.has(market)||!SYMBOL.test(row.symbol??'')
      ||row.status!=='RESEARCH_OBSERVATION_ONLY'
      ||row.executionAuthority!=='NONE'
      ||typeof row.score!=='number'||!Number.isFinite(row.score)
      ||row.score<0.7||row.score>10000
      ||typeof row.watchEventId!=='string'||!DIGEST.test(row.watchEventId)
      ||(market==='spot'&&row.direction!=='UP')
      ||(market==='futures'&&!['UP','DOWN'].includes(row.direction))
      ||verifiedInPage[market].has(row.symbol))continue;
    out.push(Object.freeze({
      market:row.market,symbol:row.symbol,direction:row.direction,
      watchEventId:row.watchEventId,status:'RESEARCH_ONLY',
      executionAuthority:'NONE',
    }));
    used.add(market);
    if(out.length===2)break;
  }
  return Object.freeze(out);
}
