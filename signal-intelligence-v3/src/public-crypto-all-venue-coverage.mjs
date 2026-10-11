// READ-ONLY discovery of all currently documented Upbit quote markets and
// Bitget futures product types. A single market/ticker REST observation is not
// a 1m archive, a trade signal, license, account entitlement or future feed.
// This is independent of member/Paper/LIVE Scanner market/quote assumptions.
import {createHash} from 'node:crypto';

export const PUBLIC_CRYPTO_ALL_VENUE_SCHEMA='public-crypto-all-venue-coverage-v1';
export const UPBIT_QUOTE_MARKETS=Object.freeze(['KRW','BTC','USDT']);
export const BITGET_FUTURES_TYPES=Object.freeze(['USDT-FUTURES','COIN-FUTURES','USDC-FUTURES']);
const MAX_ROWS=20000;
const PART=/^(KRW|BTC|USDT)-[A-Z0-9]{1,30}$/u;
const CONTRACT=/^[A-Z0-9][A-Z0-9_]{1,45}$/u;
const numeric=v=>typeof v==='number'&&Number.isFinite(v)
  ?v:(typeof v==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(v)?Number(v):NaN);
const goodId=v=>typeof v==='string'&&v.trim()===v&&CONTRACT.test(v);
const digest=values=>createHash('sha256').update(JSON.stringify(values)).digest('hex');
const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const sourceOnly=Object.freeze({
  publicReadOnly:true,sourcePricesRedacted:true,rawSymbolListPublished:false,
  publicRedistributionLicensed:false,allExchangeVenuesCertified:false,
  historicalOneMinuteVerified:false,pointInTimeUniverseVerified:false,
  wholeVenueTradingSignalReady:false,memberSignalPromotionAllowed:false,
  paperOrderAuthority:false,realOrderAuthority:false,executionAuthority:'NONE',
});
function rows(value){
 return Array.isArray(value)&&value.length<=MAX_ROWS?value:null;
}
function keys(input,keyFor){
 const list=rows(input);
 if(!list)return null;
 const result=new Map();
 let invalid=0,duplicates=0;
 for(const row of list){
   const id=keyFor(row);
   if(id===null){invalid++;continue;}
   if(result.has(id)){duplicates++;continue;}
   result.set(id,row);
 }
 return {result,invalid,duplicates};
}
function observation(roster,tickers,{timeKey,priceKey,maxAgeMs,nowMs,activeKey}){
 if(roster===null||tickers===null)return Object.freeze({
   status:'SOURCE_UNAVAILABLE',rosterCount:null,tickerCount:null,matchedTickerCount:null,
   missingTickerCount:null,unexpectedTickerCount:null,invalidIdentityCount:null,
   duplicateIdentityCount:null,invalidPriceCount:null,missingTimestampCount:null,
   futureTimestampCount:null,staleLastTradeCount:null,nonNormalContractCount:null,
   fingerprintSha256:null,observedRosterTickerParity:false,
 });
 const r=keys(roster,activeKey==='status'?x=>goodId(x?.symbol)?x.symbol:null
   :x=>typeof x?.market==='string'&&PART.test(x.market)?x.market:null);
 const t=keys(tickers,activeKey==='status'?x=>goodId(x?.symbol)?x.symbol:null
   :x=>typeof x?.market==='string'&&PART.test(x.market)?x.market:null);
 if(!r||!t)return observation(null,null,{timeKey,priceKey,maxAgeMs,nowMs,activeKey});
 let matched=0,missing=0,invalidPrice=0,missingTimestamp=0,futureTimestamp=0,stale=0,nonNormal=0;
 for(const [id,record] of r.result){
   if(activeKey==='status'&&record.symbolStatus!=='normal')nonNormal++;
   if(!t.result.has(id)){missing++;continue;}
   matched++;
   const tick=t.result.get(id),price=numeric(tick?.[priceKey]);
   if(!Number.isFinite(price)||price<=0)invalidPrice++;
   const ts=numeric(tick?.[timeKey]);
   if(!Number.isSafeInteger(ts)||ts<=0)missingTimestamp++;
   else if(ts>nowMs+300000)futureTimestamp++;
   else if(nowMs-ts>maxAgeMs)stale++;
 }
 let unexpected=0;
 for(const id of t.result.keys())if(!r.result.has(id))unexpected++;
 const invalid=r.invalid+t.invalid,duplicate=r.duplicates+t.duplicates;
 const parity=r.result.size>0&&invalid===0&&duplicate===0&&missing===0&&unexpected===0;
 let status;
 if(!r.result.size)status='EMPTY_ROSTER_NOT_CERTIFIED';
 else if(invalid||duplicate||missing||unexpected)status='BLOCKED_ROSTER_TICKER_MISMATCH';
 else if(invalidPrice||missingTimestamp||futureTimestamp||stale)
   status='BLOCKED_PRICE_OR_LAST_TRADE_AGE';
 else status='OBSERVED_ROSTER_TICKER_PARITY_ONLY';
 return Object.freeze({
   status,rosterCount:r.result.size,tickerCount:t.result.size,
   matchedTickerCount:matched,missingTickerCount:missing,unexpectedTickerCount:unexpected,
   invalidIdentityCount:invalid,duplicateIdentityCount:duplicate,
   invalidPriceCount:invalidPrice,missingTimestampCount:missingTimestamp,
   futureTimestampCount:futureTimestamp,staleLastTradeCount:stale,
   nonNormalContractCount:nonNormal,
   fingerprintSha256:digest([...r.result.keys()].sort()),
   observedRosterTickerParity:parity,
 });
}
function extractBitget(payload){
 return obj(payload)&&String(payload.code)==='00000'&&rows(payload.data)
   ?payload.data:null;
}
export function inspectPublicCryptoAllVenueSnapshots({
 upbitPairs=null,upbitTickers=null,bitgetByProduct={},nowMs=Date.now(),
 sourceOutcomes={},
}={}){
 if(!Number.isSafeInteger(nowMs)||nowMs<=0)throw Error('PUBLIC_ALL_VENUES_CLOCK_INVALID');
 const input=rows(upbitPairs);
 const buckets=Object.fromEntries(UPBIT_QUOTE_MARKETS.map(q=>[q,[]]));
 let invalidOrOtherQuotePairCount=null;
 if(input){
   invalidOrOtherQuotePairCount=0;
   for(const pair of input){
     const id=pair?.market;
     if(typeof id!=='string'||!PART.test(id)){invalidOrOtherQuotePairCount++;continue;}
     buckets[id.split('-')[0]].push(pair);
   }
 }
 const upbit=Object.freeze(Object.fromEntries(UPBIT_QUOTE_MARKETS.map(quote=>{
   const roster=input?buckets[quote]:null;
   const tickerRows=rows(upbitTickers);
   const relevant=tickerRows?tickerRows.filter(x=>x?.market?.startsWith(quote+'-')):null;
   const observed=observation(roster,relevant,{
     timeKey:'trade_timestamp',priceKey:'trade_price',maxAgeMs:10*60000,nowMs,
     activeKey:'market',
   });
   return [quote,observed];
 })));
 const bitget=Object.freeze(Object.fromEntries(BITGET_FUTURES_TYPES.map(type=>{
   const pair=bitgetByProduct?.[type];
   return [type,observation(extractBitget(pair?.contracts),
     extractBitget(pair?.tickers),{
       timeKey:'ts',priceKey:'lastPr',maxAgeMs:3*60000,nowMs,activeKey:'status',
     })];
 })));
 const missingMarketSet=input===null||invalidOrOtherQuotePairCount>0
   ||Object.values(upbit).some(x=>x.status!=='OBSERVED_ROSTER_TICKER_PARITY_ONLY')
   ||Object.values(bitget).some(x=>x.status!=='OBSERVED_ROSTER_TICKER_PARITY_ONLY'
     ||x.nonNormalContractCount>0);
 const statuses=Object.fromEntries(
   Object.entries(sourceOutcomes??{}).filter(([key,val])=>
      /^[A-Z0-9_]{2,35}$/u.test(key)&&
      ['OK','HTTP_429','HTTP_418','HTTP_403','HTTP_OTHER','TIMEOUT','NONJSON',
       'BAD_SHAPE','NETWORK_ERROR'].includes(val)));
 return Object.freeze({
   schemaVersion:PUBLIC_CRYPTO_ALL_VENUE_SCHEMA,
   observedAt:new Date(nowMs).toISOString(),
   upbit:Object.freeze({
     quoteGroups:upbit,rosterRowsObserved:input?.length??null,
     invalidOrOtherQuotePairCount,
     // A pair can appear in more than one quote market, so preserve
     // quote/base identity. A KRW base-asset count cannot cover BTC/USDT.
     identity:'FULL_QUOTE_BASE_PAIR',
   }),
   bitget:Object.freeze({productTypes:bitget,identity:'PRODUCT_TYPE_PLUS_CONTRACT'}),
   providerSourceOutcomes:Object.freeze(statuses),
   anySourceDataBlocked:missingMarketSet,
   ...sourceOnly,
 });
}
const TARGETS=Object.freeze([
 {key:'UPBIT_ROSTER',url:'https://api.upbit.com/v1/market/all?is_details=true'},
 {key:'UPBIT_ALL_TICKERS',url:'https://api.upbit.com/v1/ticker/all?quote_currencies=KRW,BTC,USDT'},
 ...BITGET_FUTURES_TYPES.flatMap(type=>[
  {key:'BITGET_'+type.replace('-','_')+'_CONTRACTS',
   url:'https://api.bitget.com/api/v2/mix/market/contracts?productType='+type},
  {key:'BITGET_'+type.replace('-','_')+'_TICKERS',
   url:'https://api.bitget.com/api/v2/mix/market/tickers?productType='+type},
 ]),
]);
function safeError(status){
 if(status===429)return 'HTTP_429';
 if(status===418)return 'HTTP_418';
 if(status===403)return 'HTTP_403';
 return 'HTTP_OTHER';
}
export async function probePublicCryptoAllVenues({
 fetchImpl=(...args)=>fetch(...args),now=Date.now,
 wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
 timeoutMs=7000,spacingMs=350,
}={}){
 if(typeof fetchImpl!=='function'||typeof now!=='function'
   ||typeof wait!=='function'||!Number.isInteger(timeoutMs)
   ||timeoutMs<500||timeoutMs>15000||!Number.isInteger(spacingMs)
   ||spacingMs<250||spacingMs>5000)
   throw Error('PUBLIC_ALL_VENUES_OPTIONS_INVALID');
 const output={},outcomes={};
 for(let i=0;i<TARGETS.length;i++){
   const target=TARGETS[i];
   if(i>0)await wait(spacingMs);
   const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeoutMs);
   try{
     // Only eight pre-approved hardcoded GETs, no user-chosen routes.
     const response=await fetchImpl(target.url,{
       signal:ctrl.signal,headers:{Accept:'application/json'},
     });
     if(!response||typeof response.status!=='number')
       throw Error('BAD_SHAPE');
     if(!response.ok){outcomes[target.key]=safeError(response.status);continue;}
     if(!String(response.headers?.get?.('content-type')??'')
       .toLowerCase().includes('json')){outcomes[target.key]='NONJSON';continue;}
     const length=Number(response.headers?.get?.('content-length')??0);
     if(Number.isFinite(length)&&length>8000000){outcomes[target.key]='BAD_SHAPE';continue;}
     const body=await response.text();
     if(body.length>8000000){outcomes[target.key]='BAD_SHAPE';continue;}
     const parsed=JSON.parse(body);
     output[target.key]=parsed;
     outcomes[target.key]='OK';
   }catch(error){
     outcomes[target.key]=ctrl.signal.aborted?'TIMEOUT':
       error instanceof SyntaxError?'NONJSON':
       error instanceof Error&&error.message==='BAD_SHAPE'?'BAD_SHAPE':'NETWORK_ERROR';
   }finally{clearTimeout(timer);}
 }
 const bitgetByProduct=Object.fromEntries(BITGET_FUTURES_TYPES.map(type=>{
   const id='BITGET_'+type.replace('-','_');
   return [type,{contracts:output[id+'_CONTRACTS'],tickers:output[id+'_TICKERS']}];
 }));
 return inspectPublicCryptoAllVenueSnapshots({
   upbitPairs:output.UPBIT_ROSTER,upbitTickers:output.UPBIT_ALL_TICKERS,
   bitgetByProduct,nowMs:now(),sourceOutcomes:outcomes,
 });
}
