// DORMANT public market-data WebSocket contract. NO SOCKET is opened here.
// Verified current roster is NOT historical PIT; WebSocket updates are NOT
// immutable final exchange candles until separate REST/source reconciliation.
import { createHash } from 'node:crypto';
import { verifyPublicMinuteRoster } from './four-market-minute-roster-capacity-v1.mjs';

export const PUBLIC_WS_MINUTE_CONTRACT='research-public-crypto-ws-minute/v1';
export const PUBLIC_WS_MINUTE_LIMITS=Object.freeze({
  maxSymbolsPerSocket:40,maxSocketPlans:32,maxMessageBytes:256*1024,
  maxRosterAgeMs:15*60_000,maxEventLeadMs:5_000,
  maxMessagesPerPacket:1,minuteMs:60_000,
});
const SOURCE=Object.freeze({
  CRYPTO_SPOT:Object.freeze({provider:'UPBIT',
    endpoint:'wss://api.upbit.com/websocket/v1',
    sourceId:'UPBIT_PUBLIC_WS_1M'}),
  CRYPTO_FUTURES:Object.freeze({provider:'BITGET',
    endpoint:'wss://ws.bitget.com/v2/ws/public',
    sourceId:'BITGET_PUBLIC_V2_WS_FUTURES_1M'}),
});
const fail=code=>{throw new TypeError(code);};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const integer=x=>Number.isSafeInteger(x)&&x>0;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const minute=x=>Math.floor(x/PUBLIC_WS_MINUTE_LIMITS.minuteMs)
  *PUBLIC_WS_MINUTE_LIMITS.minuteMs;
const noAuthority=()=>({
  sourceOnly:true,provisional:true,publicProviderGETCount:0,
  socketConnectionsOpened:0,archiveFilesWritten:0,
  privateAccountRequests:0,ordersSubmitted:0,
  historicalPITProven:false,independentOosProven:false,
  profitabilityProven:false,paperAdmissionAllowed:false,
  executionAuthority:'NONE',
});
const number=x=>{
  if((typeof x!=='string'&&typeof x!=='number')
    ||String(x).trim()==='')fail('WS_MINUTE_PRICE_INVALID');
  const n=Number(x);
  if(!Number.isFinite(n))fail('WS_MINUTE_PRICE_INVALID');
  return n;
};
function cleanRow(raw){
  const row={
    timestamp:number(raw.timestamp),
    open:number(raw.open),high:number(raw.high),
    low:number(raw.low),close:number(raw.close),
    volume:number(raw.volume),quoteVolume:number(raw.quoteVolume),
  };
  if(!integer(row.timestamp)||row.timestamp%60_000!==0
    ||row.open<=0||row.close<=0||row.high<=0||row.low<=0
    ||row.high<Math.max(row.open,row.close)
    ||row.low>Math.min(row.open,row.close)
    ||row.volume<0||row.quoteVolume<0)
    fail('WS_MINUTE_OHLCV_INVALID');
  return Object.freeze(row);
}
function decode(raw){
  if(Buffer.isBuffer(raw)||raw instanceof Uint8Array){
    if(raw.byteLength>PUBLIC_WS_MINUTE_LIMITS.maxMessageBytes)
      fail('WS_MINUTE_PACKET_OVERSIZE');
    raw=Buffer.from(raw).toString('utf8');
  }
  if(typeof raw==='string'){
    if(Buffer.byteLength(raw,'utf8')>PUBLIC_WS_MINUTE_LIMITS.maxMessageBytes)
      fail('WS_MINUTE_PACKET_OVERSIZE');
    try{return JSON.parse(raw);}catch{fail('WS_MINUTE_PACKET_JSON_INVALID');}
  }
  if(!object(raw))fail('WS_MINUTE_PACKET_INVALID');
  let size;
  try{size=Buffer.byteLength(JSON.stringify(raw),'utf8');}
  catch{fail('WS_MINUTE_PACKET_INVALID');}
  if(size>PUBLIC_WS_MINUTE_LIMITS.maxMessageBytes)
    fail('WS_MINUTE_PACKET_OVERSIZE');
  return raw;
}
function cryptoDayString(ts){
  const d=new Date(ts);
  if(!Number.isFinite(d.getTime()))fail('WS_MINUTE_DATE_INVALID');
  return d.toISOString().slice(0,10);
}
export function planPublicCryptoMinuteWebsocketV1({
  enabled=false,upbit,bitget,nowMs=Date.now(),
}={}){
  if(!enabled)return Object.freeze({contract:PUBLIC_WS_MINUTE_CONTRACT,
    status:'DISABLED',plans:Object.freeze([]),...noAuthority()});
  if(!integer(nowMs))fail('WS_MINUTE_NOW_INVALID');
  for(const r of [upbit,bitget]){
    verifyPublicMinuteRoster(r);
    if(!integer(r.observedAtMs)||r.observedAtMs>nowMs+5_000
      ||nowMs-r.observedAtMs>PUBLIC_WS_MINUTE_LIMITS.maxRosterAgeMs)
      fail('WS_MINUTE_ROSTER_STALE');
  }
  if(upbit.market!=='CRYPTO_SPOT'||bitget.market!=='CRYPTO_FUTURES')
    fail('WS_MINUTE_ROSTER_MARKET_MISMATCH');
  const plans=[];
  for(const roster of [upbit,bitget]){
    const config=SOURCE[roster.market];
    for(let i=0;i<roster.symbols.length;
      i+=PUBLIC_WS_MINUTE_LIMITS.maxSymbolsPerSocket){
      const symbols=Object.freeze(
        roster.symbols.slice(i,i+PUBLIC_WS_MINUTE_LIMITS.maxSymbolsPerSocket));
      const ticket='research-'+hash([
        roster.digest,config.provider,i,symbols]).slice(0,16);
      const subscribe=roster.market==='CRYPTO_SPOT'
        ?[{ticket},{type:'candle.1m',
          codes:symbols.map(s=>'KRW-'+s),is_only_realtime:true},
          {format:'DEFAULT'}]
        :{op:'subscribe',args:symbols.map(s=>({
          instType:'USDT-FUTURES',channel:'candle1m',instId:s,
        }))};
      plans.push(Object.freeze({
        market:roster.market,provider:config.provider,
        sourceId:config.sourceId,endpoint:config.endpoint,
        symbols,subscription:subscribe,
        restrictedSymbols:Object.freeze(
          symbols.filter(s=>roster.restrictedSymbols.includes(s))),
        rosterDigest:roster.digest,rosterObservedAtMs:roster.observedAtMs,
      }));
    }
  }
  if(plans.length>PUBLIC_WS_MINUTE_LIMITS.maxSocketPlans)
    fail('WS_MINUTE_PLAN_EXCEEDS_SOCKET_BUDGET');
  return Object.freeze({
    contract:PUBLIC_WS_MINUTE_CONTRACT,
    status:'OPERATOR_REVIEW_REQUIRED',
    plans:Object.freeze(plans),
    symbolCount:upbit.symbols.length+bitget.symbols.length,
    plannedConnections:plans.length,plannedPublicChannels:
      upbit.symbols.length+bitget.symbols.length,
    // Public market data needs no account token; data rights and
    // actual server/IP capacity are separate gates.
    publicCredentialNeeded:false,
    sourceRightsAndRetentionVerified:false,
    hostAndConnectionBudgetVerified:false,
    streamObserved:false,readyToConnect:false,
    ...noAuthority(),
  });
}
export function normalizePublicCryptoWsMinuteV1({
  raw,market,allowedSymbols,receivedAtMs,
}={}){
  const cfg=SOURCE[market];
  if(!cfg||!integer(receivedAtMs)
    ||!Array.isArray(allowedSymbols)||!allowedSymbols.length)
    fail('WS_MINUTE_NORMALIZE_SCOPE_INVALID');
  const message=decode(raw);
  let symbol,row,eventAtMs;
  if(market==='CRYPTO_SPOT'){
    if(message.type!=='candle.1m'
      ||typeof message.code!=='string'
      ||!message.code.startsWith('KRW-'))
      fail('WS_MINUTE_UPBIT_MESSAGE_INVALID');
    symbol=message.code.slice(4);
    if(message.stream_type==='SNAPSHOT')
      return Object.freeze({status:'IGNORED_SNAPSHOT',...noAuthority()});
    if(message.stream_type!=='REALTIME')
      fail('WS_MINUTE_UPBIT_STREAM_TYPE_INVALID');
    const utc=message.candle_date_time_utc;
    if(typeof utc!=='string'
      ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/u.test(utc))
      fail('WS_MINUTE_UPBIT_START_INVALID');
    const start=Date.parse(utc+'Z');
    if(!integer(start)||new Date(start).toISOString().slice(0,19)!==utc)
      fail('WS_MINUTE_UPBIT_START_INVALID');
    row=cleanRow({timestamp:start,open:message.opening_price,
      high:message.high_price,low:message.low_price,
      close:message.trade_price,volume:message.candle_acc_trade_volume,
      quoteVolume:message.candle_acc_trade_price});
    eventAtMs=number(message.timestamp);
  }else{
    if(!object(message.arg)||message.arg.instType!=='USDT-FUTURES'
      ||message.arg.channel!=='candle1m'
      ||typeof message.arg.instId!=='string')
      fail('WS_MINUTE_BITGET_MESSAGE_INVALID');
    symbol=message.arg.instId;
    if(message.action==='snapshot')
      return Object.freeze({status:'IGNORED_SNAPSHOT',...noAuthority()});
    if(message.action!=='update'||!Array.isArray(message.data)
      ||message.data.length!==1||!Array.isArray(message.data[0])
      ||message.data[0].length<7)
      fail('WS_MINUTE_BITGET_MESSAGE_INVALID');
    const v=message.data[0];
    row=cleanRow({timestamp:v[0],open:v[1],high:v[2],
      low:v[3],close:v[4],volume:v[5],quoteVolume:v[6]});
    eventAtMs=number(message.ts);
  }
  if(!allowedSymbols.includes(symbol)||!cfg
    ||receivedAtMs+PUBLIC_WS_MINUTE_LIMITS.maxEventLeadMs<eventAtMs
    ||eventAtMs<row.timestamp
    ||row.timestamp>minute(receivedAtMs))
    fail('WS_MINUTE_SOURCE_TIME_OR_SYMBOL_INVALID');
  const observation=Object.freeze({
    contract:PUBLIC_WS_MINUTE_CONTRACT,
    status:'WEBSOCKET_PROVISIONAL_MINUTE',
    market,symbol,provider:cfg.provider,sourceId:cfg.sourceId,
    row,sourceEventAtMs:eventAtMs,receivedAtMs,
    availableAtMs:receivedAtMs,observedUtcDay:cryptoDayString(row.timestamp),
    // WebSocket update is mutable, never an immutable 1m source page.
    needsRestFinalityCheck:true,fullMinuteCoverageProven:false,
    ...noAuthority(),
  });
  return observation;
}

/**
 * Bitget candle updates may include a list of rows. Normalize each row
 * separately (still provisional); never silently discard a valid row.
 * The per-symbol supervisor subsequently validates ordering and gaps.
 */
export function normalizePublicCryptoWsMinutePacketV1({
  raw,market,allowedSymbols,receivedAtMs,
}={}){
  const packet=decode(raw);
  if(market==='CRYPTO_FUTURES'&&packet.action==='update'
    &&Array.isArray(packet.data)){
    if(packet.data.length<1||packet.data.length>32
      ||packet.data.some(r=>!Array.isArray(r)||r.length<7))
      fail('WS_MINUTE_BITGET_BATCH_INVALID');
    const sorted=[...packet.data].sort((a,b)=>Number(a[0])-Number(b[0]));
    const startTimes=sorted.map(r=>r[0]);
    if(new Set(startTimes).size!==startTimes.length)
      fail('WS_MINUTE_BITGET_BATCH_DUPLICATE');
    return Object.freeze(sorted.map(row=>normalizePublicCryptoWsMinuteV1({
      raw:{...packet,data:[row]},market,allowedSymbols,receivedAtMs,
    })));
  }
  return Object.freeze([normalizePublicCryptoWsMinuteV1({
    raw:packet,market,allowedSymbols,receivedAtMs,
  })]);
}

function equalRow(a,b){
  return ['timestamp','open','high','low','close','volume','quoteVolume']
    .every(k=>a[k]===b[k]);
}
export function advancePublicCryptoWsMinuteV1({
  previous=null,observation,
}={}){
  if(observation?.contract!==PUBLIC_WS_MINUTE_CONTRACT
    ||observation.status!=='WEBSOCKET_PROVISIONAL_MINUTE')
    fail('WS_MINUTE_OBSERVATION_REQUIRED');
  const current=observation;
  if(previous===null)
    return Object.freeze({contract:PUBLIC_WS_MINUTE_CONTRACT,
      status:'PROVISIONAL_OPEN',current,unverifiedGapSlots:0,
      needsRestFinalityCheck:true,...noAuthority()});
  if(previous.contract!==PUBLIC_WS_MINUTE_CONTRACT
    ||previous.current?.market!==current.market
    ||previous.current?.symbol!==current.symbol
    ||previous.current?.sourceId!==current.sourceId)
    fail('WS_MINUTE_STATE_IDENTITY_MISMATCH');
  const old=previous.current;
  if(current.row.timestamp<old.row.timestamp
    ||current.sourceEventAtMs<old.sourceEventAtMs)
    fail('WS_MINUTE_OUT_OF_ORDER');
  if(current.row.timestamp===old.row.timestamp){
    if(current.sourceEventAtMs===old.sourceEventAtMs){
      if(!equalRow(current.row,old.row))
        fail('WS_MINUTE_SAME_EVENT_CONFLICT');
      return Object.freeze({...previous,status:'DUPLICATE_IGNORED'});
    }
    if(current.row.open!==old.row.open
      ||current.row.high<old.row.high
      ||current.row.low>old.row.low
      ||current.row.volume<old.row.volume
      ||current.row.quoteVolume<old.row.quoteVolume)
      fail('WS_MINUTE_CUMULATIVE_REVISION_INVALID');
    return Object.freeze({...previous,status:'PROVISIONAL_UPDATED',
      current});
  }
  const missing=(current.row.timestamp-old.row.timestamp)/60_000-1;
  if(!Number.isSafeInteger(missing)||missing<0)
    fail('WS_MINUTE_INTERVAL_INVALID');
  return Object.freeze({
    contract:PUBLIC_WS_MINUTE_CONTRACT,
    status:missing?'UNVERIFIED_GAPS':'ROLLOVER_REST_CHECK_REQUIRED',
    current,previousClosedCandidate:old,
    unverifiedGapSlots:previous.unverifiedGapSlots+missing,
    observedClosedMinuteCount:1,
    // A new bar does not prove the preceding provisional bar final.
    needsRestFinalityCheck:true,...noAuthority(),
  });
}
export function reconcilePublicCryptoWsRestMinuteV1({
  observation,restRow,restRetrievedAtMs,
}={}){
  if(observation?.status!=='WEBSOCKET_PROVISIONAL_MINUTE'
    ||observation.contract!==PUBLIC_WS_MINUTE_CONTRACT
    ||!integer(restRetrievedAtMs)
    ||restRetrievedAtMs<observation.receivedAtMs
    ||restRetrievedAtMs<observation.row.timestamp+65_000)
    fail('WS_MINUTE_REST_COMPARISON_INVALID');
  if(!object(restRow))
    return Object.freeze({status:'REST_MINUTE_NOT_AVAILABLE',
      sourceVerified:false,immutableArchiveAdmission:false,...noAuthority()});
  const rest=cleanRow(restRow);
  const matches=equalRow(observation.row,rest);
  return Object.freeze({
    status:matches?'REST_AND_WEBSOCKET_MATCH_SOURCE_ONLY'
      :'BLOCKED_REST_WEBSOCKET_CONFLICT',
    market:observation.market,symbol:observation.symbol,
    minuteStartMs:observation.row.timestamp,
    websocketReceiptMs:observation.receivedAtMs,
    restReceiptMs:restRetrievedAtMs,
    sourceVerified:matches,
    // Only the already existing sealed REST archive writer may create an
    // original page after separate operator + source licensing approval.
    immutableArchiveAdmission:false,
    restBackfillRequired:!matches,
    ...noAuthority(),
  });
}
