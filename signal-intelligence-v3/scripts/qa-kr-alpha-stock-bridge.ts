// Bounded live-source canary through the actual read-only StockSignalScanner
// engine, NOT the released public-market scanner or a Paper/Live runner.
// Uses a single explicitly UNVERIFIED synthetic roster entry, never
// infers current listing, licenses, 24h uptime or market-wide eligibility.
import { StockSignalScannerService } from '../../api-server/src/services/stock-signal-scanner.service';
import { MarketDataService } from '../../api-server/src/services/market-data.service';
import { ScannerUniverseService } from '../../api-server/src/services/scanner-universe.service';
import { withReadOnlyStockProviderOverlay } from '../src/public-stock-provider-overlay.mjs';
import { createPublicKrAlphaHistoricalDailyFeed } from '../src/public-kr-alpha-historical-daily.mjs';

const code='0193W0';
const source=createPublicKrAlphaHistoricalDailyFeed({timeoutMs:3200});
const syntheticSource={
 entries:[{
   ticker:code,name:'QA alphanumeric ETF',market:'KR',currency:'KRW',
   assetType:'ETF',exchange:'ETF·ETN',listingStatus:'UNKNOWN',
   source:'krx-symbol-master',publicResearchProvisional:true,
 }],
 totalCount:1,rawTotalCount:1,explainedExcludedCount:0,
 explainedExclusions:[],source:'krx-symbol-master',
 partial:true,stale:false,providerErrorCount:0,
 loadedAt:new Date().toISOString(),
};
let body;
try{
  const result=await withReadOnlyStockProviderOverlay({
    marketData:MarketDataService,scannerUniverse:ScannerUniverseService,
    scannerMarket:'KR',targetUniverse:syntheticSource,
    readPublicCandles:async(ticker,timeframe,entry)=>{
      if(ticker!==code||entry?.publicResearchProvisional!==true||timeframe!=='1D')
        throw new Error('KR_ALPHA_PUBLIC_CANARY_UNSUPPORTED_TIMEFRAME');
      return {candles:await source.getCandles(ticker,timeframe),provider:'naver-public-dayCandle'};
    },
    readPublicQuote:async(ticker,entry)=>{
      if(ticker!==code||entry?.publicResearchProvisional!==true)
        throw new Error('KR_ALPHA_INDEX_QUOTE_UNAVAILABLE_CANARY');
      return source.getQuote(ticker);
    },
    operation:()=>StockSignalScannerService.scan({
      memberId:'signal-intelligence-v3-public-only',
      market:'KR',cursor:0,batchSize:10,
      indicators:[],filters:{timeframe:'1D'},
      strategyMode:'position',
    }),
  });
  const observations=result.execution;
  body={
    result:observations.completedCount===1&&observations.insufficientDataCount===0
      && observations.providerErrorCount===0 ?'PUBLIC_ALPHA_SCANNER_BARS_VALID'
      :'PUBLIC_ALPHA_SCANNER_DATA_BLOCKED',
    requestedCount:observations.requestedCount,
    completedCount:observations.completedCount,
    dataSuccessCount:observations.dataSuccessCount??null,
    insufficientDataCount:observations.insufficientDataCount??null,
    providerErrorCount:observations.providerErrorCount,
    timeoutCount:observations.timeoutCount,
    dataState:result.dataState,
    sourceRosterPartial:result.universe.partial,
    listedConstituentVerified:false,
    candidatePromotionAllowed:false,
    orderSubmitted:result.orderSubmitted,
    exchangeRequestSent:result.exchangeRequestSent,
  };
}catch(error){
  const raw=error instanceof Error?error.message:'UNKNOWN';
  body={
    result:'PUBLIC_ALPHA_SCANNER_DATA_BLOCKED',
    errorClass:raw.split(':')[0].slice(0,80),
    listedConstituentVerified:false,
    candidatePromotionAllowed:false,
    orderSubmitted:false,exchangeRequestSent:false,
  };
}
console.log(JSON.stringify({
  mode:'SINGLE_ALPHANUMERIC_PUBLIC_RESEARCH',
  publicOnly:true,executionAuthority:'NONE',
  shareablePriceData:false,licenseVerified:false,
  fullKrUniverseVerified:false,continuous24hVerified:false,
  paperSignalAdmitted:false,liveTradingAllowed:false,
  evidence:body,
},null,2));
