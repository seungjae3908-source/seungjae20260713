// A green *contract* means the source failure was honestly blocked, NOT
// that 4-market prices/real listing/24h production coverage succeeded.
// Never turn invalid OHLC into a zero-signal or economically approved PASS.
const STRATEGIES=new Set(['SCALPING','SWING','MID_LONG']);
const numeric=n=>Number.isSafeInteger(n)&&n>=0;

// A thrown stock Scanner may now carry independently bounded, source-only
// counters. These do NOT represent any completed or trusted market page.
// Validate the complete allowlist before even referencing their totals.
const AUDIT_FIELDS=['version','candles','quote','sanitizedProviderFailures',
  'symbolsRedacted','fullMarketVerified','executionAuthority'];
const AUDIT_TF=['1m','3m','5m','15m','60m','4H','1D'];
const AUDIT_CANDLE_FIELDS=['fetched','errors','empty','shortLt20','shortLt40',
  'invalidOhlc','hasLateOrFuture','lastBarLagGteOneDay','lastBarLagGteFiveDays'];
const AUDIT_QUOTE_FIELDS=['fetched','errors','invalidPrice'];
const AUDIT_HTTP_FIELDS=['HTTP_429','HTTP_4XX','HTTP_5XX','TIMEOUT','OTHER'];
function exactCounters(value,keys){
 return value&&typeof value==='object'&&!Array.isArray(value)
   &&Object.keys(value).length===keys.length
   &&keys.every(key=>numeric(value[key]));
}
function safeFailureAudit(value){
 if(value==null)return true; // non-instrumented source failure remains blocked
 return typeof value==='object'&&!Array.isArray(value)
   &&Object.keys(value).length===AUDIT_FIELDS.length
   &&value.version==='public-stock-source-audit-v1'
   &&value.symbolsRedacted===true&&value.fullMarketVerified===false
   &&value.executionAuthority==='NONE'
   &&exactCounters(value.quote,AUDIT_QUOTE_FIELDS)
   &&exactCounters(value.sanitizedProviderFailures,AUDIT_HTTP_FIELDS)
   &&value.candles&&typeof value.candles==='object'
   &&!Array.isArray(value.candles)
   &&Object.keys(value.candles).length===AUDIT_TF.length
   &&AUDIT_TF.every(tf=>exactCounters(value.candles[tf],AUDIT_CANDLE_FIELDS));
}

export function assertBlockedKrPublicResearchCoverage(snapshot){
 if(!snapshot||snapshot.publicDataOnly!==true
   ||snapshot.safety?.executionAuthority!=='NONE'
   ||!Array.isArray(snapshot.coverage))
   throw Error('KR_PUBLIC_COVERAGE_INPUT_NOT_READONLY');
 const rows=snapshot.coverage.filter(x=>x?.market==='KR_STOCK');
 if(rows.length!==3||new Set(rows.map(x=>x.strategy)).size!==3
   ||rows.some(x=>!STRATEGIES.has(x.strategy)))
   throw Error('KR_PUBLIC_COVERAGE_LANES_MISSING');
 const lanes=[];
 for(const row of rows){
   // A fully failed public provider batch has NO candles, audit or roster
   // attestation. Its strict bounded-Scanner numeric exception is allowed as
   // fail-closed evidence, never as market coverage or successful scan.
   // This is distinct from a completed partial KRX batch below.
   if(row.error==='SCAN_PROVIDER_ERROR'){
     const metrics=row.thrownProviderMetrics;
     if(row.status!=='SEARCH_FAILURE'
       ||!numeric(row.cursorBefore)||row.cursorAfter!==row.cursorBefore
       ||row.lastGoodPreserved!==true||row.scannedCards!==0
       ||row.retainedFromBatch!==0||row.requestedCount!==null
       ||row.startedCount!==null||row.completedCount!==null
       ||row.rosterVerified===true||!safeFailureAudit(row.publicStockSourceAudit)
       ||row.cursorRotatedBlockedOnly===true
       ||!metrics||metrics.sourceFailureConfirmed!==true
       ||metrics.fullMarketVerified!==false
       ||!numeric(metrics.started)||metrics.started<1
       ||metrics.completed!==0||!numeric(metrics.providerErrors)
       ||!numeric(metrics.timeouts)||!numeric(metrics.workerErrors)
       ||metrics.providerErrors+metrics.timeouts<1
       ||metrics.providerErrors+metrics.timeouts+metrics.workerErrors>metrics.started
       ||row.providerErrors!==metrics.providerErrors||row.timeouts!==metrics.timeouts)
       throw Error('KR_PUBLIC_PROVIDER_FAILURE_NOT_FAILCLOSED');
     lanes.push(Object.freeze({
       strategy:row.strategy,timeframe:row.timeframe,
       result:'PROVIDER_FAILED_CURSOR_HELD',requestedCount:null,
       insufficientCount:null,invalidSourceBars:null,
       sourceProviderErrors:metrics.providerErrors,
       sourceTimeouts:metrics.timeouts,
       // Audit counts are observational only and never compensate for a
       // provider failure or missing market source data.
       sourceHttp429Count:row.publicStockSourceAudit?.sanitizedProviderFailures?.HTTP_429??null,
       auditedInvalidSourceCalls:row.publicStockSourceAudit?.candles?.[row.timeframe]?.invalidOhlc??null,
       observationOnly:false,cursorHeld:true,
     }));
     continue;
   }
   const audit=row.publicStockSourceAudit;
   const quality=audit?.candles?.[row.timeframe];
   if(row.rosterVerified!==true||row.universePartial!==true
     ||row.universeStale===true||!numeric(row.totalUniverse)||row.totalUniverse===0
     ||row.publicCryptoCandleQuality!=null
     ||row.status==='CANDIDATES_AVAILABLE'||row.status==='VALID_NO_TRADE'
     ||!['BLOCKED_DATA','SEARCH_FAILURE'].includes(row.status)
     ||!numeric(row.requestedCount)||row.requestedCount===0
     ||row.startedCount!==row.requestedCount||row.completedCount!==row.requestedCount
     ||row.providerErrors!==0||row.universeProviderErrors!==0||row.timeouts!==0
     ||row.batchDeadlineExceeded===true||row.lastGoodPreserved!==true
     ||!numeric(row.retainedFromBatch)||row.retainedFromBatch!==0
     ||!numeric(row.scannedCards)||row.scannedCards!==0
     ||!numeric(row.cursorBefore)||!numeric(row.cursorAfter)
     ||!quality||!numeric(quality.fetched)
     ||!audit||audit.version!=='public-stock-source-audit-v1'
     ||audit.symbolsRedacted!==true||audit.fullMarketVerified!==false
     ||audit.executionAuthority!=='NONE'
     ||!numeric(audit.quote?.errors)||audit.quote.errors!==0
     ||Object.values(audit.sanitizedProviderFailures??{})
       .some(value=>!numeric(value)||value!==0))
     throw Error('KR_PUBLIC_SOURCE_EVIDENCE_NOT_FAILCLOSED');
   let classification;
   if(row.status==='SEARCH_FAILURE'){
     const incorrectCandles=numeric(row.insufficientDataCount)&&row.insufficientDataCount>0
       &&numeric(quality.invalidOhlc)&&numeric(quality.empty)
       &&numeric(quality.shortLt20)
       &&(quality.invalidOhlc>0||quality.empty>0||quality.shortLt20>0);
     if(!incorrectCandles||row.cursorAfter!==row.cursorBefore
       ||row.cursorRotatedBlockedOnly===true
       ||!['untrusted','partial'].includes(row.responseDataState))
       throw Error('KR_PUBLIC_INVALID_CANDLES_NOT_EXPLICITLY_HELD');
     classification='BAD_CANDLE_PAGE_HELD';
   }else{
     if(row.cursorRotatedBlockedOnly!==true
       ||row.cursorAfter===row.cursorBefore
       ||row.insufficientDataCount!==0)
       throw Error('KR_PUBLIC_OBSERVATION_ADVANCE_UNTRUSTED');
     classification='UNVERIFIED_ROSTER_OBSERVATION_ONLY';
   }
   lanes.push(Object.freeze({
     strategy:row.strategy,timeframe:row.timeframe,
     result:classification,requestedCount:row.requestedCount,
     insufficientCount:row.insufficientDataCount??0,
     invalidSourceBars:quality.invalidOhlc,
     observationOnly:row.status==='BLOCKED_DATA',
     cursorHeld:row.cursorAfter===row.cursorBefore,
   }));
 }
 return Object.freeze({
   schemaVersion:'kr-public-source-truth-gate-v1',
   verdict:'CODE_FAILCLOSED_WITH_MISSING_MARKET_DATA',
   releaseReady:false,krWholeUniverseVerified:false,
   providerErrorsAccepted:false,unverifiedCandidatesAllowed:false,
   tradingAuthority:'NONE',
   lanes:Object.freeze(lanes),
 });
}
