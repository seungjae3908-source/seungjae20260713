/** Research-only isolation of genuinely trusted Spot cards on a source
 * page globally BLOCKED_DATA because OTHER Spot cards are missing candles.
 * No page promotion, no new provider HTTP, no Telegram/event/economic credit.
 * The previously established current-page gate still blocks this whole lane.
 */
const SOURCE='upbit-public';
const STATUS='BLOCKED_DATA';
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const candleSource=card=>Array.isArray(card.dataSources)
 &&card.dataSources.includes('upbit-public-candles');
function empty(state){
 return Object.freeze({cards:Object.freeze([]),diagnostic:Object.freeze({
  schemaVersion:'v3-spot-blocked-page-research-only-v1',status:state,
  consideredCards:0,trustedCardsAvailable:0,
  researchOnlySelected:0,excludedCards:0,
  addedProviderCalls:0,cursorModified:false,
  wholePageAdmitted:false,telegramEligible:false,
  oosOrProfitabilityCredit:false,executionAuthority:'NONE',
  includesSymbols:false,
 })});
}
export function selectV3TrustedSpotResearchOnly(response,{
 status,cursor,nowMs=Date.now(),
}={}){
 if(status!==STATUS||!integer(cursor)||!integer(nowMs)||nowMs<=0)
  return empty('NOT_BLOCKED_SPOT_PAGE');
 const u=response?.universe,e=response?.execution,cards=response?.cards;
 if(response?.market!=='UPBIT_KRW'||response?.assetClass!=='coin_spot'
   ||response?.ok!==true||response?.dataState!=='untrusted'
   ||response?.orderSubmitted!==false||response?.exchangeRequestSent!==false
   ||u?.source!==SOURCE||u?.cursor!==cursor
   ||u?.partial!==false||u?.stale!==false
   ||!integer(u?.totalCount)||u.totalCount===0
   ||!e||!integer(e.requestedCount)||e.requestedCount===0
   ||e.requestedCount>5||e.startedCount!==e.requestedCount
   ||e.completedCount!==e.requestedCount
   ||e.providerErrorCount!==0||e.timeoutCount!==0
   ||e.partial!==false||e.timedOut!==false||e.cancelled!==false
   ||!Array.isArray(cards)||cards.length>e.requestedCount
   ||!Array.isArray(response.failures)||response.failures.length!==0)
  return empty('SOURCE_RECEIPT_UNTRUSTED');
 const eligible=[];
 for(const card of cards){
  if(!card||card.assetClass!=='coin_spot'||card.market!=='UPBIT_KRW'
    ||typeof card.symbol!=='string'||!card.symbol.trim()
    ||card.action!=='BUY'||card.direction!=='LONG'
    ||card.listingStatus!=='LISTED'
    ||card.dataState!=='complete'
    ||card.dataQuality?.state!=='TRUSTED'
    ||card.dataQuality?.strongSignalAllowed!==true
    ||!Array.isArray(card.dataQuality.issues)
    ||card.dataQuality.issues.length!==0
    ||!candleSource(card))continue;
  const asOf=Date.parse(card.observedAt??'');
  const expiry=Date.parse(card.expiresAt??'');
  if(!Number.isFinite(asOf)||asOf>nowMs+5000
    ||nowMs-asOf>180_000||!Number.isFinite(expiry)||expiry<=nowMs)
    continue;
  eligible.push(card);
 }
 const size=eligible.length;
 return Object.freeze({
  cards:Object.freeze(eligible),
  diagnostic:Object.freeze({
   schemaVersion:'v3-spot-blocked-page-research-only-v1',
   status:'RESEARCH_ONLY_PAGE_STILL_BLOCKED',
   consideredCards:cards.length,trustedCardsAvailable:size,
   researchOnlySelected:size,excludedCards:cards.length-size,
   addedProviderCalls:0,cursorModified:false,
   wholePageAdmitted:false,telegramEligible:false,
   oosOrProfitabilityCredit:false,executionAuthority:'NONE',
   includesSymbols:false,
  }),
 });
}
