// OFFLINE/DRAFT supervisor for public crypto 1m WebSocket feeds.
// Produces transport INTENTS ONLY. Never creates WebSocket/fetch/DB/PM2/timer.
// No candle observation is final source credit without independent REST audit.
import { createHash } from 'node:crypto';
import {
  PUBLIC_WS_MINUTE_CONTRACT, PUBLIC_WS_MINUTE_LIMITS,
  normalizePublicCryptoWsMinutePacketV1,
  advancePublicCryptoWsMinuteV1,
} from './public-crypto-websocket-minute-v1.mjs';

export const PUBLIC_WS_SUPERVISOR_CONTRACT =
  'research-public-crypto-websocket-supervisor/v1';
export const PUBLIC_WS_SUPERVISOR_LIMITS = Object.freeze({
  minConnectSpacingMs:1_000, connectTimeoutMs:30_000,
  pingEveryMs:30_000, pongTimeoutMs:15_000,
  retryBaseMs:5_000, maxBackoffMs:5*60_000,
  maxReconnectFailures:8, maxPendingRestAudits:2_048,
  maxOutageAuditMinutes:180, maxInboundBytes:256*1_024,
});
const MAXTIME=8_640_000_000_000_000;
const goodMs=v=>Number.isSafeInteger(v)&&v>0&&v<MAXTIME;
const fail=code=>{throw new TypeError(code);};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const safe =()=>Object.freeze({
  sourceOnly:true,publicProviderGETCount:0,socketsOpened:0,
  realOrders:0,paperOrders:0,archiveFilesWritten:0,
  economicEvidenceCredit:0,independentOosProven:false,
  profitabilityProven:false,paperAdmissionAllowed:false,
  executionAuthority:'NONE',
});
const effect=(action,more={})=>Object.freeze({
  action,neverExecuted:true,...more,...safe(),
});
const key=(market,symbol)=>market+':'+symbol;
function plansSafe(plan){
  if(!object(plan)||plan.contract!==PUBLIC_WS_MINUTE_CONTRACT
    ||plan.status!=='OPERATOR_REVIEW_REQUIRED'
    ||plan.executionAuthority!=='NONE'||plan.readyToConnect!==false
    ||plan.sourceRightsAndRetentionVerified!==false
    ||plan.hostAndConnectionBudgetVerified!==false
    ||!Array.isArray(plan.plans)||!plan.plans.length
    ||plan.plans.length>PUBLIC_WS_MINUTE_LIMITS.maxSocketPlans
    ||plan.plannedConnections!==plan.plans.length)
    fail('WS_SUPERVISOR_SOURCE_PLAN_INVALID');
  const known=new Set();
  let count=0;
  for(const p of plan.plans){
    const up=p.market==='CRYPTO_SPOT';
    if(!['CRYPTO_SPOT','CRYPTO_FUTURES'].includes(p.market)
      ||p.provider!==(up?'UPBIT':'BITGET')
      ||p.endpoint!==(up
        ?'wss://api.upbit.com/websocket/v1'
        :'wss://ws.bitget.com/v2/ws/public')
      ||!Array.isArray(p.symbols)||!p.symbols.length
      ||p.symbols.length>PUBLIC_WS_MINUTE_LIMITS.maxSymbolsPerSocket
      ||!Array.isArray(p.restrictedSymbols)
      ||p.restrictedSymbols.some(s=>!p.symbols.includes(s))
      ||!Number.isSafeInteger(p.rosterObservedAtMs)
      ||!/^([a-f0-9]{64})$/u.test(p.rosterDigest??''))
      fail('WS_SUPERVISOR_SOURCE_PLAN_INVALID');
    if(up){
      if(!Array.isArray(p.subscription)||p.subscription.length!==3
        ||p.subscription[1]?.type!=='candle.1m'
        ||p.subscription[1]?.is_only_realtime!==true
        ||p.subscription[2]?.format!=='DEFAULT'
        ||JSON.stringify(p.subscription[1]?.codes)
          !==JSON.stringify(p.symbols.map(s=>'KRW-'+s)))
        fail('WS_SUPERVISOR_SUBSCRIPTION_INVALID');
    }else if(p.subscription?.op!=='subscribe'
      ||!Array.isArray(p.subscription?.args)
      ||JSON.stringify(p.subscription.args)
        !==JSON.stringify(p.symbols.map(s=>({
          instType:'USDT-FUTURES',channel:'candle1m',instId:s,
        }))))
      fail('WS_SUPERVISOR_SUBSCRIPTION_INVALID');
    for(const symbol of p.symbols){
      if(typeof symbol!=='string'||symbol.length<1
        ||known.has(key(p.market,symbol)))
        fail('WS_SUPERVISOR_DUPLICATE_SYMBOL');
      known.add(key(p.market,symbol));count++;
    }
  }
  if(plan.plannedPublicChannels!==count||plan.symbolCount!==count)
    fail('WS_SUPERVISOR_PLAN_COUNTS_INVALID');
}
const immutable=s=>Object.freeze(s);
const copy=s=>structuredClone(s);
function validateState(state,nowMs){
  if(!object(state)||state.contract!==PUBLIC_WS_SUPERVISOR_CONTRACT
    ||state.status!=='SIMULATION_ONLY'||!Array.isArray(state.sockets)
    ||!goodMs(nowMs)||nowMs<state.updatedAtMs
    ||!Array.isArray(state.pendingRestAudits)
    ||state.pendingRestAudits.length>PUBLIC_WS_SUPERVISOR_LIMITS.maxPendingRestAudits)
    fail('WS_SUPERVISOR_STATE_INVALID');
}
function resetToBackoff(socket,nowMs,reason){
  socket.reconnectFailures++;
  socket.phase=socket.reconnectFailures>
    PUBLIC_WS_SUPERVISOR_LIMITS.maxReconnectFailures
      ?'HALT_REVIEW':'BACKOFF';
  const exponent=Math.min(6,socket.reconnectFailures-1);
  socket.nextConnectAtMs=socket.phase==='HALT_REVIEW'?0
    :nowMs+Math.min(PUBLIC_WS_SUPERVISOR_LIMITS.maxBackoffMs,
      PUBLIC_WS_SUPERVISOR_LIMITS.retryBaseMs*2**exponent);
  socket.connectSentAtMs=0;socket.awaitingPongSinceMs=0;
  socket.lastFailure=reason;socket.lastCloseAtMs=nowMs;
  socket.acks=[];socket.subscribedAtMs=0;
}
// Collapse contiguous, not-yet-REST-audited minute ranges per symbol.
// Without this a 760-symbol feed emits >2,048 pending records after only
// three candle rollovers. Never call missing minutes 'no trade' or 'verified'.
// Preserve the COMPLETE requested tail, even past a single 180m REST page.
function gap(state,market,symbol,from,to,reason,observedAtMs){
  if(!goodMs(from)||!goodMs(to)||to<=from)return;
  const maxSpan=PUBLIC_WS_SUPERVISOR_LIMITS.maxOutageAuditMinutes*60_000;
  const prior=state.pendingRestAudits.find(v=>
    v.market===market&&v.symbol===symbol
    &&(v.requestedEndExclusiveMs??v.toExclusiveMs)>=from
    &&v.fromMs<=to);
  if(prior){
    const requiredEnd=Math.max(prior.requestedEndExclusiveMs??
      prior.toExclusiveMs,to);
    prior.requestedEndExclusiveMs=requiredEnd;
    prior.toExclusiveMs=Math.min(requiredEnd,prior.fromMs+maxSpan);
    prior.unverifiedBeyondCap=requiredEnd>prior.toExclusiveMs;
    prior.reason=prior.reason===reason?reason:'MIXED_WS_REST_AUDIT_REQUIRED';
    prior.lastObservedAtMs=observedAtMs;
    return;
  }
  if(state.pendingRestAudits.length>=PUBLIC_WS_SUPERVISOR_LIMITS.maxPendingRestAudits)
    fail('WS_SUPERVISOR_PENDING_AUDIT_LIMIT');
  const limitedEnd=Math.min(to,from+maxSpan);
  state.pendingRestAudits.push({
    market,symbol,fromMs:from,toExclusiveMs:limitedEnd,
    requestedEndExclusiveMs:to,unverifiedBeyondCap:to>limitedEnd,
    reason,observedAtMs,lastObservedAtMs:observedAtMs,
    sourceVerified:false,restBackfillRequired:true,
  });
}
export function createPublicCryptoWsSupervisorV1({
  enabled=false,plan,nowMs,
}={}){
  if(!enabled)return immutable({
    contract:PUBLIC_WS_SUPERVISOR_CONTRACT,status:'DISABLED',
    totalSockets:0,providerCalls:0,actions:Object.freeze([]),...safe(),
  });
  plansSafe(plan);
  if(!goodMs(nowMs))fail('WS_SUPERVISOR_CLOCK_INVALID');
  const sockets=plan.plans.map((p,index)=>({
    id:digest([p.market,p.provider,p.rosterDigest,p.symbols,index]).slice(0,32),
    index,market:p.market,provider:p.provider,endpoint:p.endpoint,
    symbols:[...p.symbols],subscription:p.subscription,
    phase:'BACKOFF',nextConnectAtMs:nowMs,
    reconnectFailures:0,lastFailure:null,acks:[],
    connectSentAtMs:0,subscribedAtMs:0,lastPingAtMs:0,
    awaitingPongSinceMs:0,lastPongAtMs:0,lastFrameAtMs:0,
    lastCloseAtMs:0,lastObservationAtMs:0,
    // This is an in-memory provisional observation cache only, never a
    // canonical source archive, strategy credit or encrypted trade ledger.
    provisionalBySymbol:{},
  }));
  return immutable({
    contract:PUBLIC_WS_SUPERVISOR_CONTRACT,status:'SIMULATION_ONLY',
    generatedFromPlanDigest:digest(plan.plans),
    sockets,updatedAtMs:nowMs,nextGlobalConnectAtMs:nowMs,
    pendingRestAudits:[],totalActionsProposed:0,
    ...safe(),
  });
}
function result(state,action){
  state.totalActionsProposed++;
  return immutable({state:immutable(state),intent:action,
    status:state.status,...safe()});
}
export function pollPublicCryptoWsSupervisorV1({
  state,nowMs,
}={}){
  validateState(state,nowMs);
  const s=copy(state);s.updatedAtMs=nowMs;
  for(const socket of s.sockets){
    const waiting=socket.awaitingPongSinceMs>0
      &&nowMs-socket.awaitingPongSinceMs>
      PUBLIC_WS_SUPERVISOR_LIMITS.pongTimeoutMs;
    const connecting=socket.phase==='CONNECTING'
      &&nowMs-socket.connectSentAtMs>
      PUBLIC_WS_SUPERVISOR_LIMITS.connectTimeoutMs;
    if(waiting||connecting){
      resetToBackoff(socket,nowMs,waiting?'PONG_TIMEOUT':'CONNECT_TIMEOUT');
      return result(s,effect('CLOSE_AND_RETRY_PUBLIC_SOCKET',{
        socketId:socket.id,reason:socket.lastFailure,
        nextEligibleMs:socket.nextConnectAtMs,
      }));
    }
  }
  for(const socket of s.sockets){
    if(socket.phase!=='STREAMING'
      ||socket.awaitingPongSinceMs>0
      ||nowMs-socket.lastPingAtMs<
         PUBLIC_WS_SUPERVISOR_LIMITS.pingEveryMs)continue;
    socket.awaitingPongSinceMs=nowMs;
    socket.lastPingAtMs=nowMs;
    return result(s,effect(socket.provider==='BITGET'
      ?'SEND_TEXT_PING':'SEND_WEBSOCKET_PING_FRAME',{
      socketId:socket.id,provider:socket.provider,
      payload:socket.provider==='BITGET'?'ping':null,
      deadlineMs:nowMs+PUBLIC_WS_SUPERVISOR_LIMITS.pongTimeoutMs,
    }));
  }
  if(nowMs>=s.nextGlobalConnectAtMs){
    const candidate=s.sockets.find(v=>v.phase==='BACKOFF'
      &&nowMs>=v.nextConnectAtMs);
    if(candidate){
      candidate.phase='CONNECTING';candidate.connectSentAtMs=nowMs;
      s.nextGlobalConnectAtMs=nowMs+
        PUBLIC_WS_SUPERVISOR_LIMITS.minConnectSpacingMs;
      return result(s,effect('CONNECT_PUBLIC_ONLY_INTENT',{
        socketId:candidate.id,endpoint:candidate.endpoint,
        expiresAtMs:nowMs+PUBLIC_WS_SUPERVISOR_LIMITS.connectTimeoutMs,
      }));
    }
  }
  return result(s,effect('NONE'));
}
function socketFor(state,socketId){
  const slot=state.sockets.find(v=>v.id===socketId);
  if(!slot)fail('WS_SUPERVISOR_SOCKET_IDENTITY_INVALID');
  return slot;
}
export function observePublicCryptoWsSupervisorV1({
  state,socketId,kind,nowMs,raw=null,
}={}){
  validateState(state,nowMs);
  if(typeof kind!=='string')fail('WS_SUPERVISOR_EVENT_INVALID');
  const s=copy(state);s.updatedAtMs=nowMs;
  const socket=socketFor(s,socketId);
  if(kind==='OPEN'){
    if(socket.phase!=='CONNECTING'||nowMs-socket.connectSentAtMs>
      PUBLIC_WS_SUPERVISOR_LIMITS.connectTimeoutMs)
      fail('WS_SUPERVISOR_UNEXPECTED_OPEN');
    socket.phase='SUBSCRIBING';socket.lastFrameAtMs=nowMs;
    return result(s,effect('SEND_PUBLIC_SUBSCRIPTION',{
      socketId,provider:socket.provider,
      subscription:socket.subscription,
    }));
  }
  if(kind==='SUBSCRIPTION_SENT'){
    if(socket.phase!=='SUBSCRIBING')
      fail('WS_SUPERVISOR_SUBSCRIBE_SEQUENCE_INVALID');
    socket.phase=socket.provider==='UPBIT'?'STREAMING':'AWAIT_ACK';
    if(socket.provider==='UPBIT')socket.reconnectFailures=0;
    socket.subscribedAtMs=nowMs;socket.lastPingAtMs=nowMs;
    return result(s,effect('SUBSCRIPTION_SENT_PROVISIONAL',{
      socketId,acksRequired:socket.provider==='BITGET'
        ?socket.symbols.length:0,
    }));
  }
  if(kind==='ACK'){
    if(socket.phase!=='AWAIT_ACK'||socket.provider!=='BITGET'
      ||!object(raw)||raw.event!=='subscribe'
      ||raw.arg?.instType!=='USDT-FUTURES'
      ||raw.arg?.channel!=='candle1m'
      ||!socket.symbols.includes(raw.arg.instId)
      ||(raw.code!=null&&!['0','00000'].includes(String(raw.code))))
      fail('WS_SUPERVISOR_ACK_INVALID');
    if(!socket.acks.includes(raw.arg.instId))
      socket.acks.push(raw.arg.instId);
    if(socket.acks.length===socket.symbols.length){
      socket.phase='STREAMING';socket.reconnectFailures=0;
    }
    socket.lastFrameAtMs=nowMs;
    return result(s,effect('ACK_RECORDED_PROVISIONAL',{
      socketId,acksReceived:socket.acks.length,
      acksNeeded:socket.symbols.length,
    }));
  }
  if(kind==='PONG'){
    if(socket.phase!=='STREAMING'||socket.awaitingPongSinceMs===0
      ||nowMs-socket.awaitingPongSinceMs>
        PUBLIC_WS_SUPERVISOR_LIMITS.pongTimeoutMs
      ||(socket.provider==='BITGET'&&raw!=='pong')
      ||(socket.provider==='UPBIT'&&raw!=='PONG_FRAME'))
      fail('WS_SUPERVISOR_UNEXPECTED_PONG');
    socket.awaitingPongSinceMs=0;socket.lastPongAtMs=nowMs;
    socket.lastFrameAtMs=nowMs;
    return result(s,effect('PONG_RECEIVED',{
      socketId,heartbeatHealthy:true,
    }));
  }
  if(kind==='CLOSE'){
    if(!['CONNECTING','SUBSCRIBING','AWAIT_ACK','STREAMING'].includes(
      socket.phase))
      fail('WS_SUPERVISOR_UNEXPECTED_CLOSE');
    const opened=socket.subscribedAtMs>0;
    for(const symbol of socket.symbols){
      const previous=socket.provisionalBySymbol[symbol]?.current;
      if(opened&&previous){
        gap(s,socket.market,symbol,
          previous.row.timestamp,
          Math.floor(nowMs/60_000)*60_000,
          'WEBSOCKET_DISCONNECT_UNVERIFIED',nowMs);
      }
    }
    resetToBackoff(socket,nowMs,'SOCKET_CLOSED');
    return result(s,effect('RECONNECT_BACKOFF_ONLY',{
      socketId,nextEligibleMs:socket.nextConnectAtMs,
      needsRestGapReview:true,
    }));
  }
  if(kind==='CANDLE'){
    if(socket.phase!=='STREAMING')
      fail('WS_SUPERVISOR_NOT_SUBSCRIBED');
    const observations=normalizePublicCryptoWsMinutePacketV1({
      raw,market:socket.market,
      allowedSymbols:socket.symbols,receivedAtMs:nowMs,
    });
    if(observations.length===1
      &&observations[0].status==='IGNORED_SNAPSHOT')
      return result(s,effect('SNAPSHOT_IGNORED',{socketId}));
    let last=null;
    for(const observed of observations){
      const symbol=observed.symbol;
      const older=socket.provisionalBySymbol[symbol]??null;
      const next=advancePublicCryptoWsMinuteV1({
        previous:older,observation:observed,
      });
      if(next.status==='UNVERIFIED_GAPS'
        ||next.status==='ROLLOVER_REST_CHECK_REQUIRED'){
        gap(s,socket.market,symbol,
          next.previousClosedCandidate.row.timestamp,
          observed.row.timestamp,
          next.status==='UNVERIFIED_GAPS'
            ?'MISSING_MINUTE_SLOTS_UNVERIFIED':'CLOSED_CANDLE_NEEDS_REST_FINALITY',
          nowMs);
      }
      socket.provisionalBySymbol[symbol]=next;
      last={symbol,minuteStartMs:observed.row.timestamp,status:next.status};
    }
    socket.lastFrameAtMs=nowMs;socket.lastObservationAtMs=nowMs;
    return result(s,effect('PROVISIONAL_MINUTE_OBSERVED',{
      socketId,market:socket.market,symbol:last.symbol,
      observedMinuteStartMs:last.minuteStartMs,
      observationsInPacket:observations.length,
      pendingRestAudits:s.pendingRestAudits.length,
      status:last.status,
    }));
  }
  fail('WS_SUPERVISOR_EVENT_INVALID');
}
export function publicCryptoWsSupervisorStatusV1(state){
  if(!object(state)||state.contract!==PUBLIC_WS_SUPERVISOR_CONTRACT)
    fail('WS_SUPERVISOR_STATE_INVALID');
  if(state.status==='DISABLED')
    return immutable({status:'DISABLED',...safe()});
  const count=x=>state.sockets.filter(s=>s.phase===x).length;
  return immutable({
    contract:PUBLIC_WS_SUPERVISOR_CONTRACT,
    status:'SIMULATION_ONLY',plannedConnections:state.sockets.length,
    connecting:count('CONNECTING'),
    streaming:count('STREAMING'),awaitingAcknowledgements:count('AWAIT_ACK'),
    backoff:count('BACKOFF'),manualReviewRequired:count('HALT_REVIEW'),
    pendingRestAudits:state.pendingRestAudits.length,
    pendingRestNotAutoExecuted:true,
    allSymbolsContinuouslyObserved:false,
    venueRatesHostAndRetentionAttested:false,
    ...safe(),
  });
}
