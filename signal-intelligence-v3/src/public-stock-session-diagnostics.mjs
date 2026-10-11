/**
 * Diagnostic-only public stock candle/session and KRX exclusion summary.
 * Does NOT repair missing candles, waive scan trust gates, or request data.
 * Never outputs identifiers, raw timestamps, OHLC, names, URLs or payloads.
 */
const MARKETS={
  KR_STOCK:{zone:'Asia/Seoul',open:9*60,close:15*60+30},
  US_STOCK:{zone:'America/New_York',open:9*60+30,close:16*60},
};
const FRAMES={'1m':1,'3m':3,'5m':5,'15m':15,'30m':30,'60m':60,'1H':60};
const FORMATTERS=Object.fromEntries(Object.entries(MARKETS).map(([market,value])=>[
  market,new Intl.DateTimeFormat('en-US',{timeZone:value.zone,
    hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',
    weekday:'short',hour:'2-digit',minute:'2-digit'}),
]));
const TYPES=['STOCK','ETF','ETN','LEVERAGED_ETF','INVERSE_ETF',
  'LEVERAGED_ETN','INVERSE_ETN','REIT','ADR','OTHER'];
const validCount=x=>Number.isSafeInteger(x)&&x>=0;
function milliseconds(value){
  if(typeof value==='number')return Number.isFinite(value)&&value>0
    ? value<10_000_000_000?value*1000:value:null;
  if(typeof value!=='string')return null;
  // Explicit ISO with an offset; never reinterpret UTC data as KST.
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value))return null;
  const at=Date.parse(value);return Number.isFinite(at)?at:null;
}
function localTradingClock(at,market){
  const formatter=FORMATTERS[market],hours=MARKETS[market];
  if(!formatter)return null;
  const parts=Object.fromEntries(formatter.formatToParts(new Date(at))
    .filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  const minute=Number(parts.hour)*60+Number(parts.minute);
  const weekday=parts.weekday;
  const date=parts.year+'-'+parts.month+'-'+parts.day;
  const workday=!['Sat','Sun'].includes(weekday);
  return {date,regular:workday&&minute>=hours.open&&minute<hours.close};
}
/** A candidate in-session gap is NOT proof of missing tradable candles:
 * exchange holidays, half-days, halts and feed precision are unverified.
 * Existing scanner quality decisions remain untouched.
 */
export function createPublicStockSessionGapAudit(market,timeframe){
  const minutes=FRAMES[timeframe],supported=Boolean(MARKETS[market]&&minutes);
  let inspected=0,fetchFailures=0,invalidTimeRows=0,largeGaps=0;
  let regularCandidates=0,outsideRegularCandidates=0;
  let withRegular=0,withOutside=0;
  const audit=Object.freeze({
    observe(candles){
      inspected+=1;
      if(!supported||!Array.isArray(candles))return;
      const times=[];
      for(const candle of candles){
        const at=milliseconds(candle?.time);
        if(at==null){invalidTimeRows+=1;continue;}
        times.push(at);
      }
      times.sort((a,b)=>a-b);
      let regular=false,outside=false;
      for(let i=1;i<times.length;i++){
        const gap=times[i]-times[i-1];
        if(gap<=minutes*60_000*1.8)continue;
        largeGaps+=1;
        const a=localTradingClock(times[i-1],market);
        const b=localTradingClock(times[i],market);
        if(a?.regular&&b?.regular&&a.date===b.date){
          regularCandidates+=1;regular=true;
        }else{
          outsideRegularCandidates+=1;outside=true;
        }
      }
      if(regular)withRegular+=1;
      if(outside)withOutside+=1;
    },
    observeFetchFailure(){fetchFailures+=1;},
    snapshot(){
      return Object.freeze({
        schemaVersion:'public-stock-session-gap-v1',
        classification:supported?'DIAGNOSTIC_ONLY':'NOT_APPLICABLE',
        inspectedCount:inspected,fetchFailureCount:fetchFailures,
        invalidTimestampCount:invalidTimeRows,
        largeGapCount:largeGaps,
        inRegularSessionGapCandidateCount:regularCandidates,
        outsideRegularOrBoundaryGapCount:outsideRegularCandidates,
        symbolsWithInSessionCandidateCount:withRegular,
        symbolsWithBoundaryOrExtendedHoursGapCount:withOutside,
        needsExchangeCalendarVerification:true,
        scanQualityGateModified:false,
        providerRequestsAdded:0,symbolOrCandleSamplesCaptured:false,
        economicAuthority:'NONE',
      });
    },
  });
  return audit;
}
/** Classify known KRX public exclusions. This does not establish that an
 * alphanumeric code is unsupported by every provider; it only explains which
 * classes a separate authorized feed needs to verify.
 */
export function summarizePublicKrExclusions(roster){
  const rows=Array.isArray(roster?.explainedExclusions)
    ? roster.explainedExclusions : [];
  const expected=roster?.explainedExcludedCount;
  const byAssetType=Object.fromEntries(TYPES.map(x=>[x,0]));
  let alphanumericSix=0,numericSix=0,otherCode=0;
  for(const row of rows){
    const ticker=String(row?.ticker??'').trim().toUpperCase();
    if(/^\d{6}$/u.test(ticker))numericSix+=1;
    else if(/^[A-Z0-9]{6}$/u.test(ticker))alphanumericSix+=1;
    else otherCode+=1;
    const type=TYPES.includes(row?.assetType)?row.assetType:'OTHER';
    byAssetType[type]+=1;
  }
  return Object.freeze({
    schemaVersion:'public-kr-exclusion-classes-v1',
    expectedExcludedCount:validCount(expected)?expected:null,
    observedExcludedCount:rows.length,
    countEvidenceMatches:validCount(expected)&&expected===rows.length,
    numericSixCodeCount:numericSix,
    alphanumericSixCodeCount:alphanumericSix,
    otherCodeCount:otherCode,
    byAssetType:Object.freeze(byAssetType),
    vendorSupportVerified:false,
    fullUniverseCovered:false,
    providerRequestsAdded:0,
    symbolOrNameSamplesCaptured:false,economicAuthority:'NONE',
  });
}
