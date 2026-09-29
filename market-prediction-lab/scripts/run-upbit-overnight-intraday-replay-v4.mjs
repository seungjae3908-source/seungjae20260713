import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildAdaptiveMultiEvidencePriceStructureV2 } from "../src/adaptive-multi-evidence-price-structure-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "../src/adaptive-multi-evidence-point-in-time-v2.js";

const UPBIT="https://api.upbit.com";
const DAY=86_400_000;
const NORMAL_COST=0.0015;
const STRESS_COST=NORMAL_COST*1.5;
const HISTORY_DAYS=180;
const OBSERVED_CUTOFF="2026-09-05";
const DISCOVERY_COUNT=12;
const FRESH_HOLDOUT_SKIP=24;
const FRESH_HOLDOUT_COUNT=12;
const HOLDOUT_COUNT=12;
const CANDIDATES_PER_DAY=8;
const STABLECOINS=new Set(["USDT","USDC","DAI","TUSD","USDP","BUSD","FDUSD","PYUSD","USD1"]);
const ACCOUNT=Object.freeze({riskPerTrade:0.005,maxWeight:0.20,maxConcurrent:3});
const FAMILIES=Object.freeze({
  BALANCED:Object.freeze({name:"BALANCED",trend:"NON_BEARISH",minBody:0.40,minCloseLoc:0.60,minVolReaccel:0.90,maxVwapDistance:0.030,eventMode:"UP_EVENT"}),
  TREND:Object.freeze({name:"TREND",trend:"BULLISH",minBody:0.40,minCloseLoc:0.65,minVolReaccel:0.90,maxVwapDistance:0.025,eventMode:"ANY",require1hBullish:true}),
  RETEST:Object.freeze({name:"RETEST",trend:"NON_BEARISH",minBody:0.30,minCloseLoc:0.55,minVolReaccel:0.80,maxVwapDistance:0.020,eventMode:"RETEST_HELD"}),
  EXPANSION:Object.freeze({name:"EXPANSION",trend:"NON_BEARISH",minBody:0.50,minCloseLoc:0.70,minVolReaccel:1.20,maxVwapDistance:0.030,eventMode:"BOS_OR_CHOCH",minRangeAtr:1.20}),
});

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let lastRequestAt=0;
async function upbitJson(path){
  let last;
  for(let attempt=0;attempt<4;attempt+=1){
    const wait=Math.max(0,125-(Date.now()-lastRequestAt));
    if(wait)await sleep(wait);
    lastRequestAt=Date.now();
    try{
      const response=await fetch(`${UPBIT}${path}`,{headers:{accept:"application/json","user-agent":"seungjae-research-replay/1.0"}});
      if(response.status===429){await sleep(900*(attempt+1));continue;}
      if(!response.ok)throw new Error(`UPBIT_HTTP_${response.status}`);
      return await response.json();
    }catch(error){last=error;await sleep(300*(attempt+1));}
  }
  throw last??new Error("UPBIT_FETCH_FAILED");
}
function finite(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function mean(v){return v.length?v.reduce((a,b)=>a+b,0)/v.length:0;}
function median(v){if(!v.length)return 0;const x=[...v].sort((a,b)=>a-b),m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function clamp(x,a=0,b=1){return Math.min(b,Math.max(a,x));}
function dayKey(ms){return new Date(ms).toISOString().slice(0,10);}
function sma(c,i,p){if(i-p+1<0)return null;let s=0;for(let j=i-p+1;j<=i;j++)s+=c[j].close;return s/p;}
function highBefore(c,i,p){if(i-p<0)return null;let h=-Infinity;for(let j=i-p;j<i;j++)h=Math.max(h,c[j].high);return Number.isFinite(h)?h:null;}
function avgValueBefore(c,i,p){if(i-p<0)return null;let s=0;for(let j=i-p;j<i;j++)s+=c[j].tradingValue;return s/p;}
function normalizeCandle(row){
  const timestamp=Date.parse(`${String(row?.candle_date_time_utc??"")}Z`);
  const open=finite(row?.opening_price),high=finite(row?.high_price),low=finite(row?.low_price),close=finite(row?.trade_price),volume=finite(row?.candle_acc_trade_volume),tradingValue=finite(row?.candle_acc_trade_price);
  if(!Number.isFinite(timestamp)||![open,high,low,close,volume,tradingValue].every(Number.isFinite)||Math.min(open,high,low,close)<=0||volume<0||tradingValue<0)return null;
  return {timestamp,open,high,low,close,volume,tradingValue};
}
async function markets(){
  const master=await upbitJson("/v1/market/all?isDetails=true");
  const krw=(Array.isArray(master)?master:[]).filter(x=>String(x?.market??"").startsWith("KRW-")&&String(x?.market_warning??"NONE")==="NONE");
  const ids=krw.map(x=>String(x.market));
  const tickers=[];
  for(let i=0;i<ids.length;i+=100){
    const chunk=ids.slice(i,i+100);
    const rows=await upbitJson(`/v1/ticker?markets=${encodeURIComponent(chunk.join(","))}`);
    if(Array.isArray(rows))tickers.push(...rows);
  }
  const nameMap=new Map(krw.map(x=>[String(x.market),{koreanName:String(x.korean_name??x.market),englishName:String(x.english_name??x.market)}]));
  const ranked=tickers.map(x=>({
    market:String(x.market),
    symbol:String(x.market).replace(/^KRW-/,""),
    price:finite(x.trade_price),
    tradingValue24h:finite(x.acc_trade_price_24h),
    ...(nameMap.get(String(x.market))??{}),
  })).filter(x=>x.price>0&&x.tradingValue24h>0&&!STABLECOINS.has(x.symbol))
    .sort((a,b)=>b.tradingValue24h-a.tradingValue24h);
  const discovery=ranked.slice(0,DISCOVERY_COUNT);
  const holdout=ranked.slice(FRESH_HOLDOUT_SKIP,FRESH_HOLDOUT_SKIP+FRESH_HOLDOUT_COUNT);
  const btcReference=ranked.find(x=>x.market==="KRW-BTC")??null;
  if(discovery.length!==DISCOVERY_COUNT||holdout.length!==FRESH_HOLDOUT_COUNT||!btcReference)throw new Error("UPBIT_COHORT_BUILD_FAILED");
  return {totalKrw:ranked.length,discovery,holdout,btcReference};
}
async function dailyCandles(market){
  const rows=await upbitJson(`/v1/candles/days?market=${encodeURIComponent(market)}&count=200`);
  return (Array.isArray(rows)?rows:[]).map(normalizeCandle).filter(Boolean).sort((a,b)=>a.timestamp-b.timestamp);
}
async function minute15Candles(market){
  const startMs=Date.now()-HISTORY_DAYS*DAY;
  const map=new Map();
  let to=null;
  for(let page=0;page<95;page+=1){
    const qs=new URLSearchParams({market,count:"200"});
    if(to)qs.set("to",to);
    const rows=await upbitJson(`/v1/candles/minutes/15?${qs.toString()}`);
    const normalized=(Array.isArray(rows)?rows:[]).map(normalizeCandle).filter(Boolean);
    if(!normalized.length)break;
    for(const row of normalized)map.set(row.timestamp,row);
    const oldest=Math.min(...normalized.map(x=>x.timestamp));
    if(oldest<=startMs)break;
    to=new Date(oldest-1000).toISOString().replace(/\.\d{3}Z$/,"Z");
  }
  return [...map.values()].filter(x=>x.timestamp>=startMs).sort((a,b)=>a.timestamp-b.timestamp);
}
function groupDays(rows){
  const out=new Map();
  for(const r of rows){const k=dayKey(r.timestamp),a=out.get(k)??[];a.push(r);out.set(k,a);}
  return out;
}
function completeDates(rows){
  const today=dayKey(Date.now());
  return [...groupDays(rows).entries()].filter(([d,v])=>d<today&&v.length>=90).map(([d])=>d).sort();
}
function aggregate1h(rows){
  const out=[];
  for(let i=0;i<rows.length;i+=4){
    const q=rows.slice(i,i+4);if(q.length<4)break;
    out.push({timestamp:q[0].timestamp,closeTime:q[3].timestamp+15*60_000,open:q[0].open,high:Math.max(...q.map(x=>x.high)),low:Math.min(...q.map(x=>x.low)),close:q[3].close,volume:q.reduce((s,x)=>s+x.volume,0),tradingValue:q.reduce((s,x)=>s+x.tradingValue,0)});
  }
  return out;
}
function vwap(rows,cutoff){
  let pv=0,v=0;
  for(const r of rows){if(r.timestamp>=cutoff)break;if(r.volume>0){pv+=((r.high+r.low+r.close)/3)*r.volume;v+=r.volume;}}
  return v>0?pv/v:null;
}
function structure(symbol,timeframe,bars,decisionMs){
  const duration=timeframe==="1D"?1440:timeframe==="1H"?60:15;
  const mapped=bars.map(b=>{
    const closeMs=b.closeTime??(b.timestamp+duration*60_000),iso=new Date(closeMs).toISOString();
    return {isClosed:true,eventTime:iso,publishedAt:iso,availableAt:iso,observedAt:iso,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume};
  });
  const options=timeframe==="1D"
    ?{atrPeriod:14,volumeLookback:20,pivotLeftBars:2,pivotRightBars:2,compressionLookback:5}
    :timeframe==="15m"
      ?{atrPeriod:8,volumeLookback:8,pivotLeftBars:1,pivotRightBars:1,compressionLookback:4}
      :{atrPeriod:5,volumeLookback:4,pivotLeftBars:1,pivotRightBars:1,compressionLookback:2};
  return buildAdaptiveMultiEvidencePriceStructureV2({
    lineageId:ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,market:"CRYPTO_SPOT",symbol,timeframe,side:"LONG",
    decisionTime:new Date(decisionMs).toISOString(),
    source:{sourceId:"upbit-public",originalSourceId:"upbit-public",sourceType:"PUBLIC_MARKET_DATA",sourceUrl:"https://api.upbit.com/",documentId:`KRW-${symbol}:${timeframe}`},
    candles:mapped,options,
  });
}
function candidate(row,btcDaily,date){
  const c=row.daily,dates=c.map(x=>dayKey(x.timestamp));let i=-1;
  for(let j=0;j<dates.length;j++)if(dates[j]<date)i=j;else break;
  const bd=btcDaily.map(x=>dayKey(x.timestamp));let bi=-1;
  for(let j=0;j<bd.length;j++)if(bd[j]<date)bi=j;else break;
  if(i<30||bi<20)return null;
  const close=c[i].close,m20=sma(c,i,20),m20p=sma(c,i-5,20),h20=highBefore(c,i+1,20),av=avgValueBefore(c,i,20);
  if(![m20,m20p,h20,av].every(x=>x>0))return null;
  const targetStart=Date.parse(`${date}T00:00:00.000Z`);
  const dailyPs=structure(row.symbol,"1D",c.slice(Math.max(0,i-59),i+1),targetStart+1);
  if(dailyPs.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY")return null;
  const dailyFeatures=dailyPs.features;
  const dailyTrend=dailyFeatures.priceStructure.trend;
  const dailyTransition=dailyFeatures.pattern.structureTransition;
  const rs20=(close/c[i-20].close-1)-(btcDaily[bi].close/btcDaily[bi-20].close-1);
  const valueAccel=c[i].tradingValue/av,near=close/h20,range=c[i].high-c[i].low,body=range?Math.abs(c[i].close-c[i].open)/range:0,closeLoc=range?(c[i].close-c[i].low)/range:0;
  if(!(close>m20&&m20>=m20p*0.98&&near>=0.82&&valueAccel>=0.60&&rs20>=-0.12&&dailyTrend!=="BEARISH"))return null;
  let score=15+25*clamp((rs20+0.10)/0.40)+20*clamp((valueAccel-0.60)/2.40)+15*clamp((near-0.82)/0.18)+10*clamp((closeLoc-0.40)/0.60)+8*clamp((body-0.25)/0.65);
  if(dailyTrend==="BULLISH")score+=4;
  if(["BOS_UP","CHOCH_UP"].includes(dailyTransition))score+=3;
  return {market:row.market,symbol:row.symbol,date,preparedAt:dates[i],setupScore:+Math.min(100,score).toFixed(2),setup:{rs20,valueAcceleration:valueAccel,near20dHigh:near,closeLocation:closeLoc,bodyRangeRatio:body,dailyStructureTrend:dailyTrend,dailyStructureTransition:dailyTransition,dailySwingSequence:dailyFeatures.pattern.swingSequence}};
}
const V4_FIXED_PROFILE=Object.freeze({name:"V4_FIXED_QUALITY_BOS",trend:"BULLISH",minBody:0.40,minCloseLoc:0.65,minVolReaccel:1.0,maxVwapDistance:0.025,eventMode:"BOS_OR_CHOCH",require1hBullish:false});
function v4TriggerPass(f15,f1h,vwd,vr){
  if(f15?.priceStructure?.structureEvent==="FAILED_BREAKOUT")return false;
  if(f15?.priceStructure?.trend!=="BULLISH")return false;
  if(f1h?.priceStructure?.trend==="BEARISH")return false;
  if(f15?.pattern?.structureTransition!=="BOS_UP")return false;
  const candle=f15?.candle;
  if(!candle||candle.direction!=="UP"||(candle.bodyRangeRatio??0)<0.40||(candle.closeLocation??0)<0.65)return false;
  if(vwd<0||vwd>0.025||vr<1.0)return false;
  return true;
}

function familyPass(f,f15,f1h,vwd,vr){
  const c=f15.candle,ps=f15.priceStructure,p=f15.pattern;
  if(ps.trend==="BEARISH"||f1h?.priceStructure?.trend==="BEARISH"||vwd<0||vwd>f.maxVwapDistance||c.direction!=="UP"||(c.bodyRangeRatio??0)<f.minBody||(c.closeLocation??0)<f.minCloseLoc||vr<f.minVolReaccel)return false;
  if(f.trend==="BULLISH"&&ps.trend!=="BULLISH")return false;
  if(f.require1hBullish&&f1h?.priceStructure?.trend!=="BULLISH")return false;
  if(f.eventMode==="RETEST_HELD"&&ps.structureEvent!=="RETEST_HELD")return false;
  if(f.eventMode==="BOS_OR_CHOCH"&&!["BOS_UP","CHOCH_UP"].includes(p.structureTransition))return false;
  if(f.eventMode==="UP_EVENT"&&!(ps.structureEventDirection==="UP"||["BOS_UP","CHOCH_UP"].includes(p.structureTransition)))return false;
  if((f.minRangeAtr??0)>0&&(c.rangeAtrRatio??0)<f.minRangeAtr)return false;
  return true;
}
function simulateExit(day,entryIndex,entryRaw,stopRaw,cost){
  const entry=entryRaw*(1+cost),risk=entryRaw-stopRaw,t1=entryRaw+risk,t2=entryRaw+2*risk;
  let rem=1,ret=0,tp1=false,tp2=false,exitIndex=day.length-1,reason="DAY_END",belowVwap=0;
  const fill=x=>x*(1-cost);
  for(let i=entryIndex+1;i<day.length;i++){
    const b=day[i],vw=vwap(day,b.timestamp+1);
    let protect=stopRaw;
    if(tp1&&vw!=null)protect=Math.max(entryRaw,Math.min(vw*0.998,entryRaw*1.01));
    if(b.low<=protect){ret+=rem*(fill(protect)/entry-1);rem=0;exitIndex=i;reason=tp1?"PROTECT_STOP":"STRUCTURAL_STOP";break;}
    if(!tp1&&b.high>=t1){ret+=0.25*(fill(t1)/entry-1);rem-=0.25;tp1=true;}
    if(tp1&&!tp2&&b.high>=t2){ret+=0.25*(fill(t2)/entry-1);rem-=0.25;tp2=true;}
    if(tp2&&vw!=null){
      belowVwap=b.close<vw?belowVwap+1:0;
      if(belowVwap>=2){ret+=rem*(fill(b.close)/entry-1);rem=0;exitIndex=i;reason="RUNNER_VWAP_BREAK";break;}
    }
  }
  if(rem>0){ret+=rem*(fill(day.at(-1).close)/entry-1);reason=tp2?"RUNNER_DAY_END":tp1?"PARTIAL_DAY_END":"DAY_END";}
  return {netReturn:ret,stopDistancePct:risk/entryRaw,tp1,tp2,exitTime:day[exitIndex].timestamp,exitReason:reason};
}
function replayOne(f,cand,day,cost){
  const h1=aggregate1h(day);
  for(let i=10;i<day.length-1;i++){
    const decision=day[i].timestamp+15*60_000,closed=day.slice(0,i+1).map(x=>({...x,closeTime:x.timestamp+15*60_000}));
    const ps15=structure(cand.symbol,"15m",closed,decision+1);if(ps15.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY")continue;
    const available1h=h1.filter(x=>x.closeTime<=decision);
    const ps1h=available1h.length>=5?structure(cand.symbol,"1H",available1h,decision+1):null;
    const f1h=ps1h?.status==="READY_FOR_SPECIALIST_RESEARCH_ONLY"?ps1h.features:null;
    const vw=vwap(day,decision),last=day[i];if(!(vw>0))continue;
    const prev=day.slice(Math.max(0,i-8),i).map(x=>x.volume).filter(x=>x>0),vr=prev.length?last.volume/median(prev):1,vwd=last.close/vw-1;
    if(f?.name==="V4_FIXED_QUALITY_BOS"){if(!v4TriggerPass(ps15.features,f1h,vwd,vr))continue;}else if(!familyPass(f,ps15.features,f1h,vwd,vr))continue;
    const entryIndex=i+1,entryRaw=day[entryIndex].open,support=ps15.features.priceStructure.support;
    let risk=support&&support<entryRaw?(entryRaw-support*0.998)/entryRaw:0.015;
    risk=Math.max(0.006,risk);if(risk>0.04)continue;
    const exit=simulateExit(day,entryIndex,entryRaw,entryRaw*(1-risk),cost);
    const triggerScore=+Math.min(100,cand.setupScore+10*clamp((vr-f.minVolReaccel)/2)+10*clamp(((ps15.features.candle.closeLocation??0)-f.minCloseLoc)/0.35)+5*(ps15.features.priceStructure.trend==="BULLISH")).toFixed(2);
    return {market:cand.market,symbol:cand.symbol,date:cand.date,family:f.name,setupScore:cand.setupScore,triggerScore,entryTime:day[entryIndex].timestamp,aiInputBundle:{setup:cand.setup,wave15m:ps15.features.pattern,candle15m:ps15.features.candle,structure15m:ps15.features.priceStructure,wave1h:f1h?.pattern??null,structure1h:f1h?.priceStructure??null,vwapDistance:vwd,volumeReaccel:vr},...exit};
  }
  return null;
}
function portfolio(trades){
  const sorted=[...trades].sort((a,b)=>a.entryTime-b.entryTime||b.triggerScore-a.triggerScore),active=[];
  let ret=0,admitted=0,capacityRejected=0;
  for(const t of sorted){
    for(let i=active.length-1;i>=0;i--)if(active[i].exitTime<=t.entryTime)active.splice(i,1);
    if(active.length>=ACCOUNT.maxConcurrent){capacityRejected++;continue;}
    const weight=Math.min(ACCOUNT.maxWeight,ACCOUNT.riskPerTrade/Math.max(t.stopDistancePct,1e-9));
    ret+=weight*t.netReturn;active.push(t);admitted++;
  }
  return {return:ret,admitted,capacityRejected};
}
function dayMetrics(days){
  const r=days.map(x=>x.return),pos=r.filter(x=>x>0),neg=r.filter(x=>x<0);let eq=1,peak=1,mdd=0;
  for(const x of r){eq*=1+x;peak=Math.max(peak,eq);mdd=Math.max(mdd,(peak-eq)/peak);}
  return {days:days.length,totalReturn:eq-1,averageDailyReturn:mean(r),medianDailyReturn:median(r),positiveDayRate:r.length?pos.length/r.length:0,averageWinningDay:mean(pos),averageLosingDay:mean(neg),bestDay:r.length?Math.max(...r):0,worstDay:r.length?Math.min(...r):0,maxDrawdown:mdd,daysAtLeast1Pct:r.filter(x=>x>=.01).length,daysAtLeast3Pct:r.filter(x=>x>=.03).length,daysAtLeast5Pct:r.filter(x=>x>=.05).length,daysAtLeast10Pct:r.filter(x=>x>=.10).length};
}
function runPeriod(f,dates,candidates,intraday,cost){
  const days=[],trades=[];
  for(const date of dates){
    const triggered=[];
    for(const c of candidates.get(date)??[]){const day=intraday.get(c.market)?.get(date);if(!day)continue;const t=replayOne(f,c,day,cost);if(t){triggered.push(t);trades.push(t);}}
    const p=portfolio(triggered);days.push({date,candidateCount:(candidates.get(date)??[]).length,triggered:triggered.length,...p});
  }
  return {metrics:dayMetrics(days),days,trades};
}
function selectionScore(r){if(r.trades.length<5)return -999;return r.metrics.totalReturn-1.5*r.metrics.maxDrawdown+0.30*r.metrics.averageDailyReturn;}
function calibrationGate(calibration,calibrationStress){
  return calibration.metrics.days>=60
    && calibration.trades.length>=20
    && calibration.metrics.totalReturn>0
    && calibration.metrics.averageDailyReturn>0
    && calibration.metrics.positiveDayRate>=0.35
    && calibrationStress.metrics.totalReturn>0
    && calibrationStress.metrics.averageDailyReturn>0
    && calibrationStress.metrics.positiveDayRate>=0.30
    && calibration.metrics.maxDrawdown<=0.12
    && calibrationStress.metrics.maxDrawdown<=0.14;
}
function validationGate(validation,validationStress){
  return validation.metrics.days>=20
    && validation.trades.length>=8
    && validation.metrics.totalReturn>0
    && validation.metrics.averageDailyReturn>0
    && validation.metrics.positiveDayRate>=0.35
    && validationStress.metrics.totalReturn>0
    && validationStress.metrics.averageDailyReturn>0
    && validationStress.metrics.positiveDayRate>=0.30
    && validation.metrics.maxDrawdown<=0.10
    && validationStress.metrics.maxDrawdown<=0.12;
}
function btcBullRegime(btcDaily,date){
  const dates=btcDaily.map(x=>dayKey(x.timestamp));let i=-1;
  for(let j=0;j<dates.length;j++)if(dates[j]<date)i=j;else break;
  if(i<25)return false;
  const ma20=sma(btcDaily,i,20),prior=sma(btcDaily,i-5,20);
  return ma20!=null&&prior!=null&&btcDaily[i].close>ma20&&ma20>prior;
}
function v4CandidateGate(candidate,btcDaily){
  return btcBullRegime(btcDaily,candidate.date)
    && candidate.setupScore>=60
    && candidate.setup.near20dHigh>=0.95
    && candidate.setup.closeLocation>=0.75
    && candidate.setup.bodyRangeRatio>=0.50;
}

function buildCandidates(rows,btcDaily,dates){
  const out=new Map();
  for(const date of dates){
    out.set(date,rows.map(row=>candidate(row,btcDaily,date)).filter(Boolean).filter((row)=>v4CandidateGate(row,btcDaily))
      .sort((a,b)=>b.setupScore-a.setupScore||a.symbol.localeCompare(b.symbol))
      .slice(0,CANDIDATES_PER_DAY));
  }
  return out;
}
async function main(){
  const u=await markets();
  const cohortMap=new Map([...u.discovery,...u.holdout,u.btcReference].map(x=>[x.market,x]));
  const data=[];
  for(const row of cohortMap.values()){
    const daily=await dailyCandles(row.market);
    const minute15=await minute15Candles(row.market);
    data.push({...row,daily,minute15});
  }
  const byMarket=new Map(data.map(x=>[x.market,x]));
  const btc=byMarket.get("KRW-BTC");if(!btc)throw new Error("BTC_REFERENCE_MISSING");
  const discoveryData=u.discovery.map(x=>byMarket.get(x.market)).filter(Boolean);
  const holdoutData=u.holdout.map(x=>byMarket.get(x.market)).filter(Boolean);
  if(discoveryData.length!==DISCOVERY_COUNT||holdoutData.length!==HOLDOUT_COUNT)throw new Error("COHORT_HISTORY_INCOMPLETE");
  const dates=completeDates(btc.minute15).filter((date)=>date<OBSERVED_CUTOFF);
  if(dates.length<100)throw new Error(`PRE_OBSERVED_COMPLETE_DAYS_INSUFFICIENT_${dates.length}`);
  const testCount=Math.max(20,Math.floor(dates.length*0.20));
  const validationCount=Math.max(20,Math.floor(dates.length*0.20));
  const calibrationCount=dates.length-testCount-validationCount;
  if(calibrationCount<60)throw new Error(`CALIBRATION_DAYS_INSUFFICIENT_${calibrationCount}`);
  const calibration=dates.slice(0,calibrationCount);
  const validation=dates.slice(calibrationCount,calibrationCount+validationCount);
  const test=dates.slice(calibrationCount+validationCount);
  const intraday=new Map(data.map(x=>[x.market,groupDays(x.minute15)]));
  const discoveryCandidates=buildCandidates(discoveryData,btc.daily,dates);
  const holdoutCandidates=buildCandidates(holdoutData,btc.daily,dates);
  const baselineNormal=runPeriod(FAMILIES.BALANCED,dates,holdoutCandidates,intraday,NORMAL_COST);
  const baselineStress=runPeriod(FAMILIES.BALANCED,dates,holdoutCandidates,intraday,STRESS_COST);
  const fixedNormal=runPeriod(V4_FIXED_PROFILE,dates,holdoutCandidates,intraday,NORMAL_COST);
  const fixedStress=runPeriod(V4_FIXED_PROFILE,dates,holdoutCandidates,intraday,STRESS_COST);
  const report={
    schemaVersion:4,status:"pass",market:"CRYPTO_SPOT",exchange:"UPBIT",
    purpose:"single fixed V4 quality+BOS policy on never-used current-liquidity ranks 25-36",
    dataWindow:{observedCutoffExclusive:OBSERVED_CUTOFF,completePreObservedDates:dates},
    universe:{
      currentSnapshotBias:true,totalKrwMarkets:u.totalKrw,stablecoinsExcluded:[...STABLECOINS],
      priorDiscoveryRanks:"1-12 were used by V3 and are not V4 final evidence",
      priorObservedHoldoutRanks:"13-24 influenced V4 design and are excluded",
      freshHoldoutRanks:`${FRESH_HOLDOUT_SKIP+1}-${FRESH_HOLDOUT_SKIP+FRESH_HOLDOUT_COUNT}`,
      freshHoldout:u.holdout.map(x=>({market:x.market,symbol:x.symbol,tradingValue24h:x.tradingValue24h}))
    },
    fixedPolicy:{
      parameterSearchPerformed:false,
      familySearchPerformed:false,
      candidateGate:{btcBullRegime:true,setupScoreMin:60,near20dHighMin:0.95,dailyCloseLocationMin:0.75,dailyBodyRangeRatioMin:0.50},
      triggerGate:{structure15m:"BULLISH",structureTransition:"BOS_UP",failedBreakoutRejected:true,oneHourBearishRejected:true,candleDirection:"UP",bodyRangeRatioMin:0.40,closeLocationMin:0.65,volumeReaccelMin:1.0,vwapDistanceMin:0,vwapDistanceMax:0.025},
      exit:"unchanged structural stop + 1R/2R partials + VWAP runner + day-end",
      accountPolicy:ACCOUNT
    },
    costs:{normalPerSide:NORMAL_COST,stressPerSide:STRESS_COST},
    baselineBalancedFreshHoldout:{normal:{metrics:baselineNormal.metrics,trades:baselineNormal.trades.length},stress:{metrics:baselineStress.metrics,trades:baselineStress.trades.length}},
    v4FixedFreshHoldout:{
      normal:{metrics:fixedNormal.metrics,days:fixedNormal.days,trades:fixedNormal.trades.map(t=>({symbol:t.symbol,date:t.date,setupScore:t.setupScore,triggerScore:t.triggerScore,entryTime:new Date(t.entryTime).toISOString(),exitTime:new Date(t.exitTime).toISOString(),netReturn:t.netReturn,stopDistancePct:t.stopDistancePct,tp1:t.tp1,tp2:t.tp2,exitReason:t.exitReason,aiInputBundle:t.aiInputBundle}))},
      stress:{metrics:fixedStress.metrics,days:fixedStress.days,trades:fixedStress.trades.length}
    },
    lookahead:{D1UsesPriorCompletedDailyCandle:true,dailyWaveUsesOnlyConfirmedPriorData:true,intradayUsesCompleted15mAnd1hOnly:true,entryNext15mOpen:true,freshHoldoutSymbolsUsedForDesign:false,guardPassed:true},
    safety:{researchOnly:true,publicDataOnly:true,liveExecutionAllowed:false,privateAccountRequestAllowed:false,executionAuthority:"NONE",profitabilityPromotionAllowed:false},
    limitations:[
      "V4 policy was designed after observing V3 ranks 1-24, so only ranks 25-36 are treated as fresh cross-symbol evidence.",
      "All dates remain retrospective and the current liquidity ranking creates survivorship/current-membership bias.",
      "Historical news/catalyst/order-book depth and true historical LLM outputs are unavailable and are not fabricated.",
      "This is candle replay, not exchange fill evidence, and cannot establish PROFITABILITY_PROVEN."
    ]
  };
  const out=resolve(process.argv[2]??"docs/upbit-overnight-intraday-replay-v2.json");
  await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+"\n","utf8");
  console.log(JSON.stringify(report,null,2));
}
await main();
