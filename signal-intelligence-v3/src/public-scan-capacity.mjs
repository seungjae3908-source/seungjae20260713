// Conservative four-market public scanning capacity *arithmetic*, not an
// actual vendor quota, throughput measurement, licensed feed or QA PASS.
export function evaluatePublicScanCapacity({markets,horizonMinutes,providerRequestsPerSecond}={}){
 const supported=['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES'];
 if(!markets||typeof markets!=='object'||!Number.isFinite(horizonMinutes)
   ||horizonMinutes<1||horizonMinutes>1440)throw Error('PUBLIC_SCAN_CAPACITY_INPUT_INVALID');
 const detail=[];
 for(const market of supported){
   const target=markets[market];
   if(!target||!Number.isSafeInteger(target.symbols)||target.symbols<0
     ||!Number.isSafeInteger(target.minRequestsPerSymbol)||target.minRequestsPerSymbol<1
     ||target.minRequestsPerSymbol>10)
     throw Error('PUBLIC_SCAN_CAPACITY_MARKET_INVALID');
   const requests=target.symbols*target.minRequestsPerSymbol;
   const perSecond=requests/(horizonMinutes*60);
   const observedQuota=providerRequestsPerSecond?.[market]??null;
   const quotaKnown=Number.isFinite(observedQuota)&&observedQuota>0;
   detail.push(Object.freeze({
     market,symbolCount:target.symbols,requestFloor:requests,
     minimumRequestsPerSecond:Number(perSecond.toFixed(3)),
     quotaKnown,
     rateOnlyFeasible:quotaKnown?observedQuota>=perSecond:null,
     // Even a rate-possible feed may lack constituent identity, correct
     // OHLC sessions, license, account safety and truthful OOS evidence.
     fullMarketLowLatencyVerified:false,
   }));
 }
 const anyUnknown=detail.some(x=>!x.quotaKnown);
 const insufficient=detail.some(x=>x.rateOnlyFeasible===false);
 return Object.freeze({
   requestedRoundTripHorizonMinutes:horizonMinutes,
   detail:Object.freeze(detail),
   bottleneck:insufficient?'PROVIDER_RATE_INSUFFICIENT':anyUnknown?'PROVIDER_QUOTA_UNKNOWN':'RATE_ONLY_POSSIBLE_NOT_CERTIFIED',
   fullMarketGuaranteed:false,liveTradingAllowed:false,
   actual24hVerified:false,executionAuthority:'NONE',
 });
}
