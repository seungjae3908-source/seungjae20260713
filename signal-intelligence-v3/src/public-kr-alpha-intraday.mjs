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
 if(slot<OPEN_MIN||slot>20*60)return null;
 return {at:Date.UTC(year,month-1,day,hour-9,minute),slot,
   session:year+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0')};
}
export function inspectPublicKrAlphaSessionShape(payload){
 const rows=Array.isArray(payload?.priceInfos)?payload.priceInfos:[];
 const classes={invalidLength:0,invalidDate:0,invalidClock:0,nonzeroSeconds:0,outsideSession:0,validMinute:0};
 const sessions=new Set(),slots=new Set();
 let earliest=null,latest=null,outsideBeforeOpen=0,outsideAfterClose=0;
 for(const row of rows){
  const raw=String(row?.localDateTime??'');
  const match=/^([0-9]{4})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})$/u.exec(raw);
  if(!match){classes.invalidLength++;continue;}
  const [year,month,day,hour,minute,second]=match.slice(1).map(Number);
  const check=new Date(Date.UTC(year,month-1,day));
  if(check.getUTCFullYear()!==year||check.getUTCMonth()!==month-1||check.getUTCDate()!==day){classes.invalidDate++;continue;}
  if(hour>23||minute>59){classes.invalidClock++;continue;}
  if(second!==0){classes.nonzeroSeconds++;continue;}
  const slot=hour*60+minute;
  if(slot<OPEN_MIN||slot>CLOSE_MIN){
   classes.outsideSession++;
   if(slot<OPEN_MIN)outsideBeforeOpen++;else outsideAfterClose++;
   continue;
  }
  classes.validMinute++;sessions.add(raw.slice(0,8));slots.add(slot);
  earliest=earliest===null?slot:Math.min(earliest,slot);
  latest=latest===null?slot:Math.max(latest,slot);
 }
 let missing=0,continuousMissing=0,auctionMissing=0;
 for(let i=OPEN_MIN;i<CLOSE_MIN;i++)if(!slots.has(i)){
   missing++;
   if(i<15*60+20)continuousMissing++;
   else auctionMissing++;
 }
 const toClock=n=>n===null?null:String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
 return Object.freeze({
  totalRows:rows.length,classifications:Object.freeze({...classes}),
  distinctSourceSessions:sessions.size,uniqueMinuteSlots:slots.size,
  firstClock:toClock(earliest),lastClock:toClock(latest),
  missingRegularMinutes:missing,
  missingContinuousTradingMinutes:continuousMissing,
  missingClosingAuctionMinutes:auctionMissing,
  outsideBeforeOpen,outsideAfterClose,
  closingAt1530Present:slots.has(CLOSE_MIN),
  sourcePricesRedacted:true,fullMarketSupported:false,executionAuthority:'NONE',
 });
}

export function parsePublicKrAlphaOneSession(payload,requestedCode,now=Date.now()){
 const code=krAlphaDailyCode(requestedCode);
 if(!payload||typeof payload!=='object'||Array.isArray(payload)
  ||(payload.code!=null&&String(payload.code).trim().toUpperCase()!==code))
  throw Error('KR_ALPHA_MINUTE_SOURCE_IDENTITY_INVALID');
 if(!Array.isArray(payload.priceInfos)||payload.priceInfos.length<381
  ||payload.priceInfos.length>1000)throw Error('KR_ALPHA_MINUTE_SOURCE_INCOMPLETE');
 if(!Number.isFinite(now)||now<=0)throw Error('KR_ALPHA_MINUTE_CLOCK_INVALID');
 const shape=inspectPublicKrAlphaSessionShape(payload);
 if(Object.entries(shape.classifications).some(([key,value])=>
  ['invalidLength','invalidDate','invalidClock','nonzeroSeconds'].includes(key)&&value>0)
  ||shape.outsideBeforeOpen>0 ||shape.missingContinuousTradingMinutes!==0
  ||shape.closingAt1530Present!==true)
  throw Error('KR_ALPHA_MINUTE_INCOMPLETE_CONTINUOUS_SESSION');
 const bySlot=new Map();
 let excludedAfterClose=0,excludedAuction=0;
 for(const raw of payload.priceInfos){
  const ts=parseMinute(raw?.localDateTime);
  if(!ts)throw Error('KR_ALPHA_MINUTE_TIMESTAMP_INVALID');
  if(ts.at>now)throw Error('KR_ALPHA_MINUTE_FUTURE_BAR');
  if(ts.slot>CLOSE_MIN){excludedAfterClose++;continue;}
  // 15:20..15:29 is the KRX closing call auction, not an uninterrupted
  // series of regular continuous executions. Do not synthesize 10 bars.
  if(ts.slot>=15*60+20 && ts.slot<CLOSE_MIN){excludedAuction++;continue;}
  const o=nums(raw.openPrice),h=nums(raw.highPrice),
   l=nums(raw.lowPrice),c=nums(raw.currentPrice),
   cum=nums(raw.accumulatedTradingVolume);
  if(o===null||h===null||l===null||c===null||cum===null
   ||o<=0||l<=0||c<=0||h<Math.max(o,c,l)||l>Math.min(o,c,h)||cum<0)
   throw Error('KR_ALPHA_MINUTE_OHLCV_INVALID');
  const bar={...ts,open:o,high:h,low:l,close:c,cumulativeVolume:cum};
  if(bySlot.has(ts.at)){
   const before=bySlot.get(ts.at);
   if(!['open','high','low','close','cumulativeVolume'].every(k=>before[k]===bar[k]))
    throw Error('KR_ALPHA_MINUTE_CONFLICTING_BAR');
   continue;
  }
  bySlot.set(ts.at,bar);
 }
 const ordered=[...bySlot.values()].sort((a,b)=>a.at-b.at);
 if(new Set(ordered.map(x=>x.session)).size!==1)
  throw Error('KR_ALPHA_MINUTE_MULTIPLE_SESSIONS');
 const continuous=ordered.filter(x=>x.slot<15*60+20);
 const closing=ordered.find(x=>x.slot===CLOSE_MIN);
 if(continuous.length!==380||!closing||continuous[0].slot!==OPEN_MIN)
  throw Error('KR_ALPHA_MINUTE_INCOMPLETE_CONTINUOUS_SESSION');
 let cumulative=0;
 const oneMinute=[];
 for(let i=0;i<continuous.length;i++){
  const bar=continuous[i];
  if(bar.at!==continuous[0].at+i*MINUTE)
   throw Error('KR_ALPHA_MINUTE_GAP');
  if(bar.cumulativeVolume<cumulative)
   throw Error('KR_ALPHA_MINUTE_CUMULATIVE_VOLUME_NONMONOTONIC');
  const volume=bar.cumulativeVolume-cumulative;
  cumulative=bar.cumulativeVolume;
  oneMinute.push({time:new Date(bar.at).toISOString(),
   open:bar.open,high:bar.high,low:bar.low,close:bar.close,volume});
 }
 if(closing.cumulativeVolume<cumulative)
  throw Error('KR_ALPHA_MINUTE_CLOSING_VOLUME_UNVERIFIED');
 const fiveMinute=[];
 for(let i=0;i<oneMinute.length;i+=5){
  const bucket=oneMinute.slice(i,i+5);
  if(bucket.length!==5)throw Error('KR_ALPHA_FIVE_MINUTE_INCOMPLETE');
  fiveMinute.push({time:bucket[0].time,open:bucket[0].open,
   high:Math.max(...bucket.map(x=>x.high)),
   low:Math.min(...bucket.map(x=>x.low)),close:bucket.at(-1).close,
   volume:bucket.reduce((sum,x)=>sum+x.volume,0)});
 }
 return Object.freeze({
  requestedCode:code,firstSession:continuous[0].session,
  oneMinute:Object.freeze(oneMinute.map(x=>Object.freeze(x))),
  fiveMinute:Object.freeze(fiveMinute.map(x=>Object.freeze(x))),
  sourceCloseMarkerPresent:true,
  sourceSessionContinuityVerified:true,
  continuousTradingMinutes:380,fullyObservedFiveMinuteBuckets:76,
  excludedClosingAuctionMinutes:excludedAuction,
  closingAuctionMinutesAbsent:shape.missingClosingAuctionMinutes,
  excludedAfterCloseRows:excludedAfterClose,
  closeAuctionVolumeNonnegative:true,
  // Closing-auction prices are not injected into 1m/5m indicators.
  closingAuctionNotUsedForIntradaySignals:true,
  full390MinuteContinuousTrading:false,
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
 let lastShape=null;
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
   const payload=await response.json();
   lastShape=inspectPublicKrAlphaSessionShape(payload);
   return parsePublicKrAlphaOneSession(payload,identifier,now());
  }finally{clearTimeout(timer);}
 }
 return Object.freeze({
  getOneSession:read,
  readLastShape:()=>lastShape,
  async getCandles(code,timeframe){
   if(!['1m','5m'].includes(timeframe))throw Error('KR_ALPHA_MINUTE_TIMEFRAME_UNSUPPORTED');
   const result=await read(code);
   return timeframe==='1m'?result.oneMinute:result.fiveMinute;
  },
  executionAuthority:'NONE',licensedDistribution:false,fullMarketReady:false,
 });
}
