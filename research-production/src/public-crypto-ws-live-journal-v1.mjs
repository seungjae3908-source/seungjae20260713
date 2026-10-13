// Dedicated source-only WebSocket runtime journal. No provider requests or orders.
// A START receipt is durable BEFORE any public socket opens. Every prior run
// remains an unverified REST debt until a separate original-source adjudication.
import {createHash,randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,mkdir,open,readdir,statfs,link,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,resolve,join} from 'node:path';

export const LIVE_WS_JOURNAL_CONTRACT='research-public-ws-live-journal/v1';
const SHA40=/^[a-f0-9]{40}$/u;
const RUN_ID=/^[0-9]{13}-[a-f0-9]{16}$/u;
const MARKET=new Set(['CRYPTO_SPOT','CRYPTO_FUTURES']);
const fail=c=>{throw new Error(c);};
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const safeMs=x=>Number.isSafeInteger(x)&&x>0&&x%60_000===0;
const safeSymbol=(m,s)=>typeof s==='string'&&(m==='CRYPTO_SPOT'
  ?/^[A-Z0-9]{1,20}$/u.test(s)
  :/^[A-Z0-9\p{Script=Han}]{1,26}USDT$/u.test(s));
const reserved=/^\/(?:opt\/stock-app-data|srv\/stock-app|var\/lib\/stock-app)(?:\/|$)/u;

export async function assertPrivateLiveWsRootV1(root){
  if(typeof root!=='string'||!isAbsolute(root)||resolve(root)!==root
    ||root.length<7||reserved.test(root))fail('LIVE_WS_ROOT_INVALID');
  let at=root;
  while(true){
    const s=await lstat(at);
    if(s.isSymbolicLink())fail('LIVE_WS_SYMLINK_ANCESTOR');
    if(at===root&&(!s.isDirectory()||(s.mode&0o077)))
      fail('LIVE_WS_ROOT_NOT_PRIVATE');
    const parent=dirname(at);
    if(parent===at)break;
    at=parent;
  }
  return root;
}
async function folderSafe(folder){
  try{await mkdir(folder,{mode:0o700});}
  catch(e){if(e.code!=='EEXIST')throw e;}
  const st=await lstat(folder);
  if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077))
    fail('LIVE_WS_JOURNAL_FOLDER_UNSAFE');
}
async function dirSync(folder){
  const fd=await open(folder,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{await fd.sync();}finally{await fd.close();}
}
async function readReceipt(file){
  const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const st=await fd.stat();
    if(!st.isFile()||st.nlink!==1||(st.mode&0o077)
      ||st.size<2||st.size>128*1024)fail('LIVE_WS_JOURNAL_FILE_UNSAFE');
    const input=await fd.readFile('utf8');
    let row;
    try{row=JSON.parse(input);}catch{fail('LIVE_WS_JOURNAL_JSON_INVALID');}
    if(!row||typeof row!=='object'
      ||!row.data||row.digest!==digest(row.data))
      fail('LIVE_WS_JOURNAL_CHECKSUM_INVALID');
    return row.data;
  }finally{await fd.close();}
}
async function writeReceipt(folder,name,data){
  const target=join(folder,name);
  const temp=join(folder,'.'+name+'.'+randomBytes(8).toString('hex')+'.tmp');
  const bytes=Buffer.from(JSON.stringify({data,digest:digest(data)})+'\n');
  if(bytes.length>128*1024)fail('LIVE_WS_JOURNAL_RECORD_OVERSIZE');
  let published=false;
  try{
    const fd=await open(temp,constants.O_WRONLY|constants.O_CREAT|
      constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await fd.writeFile(bytes);await fd.sync();}
    finally{await fd.close();}
    await link(temp,target);
    published=true;
    await dirSync(folder);
  }finally{
    await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});
    if(published)await dirSync(folder);
  }
  const reread=await readReceipt(target);
  if(digest(reread)!==digest(data))fail('LIVE_WS_JOURNAL_READBACK_INVALID');
}
export async function measurePrivateWsFreeBytesV1(root){
  await assertPrivateLiveWsRootV1(root);
  const st=await statfs(root,{bigint:true});
  const bytes=st.bavail*st.bsize;
  return Number(bytes>BigInt(Number.MAX_SAFE_INTEGER)
    ?BigInt(Number.MAX_SAFE_INTEGER):bytes);
}
function validateSocket(scope){
  return scope&&MARKET.has(scope.market)
    &&typeof scope.id==='string'&&/^[a-f0-9]{32}$/u.test(scope.id)
    &&Array.isArray(scope.symbols)&&scope.symbols.length>=1
    &&scope.symbols.length<=40
    &&scope.symbols.every(s=>safeSymbol(scope.market,s))
    &&new Set(scope.symbols).size===scope.symbols.length;
}
// All prior starts, including clean stops, remain source-only uncertainty;
// a clean shutdown is not proof of complete REST-final candles.
export async function startPublicWsLiveJournalV1({
  root,producerSha,sockets,nowMs,freeBytes,
}={}){
  if(!SHA40.test(producerSha??'')||!safeMs(nowMs)
    ||!Array.isArray(sockets)||sockets.length<1||sockets.length>32
    ||sockets.some(s=>!validateSocket(s))
    ||!Number.isSafeInteger(freeBytes)||freeBytes<5*1024**3)
    fail('LIVE_WS_JOURNAL_PREFLIGHT_INVALID');
  await assertPrivateLiveWsRootV1(root);
  const dir=join(root,'.public-ws-live-journal-v1');
  await folderSafe(dir);
  const names=await readdir(dir);
  if(names.length>128||names.some(n=>!RUN_ID.test(n.slice(0,30))
    ||!/^[0-9]{13}-[a-f0-9]{16}\.(?:start|end)\.json$/u.test(n)))
    fail('LIVE_WS_JOURNAL_DIRECTORY_MANUAL_REVIEW');
  const prior=names.filter(n=>n.endsWith('.start.json'));
  if(prior.length>=32)fail('LIVE_WS_JOURNAL_RETENTION_MANUAL_REVIEW');
  const merged=new Map();
  for(const name of prior){
    const rec=await readReceipt(join(dir,name));
    if(rec.contract!==LIVE_WS_JOURNAL_CONTRACT
      ||rec.type!=='START'||!RUN_ID.test(rec.runId)
      ||name!==rec.runId+'.start.json'||!SHA40.test(rec.producerSha)
      ||!safeMs(rec.startedAtMs)||rec.startedAtMs>nowMs
      ||!Array.isArray(rec.sockets)||rec.sockets.some(s=>!validateSocket(s)))
      fail('LIVE_WS_JOURNAL_START_UNTRUSTED');
    for(const socket of rec.sockets)for(const symbol of socket.symbols){
      const key=socket.market+':'+symbol;
      const old=merged.get(key);
      merged.set(key,{market:socket.market,symbol,
        fromMs:Math.min(old?.fromMs??rec.startedAtMs,rec.startedAtMs),
        requestedEndExclusiveMs:nowMs,sourceVerified:false,
        restBackfillRequired:true,reason:'LIVE_WS_RESTART_SOURCE_UNVERIFIED',
      });
    }
  }
  const runId=String(nowMs).padStart(13,'0')+'-'+randomBytes(8).toString('hex');
  const record={
    contract:LIVE_WS_JOURNAL_CONTRACT,type:'START',runId,
    producerSha,startedAtMs:nowMs,
    sockets:sockets.map(s=>({id:s.id,market:s.market,symbols:[...s.symbols]})),
    originalRestVerified:false,profitabilityProven:false,
    executionAuthority:'NONE',
  };
  await writeReceipt(dir,runId+'.start.json',record);
  return Object.freeze({
    contract:LIVE_WS_JOURNAL_CONTRACT,runId,dir,
    restoredRestDebts:Object.freeze([...merged.values()].map(o=>Object.freeze(o))),
    priorSessionCount:prior.length,
    sourceOnly:true,executionAuthority:'NONE',profitabilityProven:false,
  });
}
export async function stopPublicWsLiveJournalV1({session,nowMs}={}){
  if(session?.contract!==LIVE_WS_JOURNAL_CONTRACT
    ||!RUN_ID.test(session.runId??'')
    ||!safeMs(nowMs)||!session.dir)fail('LIVE_WS_JOURNAL_STOP_INVALID');
  const marker={
    contract:LIVE_WS_JOURNAL_CONTRACT,type:'STOP',runId:session.runId,
    stoppedAtMs:nowMs,restFinalityProven:false,
    executionAuthority:'NONE',
  };
  await writeReceipt(session.dir,session.runId+'.end.json',marker);
  return Object.freeze({status:'STOP_RECORDED_SOURCE_ONLY',
    executionAuthority:'NONE',paperAdmissionAllowed:false});
}
