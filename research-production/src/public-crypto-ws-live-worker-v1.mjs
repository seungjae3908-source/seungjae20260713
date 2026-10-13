// Isolated REAL public WebSocket transport. This opens genuine outbound
// sockets ONLY after explicit owner/runtime approvals. Source-only; no REST
// calls, secrets, DB, account, execution, Telegram or Paper authority.
import {
  createPublicCryptoWsSupervisorV1,pollPublicCryptoWsSupervisorV1,
  observePublicCryptoWsSupervisorV1,
} from './public-crypto-ws-supervisor-v1.mjs';
import {
  normalizePublicCryptoWsMinutePacketV1,
} from './public-crypto-websocket-minute-v1.mjs';
import {
  createPublicWsMinuteSpoolV1,ingestPublicWsMinuteSpoolPacketV1,
  preparePublicWsMinuteSpoolSidecarV1,
} from './public-crypto-ws-minute-spool-v1.mjs';
import {
  persistPublicWsProvisionalBatchV1,
} from './public-crypto-ws-sidecar-v1.mjs';
import {planPendingPublicWsRestAuditsV1}
  from './public-crypto-ws-rest-handoff-v1.mjs';
import {
  startPublicWsLiveJournalV1,stopPublicWsLiveJournalV1,
  measurePrivateWsFreeBytesV1,
} from './public-crypto-ws-live-journal-v1.mjs';

export const LIVE_WS_WORKER_CONTRACT='research-public-ws-live-worker/v1';
const FIVE_MIN=300_000,MIN=60_000,MAX_QUEUE=4_096;
const fail=c=>{throw new Error(c);};
const safeErr=e=>/^((?:LIVE_WS|WS_|MINUTE_)[A-Z0-9_]{1,90})$/u
  .test(String(e?.message??''))?e.message:'LIVE_WS_RUNTIME_QUARANTINED';
const REPORT_BASE=Object.freeze({
  sourceOnly:true,originalRestVerified:false,independentOosProven:false,
  profitabilityProven:false,paperAdmissionAllowed:false,
  executionAuthority:'NONE',realOrders:0,paperOrders:0,
  privateAccountCalls:0,telegramMessagesSent:0,
});
const parseMessage=async(raw,max)=>{
  let text;
  if(typeof raw==='string'){
    if(Buffer.byteLength(raw)>max)fail('LIVE_WS_FRAME_OVERSIZE');
    text=raw;
  }else if(raw instanceof ArrayBuffer){
    if(raw.byteLength>max)fail('LIVE_WS_FRAME_OVERSIZE');
    text=new TextDecoder('utf-8',{fatal:true}).decode(raw);
  }else if(ArrayBuffer.isView(raw)){
    if(raw.byteLength>max)fail('LIVE_WS_FRAME_OVERSIZE');
    text=new TextDecoder('utf-8',{fatal:true}).decode(raw);
  }else if(raw&&typeof raw.arrayBuffer==='function'&&typeof raw.size==='number'){
    if(raw.size>max)fail('LIVE_WS_FRAME_OVERSIZE');
    text=new TextDecoder('utf-8',{fatal:true}).decode(await raw.arrayBuffer());
  }else fail('LIVE_WS_FRAME_TYPE_INVALID');
  if(text==='pong')return 'pong';
  let packet;
  try{packet=JSON.parse(text);}catch{fail('LIVE_WS_FRAME_JSON_INVALID');}
  return packet;
};
const rounded=ms=>Math.floor(ms/MIN)*MIN;
const windowStart=ms=>Math.floor(ms/FIVE_MIN)*FIVE_MIN;
const isGoodSha=x=>/^[a-f0-9]{40}$/u.test(x??'');

export function createPublicCryptoWsLiveWorkerV1({
  enabled=false,operatorApproved=false,sourceRightsConfirmed=false,
  hostCapacityConfirmed=false,plan,root,producerSha,
  socketFactory=url=>new globalThis.WebSocket(url),
  clock=()=>Date.now(),diskFree=measurePrivateWsFreeBytesV1,
  persist=persistPublicWsProvisionalBatchV1,
  journalStart=startPublicWsLiveJournalV1,
  journalStop=stopPublicWsLiveJournalV1,
  logger=()=>{},intervalMs=1_000,
}={}){
  if(!enabled)return Object.freeze({
    status:'DISABLED',sourceOnly:true,websocketConnectionsOpened:0,
    publicProviderGETCount:0,archiveFilesWritten:0,
    ...REPORT_BASE,
  });
  if(!operatorApproved||!sourceRightsConfirmed||!hostCapacityConfirmed)
    fail('LIVE_WS_EXPLICIT_APPROVALS_REQUIRED');
  if(!isGoodSha(producerSha)||typeof root!=='string'
    ||typeof socketFactory!=='function'||typeof clock!=='function'
    ||typeof diskFree!=='function'||typeof persist!=='function'
    ||typeof journalStart!=='function'||typeof journalStop!=='function'
    ||typeof logger!=='function'||intervalMs<500||intervalMs>5_000)
    fail('LIVE_WS_WORKER_PREFLIGHT_INVALID');
  const initial=clock();
  let state=createPublicCryptoWsSupervisorV1({enabled:true,plan,nowMs:initial});
  const socketById=new Map(),spools=new Map();
  let session=null,started=false,stopped=false,halted=false,timer=null;
  let pending=0,queue=Promise.resolve(),errorCode=null;
  const count={connectionsOpened:0,reconnectIntents:0,
    inboundCandles:0,inboundUpdates:0,sidecarsStored:0,
    sidecarsReused:0,rawDataBytes:0};
  const byId=new Map(state.sockets.map(s=>[s.id,plan.plans[s.index]]));
  const timestamp=()=>Math.max(state.updatedAtMs,clock());
  function log(code,more={}){
    try{logger({contract:LIVE_WS_WORKER_CONTRACT,event:code,
      atMs:clock(),...more,...REPORT_BASE});}catch{/* logging never grants rights */}
  }
  function closeOne(id){
    const socket=socketById.get(id);
    if(socket){
      socketById.delete(id);
      try{socket.close(1000,'source-only-retry');}catch{/* already closed */}
    }
  }
  function fatal(e){
    if(halted)return;
    halted=true;errorCode=safeErr(e);
    if(timer){clearInterval(timer);timer=null;}
    for(const id of socketById.keys())closeOne(id);
    // Intentionally do NOT write STOP: crash/forced-stop debt must survive.
    log('HALTED_NO_SOURCE_CREDIT',{reason:errorCode});
  }
  const enqueue=(fn)=>{
    pending++;
    if(pending>MAX_QUEUE){
      pending--;
      fatal(new Error('LIVE_WS_INBOUND_BACKPRESSURE'));
      return Promise.resolve();
    }
    const item=queue.then(async()=>{
      try{if(!halted&&!stopped)await fn();}
      catch(e){fatal(e);}
      finally{pending--;}
    });
    queue=item;
    return item;
  };
  const drain=async()=>{await queue;};
  async function flushReady(nowMs){
    for(const [id,shards] of spools){
      for(const [w,s] of shards){
        if(s.windowEndMs+5_000>nowMs)continue;
        const ready=preparePublicWsMinuteSpoolSidecarV1({
          state:s,producerSha,nowMs,
        });
        if(ready.status==='HOLD_NO_OBSERVED_MINUTES'){
          shards.delete(w);continue;
        }
        if(ready.status!=='SEALED_SPOOL_SOURCE_ONLY')
          fail('LIVE_WS_SPOOL_SEAL_BLOCKED');
        const free=await diskFree(root);
        if(!Number.isSafeInteger(free)||free<5*1024**3)
          fail('LIVE_WS_DISK_BELOW_MINIMUM');
        const result=await persist({
          enabled:true,operatorApproved:true,root,
          prepared:ready.prepared,freeBytes:free,
        });
        if(!['SEALED_PROVISIONAL_ONLY','REUSED_IDENTICAL']
          .includes(result.status))
          fail('LIVE_WS_SIDECAR_PERSIST_BLOCKED');
        if(result.status==='SEALED_PROVISIONAL_ONLY')count.sidecarsStored++;
        else count.sidecarsReused++;
        // Remove from RAM ONLY after immutable readback and fsync.
        shards.delete(w);
      }
      if(shards.size===0)spools.delete(id);
    }
  }
  async function handleAction(intent){
    const action=intent.action;
    if(action==='NONE'||action==='PROVISIONAL_MINUTE_OBSERVED'
      ||action==='ACK_RECORDED_PROVISIONAL'
      ||action==='PONG_RECEIVED'
      ||action==='SNAPSHOT_IGNORED'
      ||action==='SUBSCRIPTION_SENT_PROVISIONAL'
      ||action==='RECONNECT_BACKOFF_ONLY')return;
    if(action==='CLOSE_AND_RETRY_PUBLIC_SOCKET'){
      count.reconnectIntents++;closeOne(intent.socketId);return;
    }
    if(action==='CONNECT_PUBLIC_ONLY_INTENT'){
      const planSlot=byId.get(intent.socketId);
      if(!planSlot||intent.endpoint!==planSlot.endpoint
        ||!['wss://api.upbit.com/websocket/v1',
          'wss://ws.bitget.com/v2/ws/public'].includes(intent.endpoint))
        fail('LIVE_WS_CONNECT_ENDPOINT_DENIED');
      closeOne(intent.socketId);
      let ws;
      try{ws=socketFactory(intent.endpoint);}
      catch{
        const step=observePublicCryptoWsSupervisorV1({
          state,socketId:intent.socketId,kind:'CLOSE',nowMs:timestamp(),
        });
        state=step.state;return;
      }
      if(!ws||typeof ws.addEventListener!=='function'
        ||typeof ws.send!=='function'||typeof ws.close!=='function')
        fail('LIVE_WS_TRANSPORT_INVALID');
      socketById.set(intent.socketId,ws);
      ws.addEventListener('open',()=>{void enqueue(async()=>{
        if(socketById.get(intent.socketId)!==ws)return;
        const step=observePublicCryptoWsSupervisorV1({
          state,socketId:intent.socketId,kind:'OPEN',nowMs:timestamp(),
        });
        state=step.state;
        count.connectionsOpened++;
        await handleAction(step.intent);
      });});
      ws.addEventListener('message',event=>{void enqueue(async()=>{
        if(socketById.get(intent.socketId)!==ws)return;
        await handleFrame(intent.socketId,event.data);
      });});
      ws.addEventListener('error',()=>{void enqueue(async()=>{
        await handleClose(intent.socketId,ws,'TRANSPORT_ERROR');
      });});
      ws.addEventListener('close',()=>{void enqueue(async()=>{
        await handleClose(intent.socketId,ws,'TRANSPORT_CLOSED');
      });});
      return;
    }
    if(action==='SEND_PUBLIC_SUBSCRIPTION'){
      const ws=socketById.get(intent.socketId);
      if(!ws||ws.readyState!==1)fail('LIVE_WS_SUBSCRIBE_NOT_OPEN');
      // Only the supervisor's vetted public candle subscription is sent.
      ws.send(JSON.stringify(intent.subscription));
      const step=observePublicCryptoWsSupervisorV1({
        state,socketId:intent.socketId,kind:'SUBSCRIPTION_SENT',
        nowMs:timestamp(),
      });
      state=step.state;return;
    }
    if(action==='SEND_TEXT_PING'||action==='SEND_WEBSOCKET_PING_FRAME'){
      const ws=socketById.get(intent.socketId);
      if(!ws||ws.readyState!==1)fail('LIVE_WS_HEARTBEAT_SOCKET_INVALID');
      // WHATWG WebSocket has no control-frame ping API. Upbit explicitly
      // permits text PING and responds with JSON {status:'UP'}.
      ws.send(action==='SEND_TEXT_PING'?'ping':'PING');
      return;
    }
    fail('LIVE_WS_UNKNOWN_SUPERVISOR_INTENT');
  }
  async function handleClose(id,ws,reason){
    if(socketById.get(id)!==ws)return;
    socketById.delete(id);
    const slot=state.sockets.find(x=>x.id===id);
    if(!slot||!['CONNECTING','SUBSCRIBING','AWAIT_ACK',
      'STREAMING'].includes(slot.phase))return;
    const result=observePublicCryptoWsSupervisorV1({
      state,socketId:id,kind:'CLOSE',nowMs:timestamp(),
    });
    state=result.state;
    count.reconnectIntents++;
    log('PUBLIC_SOCKET_RECONNECT_NEEDED',{provider:slot.provider,reason});
  }
  async function handleFrame(id,raw){
    const socket=state.sockets.find(s=>s.id===id);
    if(!socket)fail('LIVE_WS_SOCKET_UNKNOWN');
    const packet=await parseMessage(raw,256*1_024);
    if(packet==='pong'||packet?.status==='UP'){
      if((packet==='pong'&&socket.provider==='BITGET'
        ||packet?.status==='UP'&&socket.provider==='UPBIT')
        &&socket.awaitingPongSinceMs>0){
        const done=observePublicCryptoWsSupervisorV1({
          state,socketId:id,kind:'PONG',nowMs:timestamp(),
          raw:socket.provider==='UPBIT'?'PONG_FRAME':'pong',
        });
        state=done.state;
      }
      return;
    }
    if(packet?.error||packet?.event==='error'
      ||(packet?.event==='subscribe'&&packet?.code!=null
        &&!['0','00000'].includes(String(packet.code))))
      fail('LIVE_WS_EXCHANGE_REJECTED_PUBLIC_CHANNEL');
    if(packet?.event==='subscribe'){
      if(socket.provider!=='BITGET')fail('LIVE_WS_UNEXPECTED_SUBSCRIBE_ACK');
      const done=observePublicCryptoWsSupervisorV1({
        state,socketId:id,kind:'ACK',nowMs:timestamp(),raw:packet,
      });
      state=done.state;return;
    }
    if(socket.provider==='BITGET'&&!['update','snapshot'].includes(packet?.action))
      fail('LIVE_WS_UNKNOWN_PROVIDER_PACKET');
    if(socket.provider==='UPBIT'&&packet?.type!=='candle.1m')
      fail('LIVE_WS_UNKNOWN_PROVIDER_PACKET');
    const at=timestamp();
    const observations=normalizePublicCryptoWsMinutePacketV1({
      raw:packet,market:socket.market,allowedSymbols:socket.symbols,
      receivedAtMs:at,
    });
    const observed=observePublicCryptoWsSupervisorV1({
      state,socketId:id,kind:'CANDLE',nowMs:at,raw:packet,
    });
    state=observed.state;
    if(observations.length===1&&observations[0].status==='IGNORED_SNAPSHOT')
      return;
    let shards=spools.get(id);
    if(!shards){shards=new Map();spools.set(id,shards);}
    for(const observation of observations){
      const w=windowStart(observation.row.timestamp);
      let spool=shards.get(w);
      if(!spool){
        if(shards.size>=3)fail('LIVE_WS_PENDING_SPOOL_OVERFLOW');
        spool=createPublicWsMinuteSpoolV1({
          enabled:true,plan:byId.get(id),windowStartMs:w,
          windowMinutes:5,
        });
      }
      // Bitget batches can contain up to 32 distinct minute rows.
      // Each is validated in its own correct 5m private shard.
      const frame=socket.provider==='BITGET'
        ?{...packet,data:packet.data.filter(row=>
          Number(row[0])===observation.row.timestamp)}
        :packet;
      const next=ingestPublicWsMinuteSpoolPacketV1({
        state:spool,raw:frame,receivedAtMs:at,
      });
      if(next.status!=='PROVISIONAL_SPOOL_UPDATED'
        &&next.status!=='IGNORED_SNAPSHOT')
        fail('LIVE_WS_SPOOL_INGEST_BLOCKED');
      shards.set(w,next.state);
      count.inboundUpdates++;
    }
    count.inboundCandles++;
    count.rawDataBytes+=Buffer.byteLength(JSON.stringify(packet));
  }
  async function pulseUnsafe(){
    if(!started||stopped||halted)return;
    const at=timestamp();
    await flushReady(at);
    const step=pollPublicCryptoWsSupervisorV1({state,nowMs:at});
    state=step.state;
    await handleAction(step.intent);
    // Observe actual readyState, not candle silence, for transport errors.
    for(const [id,ws] of socketById){
      if(ws.bufferedAmount>1024*1024){
        closeOne(id);
        const slot=state.sockets.find(s=>s.id===id);
        if(['CONNECTING','SUBSCRIBING','AWAIT_ACK','STREAMING']
          .includes(slot?.phase)){
          state=observePublicCryptoWsSupervisorV1({
            state,socketId:id,kind:'CLOSE',nowMs:timestamp(),
          }).state;
        }
        count.reconnectIntents++;
      }
    }
  }
  async function start({schedule=false}={}){
    if(started||stopped)fail('LIVE_WS_ALREADY_STARTED');
    const at=timestamp();
    const free=await diskFree(root);
    session=await journalStart({
      root,producerSha,nowMs:rounded(at),freeBytes:free,
      sockets:state.sockets.map(s=>({
        id:s.id,market:s.market,symbols:[...s.symbols],
      })),
    });
    if(session.contract!=='research-public-ws-live-journal/v1')
      fail('LIVE_WS_JOURNAL_NOT_ADMITTED');
    // Conservative restart debt is never silently erased or settled.
    const merged=new Map();
    for(const debt of session.restoredRestDebts){
      const key=debt.market+':'+debt.symbol;
      const prev=merged.get(key);
      merged.set(key,{market:debt.market,symbol:debt.symbol,
        fromMs:Math.min(prev?.fromMs??debt.fromMs,debt.fromMs),
        toExclusiveMs:Math.min(rounded(at),
          debt.fromMs+180*MIN),
        requestedEndExclusiveMs:rounded(at),
        unverifiedBeyondCap:rounded(at)>debt.fromMs+180*MIN,
        reason:debt.reason,observedAtMs:at,lastObservedAtMs:at,
        restBackfillRequired:true,sourceVerified:false});
    }
    if(merged.size>2_048)fail('LIVE_WS_RESTART_AUDIT_LIMIT');
    state.pendingRestAudits.push(...[...merged.values()].filter(x=>
      x.requestedEndExclusiveMs>x.fromMs));
    started=true;
    if(schedule)timer=setInterval(()=>{void pulse();},intervalMs);
    await pulse();
    log('PUBLIC_SOURCE_CONNECTIONS_SCHEDULED',{
      socketPlans:state.sockets.length,
      restoredRestAuditCount:state.pendingRestAudits.length,
    });
  }
  const pulse=()=>enqueue(pulseUnsafe);
  async function stop(){
    if(!started||stopped)return;
    if(timer){clearInterval(timer);timer=null;}
    await drain();
    for(const id of [...socketById.keys()])closeOne(id);
    if(!halted){
      try{
        await flushReady(timestamp());
        await journalStop({session,nowMs:rounded(timestamp())});
      }catch(e){fatal(e);}
    }
    stopped=true;
    log('PUBLIC_SOURCE_STOPPED',{
      hasUnsealedProvisionalSpools:spools.size>0||halted,
    });
  }
  function report(){
    return Object.freeze({
      contract:LIVE_WS_WORKER_CONTRACT,
      status:halted?'HALTED_MANUAL_REVIEW':
        !started?'NOT_STARTED':stopped?'STOPPED_SOURCE_ONLY':'RUNNING_SOURCE_ONLY',
      errorCode,sourceOnly:true,openedPublicSockets:count.connectionsOpened,
      activeSocketCount:socketById.size,
      supervisorStreaming:state.sockets.filter(s=>s.phase==='STREAMING').length,
      pendingRestAudits:state.pendingRestAudits.length,
      provisionalSidecarsStored:count.sidecarsStored,
      provisionalSidecarsReused:count.sidecarsReused,
      receivedCandlePackets:count.inboundCandles,
      receivedMinuteUpdates:count.inboundUpdates,
      rawPublicBytesAccounted:count.rawDataBytes,
      reconnectIntents:count.reconnectIntents,
      inMemoryProvisionalShards:[...spools.values()]
        .reduce((a,b)=>a+b.size,0),
      journalRunId:session?.runId??null,
      needsIndependentREST:true,publicProviderGETCount:0,
      ...REPORT_BASE,
    });
  }
  // REST calls are NEVER executed here; only bounded source-only intents.
  // A private operator must independently approve actual REST readback.
  function auditPlan({limit=16,startIndex=0}={}){
    return planPendingPublicWsRestAuditsV1({
      state,limit,startIndex,asOfMs:timestamp(),
    });
  }
  return Object.freeze({start,pulse,drain,stop,report,auditPlan});
}
