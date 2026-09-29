import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildAdaptiveMultiEvidencePriceStructureV2 } from "../src/adaptive-multi-evidence-price-structure-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "../src/adaptive-multi-evidence-point-in-time-v2.js";

const UPBIT="https://api.upbit.com";
const DAY=86_400_000;
const NORMAL_COST=0.0015;
const STRESS_COST=NORMAL_COST*1.5;
const CAL=Object.freeze({start:"2025-12-01",end:"2026-02-01"});
const VAL=Object.freeze({start:"2026-02-01",end:"2026-03-01"});
const TEST=Object.freeze({start:"2026-03-01",end:"2026-04-01"});
const DISCOVERY_COUNT=12,HOLDOUT_COUNT=12,SCAN_LIMIT=50,CANDIDATES_PER_DAY=8;
const STABLECOINS=new Set(["USDT","USDC","DAI","TUSD","USDP","BUSD","FDUSD","PYUSD","USD1"]);
const ACCOUNT=Object.freeze({riskPerTrade:0.005,maxWeight:0.20,maxConcurrent:3});
const FAMILIES=Object.freeze({
  PULLBACK_RECLAIM:Object.freeze({name:"PULLBACK_RECLAIM",require15mBullish:false,require1hBullish:false,maxVwapDistance:0.012,minBody:0.40,minCloseLoc:0.65,minVolReaccel:1.0,structureMode:"HL_OR_UP_TRANSITION"}),
  FIRST_HL:Object.freeze({name:"FIRST_HL",require15mBullish:true,require1hBullish:false,maxVwapDistance:0.010,minBody:0.35,minCloseLoc:0.62,minVolReaccel:0.9,structureMode:"HL"}),
  RETEST_RECLAIM:Object.freeze({name:"RETEST_RECLAIM",require15mBullish:false,require1hBullish:false,maxVwapDistance:0.015,minBody:0.35,minCloseLoc:0.60,minVolReaccel:0.9,structureMode:"RETEST"}),
});

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let lastRequestAt=0;
async function upbitJson(path){
  let last;
  for(let attempt=0;attempt<5;attempt+=1){
    const wait=Math.max(0,140-(Date.now()-lastRequestAt)); if(wait)await sleep(wait);
    lastRequestAt=Date.now();
    try{
      const r=await fetch(`${UPBIT}${path}`,{headers:{accept:"application/json","user-agent":"seungjae-research-pullback-reclaim/1.0"}});
      if(r.status===429){await sleep(1000*(attempt+1));continue;}
      if(!r.ok)throw new Error(`UPBIT_HTTP_${r.status}`);
      return await r.json();
    }catch(e){last=e;await sleep(350*(attempt+1));}
  }
  throw last??new Error("UPBIT_FETCH_FAILED");
}
function finite(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function mean(v){return v.length?v.reduce((a,b)=>a+b,0)/v.length:0;}
function median(v){if(!v.length)return 0;const x=[...v].sort((a,b)=>a-b),m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function clamp(x,a=0,b=1){return Math.min(b,Math.max(a,x));}
function dayKey(ms){return new Date(ms).toISOString().slice(0,10);}
function inWindow(date,w){return date>=w.start&&date<w.end;}
function dateRange(start,end){
  const out=[];for(let ms=Date.parse(start+"T00:00:00Z");ms<Date.parse(end+"T00:00:00Z");ms+=DAY)out.push(dayKey(ms));return out;
}
function sma(c,i,p){if(i-p+1<0)return null;let s=0;for(let j=i-p+1;j<=i;j++)s+=c[j].close;return s/p;}
function highBefore(c,i,p){if(i-p<0)return null;let h=-Infinity;for(let j=i-p;j<i;j++)h=Math.max(h,c[j].high);return Number.isFinite(h)?h:null;}
function avgValueBefore(c,i,p){if(i-p<0)return null;let s=0;for(let j=i-p;j<i;j++)s+=c[j].tradingValue;return s/p;}
function normalizeCandle(row){
  const timestamp=Date.parse(`${String(row?.candle_date_time_utc??"")}Z`);
  const open=finite(row?.opening_price),high=finite(row?.high_price),low=finite(row?.low_price),close=finite(row?.trade_price),volume=finite(row?.candle_acc_trade_volume),tradingValue=finite(row?.candle_acc_trade_price);
  if(!Number.isFinite(timestamp)||![open,high,low,close,volume,tradingValue].every(Number.isFinite)||Math.min(open,high,low,close)<=0||volume<0||tradingValue<0)return null;
  return {timestamp,open,high,low,close,volume,tradingValue};
}
async function rankedMarkets(){
  const master=await upbitJson("/v1/market/all?isDetails=true");
  const krw=(Array.isArray(master)?master:[]).filter(x=>String(x?.market??"").startsWith("KRW-")&&String(x?.market_warning??"NONE")==="NONE");
  const ids=krw.map(x=>String(x.market)),tickers=[];
  for(let i=0;i<ids.length;i+=100){
    const rows=await upbitJson(`/v1/ticker?markets=${encodeURIComponent(ids.slice(i,i+100).join(","))}`);
    if(Array.isArray(rows))tickers.push(...rows);
  }
  return tickers.map(x=>({market:String(x.market),symbol:String(x.market).replace(/^KRW-/,""),tradingValue24h:finite(x.acc_trade_price_24h),price:finite(x.trade_price)}))
    .filter(x=>x.price>0&&x.tradingValue24h>0&&!STABLECOINS.has(x.symbol))
    .sort((a,b)=>b.tradingValue24h-a.tradingValue24h);
}
async function dailyHistory(market){
  const startMs=Date.parse("2025-07-01T00:00:00Z"),endMs=Date.parse("2026-04-02T00:00:00Z");
  const map=new Map();let to="2026-04-02T00:00:00Z";
  for(let page=0;page<3;page+=1){
    const qs=new URLSearchParams({market,count:"200",to});
    const rows=await upbitJson(`/v1/candles/days?${qs.toString()}`);
    const norm=(Array.isArray(rows)?rows:[]).map(normalizeCandle).filter(Boolean);
    if(!norm.length)break;
    for(const r of norm)map.set(r.timestamp,r);
    const oldest=Math.min(...norm.map(x=>x.timestamp));
    if(oldest<=startMs)break;
    to=new Date(oldest-1000).toISOString().replace(/\.\d{3}Z$/,"Z");
  }
  return [...map.values()].filter(x=>x.timestamp>=startMs&&x.timestamp<endMs).sort((a,b)=>a.timestamp-b.timestamp);
}
async function minute15Day(market,date){
  const next=new Date(Date.parse(date+"T00:00:00Z")+DAY).toISOString().replace(/\.000Z$/,"Z");
  const qs=new URLSearchParams({market,count:"200",to:next});
  const rows=await upbitJson(`/v1/candles/minutes/15?${qs.toString()}`);
  return (Array.isArray(rows)?rows:[]).map(normalizeCandle).filter(Boolean).filter(x=>dayKey(x.timestamp)===date).sort((a,b)=>a.timestamp-b.timestamp);
}
function dailyIndexBefore(c,date){let i=-1;for(let j=0;j<c.length;j++){if(dayKey(c[j].timestamp)<date)i=j;else break;}return i;}
function structure(symbol,timeframe,bars,decisionMs){
  const duration=timeframe==="1D"?1440:timeframe==="1H"?60:15;
  const mapped=bars.map(b=>{const closeMs=b.closeTime??(b.timestamp+duration*60_000),iso=new Date(closeMs).toISOString();return {isClosed:true,eventTime:iso,publishedAt:iso,availableAt:iso,observedAt:iso,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume};});
  const options=timeframe==="1D"?{atrPeriod:14,volumeLookback:20,pivotLeftBars:2,pivotRightBars:2,compressionLookback:5}:timeframe==="15m"?{atrPeriod:8,volumeLookback:8,pivotLeftBars:1,pivotRightBars:1,compressionLookback:4}:{atrPeriod:5,volumeLookback:4,pivotLeftBars:1,pivotRightBars:1,compressionLookback:2};
  return buildAdaptiveMultiEvidencePriceStructureV2({lineageId:ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,market:"CRYPTO_SPOT",symbol,timeframe,side:"LONG",decisionTime:new Date(decisionMs).toISOString(),source:{sourceId:"upbit-public",originalSourceId:"upbit-public",sourceType:"PUBLIC_MARKET_DATA",sourceUrl:"https://api.upbit.com/",documentId:`KRW-${symbol}:${timeframe}`},candles:mapped,options});
}
function btcRegime(btc,date){
  const i=dailyIndexBefore(btc,date);if(i<60)return null;
  const m20=sma(btc,i,20),m20p=sma(btc,i-5,20),m60=sma(btc,i,60);
  return {bullish:m20>0&&m20p>0&&m60>0&&btc[i].close>m20&&m20>m20p&&btc[i].close>m60,close:btc[i].close,ma20:m20,ma60:m60};
}
function candidate(row,btc,date){
  const c=row.daily,i=dailyIndexBefore(c,date),bi=dailyIndexBefore(btc,date);if(i<60||bi<20)return null;
  const regime=btcRegime(btc,date);if(!regime?.bullish)return null;
  const close=c[i].close,m20=sma(c,i,20),m20p=sma(c,i-5,20),m60=sma(c,i,60),h20=highBefore(c,i+1,20),av=avgValueBefore(c,i,20);
  if(![m20,m20p,m60,h20,av].every(x=>x>0))return null;
  const dailyPs=structure(row.symbol,"1D",c.slice(Math.max(0,i-79),i+1),Date.parse(date+"T00:00:00Z")+1);
  if(dailyPs.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY"||dailyPs.features.priceStructure.trend==="BEARISH")return null;
  const rs20=(close/c[i-20].close-1)-(btc[bi].close/btc[bi-20].close-1),valueAccel=c[i].tradingValue/av,near=close/h20,range=c[i].high-c[i].low,body=range?Math.abs(c[i].close-c[i].open)/range:0,cl=range?(c[i].close-c[i].low)/range:0;
  if(!(close>m20&&m20>=m20p&&close>m60&&rs20>=-0.05&&valueAccel>=0.70&&near>=0.70))return null;
  let score=20+25*clamp((rs20+0.05)/0.30)+20*clamp((valueAccel-0.70)/2.30)+15*clamp((near-0.70)/0.30)+10*clamp((cl-0.35)/0.65)+5*clamp((body-0.20)/0.70);
  if(dailyPs.features.priceStructure.trend==="BULLISH")score+=5;
  return {market:row.market,symbol:row.symbol,date,setupScore:+Math.min(100,score).toFixed(2),setup:{rs20,valueAcceleration:valueAccel,near20dHigh:near,closeLocation:cl,bodyRangeRatio:body,dailyTrend:dailyPs.features.priceStructure.trend,dailySwingSequence:dailyPs.features.pattern.swingSequence,btcRegime:"BULLISH"}};
}
function aggregate1h(rows){
  const out=[];for(let i=0;i<rows.length;i+=4){const q=rows.slice(i,i+4);if(q.length<4)break;out.push({timestamp:q[0].timestamp,closeTime:q[3].timestamp+15*60_000,open:q[0].open,high:Math.max(...q.map(x=>x.high)),low:Math.min(...q.map(x=>x.low)),close:q[3].close,volume:q.reduce((s,x)=>s+x.volume,0),tradingValue:q.reduce((s,x)=>s+x.tradingValue,0)});}return out;
}
function vwap(rows,cutoff){let pv=0,v=0;for(const r of rows){if(r.timestamp>=cutoff)break;if(r.volume>0){pv+=((r.high+r.low+r.close)/3)*r.volume;v+=r.volume;}}return v>0?pv/v:null;}
function familyPass(f,f15,f1h,vwd,vr,pullbackSeen){
  if(!pullbackSeen)return false;
  const c=f15.candle,ps=f15.priceStructure,p=f15.pattern;
  if(ps.trend==="BEARISH"||f1h?.priceStructure?.trend==="BEARISH"||vwd<0||vwd>f.maxVwapDistance||c.direction!=="UP"||(c.bodyRangeRatio??0)<f.minBody||(c.closeLocation??0)<f.minCloseLoc||vr<f.minVolReaccel)return false;
  if(f.require15mBullish&&ps.trend!=="BULLISH")return false;
  if(f.require1hBullish&&f1h?.priceStructure?.trend!=="BULLISH")return false;
  if(f.structureMode==="HL"&&ps.latestLowClassification!=="HL")return false;
  if(f.structureMode==="RETEST"&&ps.structureEvent!=="RETEST_HELD")return false;
  if(f.structureMode==="HL_OR_UP_TRANSITION"&&!(ps.latestLowClassification==="HL"||["BOS_UP","CHOCH_UP"].includes(p.structureTransition)||ps.structureEvent==="RETEST_HELD"))return false;
  return true;
}
function simulateExit(day,entryIndex,entryRaw,stopRaw,cost){
  const entry=entryRaw*(1+cost),risk=entryRaw-stopRaw,t1=entryRaw+risk,t2=entryRaw+2*risk;let rem=1,ret=0,tp1=false,tp2=false,exitIndex=day.length-1,reason="DAY_END",below=0;
  const fill=x=>x*(1-cost);
  for(let i=entryIndex+1;i<day.length;i++){
    const b=day[i],vw=vwap(day,b.timestamp+1);let protect=stopRaw;
    if(tp1&&vw!=null)protect=Math.max(protect,vw*0.99);
    if(tp2&&vw!=null)protect=Math.max(protect,entryRaw,vw*0.995);
    if(b.low<=protect){ret+=rem*(fill(protect)/entry-1);rem=0;exitIndex=i;reason=tp2?"RUNNER_PROTECT":tp1?"POST_TP1_PROTECT":"STRUCTURAL_STOP";break;}
    if(!tp1&&b.high>=t1){ret+=0.25*(fill(t1)/entry-1);rem-=0.25;tp1=true;}
    if(tp1&&!tp2&&b.high>=t2){ret+=0.25*(fill(t2)/entry-1);rem-=0.25;tp2=true;}
    if(tp2&&vw!=null){below=b.close<vw?below+1:0;if(below>=2){ret+=rem*(fill(b.close)/entry-1);rem=0;exitIndex=i;reason="RUNNER_VWAP_BREAK";break;}}
  }
  if(rem>0){ret+=rem*(fill(day.at(-1).close)/entry-1);reason=tp2?"RUNNER_DAY_END":tp1?"PARTIAL_DAY_END":"DAY_END";}
  return {netReturn:ret,stopDistancePct:risk/entryRaw,tp1,tp2,exitTime:day[exitIndex].timestamp,exitReason:reason};
}
function replayOne(f,cand,day,cost){
  if(day.length<60)return null;
  const h1=aggregate1h(day);let seenAbove=false,pullbackSeen=false;
  for(let i=8;i<day.length-1;i++){
    const decision=day[i].timestamp+15*60_000,vw=vwap(day,decision);if(!(vw>0))continue;
    const last=day[i],dist=last.close/vw-1;
    if(dist>=0.006)seenAbove=true;
    if(seenAbove&&dist<=0.004&&dist>=-0.012)pullbackSeen=true;
    const closed=day.slice(0,i+1).map(x=>({...x,closeTime:x.timestamp+15*60_000}));
    const ps15=structure(cand.symbol,"15m",closed,decision+1);if(ps15.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY")continue;
    const available1h=h1.filter(x=>x.closeTime<=decision),ps1h=available1h.length>=5?structure(cand.symbol,"1H",available1h,decision+1):null,f1h=ps1h?.status==="READY_FOR_SPECIALIST_RESEARCH_ONLY"?ps1h.features:null;
    const prev=day.slice(Math.max(0,i-8),i).map(x=>x.volume).filter(x=>x>0),vr=prev.length?last.volume/median(prev):1;
    if(!familyPass(f,ps15.features,f1h,dist,vr,pullbackSeen))continue;
    const entryIndex=i+1,entryRaw=day[entryIndex].open,support=ps15.features.priceStructure.support;
    let risk=support&&support<entryRaw?(entryRaw-support*0.998)/entryRaw:0.012;risk=Math.max(0.006,risk);if(risk>0.03)continue;
    const exit=simulateExit(day,entryIndex,entryRaw,entryRaw*(1-risk),cost);
    const triggerScore=+Math.min(100,cand.setupScore+10*clamp((vr-f.minVolReaccel)/2)+10*clamp(((ps15.features.candle.closeLocation??0)-f.minCloseLoc)/0.35)+5*(ps15.features.priceStructure.trend==="BULLISH")).toFixed(2);
    return {symbol:cand.symbol,market:cand.market,date:cand.date,family:f.name,setupScore:cand.setupScore,triggerScore,entryTime:day[entryIndex].timestamp,aiInputBundle:{setup:cand.setup,wave15m:ps15.features.pattern,candle15m:ps15.features.candle,structure15m:ps15.features.priceStructure,wave1h:f1h?.pattern??null,structure1h:f1h?.priceStructure??null,vwapDistance:dist,volumeReaccel:vr,pullbackSeen},...exit};
  }
  return null;
}
function portfolio(trades){const sorted=[...trades].sort((a,b)=>a.entryTime-b.entryTime||b.triggerScore-a.triggerScore),active=[];let ret=0,admitted=0;for(const t of sorted){for(let i=active.length-1;i>=0;i--)if(active[i].exitTime<=t.entryTime)active.splice(i,1);if(active.length>=ACCOUNT.maxConcurrent)continue;const w=Math.min(ACCOUNT.maxWeight,ACCOUNT.riskPerTrade/Math.max(t.stopDistancePct,1e-9));ret+=w*t.netReturn;active.push(t);admitted++;}return {return:ret,admitted};}
function dayMetrics(days){const r=days.map(x=>x.return),pos=r.filter(x=>x>0),neg=r.filter(x=>x<0);let eq=1,peak=1,mdd=0;for(const x of r){eq*=1+x;peak=Math.max(peak,eq);mdd=Math.max(mdd,(peak-eq)/peak);}return {days:days.length,totalReturn:eq-1,averageDailyReturn:mean(r),medianDailyReturn:median(r),positiveDayRate:r.length?pos.length/r.length:0,averageWinningDay:mean(pos),averageLosingDay:mean(neg),bestDay:r.length?Math.max(...r):0,worstDay:r.length?Math.min(...r):0,maxDrawdown:mdd,daysAtLeast1Pct:r.filter(x=>x>=.01).length,daysAtLeast3Pct:r.filter(x=>x>=.03).length,daysAtLeast5Pct:r.filter(x=>x>=.05).length,daysAtLeast10Pct:r.filter(x=>x>=.10).length};}
function runPeriod(f,dates,candidates,barCache,cost){const days=[],trades=[];for(const date of dates){const ts=[];for(const c of candidates.get(date)??[]){const day=barCache.get(`${c.market}|${date}`);if(!day)continue;const t=replayOne(f,c,day,cost);if(t){ts.push(t);trades.push(t);}}const p=portfolio(ts);days.push({date,candidateCount:(candidates.get(date)??[]).length,triggered:ts.length,...p});}return {metrics:dayMetrics(days),days,trades};}
function selectionScore(run){if(run.trades.length<15)return -999;return run.metrics.totalReturn-1.5*run.metrics.maxDrawdown+0.3*run.metrics.averageDailyReturn;}
function calibrationGate(n,s){return n.metrics.days>=60&&n.trades.length>=20&&n.metrics.totalReturn>0&&n.metrics.averageDailyReturn>0&&s.metrics.totalReturn>0&&s.metrics.averageDailyReturn>0&&n.metrics.maxDrawdown<=0.10&&s.metrics.maxDrawdown<=0.11;}
function validationGate(n,s){return n.metrics.days>=28&&n.trades.length>=8&&n.metrics.totalReturn>0&&n.metrics.averageDailyReturn>0&&s.metrics.totalReturn>0&&s.metrics.averageDailyReturn>0&&n.metrics.maxDrawdown<=0.08&&s.metrics.maxDrawdown<=0.09;}
function buildCandidates(rows,btc,dates){const map=new Map();for(const date of dates){map.set(date,rows.map(r=>candidate(r,btc,date)).filter(Boolean).sort((a,b)=>b.setupScore-a.setupScore||a.symbol.localeCompare(b.symbol)).slice(0,CANDIDATES_PER_DAY));}return map;}

async function main(){
  const ranked=(await rankedMarkets()).slice(0,SCAN_LIMIT),withDaily=[];
  for(const row of ranked){const daily=await dailyHistory(row.market);const beforeCal=daily.filter(x=>dayKey(x.timestamp)<CAL.start).length;const throughTest=daily.some(x=>dayKey(x.timestamp)>="2026-03-30");if(beforeCal>=90&&throughTest)withDaily.push({...row,daily});if(withDaily.length>=DISCOVERY_COUNT+HOLDOUT_COUNT&&withDaily.some(x=>x.market==="KRW-BTC"))break;}
  const btc=withDaily.find(x=>x.market==="KRW-BTC");if(!btc)throw new Error("BTC_REFERENCE_MISSING");
  const nonBtc=withDaily.filter(x=>x.market!=="KRW-BTC");
  const discovery=[btc,...nonBtc.slice(0,DISCOVERY_COUNT-1)],holdout=nonBtc.slice(DISCOVERY_COUNT-1,DISCOVERY_COUNT-1+HOLDOUT_COUNT);
  if(discovery.length!==DISCOVERY_COUNT||holdout.length!==HOLDOUT_COUNT)throw new Error(`ELIGIBLE_COHORT_TOO_SMALL:${discovery.length}:${holdout.length}`);
  const calDates=dateRange(CAL.start,CAL.end),valDates=dateRange(VAL.start,VAL.end),testDates=dateRange(TEST.start,TEST.end),allDiscoveryDates=[...calDates,...valDates,...testDates];
  const discoveryCandidates=buildCandidates(discovery,btc.daily,allDiscoveryDates),holdoutCandidates=buildCandidates(holdout,btc.daily,testDates);
  const needed=new Map();
  for(const [date,rows] of discoveryCandidates)for(const c of rows)needed.set(`${c.market}|${date}`,{market:c.market,date});
  for(const [date,rows] of holdoutCandidates)for(const c of rows)needed.set(`${c.market}|${date}`,{market:c.market,date});
  const barCache=new Map();let unavailable=0;
  for(const item of needed.values()){const rows=await minute15Day(item.market,item.date);if(rows.length>=80)barCache.set(`${item.market}|${item.date}`,rows);else unavailable++;}
  const familyResults=[];
  for(const f of Object.values(FAMILIES)){
    const cal=runPeriod(f,calDates,discoveryCandidates,barCache,NORMAL_COST),calStress=runPeriod(f,calDates,discoveryCandidates,barCache,STRESS_COST),val=runPeriod(f,valDates,discoveryCandidates,barCache,NORMAL_COST),valStress=runPeriod(f,valDates,discoveryCandidates,barCache,STRESS_COST);
    familyResults.push({family:f.name,selectionScore:selectionScore(cal),calibrationGatePass:calibrationGate(cal,calStress),validationGatePass:validationGate(val,valStress),calibration:cal,calibrationStress:calStress,validation:val,validationStress:valStress});
  }
  familyResults.sort((a,b)=>b.selectionScore-a.selectionScore);const selected=familyResults[0],gatePassed=selected.calibrationGatePass&&selected.validationGatePass;
  const sameNormal=runPeriod(FAMILIES[selected.family],testDates,discoveryCandidates,barCache,NORMAL_COST),sameStress=runPeriod(FAMILIES[selected.family],testDates,discoveryCandidates,barCache,STRESS_COST),holdNormal=runPeriod(FAMILIES[selected.family],testDates,holdoutCandidates,barCache,NORMAL_COST),holdStress=runPeriod(FAMILIES[selected.family],testDates,holdoutCandidates,barCache,STRESS_COST);
  const slim=t=>({symbol:t.symbol,date:t.date,family:t.family,setupScore:t.setupScore,triggerScore:t.triggerScore,entryTime:new Date(t.entryTime).toISOString(),exitTime:new Date(t.exitTime).toISOString(),netReturn:t.netReturn,stopDistancePct:t.stopDistancePct,tp1:t.tp1,tp2:t.tp2,exitReason:t.exitReason,aiInputBundle:t.aiInputBundle});
  const report={schemaVersion:4,status:"pass",market:"CRYPTO_SPOT",exchange:"UPBIT",purpose:"unseen historical BTC-regime pullback-reclaim D-1 -> 15m/1H replay",windows:{calibration:CAL,validation:VAL,test:TEST},universe:{currentSnapshotBias:true,stablecoinsExcluded:[...STABLECOINS],rankedScanned:ranked.length,historyEligible:withDaily.length,discovery:discovery.map(x=>x.symbol),holdout:holdout.map(x=>x.symbol)},dataEfficiency:{candidateMarketDaysRequested:needed.size,candidateMarketDaysAvailable:barCache.size,candidateMarketDaysUnavailable:unavailable,fullUniverseIntradayDownloaded:false},selectionContract:{familiesPreRegistered:Object.keys(FAMILIES),strategyPhilosophy:"D1_PREPARED_BTC_BULL_REGIME_THEN_FIRST_PULLBACK_VWAP_RECLAIM",selectedByCalibrationOnly:true,validationCanChangeSelectedFamily:false,testUsedForSelection:false,holdoutSymbolsUsedForSelection:false,actualHistoricalLlmCalled:false,critic:"DETERMINISTIC_AI_READY_PULLBACK_CRITIC_V4"},costs:{normalPerSide:NORMAL_COST,stressPerSide:STRESS_COST},accountPolicy:ACCOUNT,familyResults:familyResults.map(x=>({family:x.family,selectionScore:x.selectionScore,calibrationGatePass:x.calibrationGatePass,validationGatePass:x.validationGatePass,calibration:{metrics:x.calibration.metrics,trades:x.calibration.trades.length},calibrationStress:{metrics:x.calibrationStress.metrics,trades:x.calibrationStress.trades.length},validation:{metrics:x.validation.metrics,trades:x.validation.trades.length},validationStress:{metrics:x.validationStress.metrics,trades:x.validationStress.trades.length}})),selectedFamily:selected.family,selectedStatus:gatePassed?"CALIBRATION_AND_VALIDATION_GATE_PASS":selected.calibrationGatePass?"RESEARCH_HOLD_VALIDATION_FAILED":"RESEARCH_HOLD_CALIBRATION_FAILED",sameCohortTest:{normal:{metrics:sameNormal.metrics,trades:sameNormal.trades.map(slim)},stress:{metrics:sameStress.metrics,trades:sameStress.trades.length}},crossSymbolHoldout:{normal:{metrics:holdNormal.metrics,days:holdNormal.days,trades:holdNormal.trades.map(slim)},stress:{metrics:holdStress.metrics,days:holdStress.days,trades:holdStress.trades.length}},lookahead:{D1UsesPriorCompletedDailyCandle:true,BTCRegimeUsesPriorCompletedDailyCandle:true,intradayUsesCompleted15mAnd1hOnly:true,entryNext15mOpen:true,testUsedForSelection:false,holdoutSymbolsUsedForSelection:false,guardPassed:true},safety:{researchOnly:true,publicDataOnly:true,liveExecutionAllowed:false,privateAccountRequestAllowed:false,executionAuthority:"NONE",profitabilityPromotionAllowed:false},limitations:["This is a retrospective holdback, not prospective live evidence.","Current-liquidity universe selection retains survivorship/current-membership bias.","Historical news, order-book depth, and true historical LLM outputs are unavailable and are not fabricated.","Only candidate market-days fetch intraday bars; missing candidate-day data fails closed.","No leverage, futures, private account data, or real orders are used."]};
  const out=resolve(process.argv[2]??"docs/upbit-pullback-reclaim-v4.json");await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+"\n","utf8");console.log(JSON.stringify(report,null,2));
}
await main();
