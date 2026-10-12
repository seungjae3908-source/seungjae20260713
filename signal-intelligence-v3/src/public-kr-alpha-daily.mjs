// Signal V3 public-only Korean alphanumeric ETF/ETN DAILY evidence.
// No member/private broker API. No market-wide validation, redistribution
// authority or intraday bars are asserted from a public page sample.
const HOST='https://stock.naver.com';
const ALPHA=/^(?=[0-9A-Z]{6}$)(?=.*[A-Z])[0-9A-Z]{6}$/u;
const MS_DAY=86400000;
export function krAlphaDailyCode(value){
 if(typeof value!=='string'||value!==value.trim())throw Error('KR_ALPHA_CODE_UNSAFE');
 const s=value.toUpperCase();
 if(!ALPHA.test(s)||!/^[0-9A-Z]{6}$/u.test(value))throw Error('KR_ALPHA_CODE_UNSAFE');
 return s;
}
function number(value){
 if(typeof value==='number')return Number.isFinite(value)?value:null;
 if(typeof value!=='string')return null;
 const raw=value.trim();
 if(!/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]+)?$/u.test(raw))return null;
 const v=Number(raw.replace(/,/gu,''));return Number.isFinite(v)?v:null;
}
function parseSeoulDay(value){
 if(typeof value!=='number'&&typeof value!=='string')return null;
 const raw=String(value).trim();
 let m;
 if((m=/^([0-9]{4})[-./]?([0-9]{2})[-./]?([0-9]{2})(?:[ T]?([0-9]{2}):?([0-9]{2})(?::?([0-9]{2}))?)?$/u.exec(raw))){
   const y=+m[1],mo=+m[2],d=+m[3];
   const nominal=new Date(Date.UTC(y,mo-1,d));
   if(nominal.getUTCFullYear()!==y||nominal.getUTCMonth()!==mo-1||nominal.getUTCDate()!==d)return null;
   const h=m[4]===undefined?15:+m[4],min=m[4]===undefined?30:+m[5],sec=m[6]===undefined?0:+m[6];
   if(h>23||min>59||sec>59)return null;
   const at=Date.UTC(y,mo-1,d,h-9,min,sec);
   // Date-only or provider-midnight daily markers represent the regular
   // close; never treat an unfinished current-day bar as settled evidence.
   const closeAt=Date.UTC(y,mo-1,d,15-9,30,0);
   return {at:Math.max(at,closeAt),closeAt};
 }
 if(/^\d{4}-\d{2}-\d{2}T/u.test(raw)&&/[Zz]|[+-][0-9]{2}:[0-9]{2}$/u.test(raw)){
   const at=Date.parse(raw);return Number.isFinite(at)?{at,closeAt:at}:null;
 }
 return null;
}
export function inspectPublicKrAlphaDailyShape(payload){
 const items=Array.isArray(payload?.priceInfos)?payload.priceInfos:[];
 const days=new Map();
 let parseable=0,malformed=0,identical=0,conflicting=0,distinctTimes=0;
 const minuteModes=new Map();
 for(const row of items){
   const raw=String(row?.localDateTime??'').trim();
   const parsed=parseSeoulDay(raw);
   if(!parsed){malformed++;continue;}
   parseable++;
   const day=raw.slice(0,8),time=/^[0-9]{14}$/u.test(raw)?raw.slice(8):'UNSPECIFIED';
   minuteModes.set(time,(minuteModes.get(time)??0)+1);
   const values=['openPrice','highPrice','lowPrice','currentPrice','accumulatedTradingVolume'].map(k=>number(row?.[k]));
   const key=JSON.stringify(values);
   if(!days.has(day)){days.set(day,{times:new Set([time]),values:new Set([key]),rows:1});continue;}
   const existing=days.get(day);
   if(!existing.times.has(time))distinctTimes++;
   if(existing.values.has(key))identical++;else conflicting++;
   existing.times.add(time);existing.values.add(key);existing.rows++;
 }
 return Object.freeze({
   rawRows:items.length,parseableRows:parseable,unparseableRows:malformed,
   distinctDays:days.size,repeatedDays:[...days.values()].filter(x=>x.rows>1).length,
   byteEquivalentRepeatedRows:identical,conflictingRepeatedRows:conflicting,
   differentTimesWithinDay:distinctTimes,
   maxRowsPerDay:Math.max(0,...[...days.values()].map(x=>x.rows)),
   timeOfDayBuckets:Object.freeze([...minuteModes.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8)
     .map(([time,count])=>({time,count}))),
   rawPricesRedacted:true,fullMarketSupported:false,
 });
}

export function normalizePublicKrAlphaDaily(payload,requestedCode,nowMs=Date.now()){
 const code=krAlphaDailyCode(requestedCode);
 if(!payload||typeof payload!=='object'||Array.isArray(payload)
   || (payload.code!=null&&String(payload.code).trim().toUpperCase()!==code))
   throw Error('KR_ALPHA_DAILY_IDENTITY_MISMATCH');
 if(!Array.isArray(payload.priceInfos)||payload.priceInfos.length<1||payload.priceInfos.length>2000)
   throw Error('KR_ALPHA_DAILY_ROWS_INVALID');
 if(!Number.isFinite(nowMs)||nowMs<=0)throw Error('KR_ALPHA_DAILY_CLOCK_INVALID');
 const byTimestamp=new Map();
 for(const row of payload.priceInfos){
   const date=parseSeoulDay(row?.localDateTime);
   if(!date||date.at>nowMs||nowMs-date.at>5*365*MS_DAY)continue;
   const o=number(row.openPrice),h=number(row.highPrice),
     l=number(row.lowPrice),c=number(row.currentPrice),v=number(row.accumulatedTradingVolume);
   if(o===null||h===null||l===null||c===null||v===null||o<=0||c<=0||l<=0
     ||h<Math.max(o,c,l)||l>Math.min(o,c,h)||v<0)continue;
   const bar={time:new Date(date.at).toISOString(),open:o,high:h,low:l,close:c,volume:v};
   if(byTimestamp.has(date.at)){
     const before=byTimestamp.get(date.at);
     // Some public chart payloads duplicate the same day/timestamp. A truly
     // byte-equivalent OHLCV is safe to deduplicate, not an extra market bar.
     if(['open','high','low','close','volume'].every(k=>before[k]===bar[k]))
       continue;
     throw Error('KR_ALPHA_DAILY_CONFLICTING_BAR');
   }
   byTimestamp.set(date.at,bar);
 }
 const candles=[...byTimestamp.entries()].sort(([a],[b])=>a-b).map(([,bar])=>bar);
 if(candles.length<30)throw Error('KR_ALPHA_DAILY_INSUFFICIENT_VALID_ROWS');
 return candles;
}
export function publicKrAlphaDailyQuote(code,candles){
 const symbol=krAlphaDailyCode(code);
 if(!Array.isArray(candles)||candles.length<2)throw Error('KR_ALPHA_QUOTE_BARS_MISSING');
 const latest=candles.at(-1),previous=candles.at(-2);
 if(!Number.isFinite(latest?.close)||!Number.isFinite(previous?.close)||latest.close<=0||previous.close<=0
  ||!Number.isFinite(Date.parse(latest.time)))throw Error('KR_ALPHA_QUOTE_UNTRUSTED');
 const change=latest.close-previous.close;
 return Object.freeze({
   symbol,ticker:symbol,price:latest.close,currentPrice:latest.close,
   regularMarketPrice:latest.close,close:latest.close,previousClose:previous.close,
   prevClose:previous.close,change,changeAmount:change,
   changePercent:change/previous.close*100,
   regularMarketChangePercent:change/previous.close*100,
   volume:latest.volume,tradingValue:latest.volume*latest.close,
   open:latest.open,high:latest.high,low:latest.low,
   updatedAt:latest.time,
   provenance:'naver-public-last-closed-session',
 });
}
export function createPublicKrAlphaDailyFeed({
 fetchImpl=(...args)=>globalThis.fetch(...args),
 now=Date.now,
 timeoutMs=5000,
 minStartMs=300,
}={}){
 if(typeof fetchImpl!=='function'||typeof now!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<500||timeoutMs>10000
  ||!Number.isInteger(minStartMs)||minStartMs<200||minStartMs>5000)
  throw Error('KR_ALPHA_DAILY_PROVIDER_OPTIONS_INVALID');
 const cache=new Map(),CACHE_MS=60000;
 let lastIntegrity=null;
 let tail=Promise.resolve(),nextAt=0;
 async function fetchOne(code){
   // Shared bounded public start pacing prevents untrusted mass endpoint load.
   let unlock;
   const previous=tail;tail=new Promise(resolve=>{unlock=resolve;});
   await previous;
   try{
     const pause=Math.max(0,nextAt-now());
     if(pause>0)await new Promise(resolve=>setTimeout(resolve,pause));
     nextAt=now()+minStartMs;
   }finally{unlock();}
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
   try{
     const url=HOST+'/api/securityService/chart/domestic/item/'+code+'?periodType=day';
     const response=await fetchImpl(url,{signal:controller.signal,headers:{Accept:'application/json'}});
     if(!response?.ok)throw Error('KR_ALPHA_DAILY_HTTP_'+String(response?.status??'INVALID'));
     if(!String(response.headers?.get?.('content-type')??'').toLowerCase().includes('json'))
       throw Error('KR_ALPHA_DAILY_NONJSON');
     const data=await response.json();
     lastIntegrity=inspectPublicKrAlphaDailyShape(data);
     return normalizePublicKrAlphaDaily(data,code,now());
   }finally{clearTimeout(timer);}
 }
 async function candles(value,timeframe='1D'){
   const code=krAlphaDailyCode(value);
   if(timeframe!=='1D')throw Error('KR_ALPHA_DAILY_UNSUPPORTED_INTRADAY');
   const current=cache.get(code);
   if(current&&current.until>now())return current.value;
   const promise=fetchOne(code);
   cache.set(code,{until:now()+CACHE_MS,value:promise});
   try{return await promise;}catch(e){cache.delete(code);throw e;}
 }
 return Object.freeze({
   getCandles:candles,
   async getQuote(value){
     const code=krAlphaDailyCode(value);
     return publicKrAlphaDailyQuote(code,await candles(code,'1D'));
   },
   clear:()=>{cache.clear();lastIntegrity=null;},
   readLastIntegrity:()=>lastIntegrity,
   // No broker credentials, authentication, redistribution or LIVE support.
   executionAuthority:'NONE',
   permittedTimeframes:Object.freeze(['1D']),
 });
}
