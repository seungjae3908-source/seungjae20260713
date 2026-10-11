// Strict PUBLIC-ONLY Korean ETF/ETN historical 1D feed, independent of
// one-session intraday "periodType=day". No private broker/order APIs,
// feed licensing or full-universe coverage claims. Not wired to LIVE/Paper.
import {krAlphaDailyCode} from './public-kr-alpha-daily.mjs';
const BASE='https://api.stock.naver.com/chart/domestic/item/';
const MS_DAY=86400000;
function positive(v){
 const n=typeof v==='number'?v:typeof v==='string'
  &&/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]+)?$/u.test(v)
  ?Number(v.replace(/,/gu,'')):NaN;
 return Number.isFinite(n)?n:null;
}
function closedTradingDate(input){
 const day=typeof input==='number' && Number.isSafeInteger(input)
   ? String(input) : input;
 if(typeof day!=='string'||!/^[0-9]{8}$/u.test(day))return null;
 const y=Number(day.slice(0,4)),m=Number(day.slice(4,6)),d=Number(day.slice(6,8));
 const at=Date.UTC(y,m-1,d);
 const check=new Date(at);
 if(check.getUTCFullYear()!==y||check.getUTCMonth()!==m-1||check.getUTCDate()!==d)return null;
 // Completed 15:30 KST session, not today's incomplete open candle.
 return at+6*3600000+30*60000;
}
export function normalizePublicKrAlphaHistoricalDaily(payload,code,nowMs=Date.now()){
 const id=krAlphaDailyCode(code);
 if(!payload||typeof payload!=='object'||Array.isArray(payload)
   ||(payload.code!=null&&String(payload.code).toUpperCase()!==id)
   ||(payload.itemCode!=null&&String(payload.itemCode).toUpperCase()!==id))
   throw Error('KR_ALPHA_DAY_CANDLE_IDENTITY_INVALID');
 if(!Array.isArray(payload.priceInfos)||payload.priceInfos.length<40
    ||payload.priceInfos.length>1500)
   throw Error('KR_ALPHA_DAY_CANDLE_SOURCE_INSUFFICIENT');
 if(!Number.isFinite(nowMs)||nowMs<=0)throw Error('KR_ALPHA_DAY_CANDLE_CLOCK_INVALID');
 const rows=new Map();
 for(const bar of payload.priceInfos){
  const at=closedTradingDate(bar?.localDate);
  if(at===null||at>nowMs||nowMs-at>6*365*MS_DAY)continue;
  if(bar.itemCode!=null&&String(bar.itemCode).toUpperCase()!==id)
   throw Error('KR_ALPHA_DAY_CANDLE_ROW_IDENTITY_MISMATCH');
  const open=positive(bar.openPrice),high=positive(bar.highPrice),
    low=positive(bar.lowPrice),close=positive(bar.closePrice),
    volume=positive(bar.accumulatedTradingVolume);
  if([open,high,low,close,volume].some(x=>x===null)||open<=0||low<=0||close<=0
    ||high<Math.max(open,low,close)||low>Math.min(open,high,close)||volume<0)
    throw Error('KR_ALPHA_DAY_CANDLE_INVALID_OHLCV');
  const normalized={time:new Date(at).toISOString(),open,high,low,close,volume};
  if(rows.has(at)){
   const past=rows.get(at);
   if(!['open','high','low','close','volume'].every(k=>past[k]===normalized[k]))
    throw Error('KR_ALPHA_DAY_CANDLE_CONFLICTING_DAY');
   continue;
  }
  rows.set(at,normalized);
 }
 if(rows.size<40)throw Error('KR_ALPHA_DAY_CANDLE_VERIFIED_HISTORY_SHORT');
 const candles=[...rows.entries()].sort((a,b)=>a[0]-b[0]).map(([,v])=>Object.freeze(v));
 if(candles.at(-1).time===undefined)throw Error('KR_ALPHA_DAY_CANDLE_NO_DATE');
 return Object.freeze({
  symbol:id,timeframe:'1D',candles:Object.freeze(candles),
  barCount:candles.length,priceSource:'naver-public-historical-dayCandle',
  closedDailyOnly:true,verifiedSourceDays:true,fullMarketProven:false,
  liveQuoteProven:false,licensingVerified:false,executionAuthority:'NONE',
 });
}
export function createPublicKrAlphaHistoricalDailyFeed({
 fetchImpl=(...args)=>globalThis.fetch(...args),now=Date.now,
 timeoutMs=6000,minStartMs=300,
}={}){
 if(typeof fetchImpl!=='function'||typeof now!=='function'
   ||!Number.isInteger(timeoutMs)||timeoutMs<500||timeoutMs>10000
   ||!Number.isInteger(minStartMs)||minStartMs<200||minStartMs>10000)
   throw Error('KR_ALPHA_DAY_CANDLE_SOURCE_OPTIONS_INVALID');
 let nextAt=0,tail=Promise.resolve();
 const cache=new Map();
 async function read(value){
  const code=krAlphaDailyCode(value),t=now();
  const prev=cache.get(code);
  if(prev?.until>t)return prev.promise;
  const task=(async()=>{
    let unlock;
    const previous=tail;tail=new Promise(resolve=>{unlock=resolve;});
    await previous;
    try{
      const pause=Math.max(0,nextAt-now());
      if(pause>0)await new Promise(resolve=>setTimeout(resolve,pause));
      nextAt=now()+minStartMs;
    }finally{unlock();}
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(new Error('KR_ALPHA_DAY_CANDLE_TIMEOUT')),timeoutMs);
    try{
      const url=BASE+code+'?periodType=dayCandle';
      const response=await fetchImpl(url,{signal:controller.signal,headers:{Accept:'application/json'}});
      if(!response?.ok)throw Error('KR_ALPHA_DAY_CANDLE_HTTP_'+String(response?.status??'INVALID'));
      if(!String(response.headers?.get?.('content-type')??'').toLowerCase().includes('json'))
       throw Error('KR_ALPHA_DAY_CANDLE_NONJSON');
      return normalizePublicKrAlphaHistoricalDaily(await response.json(),code,now());
    }finally{clearTimeout(timer);}
  })();
  cache.set(code,{until:t+60000,promise:task});
  try{return await task;}catch(e){cache.delete(code);throw e;}
 }
 return Object.freeze({
  read,
  async getCandles(value,timeframe){
   if(timeframe!=='1D')throw Error('KR_ALPHA_DAY_CANDLE_UNSUPPORTED_TIMEFRAME');
   return (await read(value)).candles;
  },
  executionAuthority:'NONE',licensedForDistribution:false,fullMarketReady:false,
 });
}
