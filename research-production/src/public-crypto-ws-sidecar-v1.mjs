// DORMANT, PRIVATE, SOURCE-ONLY WebSocket provisional observation sidecar.
// This is NOT the canonical original-minute archive. REST closed source
// receipts, PIT and independent OOS are required before research promotion.
// No sockets, provider GETs or trading API calls anywhere in this module.
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,lstat,open,link,unlink} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {PUBLIC_WS_MINUTE_CONTRACT} from './public-crypto-websocket-minute-v1.mjs';

export const PUBLIC_WS_SIDECAR_CONTRACT=
  'research-public-crypto-ws-provisional-sidecar/v1';
export const PUBLIC_WS_SIDECAR_LIMITS=Object.freeze({
  maxBatchObservations:2_048,maxDistinctMinutes:480,
  maxRawUpdatesAccounted:200_000,
  maxUncompressedBytes:512*1024,maxGzipBytes:512*1024,
  minFreeBytes:5*1024**3,maxBatchMinutes:5,
});
const SHA40=/^[a-f0-9]{40}$/u,SHA64=/^[a-f0-9]{64}$/u;
const fail=c=>{throw new TypeError(c);};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const goodTime=x=>Number.isSafeInteger(x)&&x>0&&x%1===0;
const hex=x=>createHash('sha256').update(x).digest('hex');
const zero=()=>Object.freeze({
  restFinalityProven:false,historicalPITProven:false,
  sourceRightsVerified:false,immutableOriginalMinuteProven:false,
  continuousCaptureProven:false,independentOosProven:false,
  profitabilityProven:false,paperAdmissionAllowed:false,
  publicProviderGETCount:0,websocketConnectionsOpened:0,
  privateAccountCalls:0,realOrders:0,paperOrders:0,
  executionAuthority:'NONE',
});
function rootPath(raw){
  if(typeof raw!=='string'||!isAbsolute(raw)||resolve(raw)!==raw
    ||/^\/(?:opt\/stock-app-data|srv\/stock-app|var\/lib\/stock-app)(?:\/|$)/u.test(raw))
    fail('WS_SIDECAR_ROOT_INVALID');
  return raw;
}
async function protectAncestors(path){
  let at=path;
  while(true){
    const s=await lstat(at);
    if(s.isSymbolicLink())fail('WS_SIDECAR_SYMLINK_ANCESTOR');
    if(at===path&&(!s.isDirectory()||(s.mode&0o077)))
      fail('WS_SIDECAR_ROOT_NOT_PRIVATE');
    const parent=dirname(at);
    if(parent===at)break;
    at=parent;
  }
}
async function privateDir(p){
  try{await mkdir(p,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  const v=await lstat(p);
  if(!v.isDirectory()||v.isSymbolicLink()||(v.mode&0o077))
    fail('WS_SIDECAR_DIRECTORY_UNSAFE');
}
async function fsyncDir(p){
  const h=await open(p,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{await h.sync();}finally{await h.close();}
}
const labels=new Set(['CRYPTO_SPOT','CRYPTO_FUTURES']);
function validBatchArgs({market,socketDigest,producerSha,startMs,endMs}){
  if(!labels.has(market)||!SHA64.test(socketDigest??'')
    ||!SHA40.test(producerSha??'')
    ||!goodTime(startMs)||!goodTime(endMs)
    ||startMs%60_000||endMs%60_000
    ||endMs<=startMs||endMs-startMs>PUBLIC_WS_SIDECAR_LIMITS.maxBatchMinutes*60_000
    ||new Date(startMs).toISOString().slice(0,10)
      !==new Date(endMs-60_000).toISOString().slice(0,10))
    fail('WS_SIDECAR_BATCH_IDENTITY_INVALID');
}
function row(raw,{market,startMs,endMs,nowMs}){
  if(!object(raw)||raw.contract!==PUBLIC_WS_MINUTE_CONTRACT
    ||raw.status!=='WEBSOCKET_PROVISIONAL_MINUTE'
    ||raw.market!==market
    ||raw.sourceId!==(market==='CRYPTO_SPOT'
      ?'UPBIT_PUBLIC_WS_1M':'BITGET_PUBLIC_V2_WS_FUTURES_1M')
    ||raw.provider!==(market==='CRYPTO_SPOT'?'UPBIT':'BITGET')
    ||typeof raw.symbol!=='string'
    ||(market==='CRYPTO_SPOT'
      ? !/^[A-Z0-9]{1,20}$/u.test(raw.symbol)
      : !/^[A-Z0-9\p{Script=Han}]{1,26}USDT$/u.test(raw.symbol))
    ||raw.executionAuthority!=='NONE'
    ||raw.profitabilityProven!==false
    ||raw.needsRestFinalityCheck!==true
    ||raw.archiveFilesWritten!==0
    ||!goodTime(raw.receivedAtMs)||raw.receivedAtMs>nowMs+5_000
    ||!goodTime(raw.sourceEventAtMs)
    ||raw.sourceEventAtMs>raw.receivedAtMs+5_000
    ||!object(raw.row))
    fail('WS_SIDECAR_OBSERVATION_INVALID');
  const v=raw.row;
  const fields=['timestamp','open','high','low','close','volume','quoteVolume'];
  if(fields.some(k=>typeof v[k]!=='number'||!Number.isFinite(v[k]))
    ||!goodTime(v.timestamp)||v.timestamp%60_000
    ||v.timestamp<startMs||v.timestamp>=endMs
    ||v.open<=0||v.high<=0||v.low<=0||v.close<=0
    ||v.high<Math.max(v.open,v.close)||v.low>Math.min(v.open,v.close)
    ||v.volume<0||v.quoteVolume<0
    ||v.timestamp>raw.receivedAtMs)
    fail('WS_SIDECAR_ROW_INVALID');
  return Object.freeze({
    market,symbol:raw.symbol,sourceId:raw.sourceId,
    timestamp:v.timestamp,open:v.open,high:v.high,
    low:v.low,close:v.close,volume:v.volume,
    quoteVolume:v.quoteVolume,
    sourceEventAtMs:raw.sourceEventAtMs,
    firstObservedAtMs:raw.receivedAtMs,
    lastObservedAtMs:raw.receivedAtMs,
  });
}
const payloadDigest=x=>hex(JSON.stringify(x));
export function preparePublicWsProvisionalBatchV1({
  enabled=false,market,socketDigest,producerSha,
  startMs,endMs,observations=[],actualUpdatesSeen=null,nowMs,
}={}){
  if(!enabled)return Object.freeze({
    contract:PUBLIC_WS_SIDECAR_CONTRACT,status:'DISABLED',
    batch:null,archiveFilesWritten:0,...zero(),
  });
  validBatchArgs({market,socketDigest,producerSha,startMs,endMs});
  if(!Array.isArray(observations)||observations.length<1
    ||observations.length>PUBLIC_WS_SIDECAR_LIMITS.maxBatchObservations
    ||!goodTime(nowMs)||nowMs<endMs+5_000)
    fail('WS_SIDECAR_BATCH_INPUT_INVALID');
  // A per-socket spool may compact many websocket updates into the last
  // cumulative observation of each minute. Count the actual seen updates
  // without requiring thousands of duplicate raw frames on disk.
  const rawUpdateCount=actualUpdatesSeen??observations.length;
  if(!Number.isSafeInteger(rawUpdateCount)
    ||rawUpdateCount<observations.length
    ||rawUpdateCount>PUBLIC_WS_SIDECAR_LIMITS.maxRawUpdatesAccounted)
    fail('WS_SIDECAR_ACTUAL_UPDATE_COUNT_INVALID');
  const index=new Map();
  for(const obs of observations){
    const record=row(obs,{market,startMs,endMs,nowMs});
    const k=record.symbol+':'+record.timestamp;
    const prior=index.get(k);
    if(prior){
      if(record.sourceEventAtMs<prior.sourceEventAtMs)
        fail('WS_SIDECAR_EVENT_OUT_OF_ORDER');
      if(record.sourceEventAtMs===prior.sourceEventAtMs
        &&['open','high','low','close','volume','quoteVolume']
          .some(f=>record[f]!==prior[f]))
        fail('WS_SIDECAR_DUPLICATE_EVENT_CONFLICT');
      if(record.open!==prior.open||record.high<prior.high
        ||record.low>prior.low||record.volume<prior.volume
        ||record.quoteVolume<prior.quoteVolume)
        fail('WS_SIDECAR_CUMULATIVE_CONFLICT');
      index.set(k,{...record,firstObservedAtMs:prior.firstObservedAtMs});
    }else index.set(k,record);
  }
  if(index.size>PUBLIC_WS_SIDECAR_LIMITS.maxDistinctMinutes)
    fail('WS_SIDECAR_DISTINCT_MINUTES_OVERFLOW');
  const compact=[...index.values()].sort((a,b)=>
    a.market.localeCompare(b.market)||a.symbol.localeCompare(b.symbol)
    ||a.timestamp-b.timestamp);
  const header={
    contract:PUBLIC_WS_SIDECAR_CONTRACT,status:'PROVISIONAL_ONLY',
    market,socketDigest,producerSha,startMs,endMs,
    capturedAtMs:nowMs,observedRows:compact.length,
    rawUpdatesSeen:rawUpdateCount,restClosedMinuteVerified:false,
    genuineAsOfResearchCredit:false,executionAuthority:'NONE',
  };
  const digest=payloadDigest([header,compact]);
  const payload={header,observations:compact,payloadDigest:digest};
  const plain=Buffer.from(JSON.stringify(payload)+'\n','utf8');
  if(plain.length>PUBLIC_WS_SIDECAR_LIMITS.maxUncompressedBytes)
    fail('WS_SIDECAR_BATCH_OVERSIZE');
  const gzip=gzipSync(plain,{level:6,mtime:0});
  if(gzip.length>PUBLIC_WS_SIDECAR_LIMITS.maxGzipBytes)
    fail('WS_SIDECAR_BATCH_OVERSIZE');
  return Object.freeze({
    contract:PUBLIC_WS_SIDECAR_CONTRACT,status:'SEALED_PROVISIONAL_BATCH',
    payload,gzip,plainBytes:plain.length,gzipBytes:gzip.length,
    compressedDigest:hex(gzip),compactedMinutes:compact.length,
    rawUpdatesSeen:rawUpdateCount,
    archiveFilesWritten:0,...zero(),
  });
}
function pathFor(root,batch){
  const h=batch.payload.header;
  const folder=join(root,h.market,h.socketDigest,
    new Date(h.startMs).toISOString().slice(0,10));
  const file=join(folder,`${h.startMs}-${h.endMs}.ws.json.gz`);
  return {folder,file};
}
async function readFileNoLinks(file){
  let h;
  try{
    h=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    const st=await h.stat();
    if(!st.isFile()||st.nlink!==1||(st.mode&0o077)
      ||st.size<2||st.size>PUBLIC_WS_SIDECAR_LIMITS.maxGzipBytes)
      fail('WS_SIDECAR_FILE_UNSAFE');
    return await h.readFile();
  }catch(e){
    if(e.code==='ENOENT')return null;
    if(e.code==='ELOOP')fail('WS_SIDECAR_FILE_UNSAFE');
    throw e;
  }finally{await h?.close();}
}
function decodeCompressed(data){
  let content;
  try{content=gunzipSync(data,{maxOutputLength:
    PUBLIC_WS_SIDECAR_LIMITS.maxUncompressedBytes});}
  catch{fail('WS_SIDECAR_COMPRESSED_INVALID');}
  let obj;
  try{obj=JSON.parse(content.toString('utf8'));}
  catch{fail('WS_SIDECAR_JSON_INVALID');}
  if(!object(obj)||!object(obj.header)
    ||!Array.isArray(obj.observations)
    ||!SHA64.test(obj.payloadDigest??'')
    ||payloadDigest([obj.header,obj.observations])!==obj.payloadDigest
    ||obj.header.status!=='PROVISIONAL_ONLY'
    ||obj.header.executionAuthority!=='NONE'
    ||obj.header.restClosedMinuteVerified!==false
    ||obj.header.genuineAsOfResearchCredit!==false
    ||!Number.isSafeInteger(obj.header.rawUpdatesSeen)
    ||obj.header.rawUpdatesSeen<obj.observations.length
    ||obj.header.rawUpdatesSeen>
      PUBLIC_WS_SIDECAR_LIMITS.maxRawUpdatesAccounted)
    fail('WS_SIDECAR_CONTENT_INVALID');
  return obj;
}
export async function persistPublicWsProvisionalBatchV1({
  enabled=false,operatorApproved=false,root,prepared,freeBytes,
}={}){
  if(!enabled)return Object.freeze({
    contract:PUBLIC_WS_SIDECAR_CONTRACT,status:'DISABLED',
    archiveFilesWritten:0,...zero(),
  });
  if(!operatorApproved)return Object.freeze({
    contract:PUBLIC_WS_SIDECAR_CONTRACT,status:'HOLD_OPERATOR_APPROVAL',
    archiveFilesWritten:0,...zero(),
  });
  if(prepared?.contract!==PUBLIC_WS_SIDECAR_CONTRACT
    ||prepared.status!=='SEALED_PROVISIONAL_BATCH'
    ||!Buffer.isBuffer(prepared.gzip)
    ||hex(prepared.gzip)!==prepared.compressedDigest)
    fail('WS_SIDECAR_SEALED_BATCH_REQUIRED');
  if(!Number.isSafeInteger(freeBytes)||freeBytes<
    PUBLIC_WS_SIDECAR_LIMITS.minFreeBytes)
    return Object.freeze({status:'HOLD_DISK',archiveFilesWritten:0,...zero()});
  const sealed=decodeCompressed(prepared.gzip);
  if(sealed.payloadDigest!==prepared.payload.payloadDigest
    ||JSON.stringify(sealed)!==JSON.stringify(prepared.payload))
    fail('WS_SIDECAR_BATCH_MUTATED');
  rootPath(root);
  await protectAncestors(root);
  const {folder,file}=pathFor(root,prepared);
  let at=root;
  for(const part of [prepared.payload.header.market,
    prepared.payload.header.socketDigest,
    new Date(prepared.payload.header.startMs).toISOString().slice(0,10)]){
    at=join(at,part);await privateDir(at);
  }
  const prior=await readFileNoLinks(file);
  if(prior){
    const obj=decodeCompressed(prior);
    if(obj.payloadDigest!==prepared.payload.payloadDigest
      ||obj.header.socketDigest!==prepared.payload.header.socketDigest
      ||obj.header.producerSha!==prepared.payload.header.producerSha)
      fail('WS_SIDECAR_IMMUTABLE_CONFLICT');
    return Object.freeze({
      contract:PUBLIC_WS_SIDECAR_CONTRACT,status:'REUSED_IDENTICAL',
      payloadDigest:obj.payloadDigest,archiveFilesWritten:0,...zero(),
    });
  }
  const temp=file+'.tmp-'+prepared.compressedDigest.slice(0,16);
  let linked=false;
  try{
    const h=await open(temp,constants.O_WRONLY|constants.O_CREAT|
      constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await h.writeFile(prepared.gzip);await h.sync();}
    finally{await h.close();}
    try{await link(temp,file);linked=true;}
    catch(e){
      if(e.code!=='EEXIST')throw e;
      const existing=await readFileNoLinks(file);
      if(!existing||decodeCompressed(existing).payloadDigest
        !==prepared.payload.payloadDigest)
        fail('WS_SIDECAR_IMMUTABLE_CONFLICT');
    }
    await fsyncDir(folder);
  }finally{
    await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});
    if(linked)await fsyncDir(folder);
  }
  const readback=await readFileNoLinks(file);
  if(!readback||decodeCompressed(readback).payloadDigest
    !==prepared.payload.payloadDigest)
    fail('WS_SIDECAR_READBACK_FAILED');
  return Object.freeze({
    contract:PUBLIC_WS_SIDECAR_CONTRACT,
    status:linked?'SEALED_PROVISIONAL_ONLY':'REUSED_IDENTICAL',
    payloadDigest:prepared.payload.payloadDigest,
    compressedDigest:hex(readback),
    compactedMinutes:prepared.compactedMinutes,
    ...zero(),archiveFilesWritten:linked?1:0,
  });
}
export async function readPublicWsProvisionalBatchV1({
  root,market,socketDigest,producerSha,startMs,endMs,
}={}){
  validBatchArgs({market,socketDigest,producerSha,startMs,endMs});
  rootPath(root);
  await protectAncestors(root);
  const folder=join(root,market,socketDigest,new Date(startMs).toISOString().slice(0,10));
  await protectAncestors(folder);
  const file=join(folder,`${startMs}-${endMs}.ws.json.gz`);
  const binary=await readFileNoLinks(file);
  if(!binary)return Object.freeze({status:'NO_PROVISIONAL_SIDECAR',
    observations:Object.freeze([]),...zero()});
  const data=decodeCompressed(binary);
  if(data.header.market!==market||data.header.socketDigest!==socketDigest
    ||data.header.producerSha!==producerSha
    ||data.header.startMs!==startMs||data.header.endMs!==endMs
    ||data.header.observedRows!==data.observations.length)
    fail('WS_SIDECAR_READBACK_IDENTITY_INVALID');
  return Object.freeze({
    contract:PUBLIC_WS_SIDECAR_CONTRACT,status:'PROVISIONAL_READBACK_ONLY',
    payloadDigest:data.payloadDigest,
    observations:Object.freeze(data.observations),
    compressedDigest:hex(binary),...zero(),
  });
}
