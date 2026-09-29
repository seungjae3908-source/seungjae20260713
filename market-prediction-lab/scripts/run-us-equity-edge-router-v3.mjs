import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";

const DAY = 86_400_000;
const DATA_START = Date.parse("2024-01-01T00:00:00.000Z");
const TRAIN = Object.freeze({ start: Date.parse("2024-06-01T00:00:00.000Z"), end: Date.parse("2025-10-01T00:00:00.000Z") });
const VALIDATION = Object.freeze({ start: Date.parse("2025-10-01T00:00:00.000Z"), end: Date.parse("2026-03-29T00:00:00.000Z") });
const TEST = Object.freeze({ start: Date.parse("2026-03-29T00:00:00.000Z"), end: Date.parse("2026-09-29T00:00:00.000Z") });
const COST = 0.0015;
const STRESS_COST = COST * 1.5;
const MID_BASE = Object.freeze({
  breakoutLookback: 40, maPeriod: 20, atrPeriod: 14, atrStopMultiplier: 2.5,
  rewardRisk: 2, maxHoldBars: 10, relativeVolumePeriod: 20, minRelativeVolume: 1.2, maxGapPercent: 4,
});
const SMALL_BASE = Object.freeze({
  breakoutLookback: 20, maPeriod: 20, atrPeriod: 14, atrStopMultiplier: 2.5,
  rewardRisk: 2, maxHoldBars: 10, relativeVolumePeriod: 20, minRelativeVolume: 2, maxGapPercent: 10,
});
const BUCKETS = Object.freeze({
  MID: Object.freeze({ minCap: 2_000_000_000, maxCap: 10_000_000_000, limit: 100, minDollarVolume: 5_000_000 }),
  SMALL: Object.freeze({ minCap: 300_000_000, maxCap: 2_000_000_000, limit: 120, minDollarVolume: 2_000_000 }),
});
const ISSUER_EVENT_FORMS = new Set(["8-K","10-Q","10-K","6-K","20-F"]);
const DILUTION_RISK_FORMS = new Set(["S-1","S-3","F-1","F-3","424B5","424B3","POS AM","EFFECT"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function num(v) {
  const n = Number(String(v ?? "").replace(/[$,% ,]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function mean(values) { return values.length ? values.reduce((a,b) => a+b,0) / values.length : null; }
function median(values) {
  if (!values.length) return null;
  const v=[...values].sort((a,b)=>a-b), m=Math.floor(v.length/2);
  return v.length%2 ? v[m] : (v[m-1]+v[m])/2;
}
function sma(candles,index,period) {
  const start=index-period+1; if(start<0) return null;
  let total=0; for(let i=start;i<=index;i++) total+=candles[i].close;
  return total/period;
}
function highestHighBefore(candles,index,period) {
  const start=index-period; if(start<0) return null;
  let high=-Infinity; for(let i=start;i<index;i++) high=Math.max(high,candles[i].high);
  return Number.isFinite(high)?high:null;
}
function averageVolumeBefore(candles,index,period) {
  const start=index-period; if(start<0) return null;
  let total=0; for(let i=start;i<index;i++) total+=candles[i].volume;
  return total/period;
}
function averageDollarVolumeBefore(candles,index,period) {
  const start=index-period; if(start<0) return null;
  let total=0; for(let i=start;i<index;i++) total+=candles[i].close*candles[i].volume;
  return total/period;
}
function trueRange(candle,prevClose) {
  return Math.max(candle.high-candle.low,Math.abs(candle.high-prevClose),Math.abs(candle.low-prevClose));
}
function atr(candles,index,period=14) {
  if(index<period) return null;
  let total=0;
  for(let i=index-period+1;i<=index;i++){if(i<=0)return null;total+=trueRange(candles[i],candles[i-1].close);}
  return total/period;
}
function securityEligible(row) {
  const symbol=String(row.symbol??"").trim().toUpperCase();
  const name=String(row.name??"");
  const industry=String(row.industry??"");
  if(!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return false;
  if(/(Warrant|Rights?|Units?|Preferred|Depositary Preferred)/i.test(name)) return false;
  if(/Blank Checks/i.test(industry)||/Acquisition Corp/i.test(name)) return false;
  if(/[RWU]$/.test(symbol)&&symbol.length>=4) return false;
  return true;
}
async function fetchUniverse() {
  const url="https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true";
  const response=await fetch(url,{headers:{
    accept:"application/json,text/plain,*/*",
    "accept-language":"en-US,en;q=0.9",
    "user-agent":"Mozilla/5.0 Chrome/120",
  }});
  if(!response.ok) throw new Error(`NASDAQ_UNIVERSE_HTTP_${response.status}`);
  const rows=(await response.json())?.data?.rows;
  if(!Array.isArray(rows)||rows.length<1000) throw new Error("NASDAQ_UNIVERSE_INSUFFICIENT");
  return rows.map((row)=>{
    const price=num(row.lastsale),volume=num(row.volume),marketCap=num(row.marketCap);
    return {
      symbol:String(row.symbol??"").trim().toUpperCase(),
      name:String(row.name??"").replace(/\s+/g," ").trim(),
      industry:String(row.industry??""),
      price,volume,marketCap,
      dollarVolume:price!=null&&volume!=null?price*volume:null,
      securityEligible:securityEligible(row),
    };
  });
}
function selectUniverse(rows) {
  const selected={MID:[],SMALL:[]};
  const diag={rawRows:rows.length,bucketCounts:{MID:0,SMALL:0},liquidityEligible:{MID:0,SMALL:0}};
  for(const row of rows){
    if(!row.securityEligible||!(row.price>=2)||!(row.marketCap>0)||!(row.dollarVolume>=0)) continue;
    for(const [bucket,cfg] of Object.entries(BUCKETS)){
      if(row.marketCap>=cfg.minCap&&row.marketCap<cfg.maxCap){
        diag.bucketCounts[bucket]+=1;
        if(row.dollarVolume>=cfg.minDollarVolume) selected[bucket].push(row);
      }
    }
  }
  for(const [bucket,cfg] of Object.entries(BUCKETS)){
    diag.liquidityEligible[bucket]=selected[bucket].length;
    selected[bucket]=selected[bucket]
      .sort((a,b)=>b.dollarVolume-a.dollarVolume||b.marketCap-a.marketCap||a.symbol.localeCompare(b.symbol))
      .slice(0,cfg.limit);
  }
  return {selected,diag};
}
async function historyWithRetry(symbol) {
  let last;
  for(let attempt=0;attempt<3;attempt+=1){
    try{return await collectYahooStockHistory({market:"US_STOCK",symbol,startTime:DATA_START,endTime:TEST.end,timeoutMs:15_000});}
    catch(error){last=error;await sleep(350*(attempt+1));}
  }
  throw last;
}
async function mapLimit(items,limit,fn) {
  const out=new Array(items.length); let next=0;
  async function worker(){
    for(;;){
      const i=next++; if(i>=items.length) return;
      try{out[i]={ok:true,value:await fn(items[i],i)};}
      catch(error){out[i]={ok:false,error:String(error?.message??error)};}
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>worker()));
  return out;
}
async function secJson(url) {
  let last;
  for(let attempt=0;attempt<3;attempt+=1){
    try{
      const r=await fetch(url,{headers:{
        accept:"application/json",
        "user-agent":"seungjae20260713-research/1.0 github.com/seungjae3908-source/seungjae20260713",
      }});
      if(r.status===429){await sleep(1200*(attempt+1));continue;}
      if(!r.ok) throw new Error(`SEC_HTTP_${r.status}`);
      return await r.json();
    }catch(error){last=error;await sleep(500*(attempt+1));}
  }
  throw last;
}
async function buildSecMap() {
  const rows=await secJson("https://www.sec.gov/files/company_tickers.json");
  const map=new Map();
  for(const row of Object.values(rows??{})){
    const ticker=String(row?.ticker??"").toUpperCase();
    const cik=Number(row?.cik_str);
    if(ticker&&Number.isInteger(cik)&&cik>0) map.set(ticker,String(cik).padStart(10,"0"));
  }
  return map;
}
function parseFilingEvents(payload) {
  const recent=payload?.filings?.recent;
  const forms=recent?.form, dates=recent?.filingDate;
  if(!Array.isArray(forms)||!Array.isArray(dates)) return [];
  const out=[];
  for(let i=0;i<Math.min(forms.length,dates.length);i++){
    const form=String(forms[i]??"").trim().toUpperCase();
    const at=Date.parse(String(dates[i]??"")+"T00:00:00.000Z");
    if(form&&Number.isFinite(at)) out.push({form,at});
  }
  return out.sort((a,b)=>a.at-b.at);
}
async function loadSecEvents(smallRows) {
  const tickerMap=await buildSecMap();
  const results=new Map();
  let mapped=0,loaded=0;
  for(const row of smallRows){
    const cik=tickerMap.get(row.symbol);
    if(!cik){results.set(row.symbol,{available:false,events:[],reason:"CIK_NOT_FOUND"});continue;}
    mapped+=1;
    try{
      const payload=await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
      results.set(row.symbol,{available:true,events:parseFilingEvents(payload),reason:null});
      loaded+=1;
    }catch(error){
      results.set(row.symbol,{available:false,events:[],reason:String(error?.message??error)});
    }
    await sleep(130);
  }
  return {results,coverage:{requested:smallRows.length,mapped,loaded}};
}
function latestEventWithin(events,forms,signalAt,days) {
  if(!(days>0)) return false;
  const min=signalAt-days*DAY;
  for(let i=events.length-1;i>=0;i--){
    const e=events[i];
    if(e.at>signalAt) continue;
    if(e.at<min) break;
    if(forms.has(e.form)) return true;
  }
  return false;
}
function benchmarkMap(candles) {
  return new Map(candles.map((c,i)=>[c.timestamp,{close:c.close,index:i}]));
}
function relativeStrengthExcess(candles,index,benchmarkByTs,benchmarkCandles,lookback) {
  if(index<lookback) return null;
  const currentBench=benchmarkByTs.get(candles[index].timestamp);
  const pastBench=benchmarkByTs.get(candles[index-lookback].timestamp);
  if(!currentBench||!pastBench) return null;
  const stockReturn=candles[index].close/candles[index-lookback].close-1;
  const benchReturn=currentBench.close/pastBench.close-1;
  return stockReturn-benchReturn;
}
function benchmarkRegime(candleTs,benchmarkByTs,benchmarkCandles) {
  const row=benchmarkByTs.get(candleTs);
  if(!row) return null;
  const ma=sma(benchmarkCandles,row.index,50);
  return ma==null?null:row.close>ma;
}
function overlayGridMid() {
  const grid=[];
  for(const rsLookback of [20,60])
    for(const minExcessReturn of [0,0.03,0.05,0.10])
      for(const minDollarVolumeAcceleration of [1,1.2,1.5,2])
        for(const requireBenchmarkUptrend of [false,true])
          grid.push({rsLookback,minExcessReturn,minDollarVolumeAcceleration,requireBenchmarkUptrend,issuerEventRequired:false,rejectDilution:false});
  return grid;
}
function overlayGridSmall() {
  const grid=[];
  for(const rsLookback of [20,60])
    for(const minExcessReturn of [0.05,0.10,0.20])
      for(const minDollarVolumeAcceleration of [1.5,2,3])
        for(const requireBenchmarkUptrend of [false,true])
          for(const issuerEventRequired of [false,true])
            for(const rejectDilution of [false,true])
              grid.push({rsLookback,minExcessReturn,minDollarVolumeAcceleration,requireBenchmarkUptrend,issuerEventRequired,rejectDilution});
  return grid;
}
function rangeIndices(candles,range) {
  const start=candles.findIndex(c=>c.timestamp>=range.start);
  let end=candles.length-1;
  while(end>=0&&candles[end].timestamp>=range.end) end-=1;
  return start>=0&&end>start?{start,end}:null;
}
function simulateOverlay({row,base,overlay,range,cost,benchmarkByTs,benchmarkCandles,secRecord}) {
  const candles=row.candles;
  const bounds=rangeIndices(candles,range);
  if(!bounds) return [];
  const warmup=Math.max(base.breakoutLookback,base.maPeriod,base.atrPeriod,base.relativeVolumePeriod,overlay.rsLookback,25)+1;
  let signalIndex=Math.max(bounds.start,warmup);
  const trades=[];
  while(signalIndex<bounds.end){
    const signal=candles[signalIndex];
    const resistance=highestHighBefore(candles,signalIndex,base.breakoutLookback);
    const ma=sma(candles,signalIndex,base.maPeriod);
    const signalAtr=atr(candles,signalIndex,base.atrPeriod);
    const avgVol=averageVolumeBefore(candles,signalIndex,base.relativeVolumePeriod);
    const rvol=avgVol&&avgVol>0?signal.volume/avgVol:null;
    const baseQualifies=resistance!=null&&ma!=null&&signalAtr!=null&&signalAtr>0&&rvol!=null
      &&signal.close>resistance&&signal.close>ma&&rvol>=base.minRelativeVolume;
    if(!baseQualifies){signalIndex+=1;continue;}
    const avgDollar=averageDollarVolumeBefore(candles,signalIndex,20);
    const dollarAccel=avgDollar&&avgDollar>0?(signal.close*signal.volume)/avgDollar:null;
    const rs=relativeStrengthExcess(candles,signalIndex,benchmarkByTs,benchmarkCandles,overlay.rsLookback);
    const marketUp=benchmarkRegime(signal.timestamp,benchmarkByTs,benchmarkCandles);
    const secEvents=secRecord?.events??[];
    const issuerEvent=latestEventWithin(secEvents,ISSUER_EVENT_FORMS,signal.timestamp,5);
    const dilutionRisk=latestEventWithin(secEvents,DILUTION_RISK_FORMS,signal.timestamp,60);
    const overlayPass=rs!=null&&rs>=overlay.minExcessReturn
      &&dollarAccel!=null&&dollarAccel>=overlay.minDollarVolumeAcceleration
      &&(!overlay.requireBenchmarkUptrend||marketUp===true)
      &&(!overlay.issuerEventRequired||(secRecord?.available===true&&issuerEvent))
      &&(!overlay.rejectDilution||!(secRecord?.available===true&&dilutionRisk));
    if(!overlayPass){signalIndex+=1;continue;}
    const entryIndex=signalIndex+1;
    if(entryIndex>bounds.end) break;
    const entry=candles[entryIndex];
    const gapPercent=Math.abs(entry.open/signal.close-1)*100;
    if(gapPercent>base.maxGapPercent){signalIndex+=1;continue;}
    const entryPrice=entry.open*(1+cost);
    const stopDistance=signalAtr*base.atrStopMultiplier;
    const stopPrice=entry.open-stopDistance;
    const targetPrice=entry.open+stopDistance*base.rewardRisk;
    if(!(stopPrice>0&&targetPrice>entry.open)){signalIndex+=1;continue;}
    const last=Math.min(bounds.end,entryIndex+base.maxHoldBars-1);
    let exitIndex=last,rawExit=candles[last].close,exitReason="time";
    for(let i=entryIndex;i<=last;i++){
      const c=candles[i],stop=c.low<=stopPrice,target=c.high>=targetPrice;
      if(stop&&target){exitIndex=i;rawExit=stopPrice;exitReason="stop_same_bar_conservative";break;}
      if(stop){exitIndex=i;rawExit=stopPrice;exitReason="stop";break;}
      if(target){exitIndex=i;rawExit=targetPrice;exitReason="target";break;}
    }
    const exitPrice=rawExit*(1-cost);
    trades.push({
      symbol:row.symbol,signalTimestamp:signal.timestamp,entryTimestamp:entry.timestamp,exitTimestamp:candles[exitIndex].timestamp,
      netReturn:exitPrice/entryPrice-1,exitReason,relativeStrengthExcess:rs,dollarVolumeAcceleration:dollarAccel,
      benchmarkUptrend:marketUp,issuerEvent,dilutionRisk,secAvailable:secRecord?.available===true,
    });
    signalIndex=exitIndex+1;
  }
  return trades;
}
function summarize(trades,rows) {
  const returns=trades.map(t=>t.netReturn).filter(Number.isFinite);
  const wins=returns.filter(x=>x>0),losses=returns.filter(x=>x<0);
  const gp=wins.reduce((a,b)=>a+b,0),gl=Math.abs(losses.reduce((a,b)=>a+b,0));
  const bySymbol=new Map();
  for(const row of rows) bySymbol.set(row.symbol,[]);
  for(const t of trades)(bySymbol.get(t.symbol)??[]).push(t.netReturn);
  const active=[...bySymbol.entries()].filter(([,v])=>v.length>0);
  const symbolReturns=[...bySymbol.values()].map(v=>v.reduce((eq,r)=>eq*(1+r),1)-1);
  const positiveActive=active.filter(([,v])=>v.reduce((eq,r)=>eq*(1+r),1)-1>0).length;
  let equity=1,peak=1,maxDrawdown=0;
  for(const r of returns){equity*=Math.max(0.000001,1+r);peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak);}
  return {
    tradeCount:returns.length,
    winRate:returns.length?wins.length/returns.length:0,
    expectancy:returns.length?returns.reduce((a,b)=>a+b,0)/returns.length:0,
    profitFactor:gl>0?gp/gl:gp>0?999:null,
    tradeChainMaxDrawdown:maxDrawdown,
    activeSymbols:active.length,
    positiveActiveSymbols:positiveActive,
    positiveActiveRatio:active.length?positiveActive/active.length:0,
    medianSymbolReturn:median(symbolReturns),
    equalWeightSymbolReturn:mean(symbolReturns),
    issuerEventTradeRatio:trades.length?trades.filter(t=>t.issuerEvent).length/trades.length:0,
    dilutionRiskTradeRatio:trades.length?trades.filter(t=>t.dilutionRisk).length/trades.length:0,
    secAvailableTradeRatio:trades.length?trades.filter(t=>t.secAvailable).length/trades.length:0,
  };
}
function evaluate(rows,base,overlay,range,cost,benchmarkByTs,benchmarkCandles,secMap) {
  const trades=[];
  for(const row of rows){
    const secRecord=secMap?.get(row.symbol)??{available:false,events:[]};
    trades.push(...simulateOverlay({row,base,overlay,range,cost,benchmarkByTs,benchmarkCandles,secRecord}));
  }
  return summarize(trades,rows);
}
function score(summary) {
  if(summary.tradeCount<25) return -1e9;
  const pf=Number.isFinite(summary.profitFactor)?Math.min(summary.profitFactor,4):4;
  return summary.expectancy*250+(pf-1)*2+summary.positiveActiveRatio*4+(summary.medianSymbolReturn??0)*25+Math.min(2,summary.tradeCount/150);
}
function pass(summary) {
  return summary.tradeCount>=25&&summary.expectancy>0&&summary.profitFactor>=1.10&&summary.positiveActiveRatio>=0.50;
}
function optimize(rows,base,grid,benchmarkByTs,benchmarkCandles,secMap) {
  const trained=grid.map(overlay=>({overlay,train:evaluate(rows,base,overlay,TRAIN,COST,benchmarkByTs,benchmarkCandles,secMap)}))
    .sort((a,b)=>score(b.train)-score(a.train));
  const finalists=trained.slice(0,Math.min(24,trained.length))
    .map(c=>({...c,validation:evaluate(rows,base,c.overlay,VALIDATION,COST,benchmarkByTs,benchmarkCandles,secMap)}))
    .sort((a,b)=>score(b.validation)-score(a.validation));
  const selected=finalists.find(c=>pass(c.validation))??finalists[0];
  const test=evaluate(rows,base,selected.overlay,TEST,COST,benchmarkByTs,benchmarkCandles,secMap);
  const stressedTest=evaluate(rows,base,selected.overlay,TEST,STRESS_COST,benchmarkByTs,benchmarkCandles,secMap);
  const baseTest=evaluate(rows,base,{rsLookback:20,minExcessReturn:-999,minDollarVolumeAcceleration:0,requireBenchmarkUptrend:false,issuerEventRequired:false,rejectDilution:false},TEST,COST,benchmarkByTs,benchmarkCandles,secMap);
  return {
    gridCandidates:grid.length,
    selectedOverlay:selected.overlay,
    train:selected.train,
    validation:selected.validation,
    test,
    stressedTest,
    baseTest,
    improvementVsBaseTest:{
      expectancy:test.expectancy-baseTest.expectancy,
      profitFactor:(test.profitFactor??0)-(baseTest.profitFactor??0),
      positiveActiveRatio:test.positiveActiveRatio-baseTest.positiveActiveRatio,
      tradeCount:test.tradeCount-baseTest.tradeCount,
    },
    gates:{validationPassed:pass(selected.validation),testPassed:pass(test),stressPassed:pass(stressedTest)},
    status:pass(selected.validation)&&pass(test)&&pass(stressedTest)?"research_candidate":"research_hold",
  };
}
async function main() {
  const {selected,diag}=selectUniverse(await fetchUniverse());
  const flat=[];for(const [bucket,rows] of Object.entries(selected))for(const row of rows)flat.push({...row,bucket});
  const fetched=await mapLimit(flat,5,async(row)=>{
    const h=await historyWithRetry(row.symbol);
    const firstValidation=h.candles.findIndex(c=>c.timestamp>=VALIDATION.start);
    if(firstValidation<80) throw new Error(`HISTORY_TOO_SHORT:${row.symbol}:${firstValidation}`);
    return {...row,candles:h.candles};
  });
  const ok=fetched.filter(x=>x.ok).map(x=>x.value),bad=fetched.filter(x=>!x.ok);
  const mid=ok.filter(x=>x.bucket==="MID"),small=ok.filter(x=>x.bucket==="SMALL");
  const spy=await historyWithRetry("SPY");
  const benchmarkByTs=benchmarkMap(spy.candles);
  const sec=await loadSecEvents(small);
  const midResult=optimize(mid,MID_BASE,overlayGridMid(),benchmarkByTs,spy.candles,new Map());
  const smallResult=optimize(small,SMALL_BASE,overlayGridSmall(),benchmarkByTs,spy.candles,sec.results);
  const result={
    schemaVersion:1,status:"pass",market:"US_STOCK",purpose:"bucket-specific edge overlay research",
    windows:{
      train:[new Date(TRAIN.start).toISOString(),new Date(TRAIN.end).toISOString()],
      validation:[new Date(VALIDATION.start).toISOString(),new Date(VALIDATION.end).toISOString()],
      lockedTest:[new Date(TEST.start).toISOString(),new Date(TEST.end).toISOString()],
    },
    selectionContract:{
      testUsedForSelection:false,currentSnapshotUsedForUniverse:true,currentSnapshotBiasAcknowledged:true,
      baseV2ParametersFrozen:true,overlayParametersSelectedTrainValidationOnly:true,
      secIssuerEventDefinition:[...ISSUER_EVENT_FORMS],secDilutionRiskDefinition:[...DILUTION_RISK_FORMS],
      issuerEventIsDirectionalPositiveCatalyst:false,
    },
    universe:{...diag,selectedCounts:{MID:selected.MID.length,SMALL:selected.SMALL.length},historyAttempts:flat.length,historySuccesses:ok.length,historyFailures:bad.length},
    secCoverage:sec.coverage,
    MID:{strategyFamily:"breakout_v2_plus_relative_strength_volume_regime_v3",baseParameters:MID_BASE,historySymbols:mid.length,...midResult},
    SMALL:{strategyFamily:"high_rvol_v2_plus_rs_volume_sec_event_dilution_v3",baseParameters:SMALL_BASE,historySymbols:small.length,...smallResult},
    costs:{normalPerSide:COST,stressPerSide:STRESS_COST},
    safety:{researchOnly:true,liveExecutionAllowed:false,privateAccountRequestAllowed:false,executionAuthority:"NONE"},
    limitations:[
      "Current market-cap/liquidity snapshot creates survivorship and selection bias; this is not point-in-time universe proof.",
      "SEC issuer-event forms indicate a filing event, not a positive directional catalyst by themselves.",
      "Form-level dilution-risk forms are a conservative risk flag and do not prove dilution will occur.",
      "Point-in-time public-float share history is not available in this experiment and is intentionally not fabricated.",
      "Daily OHLC execution remains conservative stop-first on same-bar stop/target ambiguity.",
      "This research cannot promote profitability, Paper, live trading, or order authority.",
    ],
  };
  const out=resolve(process.argv[2]??"docs/us-equity-edge-router-v3.json");
  await mkdir(dirname(out),{recursive:true});
  await writeFile(out,JSON.stringify(result,null,2)+"\n","utf8");
  console.log(JSON.stringify(result,null,2));
}
await main();
