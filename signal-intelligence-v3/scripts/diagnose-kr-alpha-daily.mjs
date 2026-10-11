// Standalone read-only canary: single public KR alphanumeric ETF.
import {createPublicKrAlphaDailyFeed} from '../src/public-kr-alpha-daily.mjs';
const feed=createPublicKrAlphaDailyFeed();
let outcome;
try {
 const candles=await feed.getCandles('0193W0','1D');
 const quote=await feed.getQuote('0193W0');
 outcome={result:'SAMPLE_DAILY_SUPPORTED',dailyBars:candles.length,
   quoteProvenance:quote.provenance,
   latestClosedSessionTimestamp:quote.updatedAt};
}catch(error){
 outcome={result:'BLOCKED_SAMPLE_DATA',reason:error instanceof Error?error.message.split(':')[0]:'UNKNOWN'};
}
console.log(JSON.stringify({publicOnly:true,executionAuthority:'NONE',
  wholeKrMarketProven:false,intradayAlphanumericSupported:false,
  licensedMarketRedistribution:false,alphanumericDailyCanary:outcome},null,2));
