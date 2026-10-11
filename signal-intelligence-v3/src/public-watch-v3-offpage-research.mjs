/** Isolated optional out-of-cursor public data REVIEW, not an alert.
 * Max 1 Spot + 1 Futures symbol per V3 cycle, and only from the verified
 * same-cycle Stage-1 watch receipts. Does not mutate original 12 lane cursors,
 * pending signal rows, Telegram events, orders or economic evidence.
 */
const MARKET=new Set(['CRYPTO_SPOT','CRYPTO_FUTURES']);
const SYMBOL=/^[A-Z0-9][A-Z0-9._-]{0,31}$/u;
const SHA256=/^[a-f0-9]{64}$/u;
const safe=x=>Number.isSafeInteger(x)&&x>=0;
export const V3_OFFPAGE_RESEARCH_MAX=Object.freeze({
  total:2,perMarket:1,maxObservedPublicHttpCallsPerSymbol:20,
});
function output(status,values={}){
  return Object.freeze({
    schemaVersion:'public-v3-stage-two-offpage-review-v1',
    status,selectedForReview:0,reviewedFromCurrentRoster:0,
    trustedPublicData:0,watchSideAgreed:0,
    dataBlocked:0,sourceError:0,staleWatchEvidenceSkipped:0,
    publicRequestCountUnmeasured:0,
    observedPublicHttpRequests:0,
    publicRequestCountProven:true,
    skippedCursorSymbols:0,
    changedScannerUniverseCursor:false,
    candidateEventsCreated:0,telegramMessagesSent:0,
    costOosPassProven:false,paperCredit:0,
    executionAuthority:'NONE',...values,
  });
}
function wellFormed(reviews){
  if(!Array.isArray(reviews)||reviews.length>V3_OFFPAGE_RESEARCH_MAX.total)
    return false;
  const seen=new Set();
  for(const row of reviews){
    if(!row||!MARKET.has(row.market)||seen.has(row.market)
      ||!SYMBOL.test(row.symbol??'')||!SHA256.test(row.watchEventId??'')
      ||row.status!=='RESEARCH_ONLY'||row.executionAuthority!=='NONE'
      ||!Number.isSafeInteger(row.sourceAtMs)||row.sourceAtMs<=0
      ||(row.market==='CRYPTO_SPOT'&&row.direction!=='UP')
      ||(row.market==='CRYPTO_FUTURES'&&!['UP','DOWN'].includes(row.direction)))
      return false;
    seen.add(row.market);
  }
  return true;
}
function trusted(review,resp){
  const market=review.market==='CRYPTO_SPOT'?'UPBIT_KRW':'BITGET_USDT_FUTURES';
  const source=review.market==='CRYPTO_SPOT'?'upbit-public':'bitget-public';
  const x=resp?.execution,u=resp?.universe;
  if(resp?.ok!==true||resp?.market!==market
    ||resp?.orderSubmitted!==false||resp?.exchangeRequestSent!==false
    ||resp?.dataState!=='complete'
    ||!x||!u||x.requestedCount!==1||x.startedCount!==1
    ||x.completedCount!==1||x.providerErrorCount!==0||x.timeoutCount!==0
    ||x.partial!==false||x.timedOut!==false||x.cancelled!==false
    ||u.partial!==false||u.stale!==false||u.source!==source||!safe(u.totalCount)
    ||u.totalCount===0||!Array.isArray(resp.cards)||resp.cards.length!==1
    ||!Array.isArray(resp.failures)||resp.failures.length!==0)
    return null;
  const card=resp.cards[0];
  if(card?.symbol!==review.symbol)return null;
  if(!card||card.dataState!=='complete'
    ||card.dataQuality?.state!=='TRUSTED'
    ||card.dataQuality?.strongSignalAllowed!==true
    ||card.exchangeRequestSent===true||card.orderSubmitted===true)
    return null;
  const expected=review.direction==='DOWN'?'SHORT':'LONG';
  return Object.freeze({matches:card.direction===expected});
}
export async function runV3OutOfCursorResearch(
  reviews,{enabled=false,scanOne,nowMs=Date.now()}={},
){
  if(enabled!==true)return output('DISABLED');
  if(!wellFormed(reviews)||typeof scanOne!=='function'
    ||!Number.isSafeInteger(nowMs)||nowMs<=0)
    return output('REJECTED_UNSAFE_REVIEW_INPUT');
  let reviewed=0,good=0,agree=0,blocked=0,errors=0,requests=0,stale=0,unmeasured=0;
  for(const row of reviews){
    // A fresh event at the start of a long 12-lane V3 cycle can expire.
    // Never consume an old 'hot' symbol as a live Stage-2 research priority.
    if(row.sourceAtMs>nowMs+5_000||nowMs-row.sourceAtMs>180_000){
      stale+=1;continue;
    }
    let receipt;
    try{receipt=await scanOne(row);}catch{
      // A thrown callback may have already sent public HTTP requests.
      // Never present a guessed zero as an audited exact request count.
      errors+=1;unmeasured+=1;continue;
    }
    // The caller owns HTTP routing/counter instrumentation. A failure to
    // measure resource use cannot silently become a clean Stage-2 audit.
    if(!safe(receipt?.httpRequests)||receipt.httpRequests===0
      ||receipt.httpRequests>V3_OFFPAGE_RESEARCH_MAX.maxObservedPublicHttpCallsPerSymbol
      ||receipt.requestCountMeasured!==true){
      errors+=1;unmeasured+=1;continue;
    }
    requests+=receipt.httpRequests;
    if(receipt?.scannerFailed===true||!receipt.response){
      errors+=1;continue;
    }
    reviewed+=1;
    const check=trusted(row,receipt.response);
    if(!check){blocked+=1;continue;}
    good+=1;
    if(check.matches)agree+=1;
  }
  return output(reviews.length===0?'NO_OUT_OF_CURSOR_WATCH_CANDIDATE'
    :errors||blocked||stale?'RESEARCH_SOURCE_PARTIAL':'RESEARCH_DATA_OBSERVED',{
    selectedForReview:reviews.length,reviewedFromCurrentRoster:reviewed,
    trustedPublicData:good,watchSideAgreed:agree,
    dataBlocked:blocked,sourceError:errors,
    staleWatchEvidenceSkipped:stale,
    // Unknown calls are null, not invented zero; the completion counters
    // remain a conservative research-only fail-closed report.
    observedPublicHttpRequests:unmeasured===0?requests:null,
    publicRequestCountProven:unmeasured===0,
    publicRequestCountUnmeasured:unmeasured,
  });
}
