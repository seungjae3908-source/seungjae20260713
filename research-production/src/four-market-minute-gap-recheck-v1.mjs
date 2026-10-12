// Research-only, bounded 1m gap rechecks. Immutable originals are never
// overwritten. Newly observed source bars are saved only as separate, sealed
// supplements with their REAL provider retrieval timestamp, never backdated.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { lstat, mkdir, open, readdir, link, unlink } from 'node:fs/promises';
import {
  MINUTE_ARCHIVE_LIMITS, validateMinuteTask, validateMinuteCandles,
  auditOriginalMinuteWindowSlotsV1, readOriginalMinutePage, fetchCryptoMinutePage,
} from './four-market-minute-archive-intake-v1.mjs';

export const MINUTE_RECHECK_CONTRACT='research-original-minute-recheck-receipt/v1';
export const MINUTE_RECHECK_LIMITS=Object.freeze({
  maxReceiptsPerWindow:8,maxDirectoryEntries:256,maxReceiptBytes:256*1024,
  minDiskFreeBytes:MINUTE_ARCHIVE_LIMITS.minFreeBytes,
});
const SHA40=/^[0-9a-f]{40}$/u, SHA64=/^[0-9a-f]{64}$/u;
const safeTime=v=>Number.isSafeInteger(v)&&v>0;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=reason=>{throw new Error(reason);};
const columns=['timestamp','open','high','low','close','volume','quoteVolume'];
const same=(a,b)=>columns.every(k=>(a?.[k]??null)===(b?.[k]??null));

async function privateRoot(root) {
  if(typeof root!=='string'||!isAbsolute(root)||resolve(root)!==root
    ||/^\/(?:opt\/stock-app-data|srv\/stock-app|var\/lib\/stock-app)(?:\/|$)/u.test(root))
    fail('MINUTE_RECHECK_ROOT_INVALID');
  let at=root;
  while(true){
    const info=await lstat(at);
    if(info.isSymbolicLink()||!info.isDirectory())
      fail('MINUTE_RECHECK_ANCESTOR_UNSAFE');
    if(at===root&&(info.mode&0o077))fail('MINUTE_RECHECK_ROOT_PRIVATE_REQUIRED');
    const parent=dirname(at);
    if(parent===at)break;
    at=parent;
  }
}
function location(root,task) {
  const date=new Date(task.windowStartMs).toISOString().slice(0,10);
  return join(root,'minute-rechecks-v1',task.market,task.symbol,date);
}
async function directory(path,create=false) {
  if(create) {
    try{await mkdir(path,{mode:0o700});}
    catch(e){if(e?.code!=='EEXIST')throw e;}
  }
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077))
    fail('MINUTE_RECHECK_DIRECTORY_UNSAFE');
}
function receiptFilename(task,addedDigest) {
  return String(task.windowStartMs)+'-'+String(task.windowEndMs)+'-'+addedDigest+'.json';
}
function digestAdded(base,rows) {
  return hash([MINUTE_RECHECK_CONTRACT,base.candleDigest,rows]);
}
function digestReceipt(r) {
  return hash([r.contract,r.baseCandleDigest,r.baseContentDigest,
    r.researchSha,r.market,r.symbol,r.windowStartMs,r.windowEndMs,
    r.addedRowsDigest,r.retrievedAt,r.candles,r.economicEvidenceCredit,
    r.oosCredit,r.paperCredit,r.executionAuthority,r.profitabilityProven]);
}
async function readPrivateReceipt(path) {
  let fd;
  try{
    fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const info=await fd.stat();
    if(!info.isFile()||info.nlink!==1||(info.mode&0o077)
      ||info.size<2||info.size>MINUTE_RECHECK_LIMITS.maxReceiptBytes)
      fail('MINUTE_RECHECK_FILE_UNSAFE');
    try{return JSON.parse(await fd.readFile('utf8'));}
    catch{fail('MINUTE_RECHECK_JSON_INVALID');}
  }catch(e){
    if(e?.code==='ELOOP')fail('MINUTE_RECHECK_FILE_UNSAFE');
    throw e;
  }finally{await fd?.close();}
}
function validateReceipt(task,base,receipt,filename,nowMs) {
  const retrievedAt=Date.parse(receipt?.retrievedAt);
  if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)
    ||receipt.contract!==MINUTE_RECHECK_CONTRACT
    ||!SHA40.test(receipt.researchSha??'')
    ||receipt.market!==task.market||receipt.symbol!==task.symbol
    ||receipt.windowStartMs!==task.windowStartMs
    ||receipt.windowEndMs!==task.windowEndMs
    ||receipt.baseCandleDigest!==base.candleDigest
    ||receipt.baseContentDigest!==base.contentDigest
    ||!SHA64.test(receipt.addedRowsDigest??'')
    ||!SHA64.test(receipt.receiptDigest??'')
    ||receipt.economicEvidenceCredit!==0||receipt.oosCredit!==0
    ||receipt.paperCredit!==0||receipt.executionAuthority!=='NONE'
    ||receipt.profitabilityProven!==false
    ||!safeTime(retrievedAt)||retrievedAt>nowMs+5_000
    ||retrievedAt<task.windowEndMs+5_000
    ||retrievedAt<Date.parse(base.retrievedAt)
    ||!Array.isArray(receipt.candles)||!receipt.candles.length
    ||receipt.candles.length>MINUTE_ARCHIVE_LIMITS.maxWindowMinutes
    ||receipt.addedRowsDigest!==digestAdded(base,receipt.candles)
    ||receipt.receiptDigest!==digestReceipt(receipt)
    ||filename!==receiptFilename(task,receipt.addedRowsDigest))
    fail('MINUTE_RECHECK_RECEIPT_INVALID');
  validateMinuteCandles(task,receipt.candles,retrievedAt);
  return receipt;
}
function indexRows(task,base,rechecks) {
  const index=new Map();
  const originalAt=Date.parse(base.retrievedAt);
  for(const row of base.candles)index.set(row.timestamp,{
    ...row,availableAtMs:originalAt,baseOriginal:true,
  });
  let supplemental=0,duplicates=0;
  for(const receipt of rechecks) {
    const availableAtMs=Date.parse(receipt.retrievedAt);
    for(const row of receipt.candles) {
      const prior=index.get(row.timestamp);
      if(prior&&!same(prior,row))fail('MINUTE_RECHECK_CONFLICTING_SOURCE_REVISION');
      if(prior){
        duplicates++;
        if(prior.availableAtMs>availableAtMs)index.set(row.timestamp,{
          ...row,availableAtMs,baseOriginal:false,
        });
      }else{
        if(row.timestamp<task.windowStartMs||row.timestamp>=task.windowEndMs)
          fail('MINUTE_RECHECK_ROW_OUT_OF_SCOPE');
        supplemental++;
        index.set(row.timestamp,{...row,availableAtMs,baseOriginal:false});
      }
    }
  }
  return {index,supplemental,duplicates};
}
export async function readImmutableMinuteRecheckEvidenceV1({
  root,task,researchSha,nowMs=Date.now(),
}={}) {
  if(!SHA40.test(researchSha??'')||!safeTime(nowMs))
    fail('MINUTE_RECHECK_CONFIGURATION_INVALID');
  const scope=validateMinuteTask(task);
  await privateRoot(root);
  const base=await readOriginalMinutePage(root,scope,researchSha);
  if(!base)return Object.freeze({
    status:'BLOCKED_BASE_ORIGINAL_MISSING',base:null,
    receipts:Object.freeze([]),availableRows:Object.freeze([]),
    providerGETCount:0,filesWritten:0,executionAuthority:'NONE',
  });
  const dir=location(root,scope),parts=[
    join(root,'minute-rechecks-v1'),
    join(root,'minute-rechecks-v1',scope.market),
    join(root,'minute-rechecks-v1',scope.market,scope.symbol),
    dir,
  ];
  let allExist=true;
  for(const part of parts){
    try{await directory(part);}
    catch(e){if(e?.code==='ENOENT'){allExist=false;break;}throw e;}
  }
  const receipts=[];
  if(allExist){
    const entries=await readdir(dir,{withFileTypes:true});
    if(entries.length>MINUTE_RECHECK_LIMITS.maxDirectoryEntries)
      fail('MINUTE_RECHECK_DIRECTORY_LIMIT');
    const prefix=String(scope.windowStartMs)+'-'+String(scope.windowEndMs)+'-';
    for(const entry of entries){
      // Crash-left temporary records and symlinks remain visible blockers.
      if(!entry.isFile()||!/^[1-9]\d{12}-[1-9]\d{12}-[a-f0-9]{64}\.json$/u.test(entry.name))
        fail('MINUTE_RECHECK_UNEXPECTED_DIRECTORY_ENTRY');
      if(!entry.name.startsWith(prefix))continue;
      if(receipts.length>=MINUTE_RECHECK_LIMITS.maxReceiptsPerWindow)
        fail('MINUTE_RECHECK_RECEIPT_LIMIT');
      const parsed=await readPrivateReceipt(join(dir,entry.name));
      receipts.push(validateReceipt(scope,base,parsed,entry.name,nowMs));
    }
  }
  receipts.sort((a,b)=>a.retrievedAt.localeCompare(b.retrievedAt)
    ||a.addedRowsDigest.localeCompare(b.addedRowsDigest));
  const merged=indexRows(scope,base,receipts);
  const rows=[...merged.index.values()].sort((a,b)=>a.timestamp-b.timestamp);
  const audit=auditOriginalMinuteWindowSlotsV1(scope,rows);
  return Object.freeze({
    status:receipts.length?'SUPPLEMENTAL_RECEIPTS_VERIFIED'
      :'BASE_SOURCE_ONLY',
    task:scope,base,
    receipts:Object.freeze(receipts),
    availableRows:Object.freeze(rows),
    supplementalUniqueMinutes:merged.supplemental,
    duplicateRecheckRows:merged.duplicates,
    ...audit,providerGETCount:0,filesWritten:0,executionAuthority:'NONE',
  });
}
async function durableWrite(root,task,record) {
  const dirs=[
    join(root,'minute-rechecks-v1'),
    join(root,'minute-rechecks-v1',task.market),
    join(root,'minute-rechecks-v1',task.market,task.symbol),
    location(root,task),
  ];
  for(const dir of dirs)await directory(dir,true);
  const folder=dirs.at(-1);
  const target=join(folder,receiptFilename(task,record.addedRowsDigest));
  const temp=join(folder,'.recheck-tmp-'+randomUUID());
  let linked=false;
  try {
    const fd=await open(temp,
      constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{
      const data=Buffer.from(JSON.stringify(record)+'\n');
      if(data.length>MINUTE_RECHECK_LIMITS.maxReceiptBytes)
        fail('MINUTE_RECHECK_RECEIPT_TOO_LARGE');
      await fd.writeFile(data);await fd.sync();
    }finally{await fd.close();}
    try{await link(temp,target);linked=true;}
    catch(e){if(e?.code!=='EEXIST')throw e;}
    const d=await open(folder,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try{await d.sync();}finally{await d.close();}
  }finally{
    await unlink(temp).catch(e=>{if(e?.code!=='ENOENT')throw e;});
    if(linked){
      const d=await open(folder,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try{await d.sync();}finally{await d.close();}
    }
  }
  return {linked};
}
export async function reconcileMissingOriginalMinuteWindowV1({
  enabled=false,persist=false,root,task,researchSha,
  now=()=>Date.now(),fetchImpl=globalThis.fetch,
  freeBytes=null,
}={}) {
  if(!enabled)return Object.freeze({
    status:'DISABLED',providerGETCount:0,filesWritten:0,
    executionAuthority:'NONE',
  });
  if(!SHA40.test(researchSha??'')||typeof now!=='function'
    ||(persist&&(!Number.isSafeInteger(freeBytes)
      ||freeBytes<MINUTE_RECHECK_LIMITS.minDiskFreeBytes)))
    return Object.freeze({
      status:persist?'HOLD_DISK':'BLOCKED_CONFIG',
      providerGETCount:0,filesWritten:0,executionAuthority:'NONE',
    });
  const scope=validateMinuteTask(task);
  const first=await readImmutableMinuteRecheckEvidenceV1({
    root,task:scope,researchSha,nowMs:now(),
  });
  if(first.base===null)return Object.freeze({
    status:'BLOCKED_BASE_ORIGINAL_MISSING',providerGETCount:0,
    filesWritten:0,executionAuthority:'NONE',
  });
  if(first.unverifiedMissingMinuteSlots===0)return Object.freeze({
    status:'ORIGINAL_WINDOW_SLOTS_OBSERVED',providerGETCount:0,
    filesWritten:0,unverifiedMissingMinuteSlots:0,
    executionAuthority:'NONE',
  });
  if(first.receipts.length>=MINUTE_RECHECK_LIMITS.maxReceiptsPerWindow)
    return Object.freeze({
      status:'BLOCKED_RECHECK_LIMIT',providerGETCount:0,
      filesWritten:0,executionAuthority:'NONE',
    });
  const nowMs=now();
  if(!safeTime(nowMs)||scope.windowEndMs>nowMs-5_000)
    fail('MINUTE_RECHECK_WINDOW_NOT_CLOSED');
  const response=await fetchCryptoMinutePage(scope,{fetchImpl});
  const candidates=validateMinuteCandles(scope,response,now());
  const known=new Map(first.availableRows.map(row=>[row.timestamp,row]));
  for(const row of candidates){
    const old=known.get(row.timestamp);
    if(old&&!same(old,row))fail('MINUTE_RECHECK_CONFLICTING_SOURCE_REVISION');
  }
  const added=candidates.filter(row=>!known.has(row.timestamp));
  if(!added.length)return Object.freeze({
    status:'NO_NEW_CANDLES_OBSERVED',providerGETCount:1,
    filesWritten:0,addedCandleCount:0,
    unverifiedMissingMinuteSlots:first.unverifiedMissingMinuteSlots,
    noTradeIndependentlyCertified:false,executionAuthority:'NONE',
  });
  const at=now();
  if(!safeTime(at)||at<scope.windowEndMs+5_000)
    fail('MINUTE_RECHECK_TIME_INVALID');
  const addedDigest=digestAdded(first.base,added);
  if(first.receipts.some(r=>r.addedRowsDigest===addedDigest))
    return Object.freeze({
      status:'REUSED_RECHECK_RECEIPT',providerGETCount:1,
      filesWritten:0,addedCandleCount:0,
      executionAuthority:'NONE',
    });
  if(!persist)return Object.freeze({
    status:'NEW_CANDLES_OBSERVED_NOT_SAVED',providerGETCount:1,
    filesWritten:0,addedCandleCount:added.length,
    unverifiedMissingMinuteSlots:first.unverifiedMissingMinuteSlots-added.length,
    newSourceAvailableAtMs:at,paperAdmissionAllowed:false,
    executionAuthority:'NONE',
  });
  const record={
    contract:MINUTE_RECHECK_CONTRACT,researchSha,
    market:scope.market,symbol:scope.symbol,
    windowStartMs:scope.windowStartMs,windowEndMs:scope.windowEndMs,
    baseCandleDigest:first.base.candleDigest,
    baseContentDigest:first.base.contentDigest,
    retrievedAt:new Date(at).toISOString(),candles:added,
    economicEvidenceCredit:0,oosCredit:0,paperCredit:0,
    profitabilityProven:false,executionAuthority:'NONE',
  };
  record.addedRowsDigest=addedDigest;
  record.receiptDigest=digestReceipt(record);
  const saved=await durableWrite(root,scope,record);
  const readback=await readImmutableMinuteRecheckEvidenceV1({
    root,task:scope,researchSha,nowMs:now(),
  });
  if(!readback.receipts.some(r=>r.addedRowsDigest===addedDigest)
    ||readback.unverifiedMissingMinuteSlots
      !==first.unverifiedMissingMinuteSlots-added.length)
    fail('MINUTE_RECHECK_READBACK_FAILED');
  return Object.freeze({
    status:saved.linked?'IMMUTABLE_SUPPLEMENT_ARCHIVED':'REUSED_RECHECK_RECEIPT',
    providerGETCount:1,filesWritten:saved.linked?1:0,
    addedCandleCount:saved.linked?added.length:0,
    unverifiedMissingMinuteSlots:readback.unverifiedMissingMinuteSlots,
    observationTimeMs:at,independentPITProven:false,
    providerGapIndependentlyExcluded:false,paperAdmissionAllowed:false,
    profitabilityProven:false,executionAuthority:'NONE',
  });
}
