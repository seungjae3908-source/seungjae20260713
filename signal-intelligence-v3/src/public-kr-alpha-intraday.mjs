// Publicly readable KR alphanumeric ETF one-session MINUTE bars.
// The Naver periodType=day chart returns timestamps at 1m resolution, NOT a
// multi-day daily OHLCV series. This is public-source research only.
// No broker/private/order calls, no entitlement to redistribute provider data.
import {krAlphaDailyCode} from './public-kr-alpha-daily.mjs';
const MINUTE=60000;
const KST_OFFSET=9*3600000;
const OPEN_MIN=9*60,CLOSE_MIN=15*60+30;
const nums=(value)=>{
 if(typeof value==='number')return Number.isFinite(value)?value:null;
 if(typeof value!=='string')return null;
 if(!/^[0-9]+(?:\.[0-9]+)?$|^[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?$/u.test(value))return null;
 const n=Number(value.replace(/,/gu,''));return Number.isFinite(n)?n:null;
};
function parseMinute(raw){
 const m=/^([0-9]{4})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})$/u.exec(String(raw??''));
 if(!m)return null;
 const [year,month,day,hour,minute,second]=m.slice(1).map(Number);
 const check=new Date(Date.UTC(year,month-1,day));
 if(check.getUTCFullYear()!==year||check.getUTCMonth()!==month-1||check.getUTCDate()!==day
  ||hour>23||minute>59||second!==0)return null;
 const slot=hour*60+minute;
 if(slot<OPEN_MIN||slot>CLOSE_MIN)return null;
 return {at:Date.UTC(year,month-1,day,hour-9,minute),slot,
   session:year+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0')};
}
export function parsePublicKrAlphaOneSession(payload,requestedCode,now=Date.now()){
 const code=krAlphaDailyCode(requestedCode);
 if(!payload||typeof payload!=='object'||Array.isArray(payload)
  || (payload.code!=null&&String(payload.code).trim().toUpperCase()!==code))
  throw Error('KR_ALPHA_MINUTE_SOURCE_IDENTITY_INVALID');
 if(!Array.isArray(payload.priceInfos)||payload.priceInfos.length<390
  ||payload.priceInfos.length>1000)
  throw Error('KR_ALPHA_MINUTE_SOURCE_INCOMPLETE');
 if(!Number.isFinite(now)||now<=0)throw Error('KR_ALPHA_MINUTE_CLOCK_INVALID');
 const bySlot=new Map();
 for(const raw of payload.priceInfos){
  const ts=parseMinute(raw?.localDateTime);
  if(!ts)throw Error('KR_ALPHA_MINUTE_TIMESTAMP_INVALID');
  if(ts.at>now)throw Error('KR_ALPHA_MINUTE_FUTURE_BAR');
  const o=nums(raw.openPrice),h=nums(raw.highPrice),
        l=nums(raw.lowPrice),c=nums(raw.currentPrice),
        cum=nums(raw.accumulatedTradingVolume);
  if(o===null||h===null||l===null||c===null||cum===null
   ||o<=0||l<=0||c<=0||h<Math.max(o,c,l)||l>Math.min(o,c,h)||cum<0)
    throw Error('KR_ALPHA_MINUTE_OHLCV_INVALID');
  const key=ts.at,bar={...ts,open:o,high:h,low:l,close:c,cumulativeVolume:cum};
  if(bySlot.has(key)){
   const old=bySlot.get(key);
   if(!['open','high','low','close','cumulativeVolume'].every(k=>old[k]===bar[k]))
    throw Error('KR_ALPHA_MINUTE_CONFLICTING_BAR');
   continue;
  }
  bySlot.set(key,bar);
 }
 const ordered=[...bySlot.values()].sort((a,b)=>a.at-b.at);
 if(new Set(ordered.map(x=>x.session)).size!==1)
  throw Error('KR_ALPHA_MINUTE_MULTIPLE_SESSIONS');
 // For daily start/end integrity, require a continuous 09:00..15:29 run
 // and optional 15:30 closing snapshot. Missing early/later bars cannot
 // certify a daily range or be filled with synthetic zeros.
 if(ordered.length<390||ordered[0].slot!==OPEN_MIN)
  throw Error('KR_ALPHA_MINUTE_OPEN_MISSING');
 const minutes=ordered.filter(b=>b.slot<CLOSE_MIN);
 if(minutes.length!==390)throw Error('KR_ALPHA_MINUTE_INCOMPLETE_SESSION');
 let cumulative=0;
 const sourceMinutes=[];
 for(let i=0;i<minutes.length;i++){
  const bar=minutes[i],expectedAt=minutes[0].at+i*MINUTE;
  if(bar.at!==expectedAt)throw Error('KR_ALPHA_MINUTE_GAP');
  if(bar.cumulativeVolume<cumulative)
   throw Error('KR_ALPHA_MINUTE_CUMULATIVE_VOLUME_NONMONOTONIC');
  const volume=bar.cumulativeVolume-cumulative;
  cumulative=bar.cumulativeVolume;
  sourceMinutes.push({time:new Date(bar.at).toISOString(),
   open:bar.open,high:bar.high,low:bar.low,close:bar.close,volume});
 }
 if(ordered.length===391){
  const closing=ordered.at(-1);
  if(closing.slot!==CLOSE_MIN || closing.cumulativeVolume!==cumulative)
   throw Error('KR_ALPHA_MINUTE_CLOSING_VOLUME_UNVERIFIED');
 }
 const five=[];
 for(let i=0;i<sourceMinutes.length;i+=5){
  const group=sourceMinutes.slice(i,i+5);
  if(group.length!==5)throw Error('KR_ALPHA_FIVE_MINUTE_INCOMPLETE');
  five.push({
   time:group[0].time,
   open:group[0].open,high:Math.max(...group.map(x=>x.high)),
   low:Math.min(...group.map(x=>x.low)),close:group.at(-1).close,
   volume:group.reduce((sum,x)=>sum+x.volume,0),
  });
 }
 return Object.freeze({
  requestedCode:code,firstSession:minutes[0].session,
  oneMinute:Object.freeze(sourceMinutes.map(x=>Object.freeze(x))),
  fiveMinute:Object.freeze(five.map(x=>Object.freeze(x))),
  sourceCloseMarkerPresent:ordered.length===391,
  sourceSessionContinuityVerified:true,
  sourceConstituentCoverageVerified:false,licensedDistribution:false,
  sourceOnly:true,executionAuthority:'NONE',
 });
}
export function createPublicKrAlphaOneSessionFeed({
 fetchImpl=(...args)=>globalThis.fetch(...args),now=Date.now,timeoutMs=6500
}={}){
 if(typeof fetchImpl!=='function'||typeof now!=='function'||!Number.isInteger(timeoutMs)
  ||timeoutMs<500||timeoutMs>12000)throw Error('KR_ALPHA_MINUTE_FEED_OPTIONS_INVALID');
 const gate={nextAt:0,tail:Promise.resolve()};
 async function read(code){
  const identifier=krAlphaDailyCode(code);
  const wait=gate.tail;
  let unlock;gate.tail=new Promise(resolve=>{unlock=resolve;});
  await wait;
  try{
   const ms=Math.max(0,gate.nextAt-now());
   if(ms>0)await new Promise(resolve=>setTimeout(resolve,ms));
   gate.nextAt=now()+300;
  }finally{unlock();}
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const response=await fetchImpl(
     'https://stock.naver.com/api/securityService/chart/domestic/item/'+identifier+'?periodType=day',
     {signal:controller.signal,headers:{Accept:'application/json'}});
   if(!response?.ok)throw Error('KR_ALPHA_MINUTE_HTTP_'+String(response?.status??'UNKNOWN'));
   if(!String(response.headers?.get?.('content-type')??'').toLowerCase().includes('json'))
    throw Error('KR_ALPHA_MINUTE_NONJSON');
   return parsePublicKrAlphaOneSession(await response.json(),identifier,now());
  }finally{clearTimeout(timer);}
 }
 return Object.freeze({
  getOneSession:read,
  async getCandles(code,timeframe){
   if(!['1m','5m'].includes(timeframe))throw Error('KR_ALPHA_MINUTE_TIMEFRAME_UNSUPPORTED');
   const result=await read(code);
   return timeframe==='1m'?result.oneMinute:result.fiveMinute;
  },
  executionAuthority:'NONE',licensedDistribution:false,fullMarketReady:false,
 });
}
