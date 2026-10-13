// Offline Backtester compatibility prewire for independently sealed public 1m.
// It produces a PRIVATE IN-MEMORY research-model input; it never invokes
// the app HTTP backtester, source collection, a Paper admission, or an order.
import { createHash } from 'node:crypto';
import { inspectImmutableMinuteDayRollupV1 } from './four-market-minute-daily-rollup-v1.mjs';
import { deriveResearchTimeframesFromMinuteSourceV1 } from
  './research-minute-to-multiframe-reuse-v1.mjs';

export const BACKTEST_SOURCE_CONTRACT='research-original-minute-backtester-prewire/v1';
export const BACKTEST_SOURCE_PERIOD_CONTRACT='research-original-minute-period-source-readiness/v1';
export const BACKTEST_SOURCE_LIMITS=Object.freeze({
  maxDaysPerRead:7,maxPeriodDays:3660,minuteRowsPerCryptoDay:1440,
  maxMissingPreview:7,
});
const MINUTE=60_000,DAY=86_400_000;
const DIGEST=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const DATE=/^\d{4}-\d{2}-\d{2}$/u;
const fail=code=>{throw new Error(code);};
const ZERO_AUTH=Object.freeze({
  readOnly:true,providerGETCount:0,archiveFilesWritten:0,liveTrading:false,
  privateAccountAPIAllowed:false,autoTrading:false,actualFillsProven:false,
  historicalPITProven:false,independentOosProven:false,
  fullCostProfitabilityProven:false,profitabilityProven:false,
  paperAdmissionAllowed:false,executionAuthority:'NONE',
});
const stopped=(market,symbol,day,reason,meta={})=>Object.freeze({
  contract:BACKTEST_SOURCE_CONTRACT,status:'BLOCKED_DATA',
  market:market??null,symbol:symbol??null,day:day??null,
  reason,modelInput:null,
  sourceMinuteDigest:null,sourceMinuteRows:0,metadata:meta,...ZERO_AUTH,
});
const utc=ms=>new Date(ms).toISOString().slice(0,10);
function dayMs(value){
  if(typeof value!=='string'||!DATE.test(value))fail('BACKTEST_SOURCE_DAY_INVALID');
  const ms=Date.parse(value+'T00:00:00.000Z');
  if(!Number.isSafeInteger(ms)||utc(ms)!==value)fail('BACKTEST_SOURCE_DAY_INVALID');
  return ms;
}
function validAsOf(value){
  if(!Number.isSafeInteger(value)||value<=0)
    fail('BACKTEST_SOURCE_ASOF_INVALID');
}
/**
 * Called solely by a server-side, permission-gated future Research adapter.
 * No raw 1m OHLCV is published through the CLI or research-dashboard.
 *
 * modelInput has EXACT SOURCE_KEYS supported by #1534's offline native-minute
 * source model. It does not claim independently sourced historic PIT membership.
 */
export async function prepareSealedMinuteBacktesterInputV1({
  enabled=false,root,market,symbol,day,researchSha,
  asOfMs=Date.now(),inspectionNowMs=Date.now(),
}={}){
  if(!enabled)return stopped(market,symbol,day,'EXPLICIT_MODEL_SOURCE_PREWIRE_DISABLED');
  validAsOf(asOfMs);validAsOf(inspectionNowMs);
  dayMs(day);
  const inspect=await inspectImmutableMinuteDayRollupV1({
    root,market,symbol,day,researchSha,
    timeframes:['1m'],asOfMs,inspectionNowMs,
  });
  if(inspect.status!=='SOURCE_ONLY_COMPLETE_DAY_MINUTES'
    ||inspect.completeOriginalMinuteSlots!==true
    ||inspect.sourceArchiveDigestVerified!==true
    ||inspect.allRequestedDerivedBarsAvailableAtCutoff!==true)
    return stopped(market,symbol,day,
      inspect.reason??'SOURCE_MINUTE_DAY_NOT_MODEL_INPUT_READY',{
        archiveStatus:inspect.status,
        missingOneMinuteSlots:inspect.missingOneMinuteSlots,
        originalPageCount:inspect.sourceMinutePages,
      });
  const original=inspect.derivedReport;
  const native=original?.intervalData?.['1m']?.bars;
  if(!Array.isArray(native)||native.length!==BACKTEST_SOURCE_LIMITS.minuteRowsPerCryptoDay
    ||original.sourceMinuteIntegrityVerified!==true)
    fail('BACKTEST_SOURCE_DERIVED_MINUTE_CONTRACT_INVALID');
  const minuteBars=native.map(x=>Object.freeze({
    market:x.market,venue:x.venue,symbol:x.symbol,sourceId:x.sourceId,
    timestampMs:x.startMs,availableAtMs:x.availableAtMs,
    open:x.open,high:x.high,low:x.low,close:x.close,volume:x.volume,
  }));
  const start=dayMs(day);
  const source=Object.freeze({
    market,venue:original.venue,symbol,sourceId:inspect.source,
    session:Object.freeze({
      startMs:start,endMs:start+DAY,
      kind:'UTC_24H',timeZone:'UTC',
      calendarSourceId:'CRYPTO_UTC_DAY_SOURCE_ONLY',
    }),
    minuteBars:Object.freeze(minuteBars),
    sourceMinuteRowsSha256:DIGEST(minuteBars),
    asOfMs,
  });
  // Same original source schema/validation as the isolated #1534 model;
  // the later asOf is genuine retrieval time, not the historical tick time.
  const checked=deriveResearchTimeframesFromMinuteSourceV1({
    ...source,timeframes:['1m','5m'],
  });
  if(checked.sourceMinuteIntegrityVerified!==true
    ||checked.intervalData?.['1m']?.completeBarCount
      !==BACKTEST_SOURCE_LIMITS.minuteRowsPerCryptoDay
    ||checked.intervalData?.['5m']?.completeBarCount!==288)
    fail('BACKTEST_SOURCE_EXACT_CANONICAL_CHECK_FAILED');
  return Object.freeze({
    contract:BACKTEST_SOURCE_CONTRACT,status:'RETROSPECTIVE_RESEARCH_MODEL_INPUT_ONLY',
    market,symbol,day,
    modelInput:source,
    sourceMinuteDigest:source.sourceMinuteRowsSha256,
    sourceMinuteRows:minuteBars.length,
    oldestActualReceiptMs:inspect.firstActuallyRetrievedAtMs,
    newestActualReceiptMs:inspect.lastActuallyRetrievedAtMs,
    sourceArchiveDigests:inspect.sourcePageDigests,
    sourceArchiveProducerShas:inspect.originalProducerShas,
    metadata:Object.freeze({
      sourceMinutePages:inspect.sourceMinutePages,
      missingOneMinuteSlots:0,allSourceSlotsObserved:true,
      sourceSession:'UTC_CRYPTO_DAY_ONLY',
      sourceDigestMatchesCanonicalModel:true,
      independentMarketLicenseOrPITProven:false,
      retrospectiveTimeCannotBeUsedAsScannerTime:true,
    }),
    ...ZERO_AUTH,
  });
}

/**
 * Pageable 1d..10y source status. This is not 10 years loaded at once.
 * Read only <=7 UTC dates with a caller-supplied cursor, and return counts,
 * hashes and missing blockers, never the sensitive original bars.
 */
export async function inspectSealedMinuteBacktesterPeriodV1({
  enabled=false,root,market,symbol,startDate,endDate,
  cursorDate=null,daysPerRead=7,researchSha,
  asOfMs=Date.now(),inspectionNowMs=Date.now(),
}={}){
  if(!enabled)return Object.freeze({
    contract:BACKTEST_SOURCE_PERIOD_CONTRACT,status:'DISABLED',
    checkedDays:0,providerGETCount:0,archiveFilesWritten:0,
    ...ZERO_AUTH,
  });
  const first=dayMs(startDate),last=dayMs(endDate);
  validAsOf(asOfMs);validAsOf(inspectionNowMs);
  if(last<first||(last-first)/DAY+1>BACKTEST_SOURCE_LIMITS.maxPeriodDays
    ||!Number.isSafeInteger(daysPerRead)||daysPerRead<1
    ||daysPerRead>BACKTEST_SOURCE_LIMITS.maxDaysPerRead)
    fail('BACKTEST_SOURCE_PERIOD_INVALID');
  const cursor=cursorDate==null?first:dayMs(cursorDate);
  if(cursor<first||cursor>last)fail('BACKTEST_SOURCE_CURSOR_INVALID');
  const until=Math.min(last+DAY,cursor+daysPerRead*DAY);
  const reports=[];
  for(let dayMsValue=cursor;dayMsValue<until;dayMsValue+=DAY){
    const date=utc(dayMsValue);
    const result=await prepareSealedMinuteBacktesterInputV1({
      enabled:true,root,market,symbol,day:date,researchSha,
      asOfMs,inspectionNowMs,
    });
    reports.push(Object.freeze({
      day:date,sourceStatus:result.status,
      reason:result.reason??null,sourceMinuteRows:result.sourceMinuteRows,
      sourceMinuteDigest:result.sourceMinuteDigest,
      missingOneMinuteSlots:result.metadata?.missingOneMinuteSlots??null,
      historicalPITProven:false,paperAdmissionAllowed:false,
    }));
  }
  const available=reports.filter(x=>
    x.sourceStatus==='RETROSPECTIVE_RESEARCH_MODEL_INPUT_ONLY').length;
  const missing=reports.length-available;
  return Object.freeze({
    contract:BACKTEST_SOURCE_PERIOD_CONTRACT,
    status:missing?'SOURCE_LIMITED_PERIOD_PAGE':'RETROSPECTIVE_SOURCE_ONLY_PERIOD_PAGE',
    market,symbol,requestedStartDate:startDate,requestedEndDate:endDate,
    inspectedFirstDate:utc(cursor),inspectedLastDate:utc(until-DAY),
    inspectedDayCount:reports.length,originalMinuteDayModelInputs:available,
    blockedSourceDays:missing,
    nextCursorDate:until<=last?utc(until):null,
    reports:Object.freeze(reports),
    readOnly:true,sourceOnly:true,providerGETCount:0,
    archiveFilesWritten:0,fullRequestedPeriodIndependentlyVerified:false,
    ...ZERO_AUTH,
  });
}
