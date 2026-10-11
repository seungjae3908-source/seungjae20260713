// Single public-source canary. Only counts and source labels are recorded;
// do not publish raw market bars or claim entitlement/coverage/APPROVAL.
import {createPublicKrAlphaHistoricalDailyFeed} from '../src/public-kr-alpha-historical-daily.mjs';
const source=createPublicKrAlphaHistoricalDailyFeed();
let outcome={status:'BLOCKED_UNVERIFIED'};
try {
 const series=await source.read('0193W0');
 outcome={
   status:series.barCount>=40?'HISTORICAL_DAILY_SAMPLE_VERIFIED':'BLOCKED_HISTORY_SHORT',
   candles:series.barCount,
   oldestBarTime:series.candles[0]?.time??null,
   lastCompletedBarTime:series.candles.at(-1)?.time??null,
   verifiedSourceDays:series.verifiedSourceDays,
   priceSource:series.priceSource,
 };
}catch(err) {
 const raw=err instanceof Error?err.message:'SOURCE_UNKNOWN';
 outcome={status:'BLOCKED_UNVERIFIED',errorClass:raw.split(':')[0].slice(0,80)};
}
console.log(JSON.stringify({
 source:'naver-public-dayCandle',sampleCodeType:'KR_ALPHANUMERIC_ETF',
 executionAuthority:'NONE',privateApi:false,
 rawBarsPublished:false,fullMarketVerified:false,
 licensedForDistribution:false,actualContinuous24hVerified:false,
 outcome,
},null,2));
