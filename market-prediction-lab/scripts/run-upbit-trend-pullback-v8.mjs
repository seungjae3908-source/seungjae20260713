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
const FRESH_HOLDOUT_SKIP=72;
const FRESH_HOLDOUT_COUNT=12;
const V5_INTRADAY_PROFILE=Object.freeze({rs1hMin:0.015,valueAccelMin:2.0,volumeReaccelMin:1.5,maxVwapDistance:0.03,minBody:0.45,minCloseLoc:0.70,btc1hFloor:-0.015});
const V6_RETEST_PROFILE=Object.freeze({maxBarsToRetest:6,maxVwapDistance:0.025,minRetestBody:0.25,minRetestCloseLoc:0.60,minReexpansion:1.10});
const V7_REBREAK_PROFILE=Object.freeze({maxBarsAfterRetest:3,maxVwapDistance:0.03,minBody:0.35,minCloseLoc:0.65,minRebreakVolumeExpansion:1.20});
const V8_PULLBACK_PROFILE=Object.freeze({rs1hMin:0.005,btc1hFloor:-0.005,maxVwapDistance:0.015,minBody:0.35,minCloseLoc:0.65,maxPullbackVolumeRatio:0.85,minReexpansion:1.20,maxStopDistance:0.03});
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


function alignedReturn(day,index,lookback){
  if(index<lookback)return null;
  const past=day[index-lookback]?.close,current=day[index]?.close;
  return past>0&&current>0?current/past-1:null;
}
function meanPriorTradingValue(day,index,lookback){
  if(index-lookback<0)return null;
  let total=0;
  for(let i=index-lookback;i<index;i++)total+=Number(day[i]?.tradingValue??0);
  return total/lookback;
}
function intradayDiscoveryTrade(row,btcDay,date,cost){
  const day=row.dayMap?.get(date);
  if(!day||day.length<40||!btcDay||btcDay.length<40)return null;
  const btcByTs=new Map(btcDay.map((bar,i)=>[bar.timestamp,{bar,i}]));
  const h1=aggregate1h(day);
  for(let i=10;i<day.length-1;i++){
    const current=day[i];
    const btcNow=btcByTs.get(current.timestamp);
    if(!btcNow||btcNow.i<4)continue;
    const stock1h=alignedReturn(day,i,4);
    const btc1h=alignedReturn(btcDay,btcNow.i,4);
    if(stock1h==null||btc1h==null||btc1h<V5_INTRADAY_PROFILE.btc1hFloor)continue;
    const rs1h=stock1h-btc1h;
    if(rs1h<V5_INTRADAY_PROFILE.rs1hMin)continue;

    const avgValue=meanPriorTradingValue(day,i,8);
    const valueAccel=avgValue&&avgValue>0?current.tradingValue/avgValue:null;
    if(valueAccel==null||valueAccel<V5_INTRADAY_PROFILE.valueAccelMin)continue;

    const prevVolumes=day.slice(Math.max(0,i-8),i).map(x=>x.volume).filter(x=>x>0);
    const volumeReaccel=prevVolumes.length?current.volume/median(prevVolumes):1;
    if(volumeReaccel<V5_INTRADAY_PROFILE.volumeReaccelMin)continue;

    const decision=current.timestamp+15*60_000;
    const closed=day.slice(0,i+1).map(x=>({...x,closeTime:x.timestamp+15*60_000}));
    const ps15=structure(row.symbol,"15m",closed,decision+1);
    if(ps15.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY")continue;
    const available1h=h1.filter(x=>x.closeTime<=decision);
    const ps1h=available1h.length>=5?structure(row.symbol,"1H",available1h,decision+1):null;
    const f15=ps15.features;
    const f1h=ps1h?.status==="READY_FOR_SPECIALIST_RESEARCH_ONLY"?ps1h.features:null;
    if(f15.priceStructure.trend!=="BULLISH")continue;
    if(f15.priceStructure.structureEvent==="FAILED_BREAKOUT")continue;
    if(f15.pattern.structureTransition!=="BOS_UP")continue;
    if(f1h?.priceStructure?.trend==="BEARISH")continue;

    const candle=f15.candle;
    if(candle.direction!=="UP"||(candle.bodyRangeRatio??0)<V5_INTRADAY_PROFILE.minBody||(candle.closeLocation??0)<V5_INTRADAY_PROFILE.minCloseLoc)continue;

    const vw=vwap(day,decision);
    if(!(vw>0))continue;
    const vwd=current.close/vw-1;
    if(vwd<0||vwd>V5_INTRADAY_PROFILE.maxVwapDistance)continue;

    const entryIndex=i+1,entryRaw=day[entryIndex].open,support=f15.priceStructure.support;
    let risk=support&&support<entryRaw?(entryRaw-support*0.998)/entryRaw:0.015;
    risk=Math.max(0.006,risk);
    if(risk>0.04)continue;
    const exit=simulateExit(day,entryIndex,entryRaw,entryRaw*(1-risk),cost);
    const triggerScore=+Math.min(100,
      55
      +15*clamp((rs1h-V5_INTRADAY_PROFILE.rs1hMin)/0.05)
      +10*clamp((valueAccel-V5_INTRADAY_PROFILE.valueAccelMin)/3)
      +10*clamp((volumeReaccel-V5_INTRADAY_PROFILE.volumeReaccelMin)/3)
      +10*clamp(((candle.closeLocation??0)-V5_INTRADAY_PROFILE.minCloseLoc)/0.30)
    ).toFixed(2);
    return {
      market:row.market,symbol:row.symbol,date,source:"INTRADAY_DISCOVERY_V5",family:"V5_INTRADAY_DISCOVERY",
      setupScore:0,triggerScore,entryTime:day[entryIndex].timestamp,
      aiInputBundle:{
        rs1h,valueAccel,volumeReaccel,btc1h,
        wave15m:f15.pattern,candle15m:f15.candle,structure15m:f15.priceStructure,
        wave1h:f1h?.pattern??null,structure1h:f1h?.priceStructure??null,vwapDistance:vwd
      },
      ...exit
    };
  }
  return null;
}


function intradayRetestTrade(row,btcDay,date,cost){
  const day=row.dayMap?.get(date);
  if(!day||day.length<40||!btcDay||btcDay.length<40)return null;
  const btcByTs=new Map(btcDay.map((bar,i)=>[bar.timestamp,{bar,i}]));
  const h1=aggregate1h(day);
  for(let i=10;i<day.length-2;i++){
    const bosBar=day[i],btcNow=btcByTs.get(bosBar.timestamp);
    if(!btcNow||btcNow.i<4)continue;
    const stock1h=alignedReturn(day,i,4),btc1h=alignedReturn(btcDay,btcNow.i,4);
    if(stock1h==null||btc1h==null||btc1h<V5_INTRADAY_PROFILE.btc1hFloor)continue;
    const rs1h=stock1h-btc1h;
    if(rs1h<V5_INTRADAY_PROFILE.rs1hMin)continue;
    const avgValue=meanPriorTradingValue(day,i,8);
    const valueAccel=avgValue&&avgValue>0?bosBar.tradingValue/avgValue:null;
    if(valueAccel==null||valueAccel<V5_INTRADAY_PROFILE.valueAccelMin)continue;
    const prevVolumes=day.slice(Math.max(0,i-8),i).map(x=>x.volume).filter(x=>x>0);
    const volumeReaccel=prevVolumes.length?bosBar.volume/median(prevVolumes):1;
    if(volumeReaccel<V5_INTRADAY_PROFILE.volumeReaccelMin)continue;

    const bosDecision=bosBar.timestamp+15*60_000;
    const bosClosed=day.slice(0,i+1).map(x=>({...x,closeTime:x.timestamp+15*60_000}));
    const bosPs=structure(row.symbol,"15m",bosClosed,bosDecision+1);
    if(bosPs.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY")continue;
    const bos15=bosPs.features;
    const bos1hBars=h1.filter(x=>x.closeTime<=bosDecision);
    const bos1hPs=bos1hBars.length>=5?structure(row.symbol,"1H",bos1hBars,bosDecision+1):null;
    const bos1h=bos1hPs?.status==="READY_FOR_SPECIALIST_RESEARCH_ONLY"?bos1hPs.features:null;
    if(bos15.priceStructure.trend!=="BULLISH"||bos15.priceStructure.structureEvent==="FAILED_BREAKOUT"||bos15.pattern.structureTransition!=="BOS_UP"||bos1h?.priceStructure?.trend==="BEARISH")continue;
    const bosCandle=bos15.candle;
    if(bosCandle.direction!=="UP"||(bosCandle.bodyRangeRatio??0)<V5_INTRADAY_PROFILE.minBody||(bosCandle.closeLocation??0)<V5_INTRADAY_PROFILE.minCloseLoc)continue;
    const bosVwap=vwap(day,bosDecision);
    if(!(bosVwap>0))continue;
    const bosVwd=bosBar.close/bosVwap-1;
    if(bosVwd<0||bosVwd>V5_INTRADAY_PROFILE.maxVwapDistance)continue;

    const end=Math.min(day.length-2,i+V6_RETEST_PROFILE.maxBarsToRetest);
    for(let j=i+1;j<=end;j++){
      const retestBar=day[j],decision=retestBar.timestamp+15*60_000;
      const closed=day.slice(0,j+1).map(x=>({...x,closeTime:x.timestamp+15*60_000}));
      const ps15=structure(row.symbol,"15m",closed,decision+1);
      if(ps15.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY")continue;
      const f15=ps15.features;
      if(f15.priceStructure.structureEvent==="FAILED_BREAKOUT"||f15.pattern.structureTransition==="CHOCH_DOWN")break;
      const available1h=h1.filter(x=>x.closeTime<=decision);
      const ps1h=available1h.length>=5?structure(row.symbol,"1H",available1h,decision+1):null;
      const f1h=ps1h?.status==="READY_FOR_SPECIALIST_RESEARCH_ONLY"?ps1h.features:null;
      if(f1h?.priceStructure?.trend==="BEARISH")continue;
      const retestHeld=f15.priceStructure.structureEvent==="RETEST_HELD"||f15.pattern.namedPattern==="RETEST_HELD"||f15.pattern.retestHold===true;
      if(!retestHeld)continue;
      const vw=vwap(day,decision);
      if(!(vw>0))continue;
      const vwd=retestBar.close/vw-1;
      if(vwd<0||vwd>V6_RETEST_PROFILE.maxVwapDistance)continue;
      const candle=f15.candle;
      if(candle.direction!=="UP"||(candle.bodyRangeRatio??0)<V6_RETEST_PROFILE.minRetestBody||(candle.closeLocation??0)<V6_RETEST_PROFILE.minRetestCloseLoc)continue;
      const pullbackVolumes=day.slice(i+1,j).map(x=>x.volume).filter(x=>x>0);
      const pullbackMedian=pullbackVolumes.length?median(pullbackVolumes):bosBar.volume;
      const reexpansion=pullbackMedian>0?retestBar.volume/pullbackMedian:1;
      if(reexpansion<V6_RETEST_PROFILE.minReexpansion)continue;

      const entryIndex=j+1,entryRaw=day[entryIndex].open,support=f15.priceStructure.support;
      let risk=support&&support<entryRaw?(entryRaw-support*0.998)/entryRaw:0.015;
      risk=Math.max(0.006,risk);
      if(risk>0.04)continue;
      const exit=simulateExit(day,entryIndex,entryRaw,entryRaw*(1-risk),cost);
      const triggerScore=+Math.min(100,
        60
        +10*clamp((rs1h-V5_INTRADAY_PROFILE.rs1hMin)/0.05)
        +10*clamp((valueAccel-V5_INTRADAY_PROFILE.valueAccelMin)/3)
        +10*clamp((reexpansion-V6_RETEST_PROFILE.minReexpansion)/2)
        +10*clamp(((candle.closeLocation??0)-V6_RETEST_PROFILE.minRetestCloseLoc)/0.40)
      ).toFixed(2);
      return {
        market:row.market,symbol:row.symbol,date,source:"INTRADAY_RETEST_V6",family:"V6_BOS_RETEST_REEXPANSION",
        setupScore:0,triggerScore,entryTime:day[entryIndex].timestamp,
        aiInputBundle:{
          bos:{rs1h,valueAccel,volumeReaccel,btc1h,vwapDistance:bosVwd,wave15m:bos15.pattern,candle15m:bos15.candle,structure15m:bos15.priceStructure},
          retest:{barsAfterBos:j-i,reexpansion,vwapDistance:vwd,wave15m:f15.pattern,candle15m:f15.candle,structure15m:f15.priceStructure,wave1h:f1h?.pattern??null,structure1h:f1h?.priceStructure??null}
        },
        ...exit
      };
    }
  }
  return null;
}

function intradayRetestRebreakTrade(row,btcDay,date,cost){
  const day=row.dayMap?.get(date);
  if(!day||day.length<40||!btcDay||btcDay.length<40)return null;
  const btcByTs=new Map(btcDay.map((bar,i)=>[bar.timestamp,{bar,i}]));
  const h1=aggregate1h(day);
  for(let i=10;i<day.length-3;i++){
    const bosBar=day[i],btcNow=btcByTs.get(bosBar.timestamp);
    if(!btcNow||btcNow.i<4)continue;
    const stock1h=alignedReturn(day,i,4),btc1h=alignedReturn(btcDay,btcNow.i,4);
    if(stock1h==null||btc1h==null||btc1h<V5_INTRADAY_PROFILE.btc1hFloor)continue;
    const rs1h=stock1h-btc1h;
    if(rs1h<V5_INTRADAY_PROFILE.rs1hMin)continue;
    const avgValue=meanPriorTradingValue(day,i,8);
    const valueAccel=avgValue&&avgValue>0?bosBar.tradingValue/avgValue:null;
    if(valueAccel==null||valueAccel<V5_INTRADAY_PROFILE.valueAccelMin)continue;
    const prevVolumes=day.slice(Math.max(0,i-8),i).map(x=>x.volume).filter(x=>x>0);
    const volumeReaccel=prevVolumes.length?bosBar.volume/median(prevVolumes):1;
    if(volumeReaccel<V5_INTRADAY_PROFILE.volumeReaccelMin)continue;

    const bosDecision=bosBar.timestamp+15*60_000;
    const bosClosed=day.slice(0,i+1).map(x=>({...x,closeTime:x.timestamp+15*60_000}));
    const bosPs=structure(row.symbol,"15m",bosClosed,bosDecision+1);
    if(bosPs.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY")continue;
    const bos15=bosPs.features;
    const bos1hBars=h1.filter(x=>x.closeTime<=bosDecision);
    const bos1hPs=bos1hBars.length>=5?structure(row.symbol,"1H",bos1hBars,bosDecision+1):null;
    const bos1h=bos1hPs?.status==="READY_FOR_SPECIALIST_RESEARCH_ONLY"?bos1hPs.features:null;
    if(bos15.priceStructure.trend!=="BULLISH"||bos15.priceStructure.structureEvent==="FAILED_BREAKOUT"||bos15.pattern.structureTransition!=="BOS_UP"||bos1h?.priceStructure?.trend==="BEARISH")continue;
    const bosCandle=bos15.candle;
    if(bosCandle.direction!=="UP"||(bosCandle.bodyRangeRatio??0)<V5_INTRADAY_PROFILE.minBody||(bosCandle.closeLocation??0)<V5_INTRADAY_PROFILE.minCloseLoc)continue;
    const bosVwap=vwap(day,bosDecision);
    if(!(bosVwap>0))continue;
    const bosVwd=bosBar.close/bosVwap-1;
    if(bosVwd<0||bosVwd>V5_INTRADAY_PROFILE.maxVwapDistance)continue;

    const retestEnd=Math.min(day.length-3,i+V6_RETEST_PROFILE.maxBarsToRetest);
    for(let j=i+1;j<=retestEnd;j++){
      const retestBar=day[j],decision=retestBar.timestamp+15*60_000;
      const closed=day.slice(0,j+1).map(x=>({...x,closeTime:x.timestamp+15*60_000}));
      const ps15=structure(row.symbol,"15m",closed,decision+1);
      if(ps15.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY")continue;
      const f15=ps15.features;
      if(f15.priceStructure.structureEvent==="FAILED_BREAKOUT"||f15.pattern.structureTransition==="CHOCH_DOWN")break;
      const available1h=h1.filter(x=>x.closeTime<=decision);
      const ps1h=available1h.length>=5?structure(row.symbol,"1H",available1h,decision+1):null;
      const f1h=ps1h?.status==="READY_FOR_SPECIALIST_RESEARCH_ONLY"?ps1h.features:null;
      if(f1h?.priceStructure?.trend==="BEARISH")continue;
      const retestHeld=f15.priceStructure.structureEvent==="RETEST_HELD"||f15.pattern.namedPattern==="RETEST_HELD"||f15.pattern.retestHold===true;
      if(!retestHeld)continue;
      const retestVwap=vwap(day,decision);
      if(!(retestVwap>0)||retestBar.close<retestVwap)continue;

      const pullbackVolumes=day.slice(i+1,j+1).map(x=>x.volume).filter(x=>x>0);
      const pullbackMedian=pullbackVolumes.length?median(pullbackVolumes):bosBar.volume;
      const rebreakEnd=Math.min(day.length-2,j+V7_REBREAK_PROFILE.maxBarsAfterRetest);
      for(let k=j+1;k<=rebreakEnd;k++){
        const rebreakBar=day[k],rebreakDecision=rebreakBar.timestamp+15*60_000;
        const rebreakClosed=day.slice(0,k+1).map(x=>({...x,closeTime:x.timestamp+15*60_000}));
        const rebreakPs=structure(row.symbol,"15m",rebreakClosed,rebreakDecision+1);
        if(rebreakPs.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY")continue;
        const rb15=rebreakPs.features;
        if(rb15.priceStructure.structureEvent==="FAILED_BREAKOUT"||rb15.pattern.structureTransition==="CHOCH_DOWN")break;
        const rb1hBars=h1.filter(x=>x.closeTime<=rebreakDecision);
        const rb1hPs=rb1hBars.length>=5?structure(row.symbol,"1H",rb1hBars,rebreakDecision+1):null;
        const rb1h=rb1hPs?.status==="READY_FOR_SPECIALIST_RESEARCH_ONLY"?rb1hPs.features:null;
        if(rb1h?.priceStructure?.trend==="BEARISH")continue;
        const candle=rb15.candle;
        if(!(rebreakBar.close>bosBar.high))continue;
        if(candle.direction!=="UP"||(candle.bodyRangeRatio??0)<V7_REBREAK_PROFILE.minBody||(candle.closeLocation??0)<V7_REBREAK_PROFILE.minCloseLoc)continue;
        const vw=vwap(day,rebreakDecision);
        if(!(vw>0))continue;
        const vwd=rebreakBar.close/vw-1;
        if(vwd<0||vwd>V7_REBREAK_PROFILE.maxVwapDistance)continue;
        const rebreakExpansion=pullbackMedian>0?rebreakBar.volume/pullbackMedian:1;
        if(rebreakExpansion<V7_REBREAK_PROFILE.minRebreakVolumeExpansion)continue;

        const entryIndex=k+1,entryRaw=day[entryIndex].open,support=rb15.priceStructure.support;
        let risk=support&&support<entryRaw?(entryRaw-support*0.998)/entryRaw:0.015;
        risk=Math.max(0.006,risk);
        if(risk>0.04)continue;
        const exit=simulateExit(day,entryIndex,entryRaw,entryRaw*(1-risk),cost);
        const triggerScore=+Math.min(100,
          65
          +10*clamp((rs1h-V5_INTRADAY_PROFILE.rs1hMin)/0.05)
          +10*clamp((valueAccel-V5_INTRADAY_PROFILE.valueAccelMin)/3)
          +10*clamp((rebreakExpansion-V7_REBREAK_PROFILE.minRebreakVolumeExpansion)/2)
          +5*clamp(((candle.closeLocation??0)-V7_REBREAK_PROFILE.minCloseLoc)/0.35)
        ).toFixed(2);
        return {
          market:row.market,symbol:row.symbol,date,source:"INTRADAY_REBREAK_V7",family:"V7_BOS_RETEST_REBREAK",
          setupScore:0,triggerScore,entryTime:day[entryIndex].timestamp,
          aiInputBundle:{
            bos:{rs1h,valueAccel,volumeReaccel,btc1h,vwapDistance:bosVwd,wave15m:bos15.pattern,candle15m:bos15.candle,structure15m:bos15.priceStructure},
            retest:{barsAfterBos:j-i,wave15m:f15.pattern,candle15m:f15.candle,structure15m:f15.priceStructure},
            rebreak:{barsAfterRetest:k-j,rebreakExpansion,vwapDistance:vwd,wave15m:rb15.pattern,candle15m:rb15.candle,structure15m:rb15.priceStructure,wave1h:rb1h?.pattern??null,structure1h:rb1h?.priceStructure??null}
          },
          ...exit
        };
      }
      break;
    }
  }
  return null;
}

function intradayTrendPullbackTrade(row,btcDay,date,cost){
  const day=row.dayMap?.get(date);
  if(!day||day.length<40||!btcDay||btcDay.length<40)return null;
  const btcByTs=new Map(btcDay.map((bar,i)=>[bar.timestamp,{bar,i}]));
  const h1=aggregate1h(day);
  for(let i=12;i<day.length-1;i++){
    const current=day[i],btcNow=btcByTs.get(current.timestamp);
    if(!btcNow||btcNow.i<4)continue;
    const stock1h=alignedReturn(day,i,4),btc1h=alignedReturn(btcDay,btcNow.i,4);
    if(stock1h==null||btc1h==null||btc1h<V8_PULLBACK_PROFILE.btc1hFloor)continue;
    const rs1h=stock1h-btc1h;
    if(rs1h<V8_PULLBACK_PROFILE.rs1hMin)continue;

    const decision=current.timestamp+15*60_000;
    const closed=day.slice(0,i+1).map(x=>({...x,closeTime:x.timestamp+15*60_000}));
    const ps15=structure(row.symbol,"15m",closed,decision+1);
    if(ps15.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY")continue;
    const f15=ps15.features;
    const available1h=h1.filter(x=>x.closeTime<=decision);
    const ps1h=available1h.length>=5?structure(row.symbol,"1H",available1h,decision+1):null;
    const f1h=ps1h?.status==="READY_FOR_SPECIALIST_RESEARCH_ONLY"?ps1h.features:null;
    if(f1h?.priceStructure?.trend!=="BULLISH")continue;
    if(f15.priceStructure.trend!=="BULLISH")continue;
    if(f15.priceStructure.latestHighClassification!=="HH"||f15.priceStructure.latestLowClassification!=="HL")continue;
    if(f15.priceStructure.structureEvent==="FAILED_BREAKOUT"||f15.pattern.structureTransition==="CHOCH_DOWN")continue;

    const previous3=day.slice(i-3,i);
    if(!previous3.some(bar=>bar.close<bar.open))continue;
    const prePullback=day.slice(Math.max(0,i-8),i-3).map(x=>x.volume).filter(x=>x>0);
    const pullbackVolumes=previous3.map(x=>x.volume).filter(x=>x>0);
    if(!prePullback.length||!pullbackVolumes.length)continue;
    const pullbackVolumeRatio=median(pullbackVolumes)/median(prePullback);
    if(pullbackVolumeRatio>V8_PULLBACK_PROFILE.maxPullbackVolumeRatio)continue;
    const reexpansion=current.volume/median(pullbackVolumes);
    if(reexpansion<V8_PULLBACK_PROFILE.minReexpansion)continue;

    const candle=f15.candle;
    if(candle.direction!=="UP"||(candle.bodyRangeRatio??0)<V8_PULLBACK_PROFILE.minBody||(candle.closeLocation??0)<V8_PULLBACK_PROFILE.minCloseLoc)continue;
    if(current.close<=day[i-1].high)continue;
    const vw=vwap(day,decision);
    if(!(vw>0))continue;
    const vwd=current.close/vw-1;
    if(vwd<0||vwd>V8_PULLBACK_PROFILE.maxVwapDistance)continue;

    const entryIndex=i+1,entryRaw=day[entryIndex].open,support=f15.priceStructure.support;
    let risk=support&&support<entryRaw?(entryRaw-support*0.998)/entryRaw:0.015;
    risk=Math.max(0.006,risk);
    if(risk>V8_PULLBACK_PROFILE.maxStopDistance)continue;
    const exit=simulateExit(day,entryIndex,entryRaw,entryRaw*(1-risk),cost);
    const triggerScore=+Math.min(100,
      60
      +10*clamp((rs1h-V8_PULLBACK_PROFILE.rs1hMin)/0.04)
      +10*clamp((V8_PULLBACK_PROFILE.maxPullbackVolumeRatio-pullbackVolumeRatio)/0.5)
      +10*clamp((reexpansion-V8_PULLBACK_PROFILE.minReexpansion)/2)
      +10*clamp(((candle.closeLocation??0)-V8_PULLBACK_PROFILE.minCloseLoc)/0.35)
    ).toFixed(2);
    return {
      market:row.market,symbol:row.symbol,date,source:"INTRADAY_TREND_PULLBACK_V8",family:"V8_TREND_PULLBACK_CONTINUATION",
      setupScore:0,triggerScore,entryTime:day[entryIndex].timestamp,
      aiInputBundle:{
        rs1h,btc1h,pullbackVolumeRatio,reexpansion,vwapDistance:vwd,
        wave15m:f15.pattern,candle15m:f15.candle,structure15m:f15.priceStructure,
        wave1h:f1h?.pattern??null,structure1h:f1h?.priceStructure??null
      },
      ...exit
    };
  }
  return null;
}
function runTrendPullback(dates,rows,btcRow,cost){
  const days=[],trades=[];
  for(const date of dates){
    const btcDay=btcRow.dayMap?.get(date)??null,triggered=[];
    for(const row of rows){
      const trade=intradayTrendPullbackTrade(row,btcDay,date,cost);
      if(trade){triggered.push(trade);trades.push(trade);}
    }
    const p=portfolio(triggered);
    days.push({date,scannedSymbols:rows.length,triggered:triggered.length,...p});
  }
  return {metrics:dayMetrics(days),days,trades};
}

function runIntradayRebreak(dates,rows,btcRow,cost){
  const days=[],trades=[];
  for(const date of dates){
    const btcDay=btcRow.dayMap?.get(date)??null,triggered=[];
    for(const row of rows){
      const trade=intradayRetestRebreakTrade(row,btcDay,date,cost);
      if(trade){triggered.push(trade);trades.push(trade);}
    }
    const p=portfolio(triggered);
    days.push({date,scannedSymbols:rows.length,triggered:triggered.length,...p});
  }
  return {metrics:dayMetrics(days),days,trades};
}

function runIntradayRetest(dates,rows,btcRow,cost){
  const days=[],trades=[];
  for(const date of dates){
    const btcDay=btcRow.dayMap?.get(date)??null,triggered=[];
    for(const row of rows){
      const trade=intradayRetestTrade(row,btcDay,date,cost);
      if(trade){triggered.push(trade);trades.push(trade);}
    }
    const p=portfolio(triggered);
    days.push({date,scannedSymbols:rows.length,triggered:triggered.length,...p});
  }
  return {metrics:dayMetrics(days),days,trades};
}

function runIntradayDiscovery(dates,rows,btcRow,cost){
  const days=[],trades=[];
  for(const date of dates){
    const btcDay=btcRow.dayMap?.get(date)??null;
    const triggered=[];
    for(const row of rows){
      const trade=intradayDiscoveryTrade(row,btcDay,date,cost);
      if(trade){triggered.push(trade);trades.push(trade);}
    }
    const p=portfolio(triggered);
    days.push({date,scannedSymbols:rows.length,triggered:triggered.length,...p});
  }
  return {metrics:dayMetrics(days),days,trades};
}
function runHybrid(dates,overnightRun,intradayRun){
  const overByDate=new Map(overnightRun.days.map(d=>[d.date,[]]));
  for(const trade of overnightRun.trades){
    const list=overByDate.get(trade.date)??[];list.push({...trade,source:"OVERNIGHT_V4"});overByDate.set(trade.date,list);
  }
  const intraByDate=new Map(intradayRun.days.map(d=>[d.date,[]]));
  for(const trade of intradayRun.trades){
    const list=intraByDate.get(trade.date)??[];list.push(trade);intraByDate.set(trade.date,list);
  }
  const days=[],trades=[];
  for(const date of dates){
    const merged=[...(overByDate.get(date)??[]),...(intraByDate.get(date)??[])].sort((a,b)=>a.entryTime-b.entryTime||b.triggerScore-a.triggerScore);
    const chosenBySymbol=new Map();
    for(const t of merged){
      const existing=chosenBySymbol.get(t.symbol);
      if(!existing||t.entryTime<existing.entryTime||(t.entryTime===existing.entryTime&&t.triggerScore>existing.triggerScore))chosenBySymbol.set(t.symbol,t);
    }
    const unique=[...chosenBySymbol.values()];
    const p=portfolio(unique);
    days.push({date,overnightSignals:(overByDate.get(date)??[]).length,intradaySignals:(intraByDate.get(date)??[]).length,uniqueSignals:unique.length,...p});
    trades.push(...unique);
  }
  return {metrics:dayMetrics(days),days,trades};
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
  const cohortMap=new Map([...u.holdout,u.btcReference].map(x=>[x.market,x]));
  const data=[];
  for(const row of cohortMap.values()){
    const daily=await dailyCandles(row.market);
    const minute15=await minute15Candles(row.market);
    data.push({...row,daily,minute15,dayMap:groupDays(minute15)});
  }
  const byMarket=new Map(data.map(x=>[x.market,x]));
  const btc=byMarket.get("KRW-BTC");if(!btc)throw new Error("BTC_REFERENCE_MISSING");
  const holdoutData=u.holdout.map(x=>byMarket.get(x.market)).filter(Boolean);
  if(holdoutData.length!==HOLDOUT_COUNT)throw new Error("COHORT_HISTORY_INCOMPLETE");
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
  const holdoutCandidates=buildCandidates(holdoutData,btc.daily,dates);
  const overnightNormal=runPeriod(V4_FIXED_PROFILE,dates,holdoutCandidates,intraday,NORMAL_COST);
  const overnightStress=runPeriod(V4_FIXED_PROFILE,dates,holdoutCandidates,intraday,STRESS_COST);
  const rebreakNormal=runIntradayRebreak(dates,holdoutData,btc,NORMAL_COST);
  const rebreakStress=runIntradayRebreak(dates,holdoutData,btc,STRESS_COST);
  const pullbackNormal=runTrendPullback(dates,holdoutData,btc,NORMAL_COST);
  const pullbackStress=runTrendPullback(dates,holdoutData,btc,STRESS_COST);
  const hybridNormal=runHybrid(dates,overnightNormal,pullbackNormal);
  const hybridStress=runHybrid(dates,overnightStress,pullbackStress);
  const report={
    schemaVersion:8,status:"pass",market:"CRYPTO_SPOT",exchange:"UPBIT",
    purpose:"fixed 1H+15m HH/HL VWAP trend-pullback continuation V8 plus overnight V4 on fresh ranks 73-84",
    dataWindow:{observedCutoffExclusive:OBSERVED_CUTOFF,completePreObservedDates:dates},
    universe:{
      currentSnapshotBias:true,totalKrwMarkets:u.totalKrw,stablecoinsExcluded:[...STABLECOINS],
      priorObservedRanks:"1-72 influenced V1-V7 design and are excluded from V8 final evidence",
      freshHoldoutRanks:`${FRESH_HOLDOUT_SKIP+1}-${FRESH_HOLDOUT_SKIP+FRESH_HOLDOUT_COUNT}`,
      freshHoldout:u.holdout.map(x=>({market:x.market,symbol:x.symbol,tradingValue24h:x.tradingValue24h}))
    },
    fixedPolicy:{
      parameterSearchPerformed:false,familySearchPerformed:false,
      overnightPath:"V4 fixed D-1 quality+BOS policy unchanged",
      V7Baseline:"BOS -> RETEST_HELD -> BOS-high rebreak",
      intradayV8:{
        D1Required:false,oneHourStructure:"BULLISH",fifteenMinuteStructure:"BULLISH",
        swingRequirement:"latest HH + latest HL",btc1hFloor:V8_PULLBACK_PROFILE.btc1hFloor,
        rs1hVsBtcMin:V8_PULLBACK_PROFILE.rs1hMin,
        pullback:"previous 3 bars contain a down bar and median volume contracts versus prior 5 bars",
        maxPullbackVolumeRatio:V8_PULLBACK_PROFILE.maxPullbackVolumeRatio,
        trigger:"UP candle closes above previous 15m high with volume re-expansion",
        minReexpansion:V8_PULLBACK_PROFILE.minReexpansion,
        bodyRangeRatioMin:V8_PULLBACK_PROFILE.minBody,closeLocationMin:V8_PULLBACK_PROFILE.minCloseLoc,
        vwapDistanceMin:0,vwapDistanceMax:V8_PULLBACK_PROFILE.maxVwapDistance,
        maxStructuralStopDistance:V8_PULLBACK_PROFILE.maxStopDistance,
        entry:"next 15m open"
      },
      hybridRule:"earliest same-symbol signal wins; shared risk-normalized portfolio",
      exit:"structural stop + 1R/2R partials + VWAP runner + day-end",accountPolicy:ACCOUNT
    },
    costs:{normalPerSide:NORMAL_COST,stressPerSide:STRESS_COST},
    overnightV4:{normal:{metrics:overnightNormal.metrics,trades:overnightNormal.trades.length},stress:{metrics:overnightStress.metrics,trades:overnightStress.trades.length}},
    intradayRebreakV7Baseline:{normal:{metrics:rebreakNormal.metrics,trades:rebreakNormal.trades.length},stress:{metrics:rebreakStress.metrics,trades:rebreakStress.trades.length}},
    trendPullbackV8:{normal:{metrics:pullbackNormal.metrics,trades:pullbackNormal.trades.length},stress:{metrics:pullbackStress.metrics,trades:pullbackStress.trades.length}},
    hybridV8:{
      normal:{metrics:hybridNormal.metrics,days:hybridNormal.days,trades:hybridNormal.trades.map(t=>({symbol:t.symbol,date:t.date,source:t.source??"OVERNIGHT_V4",triggerScore:t.triggerScore,entryTime:new Date(t.entryTime).toISOString(),exitTime:new Date(t.exitTime).toISOString(),netReturn:t.netReturn,stopDistancePct:t.stopDistancePct,tp1:t.tp1,tp2:t.tp2,exitReason:t.exitReason,aiInputBundle:t.aiInputBundle}))},
      stress:{metrics:hybridStress.metrics,days:hybridStress.days,trades:hybridStress.trades.length}
    },
    lookahead:{D1UsesPriorCompletedDailyCandle:true,pullbackUsesCompleted15mOnly:true,oneHourContextUsesCompletedBarsOnly:true,entryNext15mOpen:true,freshHoldoutSymbolsUsedForDesign:false,guardPassed:true},
    safety:{researchOnly:true,publicDataOnly:true,liveExecutionAllowed:false,privateAccountRequestAllowed:false,executionAuthority:"NONE",profitabilityPromotionAllowed:false},
    limitations:[
      "V8 trend-pullback design was created after observing ranks 1-72; only current-liquidity ranks 73-84 are treated as fresh cross-symbol evidence.",
      "All dates remain retrospective and current liquidity ranks retain survivorship/current-membership bias.",
      "Historical news/catalyst/order-book depth and true historical LLM outputs are unavailable and are not fabricated.",
      "The AI role is represented by deterministic wave/candle/VWAP/relative-strength feature gates.",
      "This is candle replay, not exchange fill evidence, and cannot establish PROFITABILITY_PROVEN."
    ]
  };
  const out=resolve(process.argv[2]??"docs/upbit-trend-pullback-v8.json");
  await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+"\n","utf8");
  console.log(JSON.stringify(report,null,2));
}
await main();
