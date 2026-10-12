// Public CURRENT roster + capacity-only analysis. NO provider call, archive write or order.
import { createHash } from 'node:crypto';

export const MINUTE_CAPACITY_CONTRACT='research-minute-roster-capacity/v1';
export const MINUTE_ROSTER_CONTRACT='research-public-crypto-current-roster/v1';
export const MINUTE_ROSTER_PROPOSAL='research-minute-roster-manifest-review/v1';
const DAY_MINUTES=1440;
const MINUTE=60_000;
const REGEXP=/^[A-Z0-9]{1,20}$/u;
// Require the literal USDT quote and allow documented venue Han/1-char bases.
const FUTURES=/^[A-Z0-9\p{Script=Han}]{1,26}USDT$/u;
const HASH=/^[a-f0-9]{64}$/u;
const MAX_SYMBOLS=4_096;
const STATUS=new Set(['normal','listed','maintain','limit_open','restrictedAPI','off']);
const obj=x=>x!==null && typeof x==='object' && !Array.isArray(x);
const safeInt=x=>Number.isSafeInteger(x) && x>=0;
const fail=code=>{throw new Error(code);};
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');

function nonemptyArray(v,limit,code) {
  if(!Array.isArray(v)||v.length<1||v.length>limit) fail(code);
}
function sortedUnique(values,code) {
  const out=[...values].sort();
  if(out.some((v,i)=>i>0 && v===out[i-1])) fail(code);
  return Object.freeze(out);
}
function safeObservedAt(at) {
  if(!Number.isSafeInteger(at)||at<=0) fail('MINUTE_ROSTER_TIME_INVALID');
  return at;
}
function sealRoster({market,source,observedAtMs,symbols,restricted,excludedCount}) {
  const sorted=sortedUnique(symbols,'MINUTE_ROSTER_DUPLICATE');
  const risk=sortedUnique(restricted,'MINUTE_ROSTER_RISK_DUPLICATE');
  if(!sorted.length||risk.some(s=>!sorted.includes(s))) fail('MINUTE_ROSTER_EMPTY');
  if(sorted.length>MAX_SYMBOLS||!safeInt(excludedCount))
    fail('MINUTE_ROSTER_COUNT_INVALID');
  const data=[market,source,observedAtMs,sorted,risk,excludedCount];
  return Object.freeze({
    contract:MINUTE_ROSTER_CONTRACT,market,source,observedAtMs,
    symbols:sorted,restrictedSymbols:risk,excludedCount,
    digest:digest(data),historicalPITProven:false,
    independentUniverseProof:false,canTrade:false,executionAuthority:'NONE',
  });
}
export function normalizeUpbitKrwMinuteRoster(data,observedAtMs) {
  safeObservedAt(observedAtMs);
  nonemptyArray(data,MAX_SYMBOLS*3,'MINUTE_UPBIT_ROSTER_INVALID');
  const symbols=[],restricted=[];
  let excludedCount=0;
  for(const row of data){
    if(!obj(row)||typeof row.market!=='string')
      fail('MINUTE_UPBIT_ROSTER_INVALID');
    // Public BTC/USDT markets are not KRW market members.
    if(!row.market.startsWith('KRW-')) {excludedCount++;continue;}
    const ticker=row.market.slice(4);
    if(!REGEXP.test(ticker)) fail('MINUTE_UPBIT_SYMBOL_INVALID');
    // market_warning was discontinued in 2024; never interpret its
    // absence as evidence that there is no current market warning.
    const event=row.market_event;
    if(!obj(event)||typeof event.warning!=='boolean'||!obj(event.caution))
      fail('MINUTE_UPBIT_EVENT_UNVERIFIED');
    const flags=Object.values(event.caution);
    if(flags.length===0||flags.length>32||flags.some(v=>typeof v!=='boolean'))
      fail('MINUTE_UPBIT_CAUTION_UNVERIFIED');
    symbols.push(ticker);
    if(event.warning||flags.some(Boolean)) restricted.push(ticker);
  }
  return sealRoster({market:'CRYPTO_SPOT',source:'UPBIT_PUBLIC_MARKET_ALL',
    observedAtMs,symbols,restricted,excludedCount});
}
export function normalizeBitgetUsdtMinuteRoster(body,observedAtMs) {
  safeObservedAt(observedAtMs);
  if(!obj(body)||body.code!=='00000') fail('MINUTE_BITGET_ROSTER_INVALID');
  nonemptyArray(body.data,MAX_SYMBOLS*3,'MINUTE_BITGET_ROSTER_INVALID');
  const symbols=[],restricted=[];
  const seen=new Set();
  let excludedCount=0;
  for(const row of body.data){
    if(!obj(row)||typeof row.symbol!=='string'||!FUTURES.test(row.symbol)
      ||row.quoteCoin!=='USDT'||!row.symbol.endsWith('USDT')
      ||!STATUS.has(row.symbolStatus))
      fail('MINUTE_BITGET_ROSTER_INVALID');
    if(seen.has(row.symbol)) fail('MINUTE_BITGET_DUPLICATE_SYMBOL');
    seen.add(row.symbol);
    if(row.symbolType!=='perpetual'||row.symbolStatus==='off'
      ||row.isRwa==='YES') { excludedCount++;continue; }
    // Missing/unknown RWA labels or abnormal statuses require manual
    // data-source review; keep them visible, never trade them.
    symbols.push(row.symbol);
    if(!['normal','listed'].includes(row.symbolStatus)
      ||row.isRwa!=='NO') restricted.push(row.symbol);
  }
  return sealRoster({market:'CRYPTO_FUTURES',
    source:'BITGET_PUBLIC_V2_CONTRACTS',observedAtMs,
    symbols,restricted,excludedCount});
}
export function verifyPublicMinuteRoster(roster) {
  if(!obj(roster)||roster.contract!==MINUTE_ROSTER_CONTRACT
    ||!['CRYPTO_SPOT','CRYPTO_FUTURES'].includes(roster.market)
    ||!Number.isSafeInteger(roster.observedAtMs)||roster.observedAtMs<=0
    ||!HASH.test(roster.digest??'')
    ||!Array.isArray(roster.symbols)||!roster.symbols.length
    ||!Array.isArray(roster.restrictedSymbols)
    ||roster.historicalPITProven!==false
    ||roster.independentUniverseProof!==false
    ||roster.canTrade!==false||roster.executionAuthority!=='NONE'
    ||!safeInt(roster.excludedCount))
    fail('MINUTE_ROSTER_ATTESTATION_INVALID');
  const symbols=sortedUnique(roster.symbols,'MINUTE_ROSTER_DUPLICATE');
  const risk=sortedUnique(roster.restrictedSymbols,'MINUTE_ROSTER_RISK_DUPLICATE');
  if(symbols.some(s=>!REGEXP.test(s))&&roster.market==='CRYPTO_SPOT'
    ||symbols.some(s=>!FUTURES.test(s))&&roster.market==='CRYPTO_FUTURES'
    ||risk.some(s=>!symbols.includes(s)))
    fail('MINUTE_ROSTER_ATTESTATION_INVALID');
  if(digest([roster.market,roster.source,roster.observedAtMs,
    symbols,risk,roster.excludedCount])!==roster.digest)
    fail('MINUTE_ROSTER_DIGEST_MISMATCH');
  return roster;
}
function countChecked(v,label,max=100_000){
  if(!safeInt(v)||v>max) fail(label);
  return v;
}
export function assessMinuteArchiveCapacity({
  cryptoSpotSymbols=0,cryptoFuturesSymbols=0,stockSymbols=0,
  actionsPerCycle=16,cycleMinutes=5,windowMinutes=120,
  headroomPercent=20,
}={}) {
  const spot=countChecked(cryptoSpotSymbols,'MINUTE_CAPACITY_SPOT_INVALID');
  const futures=countChecked(cryptoFuturesSymbols,'MINUTE_CAPACITY_FUTURES_INVALID');
  const stock=countChecked(stockSymbols,'MINUTE_CAPACITY_STOCK_INVALID');
  const actions=countChecked(actionsPerCycle,'MINUTE_CAPACITY_ACTIONS_INVALID',1024);
  const cycle=countChecked(cycleMinutes,'MINUTE_CAPACITY_CYCLE_INVALID',1440);
  const window=countChecked(windowMinutes,'MINUTE_CAPACITY_WINDOW_INVALID',200);
  const headroom=countChecked(headroomPercent,'MINUTE_CAPACITY_HEADROOM_INVALID',200);
  if(cycle===0||window===0||DAY_MINUTES%cycle!==0)
    fail('MINUTE_CAPACITY_INTERVAL_INVALID');
  const cyclesPerDay=DAY_MINUTES/cycle;
  const continuousSymbols=spot+futures;
  const windowsPerSymbolPerDay=Math.ceil(DAY_MINUTES/window);
  const dailyRequired=continuousSymbols*windowsPerSymbolPerDay;
  const dailyAvailable=cyclesPerDay*actions;
  const requiredWithHeadroom=Math.ceil(dailyRequired*(100+headroom)/100);
  const rateSufficient=dailyAvailable>=requiredWithHeadroom;
  const status=stock>0?'STOCK_SESSION_NOT_MODELLED'
    :!continuousSymbols?'NO_CRYPTO_CONTINUOUS_SCOPE'
      :rateSufficient?'CAPACITY_MODEL_POSSIBLE':'CAPACITY_MODEL_INSUFFICIENT';
  return Object.freeze({
    contract:MINUTE_CAPACITY_CONTRACT,status,
    cryptoSpotSymbols:spot,cryptoFuturesSymbols:futures,stockSymbols:stock,
    cycleMinutes:cycle,actionsPerCycle:actions,windowMinutes:window,
    headroomPercent:headroom,cyclesPerDay,windowsPerSymbolPerDay,
    dailyRequired,dailyAvailable,requiredWithHeadroom,
    minActionsPerCycleNoHeadroom:Math.ceil(dailyRequired/cyclesPerDay),
    minActionsPerCycleWithHeadroom:Math.ceil(requiredWithHeadroom/cyclesPerDay),
    modeledCapacitySufficient:status==='CAPACITY_MODEL_POSSIBLE',
    providerRateBudgetVerified:false,hostCapacityVerified:false,
    fourMarketCoverageProven:false,continuous24hProven:false,
    profitabilityProven:false,executionAuthority:'NONE',
  });
}
export function assessMinuteManifestCapacity(manifest,opts={}) {
  if(!obj(manifest)||!Array.isArray(manifest.ranges)
    ||manifest.ranges.length>4096) fail('MINUTE_CAPACITY_SCOPE_INVALID');
  const rows=manifest.ranges.filter(v=>obj(v)&&v.mode==='CONTINUOUS');
  const markets=['CRYPTO_SPOT','CRYPTO_FUTURES'];
  if(rows.some(v=>!['CRYPTO_SPOT','CRYPTO_FUTURES','KR_STOCK','US_STOCK'].includes(v.market)))
    fail('MINUTE_CAPACITY_SCOPE_INVALID');
  return assessMinuteArchiveCapacity({
    cryptoSpotSymbols:rows.filter(v=>v.market===markets[0]).length,
    cryptoFuturesSymbols:rows.filter(v=>v.market===markets[1]).length,
    stockSymbols:rows.filter(v=>v.market==='KR_STOCK'||v.market==='US_STOCK').length,
    ...opts,
  });
}
export function proposeCurrentCryptoMinuteManifest({
  upbit,bitget,startMs,nowMs,mode='CONTINUOUS',
}={}) {
  verifyPublicMinuteRoster(upbit);
  verifyPublicMinuteRoster(bitget);
  if(upbit.market!=='CRYPTO_SPOT'||bitget.market!=='CRYPTO_FUTURES')
    fail('MINUTE_ROSTER_MARKETS_INVALID');
  if(!Number.isSafeInteger(nowMs)||nowMs<=0
    ||nowMs-upbit.observedAtMs>15*MINUTE
    ||nowMs-bitget.observedAtMs>15*MINUTE
    ||upbit.observedAtMs>nowMs+5_000
    ||bitget.observedAtMs>nowMs+5_000)
    fail('MINUTE_ROSTER_STALE_OR_FUTURE');
  if(!Number.isSafeInteger(startMs)||startMs<=0||startMs%MINUTE
    ||startMs>nowMs-2*MINUTE||mode!=='CONTINUOUS')
    fail('MINUTE_ROSTER_START_INVALID');
  const ranges=[
    ...upbit.symbols.map(symbol=>({market:'CRYPTO_SPOT',symbol,
      mode,startMs})),
    ...bitget.symbols.map(symbol=>({market:'CRYPTO_FUTURES',symbol,
      mode,startMs})),
  ];
  if(ranges.length>2048)fail('MINUTE_ROSTER_MANIFEST_OVERSIZE');
  const capacity=assessMinuteArchiveCapacity({
    cryptoSpotSymbols:upbit.symbols.length,
    cryptoFuturesSymbols:bitget.symbols.length,
  });
  return Object.freeze({
    contract:MINUTE_ROSTER_PROPOSAL,status:'REQUIRES_OPERATOR_APPROVAL',
    manifest:Object.freeze({schemaVersion:'research-minute-backfill-scope/v1',
      ranges:Object.freeze(ranges)}),
    sourceDigests:Object.freeze([upbit.digest,bitget.digest]),
    atMs:nowMs,capacity,
    reviewed:false,admitted:false,automaticActivation:false,
    historicalPITProven:false,fullUniverseProven:false,
    executionAuthority:'NONE',
  });
}


const PUBLIC_ROSTER_URLS=Object.freeze([
  'https://api.upbit.com/v1/market/all?is_details=true',
  'https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES',
]);
export const PUBLIC_ROSTER_FETCH_LIMITS=Object.freeze({
  responseBytes:2*1024*1024,timeoutMs:8_000,publicCallsPerProbe:2,
});
async function publicRosterJson(url,{fetchImpl,timeoutMs}) {
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
  timer.unref?.();
  try{
    const res=await fetchImpl(url,{
      method:'GET',redirect:'error',signal:ctrl.signal,
      headers:{accept:'application/json', 'user-agent':'research-minute-roster-public-audit/1.0'},
    });
    if(!res || res.ok!==true) fail('MINUTE_ROSTER_PROVIDER_HTTP_BLOCKED');
    const declared=Number(res.headers?.get?.('content-length'));
    if(Number.isFinite(declared) && declared>PUBLIC_ROSTER_FETCH_LIMITS.responseBytes)
      fail('MINUTE_ROSTER_PROVIDER_BODY_OVERSIZE');
    let bytes;
    if(typeof res.body?.getReader==='function'){
      const r=res.body.getReader(),parts=[];let size=0;
      try{
        while(true){
          const {done,value}=await r.read();
          if(done) break;
          size+=value.byteLength;
          if(size>PUBLIC_ROSTER_FETCH_LIMITS.responseBytes){
            await r.cancel();
            fail('MINUTE_ROSTER_PROVIDER_BODY_OVERSIZE');
          }
          parts.push(Buffer.from(value));
        }
      }finally{r.releaseLock();}
      bytes=Buffer.concat(parts);
    }else{
      const text=await res.text();
      bytes=Buffer.from(text,'utf8');
      if(bytes.length>PUBLIC_ROSTER_FETCH_LIMITS.responseBytes)
        fail('MINUTE_ROSTER_PROVIDER_BODY_OVERSIZE');
    }
    try{return JSON.parse(bytes.toString('utf8'));}
    catch{fail('MINUTE_ROSTER_PROVIDER_JSON_INVALID');}
  }catch(e){
    if(ctrl.signal.aborted)fail('MINUTE_ROSTER_PROVIDER_TIMEOUT');
    if(/^MINUTE_ROSTER_[A-Z0-9_]+$/u.test(e?.message??''))throw e;
    fail('MINUTE_ROSTER_PROVIDER_NETWORK_UNAVAILABLE');
  }finally{clearTimeout(timer);}
}
export async function probePublicCurrentCryptoRosters({
  enabled=false,fetchImpl=globalThis.fetch,now=()=>Date.now(),
  timeoutMs=PUBLIC_ROSTER_FETCH_LIMITS.timeoutMs,
}={}){
  if(!enabled)return Object.freeze({
    status:'DISABLED',publicProviderCalls:0,archiveFilesWritten:0,
    tradingAuthority:'NONE',
  });
  if(typeof fetchImpl!=='function'||typeof now!=='function'
    ||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>15_000)
    fail('MINUTE_ROSTER_PROBE_CONFIGURATION_INVALID');
  // Fail closed on either missing provider. Never publish a partial subset as
  // an all-crypto current source snapshot. No member/trading/DB side effects.
  const a=await publicRosterJson(PUBLIC_ROSTER_URLS[0],{fetchImpl,timeoutMs});
  const spot=normalizeUpbitKrwMinuteRoster(a,now());
  const b=await publicRosterJson(PUBLIC_ROSTER_URLS[1],{fetchImpl,timeoutMs});
  const futures=normalizeBitgetUsdtMinuteRoster(b,now());
  const capacity=assessMinuteArchiveCapacity({
    cryptoSpotSymbols:spot.symbols.length,
    cryptoFuturesSymbols:futures.symbols.length,
  });
  return Object.freeze({
    contract:'research-public-roster-probe/v1',
    status:'OPERATOR_REVIEW_REQUIRED',
    publicProviderCalls:2,archiveFilesWritten:0,
    observedAtMs:now(),upbit:spot,bitget:futures,capacity,
    noProviderKeyUsed:true,marketObservationOnly:true,
    historicalPITProven:false,fullUniverseProven:false,
    tradingAuthority:'NONE',
  });
}
