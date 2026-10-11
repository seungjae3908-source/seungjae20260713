// Research-only, sanitized stock-source completeness evidence.
// The source is already read by the same V3 cycle; no extra provider calls,
// symbols, URLs, responses or account identifiers enter this evidence.
export const PUBLIC_STOCK_SOURCE_AUDIT_VERSION='public-stock-source-audit-v1';
const TF=['1m','3m','5m','15m','60m','4H','1D'];
const safeTimestamp=value=>{
 const at=typeof value==='number'?(value<1e10?value*1000:value):Date.parse(String(value??''));
 return Number.isFinite(at)&&at>0?at:null;
};
const emptyBuckets=()=>Object.fromEntries(TF.map(tf=>[tf,{
  fetched:0,errors:0,empty:0,shortLt20:0,shortLt40:0,
  invalidOhlc:0,hasLateOrFuture:0,
  lastBarLagGteOneDay:0,lastBarLagGteFiveDays:0,
}]));
export function createPublicStockSourceAudit({now=Date.now}={}){
 if(typeof now!=='function')throw Error('PUBLIC_STOCK_AUDIT_CLOCK_INVALID');
 const candles=emptyBuckets(),quote={
  fetched:0,errors:0,invalidPrice:0,
  missingTimestamp:0,expiredTimestamp:0,futureTimestamp:0,
};
 const errors={HTTP_429:0,HTTP_4XX:0,HTTP_5XX:0,TIMEOUT:0,OTHER:0};
 function fail(bucket,error){
   const s=String(error instanceof Error?error.message:'').toUpperCase();
   bucket.errors++;
   if(/(?:HTTP[_-]?429|429 TOO MANY)/u.test(s))errors.HTTP_429++;
   else if(/HTTP[_-]?4[0-9]{2}/u.test(s))errors.HTTP_4XX++;
   else if(/HTTP[_-]?5[0-9]{2}/u.test(s))errors.HTTP_5XX++;
   else if(/TIMEOUT|TIMED OUT|BUDGET|ABORTED/u.test(s))errors.TIMEOUT++;
   else errors.OTHER++;
 }
 return Object.freeze({
  recordCandles(timeframe,rows){
    if(!Object.hasOwn(candles,timeframe))return;
    const b=candles[timeframe];b.fetched++;
    if(!Array.isArray(rows)||rows.length===0){b.empty++;return;}
    if(rows.length<20)b.shortLt20++;
    if(rows.length<40)b.shortLt40++;
    if(rows.some(row=>![row?.open,row?.high,row?.low,row?.close].every(v=>Number.isFinite(v)&&v>0)
      ||row.high<Math.max(row.open,row.close,row.low)||row.low>Math.min(row.open,row.close,row.high)))
      b.invalidOhlc++;
    const at=safeTimestamp(rows.at(-1)?.time);
    if(at===null||at>now()+300000)b.hasLateOrFuture++;
    if(at!=null){
      if(now()-at>=86400000)b.lastBarLagGteOneDay++;
      if(now()-at>=5*86400000)b.lastBarLagGteFiveDays++;
    }
  },
  candleError(timeframe,error){if(Object.hasOwn(candles,timeframe))fail(candles[timeframe],error);},
  recordQuote(row,timeframe='1D'){
    quote.fetched++;
    if(!Number.isFinite(row?.price)||row.price<=0)quote.invalidPrice++;
    // Research-only diagnostics mirror the selector's 2h intraday / 5d
    // daily freshness gate. Expired quotes remain blocked, even on weekends.
    const observedAt=typeof row?.updatedAt==='string'?Date.parse(row.updatedAt):NaN;
    const at=now();
    if(!Number.isFinite(observedAt))quote.missingTimestamp++;
    else if(observedAt>at+300000)quote.futureTimestamp++;
    else if(at-observedAt>(timeframe==='1D'?5*86400000:2*3600000))
      quote.expiredTimestamp++;
  },
  quoteError(error){fail(quote,error);},
  snapshot(){return Object.freeze({
    version:PUBLIC_STOCK_SOURCE_AUDIT_VERSION,
    candles:Object.freeze(Object.fromEntries(Object.entries(candles).map(([tf,b])=>[tf,Object.freeze({...b})]))),
    quote:Object.freeze({...quote}),
    sanitizedProviderFailures:Object.freeze({...errors}),
    symbolsRedacted:true,
    // Successful source requests are not proof of quote coverage across
    // every instrument, a complete session or a profitable trade.
    fullMarketVerified:false,executionAuthority:'NONE',
  });},
 });
}


// Preserve bounded public-source failure buckets even when the stock scanner
// throws before returning its response. The Error never carries provider
// bodies, URLs, ticker identities or credentials into exported diagnostics.
const PUBLIC_STOCK_ERROR_AUDIT=Symbol('public-v3-stock-failure-audit');
const CANDLE_BUCKET_FIELDS=Object.freeze([
  'fetched','errors','empty','shortLt20','shortLt40','invalidOhlc',
  'hasLateOrFuture','lastBarLagGteOneDay','lastBarLagGteFiveDays',
]);
const QUOTE_BUCKET_FIELDS=Object.freeze([
  'fetched','errors','invalidPrice',
  'missingTimestamp','expiredTimestamp','futureTimestamp',
]);
const FAILURE_BUCKET_FIELDS=Object.freeze(['HTTP_429','HTTP_4XX','HTTP_5XX','TIMEOUT','OTHER']);
const validCount=x=>Number.isSafeInteger(x)&&x>=0;
function auditedCounters(input,keys){
  if(!input||typeof input!=='object'||Array.isArray(input))return null;
  const output={};
  for(const key of keys){
    if(!validCount(input[key]))return null;
    output[key]=input[key];
  }
  return Object.freeze(output);
}
export function sanitizePublicStockSourceAudit(input){
  if(!input||input.version!==PUBLIC_STOCK_SOURCE_AUDIT_VERSION
    ||input.symbolsRedacted!==true||input.fullMarketVerified!==false
    ||input.executionAuthority!=='NONE'
    ||!input.candles||typeof input.candles!=='object')return null;
  const candles={};
  for(const tf of TF){
    const cleaned=auditedCounters(input.candles[tf],CANDLE_BUCKET_FIELDS);
    if(!cleaned)return null;
    candles[tf]=cleaned;
  }
  const quote=auditedCounters(input.quote,QUOTE_BUCKET_FIELDS);
  const failures=auditedCounters(input.sanitizedProviderFailures,FAILURE_BUCKET_FIELDS);
  if(!quote||!failures)return null;
  // Whitelist and deep-freeze only numerical statistics from our adapter.
  return Object.freeze({
    version:PUBLIC_STOCK_SOURCE_AUDIT_VERSION,
    candles:Object.freeze(candles),quote,
    sanitizedProviderFailures:failures,
    symbolsRedacted:true,fullMarketVerified:false,executionAuthority:'NONE',
  });
}
export function attachPublicStockSourceAuditToError(error,audit){
  if(!(error instanceof Error))return error;
  const safe=sanitizePublicStockSourceAudit(audit);
  if(!safe)return error;
  try{
    Object.defineProperty(error,PUBLIC_STOCK_ERROR_AUDIT,{
      value:safe,enumerable:false,configurable:false,writable:false,
    });
  }catch{
    // A frozen third-party error stays unmodified and fail-closed.
  }
  return error;
}
export function readPublicStockSourceAuditFromError(error){
  return error instanceof Error
    ?sanitizePublicStockSourceAudit(error[PUBLIC_STOCK_ERROR_AUDIT]):null;
}


/**
 * Explain already-blocked stock research source observations without a second
 * provider call. An expired quote is not a network outage or a safe live price.
 * Even "ALL_OBSERVED_QUOTES_EXPIRED" does NOT prove that the exchange is closed,
 * that every symbol is covered, or that any scanner/trading gate can be opened.
 */
export function classifyPublicStockSourceBlocker(audit,timeframe){
 const source=sanitizePublicStockSourceAudit(audit);
 const unknown=Object.freeze({
   category:'SOURCE_CAUSE_UNVERIFIED',observedQuoteReads:null,expiredQuoteReads:null,
   http429Reads:null,blockedOnly:true,fullMarketDataReady:false,
   candidatePromotionAllowed:false,executionAuthority:'NONE',
 });
 if(!source||!TF.includes(timeframe))return unknown;
 const q=source.quote,c=source.candles[timeframe],f=source.sanitizedProviderFailures;
 let category='SOURCE_CAUSE_UNVERIFIED';
 if(f.HTTP_429>0)category='HTTP_429_OBSERVED';
 else if(f.TIMEOUT>0)category='HTTP_TIMEOUT_OBSERVED';
 else if(f.HTTP_4XX>0||f.HTTP_5XX>0)category='HTTP_OTHER_ERROR_OBSERVED';
 else if(f.OTHER>0)category='PROVIDER_OTHER_ERROR_OBSERVED';
 else if(q.missingTimestamp>0||q.futureTimestamp>0)
   category='QUOTE_TIMESTAMP_INVALID_OBSERVED';
 else if(q.fetched>0&&q.expiredTimestamp===q.fetched
   &&q.errors===0&&q.invalidPrice===0)
   category='ALL_OBSERVED_QUOTES_EXPIRED';
 else if(q.expiredTimestamp>0)category='SOME_OBSERVED_QUOTES_EXPIRED';
 else if(c.invalidOhlc>0)category='INVALID_OHLC_OBSERVED';
 else if(c.empty>0||c.shortLt20>0)category='CANDLE_DEPTH_OR_EMPTY_OBSERVED';
 return Object.freeze({
   category,observedQuoteReads:q.fetched,expiredQuoteReads:q.expiredTimestamp,
   http429Reads:f.HTTP_429,blockedOnly:true,fullMarketDataReady:false,
   candidatePromotionAllowed:false,executionAuthority:'NONE',
 });
}
