// Read-only Research archive → exact original-minute multi-timeframe bridge.
// No provider calls, no archive writes, no research PASS, Paper/LIVE authority.
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  MINUTE_MS, validateMinuteTask,
} from './four-market-minute-archive-intake-v1.mjs';
import {
  readImmutableMinuteRecheckEvidenceV1,
} from './four-market-minute-gap-recheck-v1.mjs';
import {
  deriveResearchTimeframesFromMinuteSourceV1,
} from './research-minute-to-multiframe-reuse-v1.mjs';

export const ARCHIVED_MINUTE_ROLLUP_CONTRACT='research-immutable-1m-daily-rollup/v1';
export const ARCHIVED_MINUTE_ROLLUP_LIMITS=Object.freeze({
  maxDirectoryEntries:512, maxReadPagesPerDay:512, maxMinuteRows:1440,
  maxPreviewMissingMinutes:12,
});
const DAY=86_400_000;
const MARKETS=Object.freeze({
  CRYPTO_SPOT:Object.freeze({venue:'UPBIT_KRW',source:'UPBIT_PUBLIC_1M'}),
  CRYPTO_FUTURES:Object.freeze({venue:'BITGET_USDT_FUTURES',source:'BITGET_PUBLIC_FUTURES_1M'}),
});
const SHA40=/^[a-f0-9]{40}$/u;
const DAY_DATE=/^\d{4}-\d{2}-\d{2}$/u;
const PAGE_FILENAME=/^([1-9]\d{12})-([1-9]\d{12})\.json$/u;
const INTERVALS=new Set(['1m','3m','5m','15m','30m','60m','1h','4h','1d']);
const fail=code=>{throw new Error(code);};
const checksum=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');

function validateSelection({market,symbol,day,asOfMs,inspectionNowMs,sourceRoot,researchSha,timeframes}){
  if(typeof day!=='string'||!DAY_DATE.test(day))
    fail('MINUTE_ROLLUP_DAY_INVALID');
  const start=Date.parse(day+'T00:00:00.000Z');
  if(!Number.isSafeInteger(start)||new Date(start).toISOString().slice(0,10)!==day)
    fail('MINUTE_ROLLUP_DAY_INVALID');
  if(!Number.isSafeInteger(asOfMs)||asOfMs<=0
    ||!Number.isSafeInteger(inspectionNowMs)||inspectionNowMs<=0
    ||asOfMs>inspectionNowMs+5_000)
    fail('MINUTE_ROLLUP_INSPECTION_TIME_INVALID');
  if(!Array.isArray(timeframes)||!timeframes.length||timeframes.length>9
    ||new Set(timeframes).size!==timeframes.length
    ||timeframes.some(x=>!INTERVALS.has(x)))
    fail('MINUTE_ROLLUP_INTERVAL_SELECTION_INVALID');
  // Fail closed on unsupported stock sessions; never force UTC-day grouping
  // across KRX, Nasdaq/NYSE, premarket, after-hours or DST boundaries.
  validateMinuteTask({market,symbol,windowStartMs:start,windowEndMs:start+MINUTE_MS});
  if(!Object.hasOwn(MARKETS,market))
    return Object.freeze({market,symbol,day,start,stockSourceBlocked:true});
  if(typeof sourceRoot!=='string'||!isAbsolute(sourceRoot)
    ||resolve(sourceRoot)!==sourceRoot ||!SHA40.test(researchSha??'')
    ||/^\/(?:opt\/stock-app-data|srv\/stock-app|var\/lib\/stock-app)(?:\/|$)/u.test(sourceRoot))
    fail('MINUTE_ROLLUP_CONFIGURATION_INVALID');
  return Object.freeze({market,symbol,day,start,stockSourceBlocked:false});
}
async function validateAncestorsNoLink(root) {
  let part=root;
  while(true){
    const meta=await lstat(part);
    if(!meta.isDirectory()||meta.isSymbolicLink())
      fail('MINUTE_ROLLUP_ROOT_UNSAFE');
    const parent=dirname(part);
    if(parent===part)break;
    part=parent;
  }
}
async function privateDirectory(path,optional=false){
  try{
    const st=await lstat(path);
    if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0)
      fail('MINUTE_ROLLUP_DIRECTORY_UNSAFE');
    return true;
  }catch(e){
    if(optional&&e?.code==='ENOENT')return false;
    throw e;
  }
}
function emptyStatus(identity,status,reason,fields={}){
  return Object.freeze({
    contract:ARCHIVED_MINUTE_ROLLUP_CONTRACT,
    market:identity.market, symbol:identity.symbol??null,day:identity.day,
    status,reason,readOnly:true,sourceMinutePages:0,sourceMinuteRows:0,
    completeOriginalMinuteSlots:false,missingOneMinuteSlots:null,
    derivedReport:null,
    sourceArchiveDigestVerified:false,independentlyAuthenticatedPIT:false,
    genuineScannerTimeAvailabilityProven:false,profitabilityProven:false,
    oosPassCount:0,paperAdmissionAllowed:false,executionAuthority:'NONE',
    ...fields,
  });
}
function taskFromFilename(market,symbol,file){
  const match=PAGE_FILENAME.exec(file);
  if(!match)fail('MINUTE_ROLLUP_PAGE_FILENAME_INVALID');
  const from=Number(match[1]),to=Number(match[2]);
  return validateMinuteTask({
    market,symbol,windowStartMs:from,windowEndMs:to,
  });
}
async function listSelectedPages(root,market,symbol,dayStart){
  const result=[];
  const marketPath=join(root,market),symbolPath=join(marketPath,symbol);
  if(!await privateDirectory(marketPath,true)
    ||!await privateDirectory(symbolPath,true))return result;
  // Each original request spans <=180m, so only previous and current
  // UTC-date directories can intersect the requested UTC day.
  for(const dayMs of [dayStart-DAY,dayStart]){
    const dir=join(symbolPath,new Date(dayMs).toISOString().slice(0,10));
    if(!await privateDirectory(dir,true))continue;
    const entries=await readdir(dir,{withFileTypes:true});
    if(entries.length>ARCHIVED_MINUTE_ROLLUP_LIMITS.maxDirectoryEntries)
      fail('MINUTE_ROLLUP_DIRECTORY_PAGE_LIMIT');
    for(const entry of entries){
      // Never treat unfinalized/corrupt/temp files as complete evidence.
      if(!entry.isFile()||!PAGE_FILENAME.test(entry.name))
        fail('MINUTE_ROLLUP_UNEXPECTED_ARCHIVE_ENTRY');
      const task=taskFromFilename(market,symbol,entry.name);
      if(new Date(task.windowStartMs).toISOString().slice(0,10)
        !==new Date(dayMs).toISOString().slice(0,10))
        fail('MINUTE_ROLLUP_PAGE_DATE_MISMATCH');
      if(task.windowEndMs>dayStart && task.windowStartMs<dayStart+DAY)
        result.push(task);
    }
  }
  if(result.length>ARCHIVED_MINUTE_ROLLUP_LIMITS.maxReadPagesPerDay)
    fail('MINUTE_ROLLUP_READ_PAGE_LIMIT');
  result.sort((a,b)=>a.windowStartMs-b.windowStartMs
    ||a.windowEndMs-b.windowEndMs);
  return result;
}

/**
 * Bound to one UTC crypto day and an existing owner-controlled private root.
 * Does not list arbitrary market directories, query providers, or write.
 * Missing/no-trade minutes are NEVER zero-filled or inferred complete.
 */
export async function inspectImmutableMinuteDayRollupV1({
  root,market,symbol,day,researchSha,
  timeframes=['1m','3m','5m','15m','60m'],
  asOfMs=Date.now(),inspectionNowMs=Date.now(),
}={}){
  const selection=validateSelection({market,symbol,day,asOfMs,inspectionNowMs,
    sourceRoot:root,researchSha,timeframes});
  if(selection.stockSourceBlocked)
    return emptyStatus(selection,'BLOCKED_DATA','STOCK_EXCHANGE_SESSION_SOURCE_NOT_CONNECTED');
  const config=MARKETS[market];
  try{await validateAncestorsNoLink(root);await privateDirectory(root);}
  catch(e){
    if(e?.code==='ENOENT')
      return emptyStatus(selection,'BLOCKED_DATA','PRIVATE_ARCHIVE_ROOT_NOT_PRESENT');
    throw e;
  }
  const pageTasks=await listSelectedPages(root,market,symbol,selection.start);
  if(!pageTasks.length)
    return emptyStatus(selection,'BLOCKED_DATA','NO_ORIGINAL_MINUTE_PAGES',
      {missingOneMinuteSlots:1440});
  const bars=new Map();
  const sourcePageDigests=[],supplementalReceiptDigests=[],producerShas=new Set();
  let duplicateMinutes=0,earliestRetrievedAt=Number.POSITIVE_INFINITY,
    latestRetrievedAt=0,supplementalUniqueMinutes=0;
  for(const task of pageTasks){
    // Each extension is independently source-sealed and anchored to the
    // immutable original page checksum. Never replace its rows.
    const evidence=await readImmutableMinuteRecheckEvidenceV1({
      root,task,researchSha,nowMs:inspectionNowMs,
    });
    const page=evidence.base;
    if(!page)fail('MINUTE_ROLLUP_PAGE_DISAPPEARED');
    supplementalUniqueMinutes+=evidence.supplementalUniqueMinutes;
    for(const receipt of evidence.receipts){
      supplementalReceiptDigests.push(receipt.receiptDigest);
      producerShas.add(receipt.researchSha);
    }
    if(page.source!==config.source||page.market!==market
      ||page.symbol!==symbol||!SHA40.test(page.researchSha??''))
      fail('MINUTE_ROLLUP_SOURCE_IDENTITY_INVALID');
    const received=Date.parse(page.retrievedAt);
    if(!Number.isSafeInteger(received)||received<=0
      ||received>inspectionNowMs+5_000)
      fail('MINUTE_ROLLUP_RETRIEVAL_TIME_INVALID');
    earliestRetrievedAt=Math.min(earliestRetrievedAt,received);
    latestRetrievedAt=Math.max(latestRetrievedAt,received);
    producerShas.add(page.researchSha);
    sourcePageDigests.push(page.contentDigest);
    for(const c of evidence.availableRows){
      if(c.timestamp<selection.start||c.timestamp>=selection.start+DAY)continue;
      const existing=bars.get(c.timestamp);
      const row=Object.freeze({
        market,venue:config.venue,symbol,sourceId:config.source,
        timestampMs:c.timestamp,
        availableAtMs:Math.max(c.availableAtMs,c.timestamp+MINUTE_MS),
        open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume,
      });
      if(existing){
        if(['open','high','low','close','volume'].some(k=>existing[k]!==row[k]))
          fail('MINUTE_ROLLUP_OVERLAPPING_SOURCE_CONFLICT');
        duplicateMinutes++;
        // Two observations of the identical minute may be collected on
        // different dates; the earliest real receipt is the first availability.
        if(row.availableAtMs<existing.availableAtMs)bars.set(c.timestamp,row);
      }else{
        if(bars.size>=ARCHIVED_MINUTE_ROLLUP_LIMITS.maxMinuteRows)
          fail('MINUTE_ROLLUP_MINUTE_LIMIT');
        bars.set(c.timestamp,row);
      }
    }
  }
  const minuteBars=[...bars.values()].sort((a,b)=>a.timestampMs-b.timestampMs);
  if(!minuteBars.length)
    return emptyStatus(selection,'BLOCKED_DATA','NO_MINUTES_IN_SELECTED_DAY',
      {sourceMinutePages:pageTasks.length,missingOneMinuteSlots:1440});
  const missing=[];
  for(let at=selection.start;at<selection.start+DAY;at+=MINUTE_MS){
    if(!bars.has(at) && missing.length<ARCHIVED_MINUTE_ROLLUP_LIMITS.maxPreviewMissingMinutes)
      missing.push(new Date(at).toISOString());
  }
  const missingCount=1440-minuteBars.length;
  if(missingCount<0)fail('MINUTE_ROLLUP_MINUTE_LIMIT');
  const minutesDigest=checksum(minuteBars);
  const derived=deriveResearchTimeframesFromMinuteSourceV1({
    market,venue:config.venue,symbol,sourceId:config.source,
    session:{startMs:selection.start,endMs:selection.start+DAY,
      kind:'UTC_24H',timeZone:'UTC',
      calendarSourceId:'CRYPTO_UTC_DAY_SOURCE_ONLY'},
    minuteBars,sourceMinuteRowsSha256:minutesDigest,
    asOfMs,timeframes,
  });
  if(derived.status==='BLOCKED_DATA'||derived.sourceMinuteIntegrityVerified!==true)
    fail('MINUTE_ROLLUP_DERIVATION_REJECTED');
  const derivedCompleteAtCutoff=missingCount===0 && timeframes.every(
    f=>derived.intervalData[f]?.sourceSessionCoverageComplete===true);
  return Object.freeze({
    contract:ARCHIVED_MINUTE_ROLLUP_CONTRACT,
    status:derivedCompleteAtCutoff
      ?'SOURCE_ONLY_COMPLETE_DAY_MINUTES':'SOURCE_ONLY_PARTIAL_DAY_MINUTES',
    reason:derived.reason,market,symbol,day,
    source:config.source,sourceMinutesDigest:minutesDigest,
    sourcePageDigests:Object.freeze(sourcePageDigests),
    supplementalReceiptDigests:Object.freeze(supplementalReceiptDigests),
    supplementalReceiptCount:supplementalReceiptDigests.length,
    supplementalUniqueMinuteObservations:supplementalUniqueMinutes,
    originalProducerShas:Object.freeze([...producerShas].sort()),
    sourceMinutePages:pageTasks.length,
    sourceMinuteRows:minuteBars.length,
    duplicateOverlappingSourceRows:duplicateMinutes,
    missingOneMinuteSlots:missingCount,
    missingOneMinutePreview:Object.freeze(missing),
    firstActuallyRetrievedAtMs:earliestRetrievedAt,
    lastActuallyRetrievedAtMs:latestRetrievedAt,
    completeOriginalMinuteSlots:missingCount===0,
    allRequestedDerivedBarsAvailableAtCutoff:derivedCompleteAtCutoff,
    derivedReport:derived,
    readOnly:true,providerGETCount:0,archiveFilesWritten:0,
    sourceArchiveDigestVerified:true,independentlyAuthenticatedPIT:false,
    genuineScannerTimeAvailabilityProven:false,
    fullMarketCoverageProven:false,profitabilityProven:false,
    oosPassCount:0,paperAdmissionAllowed:false,executionAuthority:'NONE',
  });
}
