/** V3-only deterministic quality diagnostics for cards ALREADY returned by
 * the public Crypto Scanner, BEFORE ranking/hard filtering. Never collect
 * ticker identities, OHLCV, provider responses, free-text messages or keys.
 * No extra network calls; cannot affect scanner candidate admission.
 */
const ISSUE_CODES=Object.freeze([
 'STALE_TIMESTAMP','MISSING_CANDLE','DUPLICATE_CANDLE',
 'INVALID_OHLC','INVALID_VOLUME','ABNORMAL_SPIKE',
 'SYMBOL_MISMATCH','PROVIDER_DISAGREEMENT',
 'MARKET_CLOSED','TRADING_HALT',
]);
const QUALITY_STATES=Object.freeze(['TRUSTED','DEGRADED','DATA_UNTRUSTED','MISSING']);
const DATA_STATES=Object.freeze(['complete','partial','untrusted','unknown']);
const hasOwn=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
const count=x=>Number.isSafeInteger(x)&&x>=0;
function zero(keys){return Object.fromEntries(keys.map(k=>[k,0]));}
export function summarizeV3RawCryptoQuality(response,{rankedCards=0}={}){
  const cards=response?.cards;
  if(!Array.isArray(cards)||cards.length>100||!count(rankedCards)
    ||rankedCards>cards.length)
    throw Error('V3_CRYPTO_QUALITY_RECEIPT_INVALID');
  const states=zero(QUALITY_STATES),dataStates=zero(DATA_STATES),issues=zero(
    ISSUE_CODES.flatMap(k=>[k+':blocking',k+':warning']));
  let invalidQualityReceipts=0,completeWithUntrustedQuality=0;
  for(const card of cards){
    if(!card||typeof card!=='object')throw Error('V3_CRYPTO_QUALITY_CARD_INVALID');
    const dataState=DATA_STATES.includes(card.dataState)?card.dataState:'unknown';
    dataStates[dataState]+=1;
    const quality=card.dataQuality;
    if(!quality){states.MISSING+=1;invalidQualityReceipts+=1;continue;}
    if(!QUALITY_STATES.includes(quality.state)
      ||quality.state==='MISSING'||!Array.isArray(quality.issues)
      ||quality.issues.length>50){
      invalidQualityReceipts+=1;
      continue;
    }
    states[quality.state]+=1;
    if(dataState==='complete'&&quality.state==='DATA_UNTRUSTED')
      completeWithUntrustedQuality+=1;
    for(const issue of quality.issues){
      const key=issue?.code+':'+issue?.severity;
      if(!hasOwn(issues,key)){invalidQualityReceipts+=1;continue;}
      issues[key]+=1;
    }
  }
  const blocking=Object.fromEntries(Object.entries(issues)
    .filter(([,v])=>v>0));
  return Object.freeze({
    schemaVersion:'public-v3-raw-crypto-quality-v1',
    observedPreRankingCards:cards.length,
    displayedAfterRankingCards:rankedCards,
    removedByRankingOrDirection:cards.length-rankedCards,
    qualityStates:Object.freeze(states),
    dataStates:Object.freeze(dataStates),
    qualityIssues:Object.freeze(blocking),
    invalidQualityReceipts,completeWithUntrustedQuality,
    sourceFailuresCount:count(response?.failures?.length)?response.failures.length:null,
    scannedCount:count(response?.execution?.requestedCount)
      ?response.execution.requestedCount:null,
    extraProviderRequests:0,signalAuthority:'NONE',
    fullMarketCoverageProven:false,profitabilityProven:false,
    includedTickerIdentifiers:false,includedOHLC:false,
  });
}
