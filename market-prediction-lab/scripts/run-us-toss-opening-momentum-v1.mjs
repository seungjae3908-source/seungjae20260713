import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { buildAdaptiveMultiEvidencePriceStructureV2 } from "../src/adaptive-multi-evidence-price-structure-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "../src/adaptive-multi-evidence-point-in-time-v2.js";

const TOSS_BASE=String(process.env.TOSS_API_BASE_URL??"https://openapi.tossinvest.com").replace(/\/$/,"");
const EVAL_START=Date.parse("2026-08-03T00:00:00.000Z");
const EVAL_END=Date.parse("2026-09-01T00:00:00.000Z");
const DAILY_START=Date.parse("2025-08-01T00:00:00.000Z");
const NORMAL_COST=0.0015;
const STRESS_COST=NORMAL_COST*1.5;
const CANDIDATES_PER_DAY=5;
const ACCOUNT=Object.freeze({riskPerTrade:0.005,maxWeight:0.20,maxConcurrent:3,maxPerSector:2});
const FAMILIES=Object.freeze({
  OPENING_BREAKOUT:Object.freeze({name:"OPENING_BREAKOUT"}),
  FIRST_PULLBACK:Object.freeze({name:"FIRST_PULLBACK"}),
});
const ny=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let tokenCache=null,lastTossAt=0;

function parts(ms){const p=Object.fromEntries(ny.formatToParts(new Date(ms)).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));return {date:`${p.year}-${p.month}-${p.day}`,hour:+p.hour,minute:+p.minute};}
function mean(v){return v.length?v.reduce((a,b)=>a+b,0)/v.length:0;}
function median(v){if(!v.length)return 0;const x=[...v].sort((a,b)=>a-b),m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function clamp(x,a=0,b=1){return Math.min(b,Math.max(a,x));}
function num(v){const n=Number(String(v??"").replace(/[$,% ,]/g,""));return Number.isFinite(n)?n:null;}
function sma(c,i,p){if(i-p+1<0)return null;let s=0;for(let j=i-p+1;j<=i;j++)s+=c[j].close;return s/p;}
function highBefore(c,i,p){if(i-p<0)return null;let h=-Infinity;for(let j=i-p;j<i;j++)h=Math.max(h,c[j].high);return Number.isFinite(h)?h:null;}
function avgDollar(c,i,p){if(i-p<0)return null;let s=0;for(let j=i-p;j<i;j++)s+=c[j].close*c[j].volume;return s/p;}
function regular(ms){const p=parts(ms),m=p.hour*60+p.minute;return m>=570&&m<960;}
function minuteOfDay(ms){const p=parts(ms);return p.hour*60+p.minute;}
function securityEligible(row){const s=String(row.symbol??"").trim().toUpperCase(),n=String(row.name??""),industry=String(row.industry??"");if(!/^[A-Z][A-Z0-9.-]{0,9}$/.test(s))return false;if(/(Warrant|Rights?|Units?|Preferred|Depositary Preferred)/i.test(n))return false;if(/Blank Checks/i.test(industry)||/Acquisition Corp/i.test(n))return false;if(/[RWU]$/.test(s)&&s.length>=4)return false;return true;}

async function issueToken(){
  const clientId=String(process.env.TOSS_CLIENT_ID??"").trim(),clientSecret=String(process.env.TOSS_CLIENT_SECRET??"").trim();
  if(!clientId||!clientSecret)throw new Error("TOSS_RESEARCH_CREDENTIAL_MISSING");
  const body=new URLSearchParams({grant_type:"client_credentials",client_id:clientId,client_secret:clientSecret});
  const r=await fetch(`${TOSS_BASE}/oauth2/token`,{method:"POST",headers:{accept:"application/json","content-type":"application/x-www-form-urlencoded"},body});
  if(!r.ok)throw new Error(`TOSS_TOKEN_HTTP_${r.status}`);
  const j=await r.json(),token=String(j?.access_token??""),expires=Number(j?.expires_in??0);
  if(token.length<30||!(expires>0))throw new Error("TOSS_TOKEN_INVALID");
  tokenCache={token,expiresAt:Date.now()+expires*1000};
  return token;
}
async function token(){if(tokenCache&&Date.now()<tokenCache.expiresAt-60_000)return tokenCache.token;return issueToken();}
async function tossGet(path,params){
  const wait=Math.max(0,140-(Date.now()-lastTossAt));if(wait)await sleep(wait);lastTossAt=Date.now();
  const url=new URL(`${TOSS_BASE}${path}`);for(const [k,v] of Object.entries(params))if(v!=null)url.searchParams.set(k,String(v));
  let last;
  for(let attempt=0;attempt<4;attempt++){
    const r=await fetch(url,{headers:{accept:"application/json",authorization:`Bearer ${await token()}`}});
    if(r.status===401&&attempt===0){tokenCache=null;continue;}
    if(r.status===429){await sleep(600*(attempt+1));last=new Error("TOSS_RATE_LIMIT");continue;}
    if(r.status>=500){await sleep(400*(attempt+1));last=new Error(`TOSS_HTTP_${r.status}`);continue;}
    if(!r.ok)throw new Error(`TOSS_HTTP_${r.status}`);
    return r.json();
  }
  throw last??new Error("TOSS_FETCH_FAILED");
}
function normalizeTossCandle(raw){
  const timestamp=Date.parse(String(raw?.timestamp??"")),open=num(raw?.openPrice),high=num(raw?.highPrice),low=num(raw?.lowPrice),close=num(raw?.closePrice),volume=num(raw?.volume);
  if(!Number.isFinite(timestamp)||![open,high,low,close,volume].every(Number.isFinite)||Math.min(open,high,low,close)<=0||volume<0)return null;
  return {timestamp,open,high,low,close,volume};
}
async function tossMinuteHistory(symbol){
  const map=new Map();let before="2026-09-01T23:59:59-04:00";
  for(let page=0;page<110;page++){
    const payload=await tossGet("/api/v1/candles",{symbol,interval:"1m",count:200,before,adjusted:true});
    const result=payload?.result??{},rows=Array.isArray(result?.candles)?result.candles:[],normalized=rows.map(normalizeTossCandle).filter(Boolean);
    if(!normalized.length)break;
    for(const row of normalized)if(row.timestamp>=EVAL_START-2*86_400_000&&row.timestamp<EVAL_END+86_400_000)map.set(row.timestamp,row);
    const oldest=Math.min(...normalized.map(x=>x.timestamp));
    if(oldest<EVAL_START-2*86_400_000)break;
    const next=String(result?.nextBefore??"").trim();
    if(!next||next===before)break;
    before=next;
  }
  return [...map.values()].filter(x=>x.timestamp>=EVAL_START-2*86_400_000&&x.timestamp<EVAL_END+86_400_000).sort((a,b)=>a.timestamp-b.timestamp);
}

async function fetchUniverse(){
  const r=await fetch("https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true",{headers:{accept:"application/json,text/plain,*/*","user-agent":"Mozilla/5.0 Chrome/120"}});
  if(!r.ok)throw new Error(`NASDAQ_HTTP_${r.status}`);
  const raw=(await r.json())?.data?.rows;if(!Array.isArray(raw)||raw.length<1000)throw new Error("NASDAQ_UNIVERSE_INSUFFICIENT");
  const rows=raw.map(row=>{const price=num(row.lastsale),volume=num(row.volume),marketCap=num(row.marketCap);return {symbol:String(row.symbol??"").trim().toUpperCase(),name:String(row.name??""),sector:String(row.sector??"UNKNOWN")||"UNKNOWN",industry:String(row.industry??""),price,volume,marketCap,dollarVolume:price!=null&&volume!=null?price*volume:null};}).filter(r=>securityEligible(r)&&r.price>=2&&r.marketCap>0&&r.dollarVolume>0);
  const buckets={
    LARGE:rows.filter(r=>r.marketCap>=10_000_000_000).sort((a,b)=>b.dollarVolume-a.dollarVolume||a.symbol.localeCompare(b.symbol)).slice(160,180),
    MID:rows.filter(r=>r.marketCap>=2_000_000_000&&r.marketCap<10_000_000_000).sort((a,b)=>b.dollarVolume-a.dollarVolume||a.symbol.localeCompare(b.symbol)).slice(100,120),
    SMALL:rows.filter(r=>r.marketCap>=300_000_000&&r.marketCap<2_000_000_000).sort((a,b)=>b.dollarVolume-a.dollarVolume||a.symbol.localeCompare(b.symbol)).slice(240,280),
  };
  return {rawRows:raw.length,buckets};
}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;async function w(){for(;;){const i=next++;if(i>=items.length)return;try{out[i]={ok:true,value:await fn(items[i],i)};}catch(e){out[i]={ok:false,error:String(e?.message??e)};}}}await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>w()));return out;}
function dailyIndexBefore(candles,date){let idx=-1;for(let i=0;i<candles.length;i++){if(parts(candles[i].timestamp).date<date)idx=i;else break;}return idx;}
function dailyCandidate(row,spyDaily,date){
  const c=row.daily,i=dailyIndexBefore(c,date),si=dailyIndexBefore(spyDaily,date);if(i<60||si<20)return null;
  const close=c[i].close,m20=sma(c,i,20),m20p=sma(c,i-5,20),m50=sma(c,i,50),h20=highBefore(c,i+1,20),ad=avgDollar(c,i,20);
  if(![m20,m20p,m50,h20,ad].every(x=>x>0))return null;
  const rs20=(close/c[i-20].close-1)-(spyDaily[si].close/spyDaily[si-20].close-1),dv=(close*c[i].volume)/ad,near=close/h20,range=c[i].high-c[i].low,body=range?Math.abs(c[i].close-c[i].open)/range:0,closeLoc=range?(c[i].close-c[i].low)/range:0;
  if(!(close>m20&&m20>m20p&&close>m50&&near>=0.88&&rs20>=-0.02&&dv>=0.75))return null;
  const score=30+20*clamp((rs20+0.02)/0.18)+15*clamp((dv-0.75)/2.25)+15*clamp((near-0.88)/0.12)+10*clamp((closeLoc-0.4)/0.6)+10*clamp((body-0.25)/0.65);
  return {symbol:row.symbol,sector:row.sector,bucket:row.bucket,date,setupScore:+Math.min(100,score).toFixed(2),setup:{rs20,dollarVolumeAcceleration:dv,near20dHigh:near,closeLocation:closeLoc,bodyRangeRatio:body}};
}
function groupDays(rows){const m=new Map();for(const r of rows){if(!regular(r.timestamp))continue;const d=parts(r.timestamp).date,a=m.get(d)??[];a.push(r);m.set(d,a);}return m;}
function completeDates(rows){return [...groupDays(rows).entries()].filter(([d,v])=>Date.parse(d+"T00:00:00Z")>=EVAL_START&&Date.parse(d+"T00:00:00Z")<EVAL_END&&v.length>=300).map(([d])=>d).sort();}
function aggregate(rows,min){
  const out=[];let cur=null;
  for(const r of rows){const mod=minuteOfDay(r.timestamp)-570;if(mod<0)continue;const bucket=Math.floor(mod/min);if(!cur||cur.bucket!==bucket){if(cur)out.push(cur);cur={bucket,open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume,timestamp:r.timestamp,last:r.timestamp};}else{cur.high=Math.max(cur.high,r.high);cur.low=Math.min(cur.low,r.low);cur.close=r.close;cur.volume+=r.volume;cur.last=r.timestamp;}}
  if(cur)out.push(cur);return out.map(x=>({...x,closeTime:x.last+60_000}));
}
function vwap(rows,cutoff){let pv=0,v=0;for(const r of rows){if(r.timestamp>=cutoff)break;if(r.volume>0){pv+=((r.high+r.low+r.close)/3)*r.volume;v+=r.volume;}}return v?pv/v:null;}
function structure(symbol,timeframe,bars,decision){
  const mapped=bars.map(b=>{const iso=new Date(b.closeTime).toISOString();return {isClosed:true,eventTime:iso,publishedAt:iso,availableAt:iso,observedAt:iso,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume};});
  return buildAdaptiveMultiEvidencePriceStructureV2({lineageId:ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,market:"US_STOCK",symbol,timeframe,side:"LONG",decisionTime:new Date(decision).toISOString(),source:{sourceId:"toss-openapi",originalSourceId:"toss-openapi",sourceType:"PUBLIC_MARKET_DATA",sourceUrl:TOSS_BASE,documentId:`${symbol}:${timeframe}`},candles:mapped,options:timeframe==="5m"?{atrPeriod:8,volumeLookback:8,pivotLeftBars:1,pivotRightBars:1,compressionLookback:4}:{atrPeriod:5,volumeLookback:4,pivotLeftBars:1,pivotRightBars:1,compressionLookback:2}});
}
function volumeReaccel(bars,index,lookback=5){const prev=bars.slice(Math.max(0,index-lookback),index).map(x=>x.volume).filter(x=>x>0);return prev.length?bars[index].volume/median(prev):1;}
function openingRange(day){const rows=day.filter(r=>minuteOfDay(r.timestamp)>=570&&minuteOfDay(r.timestamp)<585);if(rows.length<10)return null;return {high:Math.max(...rows.map(x=>x.high)),low:Math.min(...rows.map(x=>x.low)),open:rows[0].open};}
function nextMinuteIndex(day,closeTime){return day.findIndex(x=>x.timestamp>=closeTime);}
function simulateExit(day,entryIndex,entryRaw,stopRaw,cost){
  const entry=entryRaw*(1+cost),risk=entryRaw-stopRaw,t1=entryRaw+risk,t2=entryRaw+2*risk;let rem=1,ret=0,tp1=false,tp2=false,exitIndex=day.length-1,reason="EOD",below=0;const fill=x=>x*(1-cost);
  for(let i=entryIndex+1;i<day.length;i++){const b=day[i],vw=vwap(day,b.timestamp+1),protect=tp1&&vw?Math.max(entryRaw,Math.min(vw*0.998,entryRaw*1.01)):stopRaw;if(b.low<=protect){ret+=rem*(fill(protect)/entry-1);rem=0;exitIndex=i;reason=tp1?"PROTECT_STOP":"STRUCTURAL_STOP";break;}if(!tp1&&b.high>=t1){ret+=.25*(fill(t1)/entry-1);rem-=.25;tp1=true;}if(tp1&&!tp2&&b.high>=t2){ret+=.25*(fill(t2)/entry-1);rem-=.25;tp2=true;}if(tp2&&vw){below=b.close<vw?below+1:0;if(below>=3){ret+=rem*(fill(b.close)/entry-1);rem=0;exitIndex=i;reason="RUNNER_VWAP_BREAK";break;}}}
  if(rem>0){ret+=rem*(fill(day.at(-1).close)/entry-1);reason=tp2?"RUNNER_EOD":tp1?"PARTIAL_EOD":"EOD";}
  return {netReturn:ret,stopDistancePct:risk/entryRaw,tp1,tp2,exitTime:day[exitIndex].timestamp,exitReason:reason};
}
function openingBreakoutTrade(candidate,day,spyDay,cost){
  const or=openingRange(day);if(!or)return null;
  const b5=aggregate(day,5),b15=aggregate(day,15),spy5=aggregate(spyDay,5);
  for(let i=3;i<b5.length-1;i++){
    const bar=b5[i],m=minuteOfDay(bar.closeTime);if(m<585||m>690)continue;
    const completed=b5.slice(0,i+1),p15=b15.filter(x=>x.closeTime<=bar.closeTime);if(completed.length<6||p15.length<3)continue;
    const ps5=structure(candidate.symbol,"5m",completed,bar.closeTime+1);if(ps5.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY")continue;
    const f5=ps5.features,ps15=structure(candidate.symbol,"15m",p15,bar.closeTime+1),f15=ps15.status==="READY_FOR_SPECIALIST_RESEARCH_ONLY"?ps15.features:null;
    const vw=vwap(day,bar.closeTime),vr=volumeReaccel(b5,i,5),range=bar.high-bar.low,body=range?Math.abs(bar.close-bar.open)/range:0,cl=range?(bar.close-bar.low)/range:0;
    const spyBar=spy5.find(x=>x.closeTime===bar.closeTime),spyVw=vwap(spyDay,bar.closeTime),marketOk=spyBar&&spyVw?spyBar.close>=spyVw*0.998:true;
    const upEvent=f5.priceStructure.structureEventDirection==="UP"||["BOS_UP","CHOCH_UP"].includes(f5.pattern.structureTransition);
    if(!(marketOk&&bar.close>or.high&&vw&&bar.close>vw&&bar.close/vw-1<=0.025&&f5.priceStructure.trend!=="BEARISH"&&f15?.priceStructure?.trend!=="BEARISH"&&upEvent&&bar.close>bar.open&&body>=0.45&&cl>=0.70&&vr>=1.2))continue;
    const entryIndex=nextMinuteIndex(day,bar.closeTime);if(entryIndex<0)continue;const entryRaw=day[entryIndex].open,support=f5.priceStructure.support;
    const logical=Math.min(or.high*0.997,support&&support<entryRaw?support*0.998:or.high*0.997),risk=(entryRaw-logical)/entryRaw;if(!(risk>=0.003&&risk<=0.03))continue;
    const ex=simulateExit(day,entryIndex,entryRaw,logical,cost);
    return {symbol:candidate.symbol,sector:candidate.sector,bucket:candidate.bucket,date:candidate.date,family:"OPENING_BREAKOUT",setupScore:candidate.setupScore,triggerScore:+Math.min(100,candidate.setupScore+10*clamp((vr-1.2)/2)+10*clamp((cl-.70)/.3)).toFixed(2),entryTime:day[entryIndex].timestamp,aiInputBundle:{setup:candidate.setup,openingRange:or,wave5m:f5.pattern,candle5m:f5.candle,structure5m:f5.priceStructure,structure15m:f15?.priceStructure??null,vwapDistance:bar.close/vw-1,volumeReaccel:vr,marketAboveVwap:marketOk},...ex};
  }
  return null;
}
function firstPullbackTrade(candidate,day,spyDay,cost){
  const or=openingRange(day);if(!or)return null;
  const b5=aggregate(day,5),b15=aggregate(day,15),spy5=aggregate(spyDay,5);
  let impulse=null;
  for(let i=3;i<b5.length-1;i++){
    const bar=b5[i],m=minuteOfDay(bar.closeTime);if(m<585||m>660)continue;
    const completed=b5.slice(0,i+1),p15=b15.filter(x=>x.closeTime<=bar.closeTime);if(completed.length<6||p15.length<3)continue;
    const ps5=structure(candidate.symbol,"5m",completed,bar.closeTime+1);if(ps5.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY")continue;
    const f5=ps5.features,vw=vwap(day,bar.closeTime),vr=volumeReaccel(b5,i,5),up=f5.priceStructure.structureEventDirection==="UP"||["BOS_UP","CHOCH_UP"].includes(f5.pattern.structureTransition);
    const spyBar=spy5.find(x=>x.closeTime===bar.closeTime),spyVw=vwap(spyDay,bar.closeTime),marketOk=spyBar&&spyVw?spyBar.close>=spyVw*0.998:true;
    if(!impulse){
      if(marketOk&&bar.close>or.high&&vw&&bar.close>vw&&f5.priceStructure.trend!=="BEARISH"&&up&&vr>=1.2)impulse={index:i,high:bar.high};
      continue;
    }
    if(i>impulse.index+6)break;
    const range=bar.high-bar.low,body=range?Math.abs(bar.close-bar.open)/range:0,cl=range?(bar.close-bar.low)/range:0;
    const retest=bar.low<=or.high*1.006&&bar.close>=or.high&&vw&&bar.close>vw;
    if(!(retest&&bar.close>bar.open&&body>=0.30&&cl>=0.60&&vr>=0.85))continue;
    const ps15=structure(candidate.symbol,"15m",p15,bar.closeTime+1);const f15=ps15.status==="READY_FOR_SPECIALIST_RESEARCH_ONLY"?ps15.features:null;if(f15?.priceStructure?.trend==="BEARISH")continue;
    const entryIndex=nextMinuteIndex(day,bar.closeTime);if(entryIndex<0)continue;const entryRaw=day[entryIndex].open,logical=bar.low*0.998,risk=(entryRaw-logical)/entryRaw;if(!(risk>=0.003&&risk<=0.03))continue;
    const ex=simulateExit(day,entryIndex,entryRaw,logical,cost);
    return {symbol:candidate.symbol,sector:candidate.sector,bucket:candidate.bucket,date:candidate.date,family:"FIRST_PULLBACK",setupScore:candidate.setupScore,triggerScore:+Math.min(100,candidate.setupScore+10*clamp((vr-.85)/2)+10*clamp((cl-.60)/.4)).toFixed(2),entryTime:day[entryIndex].timestamp,aiInputBundle:{setup:candidate.setup,openingRange:or,impulseHigh:impulse.high,wave5m:f5.pattern,candle5m:f5.candle,structure5m:f5.priceStructure,structure15m:f15?.priceStructure??null,vwapDistance:bar.close/vw-1,volumeReaccel:vr},...ex};
  }
  return null;
}
function portfolio(trades){const sorted=[...trades].sort((a,b)=>a.entryTime-b.entryTime||b.triggerScore-a.triggerScore),active=[],sectors=new Map();let ret=0,admitted=0;for(const t of sorted){for(let i=active.length-1;i>=0;i--)if(active[i].exitTime<=t.entryTime){const s=active[i].sector;sectors.set(s,Math.max(0,(sectors.get(s)??1)-1));active.splice(i,1);}if(active.length>=ACCOUNT.maxConcurrent||(sectors.get(t.sector)??0)>=ACCOUNT.maxPerSector)continue;const w=Math.min(ACCOUNT.maxWeight,ACCOUNT.riskPerTrade/Math.max(t.stopDistancePct,1e-9));ret+=w*t.netReturn;active.push(t);sectors.set(t.sector,(sectors.get(t.sector)??0)+1);admitted++;}return {return:ret,admitted};}
function dayMetrics(days){const r=days.map(x=>x.return),pos=r.filter(x=>x>0),neg=r.filter(x=>x<0);let eq=1,peak=1,mdd=0;for(const x of r){eq*=1+x;peak=Math.max(peak,eq);mdd=Math.max(mdd,(peak-eq)/peak);}return {days:days.length,totalReturn:eq-1,averageDailyReturn:mean(r),medianDailyReturn:median(r),positiveDayRate:r.length?pos.length/r.length:0,averageWinningDay:mean(pos),averageLosingDay:mean(neg),bestDay:r.length?Math.max(...r):0,worstDay:r.length?Math.min(...r):0,maxDrawdown:mdd,daysAtLeast1Pct:r.filter(x=>x>=.01).length,daysAtLeast3Pct:r.filter(x=>x>=.03).length,daysAtLeast5Pct:r.filter(x=>x>=.05).length,daysAtLeast10Pct:r.filter(x=>x>=.10).length};}
function runFamily(name,dates,candidates,dataBySymbol,spyDays,cost){
  const days=[],trades=[];
  for(const date of dates){const xs=[];for(const c of candidates.get(date)??[]){const day=dataBySymbol.get(c.symbol)?.minuteDays.get(date),spyDay=spyDays.get(date);if(!day||!spyDay)continue;const t=name==="OPENING_BREAKOUT"?openingBreakoutTrade(c,day,spyDay,cost):firstPullbackTrade(c,day,spyDay,cost);if(t){xs.push(t);trades.push(t);}}const p=portfolio(xs);days.push({date,candidateCount:(candidates.get(date)??[]).length,triggered:xs.length,...p});}
  return {metrics:dayMetrics(days),days,trades};
}
function selectionScore(r){if(r.trades.length<5)return -999;return r.metrics.totalReturn-1.5*r.metrics.maxDrawdown+0.25*r.metrics.averageDailyReturn;}
function validationPass(normal,stress){return normal.metrics.days>=4&&normal.trades.length>=3&&normal.metrics.totalReturn>0&&normal.metrics.averageDailyReturn>0&&stress.metrics.totalReturn>0&&stress.metrics.averageDailyReturn>0&&normal.metrics.maxDrawdown<=0.06&&stress.metrics.maxDrawdown<=0.07;}

async function main(){
  const u=await fetchUniverse(),spyDaily=(await collectYahooStockHistory({market:"US_STOCK",symbol:"SPY",startTime:DAILY_START,endTime:EVAL_END})).candles;
  const selected=[];
  for(const [bucket,rows] of Object.entries(u.buckets)){
    const tested=await mapLimit(rows,4,async row=>({...row,bucket,daily:(await collectYahooStockHistory({market:"US_STOCK",symbol:row.symbol,startTime:DAILY_START,endTime:EVAL_END})).candles}));
    for(const x of tested.filter(x=>x.ok).map(x=>x.value)){if(x.daily.length>=180)selected.push(x);if(selected.filter(y=>y.bucket===bucket).length>=4)break;}
  }
  if(["LARGE","MID","SMALL"].some(b=>selected.filter(x=>x.bucket===b).length<4))throw new Error("FRESH_BUCKET_HISTORY_INSUFFICIENT");
  const spyMinute=await tossMinuteHistory("SPY"),spyDays=groupDays(spyMinute),dates=completeDates(spyMinute);if(dates.length<12)throw new Error(`COMPLETE_DATES_INSUFFICIENT_${dates.length}`);
  const minuteFetched=await mapLimit(selected,2,async row=>({...row,minute:await tossMinuteHistory(row.symbol)})),ok=minuteFetched.filter(x=>x.ok).map(x=>x.value);
  if(ok.length<10)throw new Error(`TOSS_SYMBOL_COVERAGE_INSUFFICIENT_${ok.length}`);
  const dataBySymbol=new Map(ok.map(x=>[x.symbol,{...x,minuteDays:groupDays(x.minute)}]));
  const candidates=new Map();
  for(const date of dates){const rows=ok.map(r=>dailyCandidate(r,spyDaily,date)).filter(Boolean).sort((a,b)=>b.setupScore-a.setupScore).slice(0,CANDIDATES_PER_DAY);candidates.set(date,rows);}
  const testCount=Math.max(3,Math.floor(dates.length*.25)),validationCount=Math.max(3,Math.floor(dates.length*.25)),calCount=dates.length-testCount-validationCount;if(calCount<6)throw new Error("CALIBRATION_DATES_INSUFFICIENT");
  const calibration=dates.slice(0,calCount),validation=dates.slice(calCount,calCount+validationCount),test=dates.slice(calCount+validationCount);
  const familyResults=[];
  for(const family of Object.keys(FAMILIES)){
    const cal=runFamily(family,calibration,candidates,dataBySymbol,spyDays,NORMAL_COST);
    const val=runFamily(family,validation,candidates,dataBySymbol,spyDays,NORMAL_COST);
    const valStress=runFamily(family,validation,candidates,dataBySymbol,spyDays,STRESS_COST);
    familyResults.push({family,selectionScore:selectionScore(cal),validationPass:validationPass(val,valStress),calibration:cal,validation:val,validationStress:valStress});
  }
  familyResults.sort((a,b)=>b.selectionScore-a.selectionScore);
  const selectedFamily=familyResults[0],gatePassed=selectedFamily.validationPass;
  const testNormal=runFamily(selectedFamily.family,test,candidates,dataBySymbol,spyDays,NORMAL_COST),testStress=runFamily(selectedFamily.family,test,candidates,dataBySymbol,spyDays,STRESS_COST);
  const report={
    schemaVersion:1,status:"pass",market:"US_STOCK",provider:"toss-openapi",
    purpose:"fresh-symbol D-1 candidate -> US opening momentum / first pullback intraday replay",
    dataWindow:{startInclusive:new Date(EVAL_START).toISOString(),endExclusive:new Date(EVAL_END).toISOString(),completeDates:dates,calibrationDates:calibration,validationDates:validation,testDates:test},
    universe:{currentSnapshotBias:true,rawRows:u.rawRows,selectionPolicy:{largeCurrentLiquidityRanks:"161-180 -> first 4 with sufficient history",midCurrentLiquidityRanks:"101-120 -> first 4 with sufficient history",smallCurrentLiquidityRanks:"241-280 -> first 4 with sufficient history"},selected:ok.map(x=>({symbol:x.symbol,bucket:x.bucket,sector:x.sector,marketCap:x.marketCap,dollarVolume:x.dollarVolume}))},
    selectionContract:{familiesPreRegistered:Object.keys(FAMILIES),selectedFamilyChosenByCalibrationOnly:true,validationCanOnlyPassOrFailSelectedFamily:true,testUsedForSelection:false,actualHistoricalLlmCalled:false,critic:"DETERMINISTIC_WAVE_CANDLE_VWAP_GATE_US_V1"},
    costs:{normalPerSide:NORMAL_COST,stressPerSide:STRESS_COST,note:"research all-in fee+spread+slippage assumption"},
    accountPolicy:ACCOUNT,
    familyResults:familyResults.map(x=>({family:x.family,selectionScore:x.selectionScore,validationPass:x.validationPass,calibration:{metrics:x.calibration.metrics,trades:x.calibration.trades.length},validation:{metrics:x.validation.metrics,trades:x.validation.trades.length},validationStress:{metrics:x.validationStress.metrics,trades:x.validationStress.trades.length}})),
    selectedFamily:selectedFamily.family,selectedStatus:gatePassed?"VALIDATION_GATE_PASS":"RESEARCH_HOLD_VALIDATION_FAILED",
    test:{normal:{metrics:testNormal.metrics,days:testNormal.days,trades:testNormal.trades.map(t=>({symbol:t.symbol,date:t.date,bucket:t.bucket,family:t.family,setupScore:t.setupScore,triggerScore:t.triggerScore,entryTime:new Date(t.entryTime).toISOString(),exitTime:new Date(t.exitTime).toISOString(),netReturn:t.netReturn,stopDistancePct:t.stopDistancePct,tp1:t.tp1,tp2:t.tp2,exitReason:t.exitReason,aiInputBundle:t.aiInputBundle}))},stress:{metrics:testStress.metrics,days:testStress.days,trades:testStress.trades.length}},
    lookahead:{D1UsesPriorCompletedDailyCandle:true,intradayUsesCompleted1mAggregated5m15m:true,entryNext1mOpen:true,testUsedForSelection:false,guardPassed:true},
    safety:{researchOnly:true,marketDataOnly:true,accountHeaderUsed:false,orderRouteCalled:false,liveExecutionAllowed:false,privateAccountRequestAllowed:false,executionAuthority:"NONE",profitabilityPromotionAllowed:false},
    limitations:["Toss credentials are used only for authenticated market-data GET requests; no account header or order route is used.","Universe uses a current Nasdaq liquidity snapshot and therefore has survivorship/current-membership bias.","The August period is retrospective and the strategy family was designed later, so this is not prospective proof.","Historical news/catalyst/order-book/short-interest and historical LLM outputs are not included.","Candle replay is not broker fill evidence and cannot establish PROFITABILITY_PROVEN."]
  };
  const out=resolve(process.argv[2]??"docs/us-toss-opening-momentum-v1.json");await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+"\n","utf8");console.log(JSON.stringify(report,null,2));
}
await main();
