// Standalone Signal V3 public-only scheduler/health contract. No external
// network here; safe to exercise 24h of *virtual* time in offline unit tests.
// Real 24h public-provider uptime is NOT established by this code.
export const PUBLIC_SCAN_SUPERVISOR_SCHEMA='public-scan-supervisor-v1';
const MARKETS=['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES'];
const PROFILES=['SCALPING','SWING','MID_LONG'];
const STATUSES=new Set(['CANDIDATES_AVAILABLE','VALID_NO_TRADE','BLOCKED_DATA','SEARCH_FAILURE']);
const exactSha=/^[a-f0-9]{40}$/u;
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const safeDate=x=>{const t=Date.parse(String(x??''));return Number.isFinite(t)?t:null;};
export function summarizePublicCycleHealth(snapshot, expectedSha, observedNow=Date.now()){
 if(!exactSha.test(expectedSha)||!Number.isFinite(observedNow)||observedNow<0)
   throw Error('PUBLIC_SUPERVISOR_BAD_EXPECTATION');
 if(!snapshot||snapshot.serviceSha!==expectedSha
   ||snapshot.publicDataOnly!==true||snapshot.safety?.executionAuthority!=='NONE'
   ||snapshot.profile?.fullStrategyCoverage!==true
   ||!Array.isArray(snapshot.coverage)||snapshot.coverage.length!==12)
   throw Error('PUBLIC_SUPERVISOR_UNTRUSTED_CYCLE');
 const at=safeDate(snapshot.generatedAt);
 if(at===null||at>observedNow+5000||observedNow-at>15*60000)
   throw Error('PUBLIC_SUPERVISOR_STALE_CYCLE');
 const seen=new Set(),buckets={candidate:0,noTrade:0,blocked:0,failed:0};
 const market={};
 for(const m of MARKETS)market[m]={verifiedBatches:0,blockedBatches:0,failedBatches:0,
   providerErrors:0,timeouts:0,sourceEligibleRoundVerifications:0};
 for(const row of snapshot.coverage){
   const key=row.market+'|'+row.strategy;
   if(!MARKETS.includes(row.market)||!PROFILES.includes(row.strategy)
     ||seen.has(key)||!STATUSES.has(row.status))throw Error('PUBLIC_SUPERVISOR_LANES_INVALID');
   seen.add(key);
   const m=market[row.market];
   if(row.status==='CANDIDATES_AVAILABLE'){buckets.candidate++;m.verifiedBatches++;}
   if(row.status==='VALID_NO_TRADE'){buckets.noTrade++;m.verifiedBatches++;}
   if(row.status==='BLOCKED_DATA'){buckets.blocked++;m.blockedBatches++;}
   if(row.status==='SEARCH_FAILURE'){buckets.failed++;m.failedBatches++;}
   if(!integer(row.providerErrors)||!integer(row.timeouts))
     throw Error('PUBLIC_SUPERVISOR_MISSING_FAILURE_COUNTS');
   m.providerErrors+=row.providerErrors;
   m.timeouts+=row.timeouts;
   if(row.eligibleIndexProgress?.lastRound?.allEligibleIndexPagesVerified===true
     && row.eligibleIndexProgress?.lastRound?.fullMarketConstituentProof===false)
      m.sourceEligibleRoundVerifications++;
 }
 if(seen.size!==12)throw Error('PUBLIC_SUPERVISOR_MISSING_LANES');
 return Object.freeze({
  schemaVersion:PUBLIC_SCAN_SUPERVISOR_SCHEMA,at:new Date(at).toISOString(),
  buckets:Object.freeze({...buckets}),
  markets:Object.freeze(Object.fromEntries(Object.entries(market).map(([k,v])=>[k,Object.freeze(v)]))),
  executionAuthority:'NONE',
  allMarketProviderCoverageProven:false,
  actualContinuous24hVerified:false,
  profitabilityProven:false,
 });
}
export function createPublicOnlyCycleController({
 serviceSha,now=Date.now,minIntervalMs=120000,maxHistory=720,
}={}){
 if(!exactSha.test(serviceSha)||typeof now!=='function'
   ||!Number.isInteger(minIntervalMs)||minIntervalMs<60000||minIntervalMs>3600000
   ||!Number.isInteger(maxHistory)||maxHistory<1||maxHistory>1440)
   throw Error('PUBLIC_SUPERVISOR_OPTIONS_INVALID');
 let running=false,startedAt=null,nextAllowedAt=0,completed=0,failed=0,lastError=null,lastHealth=null;
 const history=[];
 function prune(t){
   while(history.length>maxHistory || (history.length && t-history[0].atMs>24*3600000))
     history.shift();
 }
 return Object.freeze({
  start(){
    const t=now();
    if(!Number.isFinite(t)||t<0)throw Error('PUBLIC_SUPERVISOR_CLOCK_INVALID');
    if(running)return Object.freeze({allowed:false,reason:'IN_FLIGHT'});
    if(t<nextAllowedAt)return Object.freeze({allowed:false,reason:'INTERVAL_NOT_DUE',waitMs:nextAllowedAt-t});
    running=true;startedAt=t;
    return Object.freeze({allowed:true,reason:'PUBLIC_ONLY_CYCLE',startedAt:t});
  },
  finish({snapshot,error}={}){
    if(!running||startedAt===null)throw Error('PUBLIC_SUPERVISOR_NOT_RUNNING');
    const at=now();
    if(!Number.isFinite(at)||at<startedAt)throw Error('PUBLIC_SUPERVISOR_CLOCK_REVERSED');
    let summary=null,failReason=null;
    if(error)failReason='CYCLE_EXECUTION_FAILED';
    else try{summary=summarizePublicCycleHealth(snapshot,serviceSha,at);}
      catch(e){failReason=e instanceof Error?e.message.split(':')[0]:'UNKNOWN';}
    if(summary){completed++;lastHealth=summary;lastError=null;}
    else{failed++;lastError=failReason??'PUBLIC_SUPERVISOR_NO_EVIDENCE';}
    history.push({atMs:at,ok:Boolean(summary),
      results:summary?summary.buckets:null,reason:failReason});
    prune(at);
    running=false;startedAt=null;
    // Limit automatic repeats: never start a burst after a slow/failing
    // cycle, and never exceed one read-only scan each minute.
    nextAllowedAt=at+minIntervalMs;
    return Object.freeze({ok:Boolean(summary),reason:failReason,
      nextAllowedAt,executionAuthority:'NONE'});
  },
  health(){
    prune(now());
    return Object.freeze({
      schemaVersion:PUBLIC_SCAN_SUPERVISOR_SCHEMA,serviceSha,
      running,nextAllowedAt,
      completed,failed,lastError,
      observationsInPast24h:history.length,
      lastHealth,fullMarketVerified:false,actualContinuous24hVerified:false,
      executionAuthority:'NONE',noRealOrders:true,
    });
  },
 });
}
