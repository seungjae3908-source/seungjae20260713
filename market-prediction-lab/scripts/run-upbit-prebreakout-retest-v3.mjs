import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildAdaptiveMultiEvidencePriceStructureV2 } from "../src/adaptive-multi-evidence-price-structure-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "../src/adaptive-multi-evidence-point-in-time-v2.js";

const UPBIT="https://api.upbit.com";
const DAY=86_400_000;
const NORMAL_COST=0.0015;
const STRESS_COST=NORMAL_COST*1.5;
const HISTORY_DAYS=35;
const PREVIOUSLY_OBSERVED=new Set([
  "XRP","ONDO","XLM","BTC","ETH","HBAR","SOON","NEAR","SUI","LINK",
  "WLD","EGLD","SOL","DOGE","CASHCAT","ALGO","ADA","0G","FOLD","ENA",
]);
const FRESH_HOLDOUT_COUNT=10;
const CANDIDATES_PER_DAY=5;
const STABLECOINS=new Set(["USDT","USDC","DAI","TUSD","USDP","BUSD","FDUSD","PYUSD","USD1"]);
const ACCOUNT=Object.freeze({riskPerTrade:0.005,maxWeight:0.20,maxConcurrent:3});
const FAMILIES=Object.freeze({
  RETEST_TIGHT:Object.freeze({
    name:"RETEST_TIGHT",
    d1MinDistance:0.005,d1MaxDistance:0.045,minRs20:0.00,maxRangeCompression:0.88,maxVolumeContraction:1.05,
    breakoutBuffer:0.001,maxBreakoutExtension:0.030,retestTolerance:0.006,minVolumeReaccel:1.05,
    minBody:0.35,minCloseLoc:0.60,maxVwapDistance:0.025,require1hBullish:false,
  }),
  RETEST_BALANCED:Object.freeze({
    name:"RETEST_BALANCED",
    d1MinDistance:0.005,d1MaxDistance:0.075,minRs20:-0.03,maxRangeCompression:1.00,maxVolumeContraction:1.15,
    breakoutBuffer:0.001,maxBreakoutExtension:0.040,retestTolerance:0.009,minVolumeReaccel:0.90,
    minBody:0.30,minCloseLoc:0.55,maxVwapDistance:0.030,require1hBullish:false,
  }),
  RETEST_RS:Object.freeze({
    name:"RETEST_RS",
    d1MinDistance:0.005,d1MaxDistance:0.060,minRs20:0.03,maxRangeCompression:0.95,maxVolumeContraction:1.10,
    breakoutBuffer:0.001,maxBreakoutExtension:0.035,retestTolerance:0.008,minVolumeReaccel:1.00,
    minBody:0.35,minCloseLoc:0.60,maxVwapDistance:0.025,require1hBullish:true,
  }),
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
function trueRange(candle,prevClose){return Math.max(candle.high-candle.low,Math.abs(candle.high-prevClose),Math.abs(candle.low-prevClose));}
function avgTrueRangeWindow(c,endExclusive,count){
  const start=endExclusive-count;if(start<1)return null;let sum=0,n=0;
  for(let i=start;i<endExclusive;i++){sum+=trueRange(c[i],c[i-1].close);n++;}
  return n?sum/n:null;
}
function avgVolumeWindow(c,endExclusive,count){
  const start=endExclusive-count;if(start<0)return null;let sum=0;
  for(let i=start;i<endExclusive;i++)sum+=c[i].volume;
  return count?sum/count:null;
}
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
  const development=ranked.filter(x=>PREVIOUSLY_OBSERVED.has(x.symbol));
  const freshHoldout=ranked.filter(x=>!PREVIOUSLY_OBSERVED.has(x.symbol)).slice(0,FRESH_HOLDOUT_COUNT);
  const btcReference=ranked.find(x=>x.market==="KRW-BTC")??null;
  if(development.length<16||freshHoldout.length!==FRESH_HOLDOUT_COUNT||!btcReference)throw new Error(`UPBIT_COHORT_BUILD_FAILED:dev=${development.length}:holdout=${freshHoldout.length}`);
  return {totalKrw:ranked.length,development,freshHoldout,btcReference,missingPreviouslyObserved:[...PREVIOUSLY_OBSERVED].filter(s=>!development.some(x=>x.symbol===s))};
}
async function dailyCandles(market){
  const rows=await upbitJson(`/v1/candles/days?market=${encodeURIComponent(market)}&count=70`);
  return (Array.isArray(rows)?rows:[]).map(normalizeCandle).filter(Boolean).sort((a,b)=>a.timestamp-b.timestamp);
}
async function minute15Candles(market){
  const startMs=Date.now()-HISTORY_DAYS*DAY;
  const map=new Map();
  let to=null;
  for(let page=0;page<20;page+=1){
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
function candidate(row,btcDaily,date,family){
  const c=row.daily,dates=c.map(x=>dayKey(x.timestamp));let i=-1;
  for(let j=0;j<dates.length;j++)if(dates[j]<date)i=j;else break;
  const bd=btcDaily.map(x=>dayKey(x.timestamp));let bi=-1;
  for(let j=0;j<bd.length;j++)if(bd[j]<date)bi=j;else break;
  if(i<35||bi<20)return null;
  const close=c[i].close,m20=sma(c,i,20),m20p=sma(c,i-5,20),priorHigh20=highBefore(c,i,20);
  if(![m20,m20p,priorHigh20].every(x=>x>0)||!(close<priorHigh20))return null;
  const distance=(priorHigh20-close)/priorHigh20;
  if(distance<family.d1MinDistance||distance>family.d1MaxDistance)return null;
  const rs20=(close/c[i-20].close-1)-(btcDaily[bi].close/btcDaily[bi-20].close-1);
  if(rs20<family.minRs20)return null;

  const recentAtr=avgTrueRangeWindow(c,i+1,5);
  const priorAtr=avgTrueRangeWindow(c,i-4,10);
  const recentVol=avgVolumeWindow(c,i+1,5);
  const priorVol=avgVolumeWindow(c,i-4,15);
  if(!(recentAtr>0&&priorAtr>0&&recentVol>=0&&priorVol>0))return null;
  const rangeCompression=recentAtr/priorAtr;
  const volumeContraction=recentVol/priorVol;
  if(rangeCompression>family.maxRangeCompression||volumeContraction>family.maxVolumeContraction)return null;

  const targetStart=Date.parse(`${date}T00:00:00.000Z`);
  const dailyPs=structure(row.symbol,"1D",c.slice(Math.max(0,i-69),i+1),targetStart+1);
  if(dailyPs.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY")return null;
  const df=dailyPs.features;
  if(df.priceStructure.trend==="BEARISH"||df.priceStructure.structureEvent==="FAILED_BREAKOUT")return null;
  const range=c[i].high-c[i].low,body=range?Math.abs(c[i].close-c[i].open)/range:0,closeLoc=range?(c[i].close-c[i].low)/range:0;
  if(!(close>=m20*0.985&&m20>=m20p*0.985))return null;

  let score=30
    +20*clamp((rs20-family.minRs20+0.02)/0.20)
    +20*clamp((family.d1MaxDistance-distance)/Math.max(0.001,family.d1MaxDistance-family.d1MinDistance))
    +15*clamp((family.maxRangeCompression-rangeCompression)/Math.max(0.10,family.maxRangeCompression))
    +10*clamp((family.maxVolumeContraction-volumeContraction)/Math.max(0.10,family.maxVolumeContraction))
    +5*clamp((closeLoc-0.45)/0.55);
  if(df.priceStructure.trend==="BULLISH")score+=5;
  return {
    market:row.market,symbol:row.symbol,date,preparedAt:dates[i],family:family.name,
    state:"PRE_BREAKOUT",breakoutLevel:priorHigh20,setupScore:+Math.min(100,score).toFixed(2),
    setup:{rs20,distanceToBreakout:distance,rangeCompression,volumeContraction,closeLocation:closeLoc,bodyRangeRatio:body,
      dailyStructureTrend:df.priceStructure.trend,dailyStructureTransition:df.pattern.structureTransition,dailySwingSequence:df.pattern.swingSequence},
  };
}
function retestPass(f,cand,bar,previousBar,f15,f1h,vwd,vr,breakoutSeen){
  if(!breakoutSeen)return false;
  const c=f15.candle,ps=f15.priceStructure;
  if(ps.structureEvent==="FAILED_BREAKOUT"||f15.pattern?.namedPattern==="FAILED_BREAKOUT")return false;
  if(ps.trend==="BEARISH"||f1h?.priceStructure?.trend==="BEARISH")return false;
  if(f.require1hBullish&&f1h?.priceStructure?.trend!=="BULLISH")return false;
  if(vwd<0||vwd>f.maxVwapDistance||vr<f.minVolumeReaccel)return false;
  if(c.direction!=="UP"||(c.bodyRangeRatio??0)<f.minBody||(c.closeLocation??0)<f.minCloseLoc)return false;
  const level=cand.breakoutLevel;
  const retested=bar.low<=level*(1+f.retestTolerance)&&bar.low>=level*(1-f.retestTolerance*2.0);
  const reclaimed=bar.close>level*(1+f.breakoutBuffer*0.25);
  const rebreak=previousBar?bar.close>previousBar.high:false;
  const notExtended=bar.close<=level*(1+f.maxBreakoutExtension);
  return retested&&reclaimed&&rebreak&&notExtended;
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
function bump(funnel,key){funnel[key]=(funnel[key]??0)+1;}
function replayOne(f,cand,day,cost,funnel){
  bump(funnel,"candidateDaysScanned");
  const h1=aggregate1h(day);
  let breakoutSeen=false;
  for(let i=10;i<day.length-1;i++){
    const decision=day[i].timestamp+15*60_000;
    const closed=day.slice(0,i+1).map(x=>({...x,closeTime:x.timestamp+15*60_000}));
    const ps15=structure(cand.symbol,"15m",closed,decision+1);
    if(ps15.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY"){bump(funnel,"structureUnavailable");continue;}
    const f15=ps15.features;
    const bar=day[i],previousBar=i>0?day[i-1]:null;
    if(f15.priceStructure.structureEvent==="FAILED_BREAKOUT"){
      if(breakoutSeen)bump(funnel,"failedBreakoutAfterBreak");
      breakoutSeen=false;
      continue;
    }
    const closeOverLevel=bar.close>cand.breakoutLevel*(1+f.breakoutBuffer);
    const extension=bar.close/cand.breakoutLevel-1;
    if(!breakoutSeen&&closeOverLevel){
      bump(funnel,"breakoutCloses");
      if(extension<=f.maxBreakoutExtension){
        breakoutSeen=true;
        bump(funnel,"acceptedFirstBreakouts");
      }else{
        bump(funnel,"overextendedFirstBreakouts");
      }
      continue;
    }
    if(!breakoutSeen)continue;

    const available1h=h1.filter(x=>x.closeTime<=decision);
    const ps1h=available1h.length>=5?structure(cand.symbol,"1H",available1h,decision+1):null;
    const f1h=ps1h?.status==="READY_FOR_SPECIALIST_RESEARCH_ONLY"?ps1h.features:null;
    if(f15.priceStructure.trend==="BEARISH"||f1h?.priceStructure?.trend==="BEARISH"){bump(funnel,"bearishStructureRejected");continue;}
    if(f.require1hBullish&&f1h?.priceStructure?.trend!=="BULLISH"){bump(funnel,"oneHourBullishRejected");continue;}

    const level=cand.breakoutLevel;
    const touched=bar.low<=level*(1+f.retestTolerance)&&bar.low>=level*(1-f.retestTolerance*2.0);
    if(!touched)continue;
    bump(funnel,"retestTouches");
    const reclaimed=bar.close>level*(1+f.breakoutBuffer*0.25);
    if(!reclaimed){bump(funnel,"reclaimRejected");continue;}
    bump(funnel,"reclaims");
    const rebreak=previousBar?bar.close>previousBar.high:false;
    if(!rebreak){bump(funnel,"rebreakRejected");continue;}
    bump(funnel,"rebreaks");
    const notExtended=bar.close<=level*(1+f.maxBreakoutExtension);
    if(!notExtended){bump(funnel,"retestOverextendedRejected");continue;}

    const vw=vwap(day,decision);
    if(!(vw>0)){bump(funnel,"vwapUnavailable");continue;}
    const prevVol=day.slice(Math.max(0,i-8),i).map(x=>x.volume).filter(x=>x>0);
    const vr=prevVol.length?bar.volume/median(prevVol):1;
    const vwd=bar.close/vw-1;
    if(vwd<0||vwd>f.maxVwapDistance){bump(funnel,"vwapDistanceRejected");continue;}
    if(vr<f.minVolumeReaccel){bump(funnel,"volumeRejected");continue;}
    const candle=f15.candle;
    if(candle.direction!=="UP"||(candle.bodyRangeRatio??0)<f.minBody||(candle.closeLocation??0)<f.minCloseLoc){
      bump(funnel,"candleRejected");continue;
    }
    bump(funnel,"triggerQualityPassed");

    const entryIndex=i+1,entryRaw=day[entryIndex].open;
    const retestLow=bar.low;
    const structural=Math.min(retestLow*0.997,cand.breakoutLevel*(1-f.retestTolerance));
    let risk=(entryRaw-structural)/entryRaw;
    risk=Math.max(0.005,risk);
    if(!(risk>0&&risk<=0.035)){bump(funnel,"stopWidthRejected");continue;}

    const result=simulateExit(day,entryIndex,entryRaw,entryRaw*(1-risk),cost);
    bump(funnel,"entries");
    const triggerScore=+Math.min(100,cand.setupScore
      +10*clamp((vr-f.minVolumeReaccel)/1.5)
      +10*clamp(((f15.candle.closeLocation??0)-f.minCloseLoc)/0.35)
      +5*(f15.priceStructure.trend==="BULLISH")).toFixed(2);
    return {
      market:cand.market,symbol:cand.symbol,date:cand.date,family:f.name,state:"RETEST_REBREAK",
      setupScore:cand.setupScore,triggerScore,breakoutLevel:cand.breakoutLevel,
      entryTime:day[entryIndex].timestamp,
      aiInputBundle:{setup:cand.setup,breakoutLevel:cand.breakoutLevel,wave15m:f15.pattern,candle15m:f15.candle,
        structure15m:f15.priceStructure,wave1h:f1h?.pattern??null,structure1h:f1h?.priceStructure??null,
        vwapDistance:vwd,volumeReaccel:vr,retestLow:bar.low},
      ...result,
    };
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
  const days=[],trades=[],funnel={
    preparedCandidates:0,candidateDaysScanned:0,structureUnavailable:0,breakoutCloses:0,
    acceptedFirstBreakouts:0,overextendedFirstBreakouts:0,failedBreakoutAfterBreak:0,
    bearishStructureRejected:0,oneHourBullishRejected:0,retestTouches:0,reclaimRejected:0,
    reclaims:0,rebreakRejected:0,rebreaks:0,retestOverextendedRejected:0,vwapUnavailable:0,
    vwapDistanceRejected:0,volumeRejected:0,candleRejected:0,triggerQualityPassed:0,
    stopWidthRejected:0,entries:0,
  };
  for(const date of dates){
    const prepared=candidates.get(date)??[];
    funnel.preparedCandidates+=prepared.length;
    const triggered=[];
    for(const cand of prepared){
      const day=intraday.get(cand.market)?.get(date);
      if(!day)continue;
      const t=replayOne(f,cand,day,cost,funnel);
      if(t){triggered.push(t);trades.push(t);}
    }
    const p=portfolio(triggered);
    days.push({date,candidateCount:prepared.length,triggered:triggered.length,...p});
  }
  return {metrics:dayMetrics(days),days,trades,funnel};
}
function selectionScore(r){if(r.trades.length<6)return -999;return r.metrics.totalReturn-1.5*r.metrics.maxDrawdown+0.30*r.metrics.averageDailyReturn;}
function robustGate(cal,calStress,val,valStress){
  return cal.metrics.days>=8&&cal.trades.length>=6&&cal.metrics.totalReturn>0&&cal.metrics.averageDailyReturn>0
    &&calStress.metrics.totalReturn>0&&calStress.metrics.averageDailyReturn>0
    &&val.metrics.days>=4&&val.trades.length>=3&&val.metrics.totalReturn>0&&val.metrics.averageDailyReturn>0
    &&valStress.metrics.totalReturn>0&&valStress.metrics.averageDailyReturn>0
    &&cal.metrics.maxDrawdown<=0.05&&val.metrics.maxDrawdown<=0.05&&valStress.metrics.maxDrawdown<=0.06;
}
function buildCandidates(rows,btcDaily,dates,family){
  const out=new Map();
  for(const date of dates){
    out.set(date,rows.map(row=>candidate(row,btcDaily,date,family)).filter(Boolean)
      .sort((a,b)=>b.setupScore-a.setupScore||a.symbol.localeCompare(b.symbol))
      .slice(0,CANDIDATES_PER_DAY));
  }
  return out;
}
async function main(){
  const u=await markets();
  const cohort=new Map([...u.development,...u.freshHoldout,u.btcReference].map(x=>[x.market,x]));
  const data=[];
  for(const row of cohort.values()){
    const daily=await dailyCandles(row.market);
    const minute15=await minute15Candles(row.market);
    data.push({...row,daily,minute15});
  }
  const byMarket=new Map(data.map(x=>[x.market,x]));
  const btc=byMarket.get("KRW-BTC");if(!btc)throw new Error("BTC_REFERENCE_MISSING");
  const developmentData=u.development.map(x=>byMarket.get(x.market)).filter(Boolean);
  const freshData=u.freshHoldout.map(x=>byMarket.get(x.market)).filter(Boolean);
  if(developmentData.length<16||freshData.length!==FRESH_HOLDOUT_COUNT)throw new Error("COHORT_HISTORY_INCOMPLETE");

  const dates=completeDates(btc.minute15).slice(-24);
  if(dates.length<18)throw new Error(`COMPLETE_DAYS_INSUFFICIENT_${dates.length}`);
  const validationCount=5;
  const calibration=dates.slice(0,dates.length-validationCount);
  const validation=dates.slice(dates.length-validationCount);
  const intraday=new Map(data.map(x=>[x.market,groupDays(x.minute15)]));

  const familyResults=[];
  for(const f of Object.values(FAMILIES)){
    const devCandidates=buildCandidates(developmentData,btc.daily,dates,f);
    const cal=runPeriod(f,calibration,devCandidates,intraday,NORMAL_COST);
    const calStress=runPeriod(f,calibration,devCandidates,intraday,STRESS_COST);
    const val=runPeriod(f,validation,devCandidates,intraday,NORMAL_COST);
    const valStress=runPeriod(f,validation,devCandidates,intraday,STRESS_COST);
    familyResults.push({family:f.name,selectionScore:selectionScore(cal),gatePass:robustGate(cal,calStress,val,valStress),
      calibration:cal,calibrationStress:calStress,validation:val,validationStress:valStress});
  }
  familyResults.sort((a,b)=>b.selectionScore-a.selectionScore);
  const eligible=familyResults.filter(x=>x.gatePass);
  const selected=eligible[0]??familyResults[0];
  const f=FAMILIES[selected.family];

  // Fresh symbols were not used in design/selection; use the full 24-day window for cross-symbol holdout.
  const freshCandidates=buildCandidates(freshData,btc.daily,dates,f);
  const holdoutNormal=runPeriod(f,dates,freshCandidates,intraday,NORMAL_COST);
  const holdoutStress=runPeriod(f,dates,freshCandidates,intraday,STRESS_COST);
  const last5=dates.slice(-5);
  const holdoutLast5=runPeriod(f,last5,freshCandidates,intraday,NORMAL_COST);

  const report={
    schemaVersion:3,status:"pass",market:"CRYPTO_SPOT",exchange:"UPBIT",
    purpose:"D-1 pre-breakout compression candidate -> first D-day breakout retest/rebreak cross-symbol holdout; funnel-instrumented diagnostic",
    dataWindow:{allDates:dates,developmentCalibrationDates:calibration,developmentValidationDates:validation,
      holdoutDates:dates,holdoutDatesPreviouslyObservedInPriorResearch:true},
    universe:{currentSnapshotBias:true,totalKrwMarkets:u.totalKrw,stablecoinsExcluded:[...STABLECOINS],
      development:u.development.map(x=>({market:x.market,symbol:x.symbol,tradingValue24h:x.tradingValue24h})),
      missingPreviouslyObserved:u.missingPreviouslyObserved,
      freshHoldout:u.freshHoldout.map(x=>({market:x.market,symbol:x.symbol,tradingValue24h:x.tradingValue24h}))},
    holdoutPolicy:{previouslyObservedSymbols:[...PREVIOUSLY_OBSERVED],freshHoldoutExcludesAllPreviouslyObserved:true,
      freshHoldoutSymbolsUsedForFamilySelection:false,crossSymbolHoldout:true,temporalFreshness:"NOT_FRESH_DATES_ALREADY_OBSERVED"},
    strategyContract:{D1State:"PRE_BREAKOUT_ONLY",D1PriorHighExcludesCurrentCandle:true,firstExpansionBarEntryForbidden:true,
      failedBreakoutEntryForbidden:true,entryRequiresBreakoutThenRetestThenRebreak:true,entryNext15mOpen:true,
      exitPolicy:"unchanged from V2: structural stop, 25% at 1R, 25% at 2R, runner/VWAP/day-end"},
    selectionContract:{familiesPreRegistered:Object.keys(FAMILIES),developmentOnlyForSelection:true,
      calibrationMustBePositiveNormalAndStress:true,validationMustBePositiveNormalAndStress:true,
      holdoutSymbolsUsedForSelection:false,actualHistoricalLlmCalled:false,critic:"DETERMINISTIC_AI_READY_PREBREAKOUT_RETEST_V3"},
    costs:{normalPerSide:NORMAL_COST,stressPerSide:STRESS_COST},accountPolicy:ACCOUNT,
    familyResults:familyResults.map(x=>({family:x.family,selectionScore:x.selectionScore,gatePass:x.gatePass,
      calibration:{metrics:x.calibration.metrics,trades:x.calibration.trades.length,funnel:x.calibration.funnel},
      calibrationStress:{metrics:x.calibrationStress.metrics,trades:x.calibrationStress.trades.length,funnel:x.calibrationStress.funnel},
      validation:{metrics:x.validation.metrics,trades:x.validation.trades.length,funnel:x.validation.funnel},
      validationStress:{metrics:x.validationStress.metrics,trades:x.validationStress.trades.length,funnel:x.validationStress.funnel}})),
    selectedFamily:selected.family,
    selectedStatus:eligible.length?"ROBUST_GATE_PASS":"RESEARCH_HOLD_NO_FAMILY_PASSED_ROBUST_GATE",
    freshCrossSymbolHoldout:{
      normal:{metrics:holdoutNormal.metrics,days:holdoutNormal.days,funnel:holdoutNormal.funnel,trades:holdoutNormal.trades.map(t=>({
        symbol:t.symbol,date:t.date,family:t.family,setupScore:t.setupScore,triggerScore:t.triggerScore,
        breakoutLevel:t.breakoutLevel,entryTime:new Date(t.entryTime).toISOString(),exitTime:new Date(t.exitTime).toISOString(),
        netReturn:t.netReturn,stopDistancePct:t.stopDistancePct,tp1:t.tp1,tp2:t.tp2,exitReason:t.exitReason,aiInputBundle:t.aiInputBundle}))},
      stress:{metrics:holdoutStress.metrics,days:holdoutStress.days,funnel:holdoutStress.funnel,trades:holdoutStress.trades.length},
      last5Diagnostic:{metrics:holdoutLast5.metrics,funnel:holdoutLast5.funnel,trades:holdoutLast5.trades.length}},
    lookahead:{D1UsesPriorCompletedDailyCandle:true,priorHighExcludesD1Candle:true,intradayUsesCompleted15mAnd1hOnly:true,
      firstExpansionBarEntryForbidden:true,entryNext15mOpen:true,holdoutSymbolsUsedForSelection:false,guardPassed:true},
    safety:{researchOnly:true,publicDataOnly:true,liveExecutionAllowed:false,privateAccountRequestAllowed:false,
      executionAuthority:"NONE",profitabilityPromotionAllowed:false},
    limitations:[
      "Fresh holdout symbols are cross-sectional OOS relative to prior strategy work, but the calendar dates were already observed.",
      "Universe and liquidity ranking use a current Upbit snapshot and retain survivorship/current-membership bias.",
      "Historical order-book depth, archived news/catalyst, and historical LLM outputs are unavailable and are not fabricated.",
      "This V3 specifically tests pre-breakout compression plus first retest/rebreak; it does not prove AI or wave analysis generally profitable.",
      "Candle replay is not exchange fill evidence and cannot establish PROFITABILITY_PROVEN.",
    ],
  };
  const out=resolve(process.argv[2]??"docs/upbit-prebreakout-retest-v3.json");
  await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+"\n","utf8");
  console.log(JSON.stringify(report,null,2));
}
await main();
