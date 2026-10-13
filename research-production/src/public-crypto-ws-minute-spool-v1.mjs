// DORMANT per-socket minute coalescing spool. Pure/in-memory only.
// Incoming cumulative WS updates stay source-only and NEVER become
// original REST candles, OOS/Paper evidence, orders or a live connection.
import {createHash} from 'node:crypto';
import {
  PUBLIC_WS_MINUTE_CONTRACT,PUBLIC_WS_MINUTE_LIMITS,
  normalizePublicCryptoWsMinutePacketV1,
  advancePublicCryptoWsMinuteV1,
} from './public-crypto-websocket-minute-v1.mjs';
import {
  preparePublicWsProvisionalBatchV1,
  PUBLIC_WS_SIDECAR_LIMITS,
} from './public-crypto-ws-sidecar-v1.mjs';

export const PUBLIC_WS_SPOOL_CONTRACT=
  'research-public-ws-minute-compaction-spool/v1';
export const PUBLIC_WS_SPOOL_LIMITS=Object.freeze({
  maxWindowMinutes:5,maxSymbolsPerSocket:
    PUBLIC_WS_MINUTE_LIMITS.maxSymbolsPerSocket,
  maxPacketUpdates:PUBLIC_WS_SIDECAR_LIMITS.maxRawUpdatesAccounted,
});
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const integer=x=>Number.isSafeInteger(x)&&x>0;
const fail=code=>{throw new TypeError(code);};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const zero=()=>Object.freeze({
  sourceOnly:true,liveConnectionVerified:false,
  hostStorageBenchmarked:false,providerRateBudgetVerified:false,
  licensedRedistributionProven:false,
  originalRestSourceVerified:false,independentOosProven:false,
  profitabilityProven:false,paperAdmissionAllowed:false,
  publicProviderGETCount:0,websocketConnectionsOpened:0,
  archiveFilesWritten:0,executionAuthority:'NONE',
});
function validateWindow(startMs,windowMinutes){
  if(!integer(startMs)||startMs%60_000
    ||!Number.isSafeInteger(windowMinutes)||windowMinutes<1
    ||windowMinutes>PUBLIC_WS_SPOOL_LIMITS.maxWindowMinutes
    ||new Date(startMs).toISOString().slice(0,10)
      !==new Date(startMs+windowMinutes*60_000-60_000)
        .toISOString().slice(0,10))
    fail('WS_SPOOL_WINDOW_INVALID');
}
function checkState(s){
  if(!object(s)||s.contract!==PUBLIC_WS_SPOOL_CONTRACT
    ||s.status!=='PROVISIONAL_BUFFERED'
    ||!Number.isSafeInteger(s.rawUpdatesReceived)
    ||s.rawUpdatesReceived<0
    ||!object(s.latestBySymbolMinute)
    ||!Array.isArray(s.symbols)
    ||s.symbols.length<1
    ||s.symbols.length>PUBLIC_WS_SPOOL_LIMITS.maxSymbolsPerSocket
    ||s.executionAuthority!=='NONE')
    fail('WS_SPOOL_STATE_INVALID');
}
function checkPlan(p){
  if(!object(p)||!['CRYPTO_SPOT','CRYPTO_FUTURES'].includes(p.market)
    ||p.endpoint!==(p.market==='CRYPTO_SPOT'
      ?'wss://api.upbit.com/websocket/v1'
      :'wss://ws.bitget.com/v2/ws/public')
    ||p.sourceId!==(p.market==='CRYPTO_SPOT'
      ?'UPBIT_PUBLIC_WS_1M':'BITGET_PUBLIC_V2_WS_FUTURES_1M')
    ||p.provider!==(p.market==='CRYPTO_SPOT'?'UPBIT':'BITGET')
    ||!Array.isArray(p.symbols)||!p.symbols.length
    ||p.symbols.length>PUBLIC_WS_SPOOL_LIMITS.maxSymbolsPerSocket
    ||new Set(p.symbols).size!==p.symbols.length
    ||p.symbols.some(symbol=>typeof symbol!=='string'
      ||(p.market==='CRYPTO_SPOT'
        ?!/^[A-Z0-9]{1,20}$/u.test(symbol)
        :!/^[A-Z0-9\p{Script=Han}]{1,26}USDT$/u.test(symbol)))
    ||!/^([a-f0-9]{64})$/u.test(p.rosterDigest??''))
    fail('WS_SPOOL_PUBLIC_PLAN_INVALID');
}
/** Worst-case official 1s pushes per trading symbol, not observed traffic. */
export function assessPublicWsSpoolPressureV1({
  symbolsPerSocket=40,windowMinutes=5,
  updatesPerSecondPerSymbol=1,
}={}){
  const [s,w,r]=[symbolsPerSocket,windowMinutes,
    updatesPerSecondPerSymbol];
  if(!Number.isSafeInteger(s)||s<1||s>40
    ||!Number.isSafeInteger(w)||w<1||w>5
    ||!Number.isSafeInteger(r)||r<0||r>10)
    fail('WS_SPOOL_PRESSURE_INPUT_INVALID');
  const theoreticalUpdates=s*w*60*r,distinctSnapshots=s*w;
  return Object.freeze({
    contract:PUBLIC_WS_SPOOL_CONTRACT,
    status:'THEORETICAL_NOT_OPERATIONAL',
    symbolsPerSocket:s,windowMinutes:w,updatesPerSecondPerSymbol:r,
    theoreticalRawUpdates:theoreticalUpdates,
    theoreticalMinuteSnapshots:distinctSnapshots,
    rawSidecarLimit:PUBLIC_WS_SIDECAR_LIMITS.maxBatchObservations,
    naiveRawBatchWouldOverflow:
      theoreticalUpdates>PUBLIC_WS_SIDECAR_LIMITS.maxBatchObservations,
    snapshotBatchFitsCountOnly:
      distinctSnapshots<=PUBLIC_WS_SIDECAR_LIMITS.maxDistinctMinutes
      &&distinctSnapshots<=PUBLIC_WS_SIDECAR_LIMITS.maxBatchObservations,
    actualPacketRateUnknown:true,requiresPerSocketInMemoryCoalescing:true,
    ...zero(),
  });
}
export function createPublicWsMinuteSpoolV1({
  enabled=false,plan,windowStartMs,windowMinutes=5,
}={}){
  if(!enabled)return Object.freeze({
    contract:PUBLIC_WS_SPOOL_CONTRACT,status:'DISABLED',
    rawUpdatesReceived:0,snapshotsStored:0,...zero(),
  });
  checkPlan(plan);
  validateWindow(windowStartMs,windowMinutes);
  const endMs=windowStartMs+windowMinutes*60_000;
  const digest=hash([plan.market,plan.provider,plan.rosterDigest,
    plan.symbols,windowStartMs,endMs]);
  return Object.freeze({
    contract:PUBLIC_WS_SPOOL_CONTRACT,status:'PROVISIONAL_BUFFERED',
    market:plan.market,sourceId:plan.sourceId,
    symbols:Object.freeze([...plan.symbols]),
    windowStartMs,windowEndMs:endMs,
    socketDigest:digest,
    latestBySymbolMinute:{},rawUpdatesReceived:0,
    duplicateUpdates:0,lastPacketAtMs:0,
    ...zero(),
  });
}
export function ingestPublicWsMinuteSpoolPacketV1({
  state,raw,receivedAtMs,
}={}){
  checkState(state);
  if(!integer(receivedAtMs)
    ||receivedAtMs<state.windowStartMs
    ||receivedAtMs>state.windowEndMs+60_000
    ||(state.lastPacketAtMs>0&&receivedAtMs<state.lastPacketAtMs))
    fail('WS_SPOOL_PACKET_TIME_INVALID');
  const updates=normalizePublicCryptoWsMinutePacketV1({
    market:state.market,allowedSymbols:state.symbols,raw,receivedAtMs,
  });
  if(updates.length===1&&updates[0].status==='IGNORED_SNAPSHOT')
    return Object.freeze({
      status:'IGNORED_SNAPSHOT',state,latestSnapshots:
        Object.keys(state.latestBySymbolMinute).length,...zero(),
    });
  if(state.rawUpdatesReceived+updates.length>
    PUBLIC_WS_SPOOL_LIMITS.maxPacketUpdates)
    fail('WS_SPOOL_UPDATE_COUNT_LIMIT');
  const next=structuredClone(state);
  let duplicate=0;
  for(const observed of updates){
    if(observed.contract!==PUBLIC_WS_MINUTE_CONTRACT
      ||observed.status!=='WEBSOCKET_PROVISIONAL_MINUTE'
      ||observed.row.timestamp<state.windowStartMs
      ||observed.row.timestamp>=state.windowEndMs)
      fail('WS_SPOOL_SOURCE_WINDOW_INVALID');
    const k=observed.symbol+':'+observed.row.timestamp;
    const prior=next.latestBySymbolMinute[k];
    if(!prior&&Object.keys(next.latestBySymbolMinute).length>=
      PUBLIC_WS_SIDECAR_LIMITS.maxDistinctMinutes)
      fail('WS_SPOOL_DISTINCT_MINUTES_LIMIT');
    const result=advancePublicCryptoWsMinuteV1({
      previous:prior?{
        contract:PUBLIC_WS_MINUTE_CONTRACT,current:prior,
        status:'PROVISIONAL_BUFFERED',unverifiedGapSlots:0,
      }:null,
      observation:observed,
    });
    if(result.status==='DUPLICATE_IGNORED')duplicate++;
    else next.latestBySymbolMinute[k]=observed;
  }
  next.rawUpdatesReceived+=updates.length;
  next.duplicateUpdates+=duplicate;
  next.lastPacketAtMs=receivedAtMs;
  return Object.freeze({
    status:'PROVISIONAL_SPOOL_UPDATED',state:Object.freeze(next),
    newestRawUpdateAtMs:receivedAtMs,
    latestSnapshots:Object.keys(next.latestBySymbolMinute).length,
    duplicateUpdates:next.duplicateUpdates,
    ...zero(),
  });
}
export function preparePublicWsMinuteSpoolSidecarV1({
  state,producerSha,nowMs,
}={}){
  checkState(state);
  if(!integer(nowMs)||nowMs<state.windowEndMs+5_000
    ||!/^([a-f0-9]{40})$/u.test(producerSha??''))
    fail('WS_SPOOL_FINALIZE_TIME_OR_SHA_INVALID');
  const observations=Object.values(state.latestBySymbolMinute)
    .sort((a,b)=>a.symbol.localeCompare(b.symbol)
      ||a.row.timestamp-b.row.timestamp);
  if(!observations.length)
    return Object.freeze({
      status:'HOLD_NO_OBSERVED_MINUTES',prepared:null,
      rawUpdatesReceived:state.rawUpdatesReceived,
      reason:'NO_TRADE_OR_SOURCE_UNVERIFIED',...zero(),
    });
  const prepared=preparePublicWsProvisionalBatchV1({
    enabled:true,market:state.market,
    socketDigest:state.socketDigest,producerSha,
    startMs:state.windowStartMs,endMs:state.windowEndMs,
    observations,actualUpdatesSeen:state.rawUpdatesReceived,nowMs,
  });
  return Object.freeze({
    contract:PUBLIC_WS_SPOOL_CONTRACT,
    status:'SEALED_SPOOL_SOURCE_ONLY',prepared,
    rawUpdatesReceived:state.rawUpdatesReceived,
    minuteSnapshots:observations.length,
    compressionRatio:state.rawUpdatesReceived/observations.length,
    storagePersistRequiresSeparateOperatorApproval:true,
    ...zero(),
  });
}
