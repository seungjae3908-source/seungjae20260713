import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";

const START = Date.parse("2009-01-01T00:00:00.000Z");
const END = Date.parse("2026-09-30T00:00:00.000Z");
const SYMBOLS = Object.freeze(["SPY", "QQQ", "IWM", "DIA"]);
const COST_PER_SIDE = 0.0015;
const STRESS_COST_PER_SIDE = COST_PER_SIDE * 1.5;
const RULE = Object.freeze({
  id: "CONNORS_RSI2_CLASSIC_V1",
  rsiPeriod: 2,
  rsiThreshold: 5,
  trendSma: 200,
  exitSma: 5,
  longOnly: true,
  stopLoss: null,
});
const WINDOWS = Object.freeze({
  PRIOR: Object.freeze({ start: "2010-01-01", endExclusive: "2017-01-01" }),
  MID: Object.freeze({ start: "2017-01-01", endExclusive: "2023-01-01" }),
  RECENT: Object.freeze({ start: "2023-01-01", endExclusive: "2026-10-01" }),
});
const SOURCE_BOOK = "Larry Connors & Cesar Alvarez, Short Term Trading Strategies That Work";
const SOURCE_REFERENCE = "https://www.reddit.com/r/algotrading/comments/1fm5lfj/backtest_results_for_connors_rsi2_strategy/";

function mean(values) { return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null; }
function median(values) {
  if (!values.length) return null;
  const a=[...values].sort((x,y)=>x-y); const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
}
function dateOf(ms){ return new Date(ms).toISOString().slice(0,10); }
function inWindow(ms, window){ const d=dateOf(ms); return d>=window.start && d<window.endExclusive; }
function sma(candles, index, period) {
  if(index-period+1<0) return null;
  let sum=0; for(let i=index-period+1;i<=index;i+=1) sum+=candles[i].close;
  return sum/period;
}
function rsiWilder(candles, period=2) {
  const out=new Array(candles.length).fill(null);
  if(candles.length<=period) return out;
  let gains=0, losses=0;
  for(let i=1;i<=period;i+=1){
    const delta=candles[i].close-candles[i-1].close;
    if(delta>0) gains+=delta; else losses-=delta;
  }
  let avgGain=gains/period, avgLoss=losses/period;
  out[period]=avgLoss===0?100:100-(100/(1+avgGain/avgLoss));
  for(let i=period+1;i<candles.length;i+=1){
    const delta=candles[i].close-candles[i-1].close;
    const gain=Math.max(delta,0), loss=Math.max(-delta,0);
    avgGain=((period-1)*avgGain+gain)/period;
    avgLoss=((period-1)*avgLoss+loss)/period;
    out[i]=avgLoss===0?100:100-(100/(1+avgGain/avgLoss));
  }
  return out;
}
function summarize(trades) {
  if(!trades.length) return {trades:0,meanNetReturn:null,medianNetReturn:null,winRate:null,profitFactor:null,compoundSequential:null,maxDrawdown:null,meanHoldDays:null};
  const returns=trades.map(t=>t.netReturn);
  const gains=returns.filter(v=>v>0).reduce((s,v)=>s+v,0);
  const losses=-returns.filter(v=>v<0).reduce((s,v)=>s+v,0);
  let equity=1, peak=1, maxDrawdown=0;
  for(const r of returns){ equity*=1+r; peak=Math.max(peak,equity); maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak); }
  return {
    trades:trades.length,
    meanNetReturn:mean(returns),
    medianNetReturn:median(returns),
    winRate:returns.filter(v=>v>0).length/returns.length,
    profitFactor:losses>0?gains/losses:(gains>0?null:0),
    compoundSequential:equity-1,
    maxDrawdown,
    meanHoldDays:mean(trades.map(t=>t.holdBars)),
  };
}
function executeTrade(candles, signalIndex, rsi, costPerSide, mode, window) {
  const entryIndex=mode==="SOURCE_CLOSE"?signalIndex:signalIndex+1;
  if(entryIndex>=candles.length || !inWindow(candles[entryIndex].timestamp,window)) return null;
  const rawEntry=mode==="SOURCE_CLOSE"?candles[entryIndex].close:candles[entryIndex].open;
  const entryFill=rawEntry*(1+costPerSide);
  let exitIndex=null, exitReason=null, rawExit=null;
  for(let i=signalIndex+1;i<candles.length;i+=1){
    if(!inWindow(candles[i].timestamp,window)) break;
    const ma5=sma(candles,i,RULE.exitSma);
    if(!(ma5>0)) continue;
    if(candles[i].close>ma5){
      if(mode==="SOURCE_CLOSE"){
        exitIndex=i; rawExit=candles[i].close; exitReason="CLOSE_ABOVE_SMA5";
      } else if(i+1<candles.length && inWindow(candles[i+1].timestamp,window)){
        exitIndex=i+1; rawExit=candles[i+1].open; exitReason="NEXT_OPEN_AFTER_CLOSE_ABOVE_SMA5";
      }
      break;
    }
  }
  if(exitIndex==null){
    const last=[...candles].reverse().findIndex(c=>inWindow(c.timestamp,window));
    if(last<0) return null;
    exitIndex=candles.length-1-last;
    if(exitIndex<=entryIndex) return null;
    rawExit=candles[exitIndex].close; exitReason="WINDOW_END_FORCED_EXIT";
  }
  const exitFill=rawExit*(1-costPerSide);
  return {
    signalDate:dateOf(candles[signalIndex].timestamp),
    entryDate:dateOf(candles[entryIndex].timestamp),
    exitDate:dateOf(candles[exitIndex].timestamp),
    rsi2:rsi[signalIndex],
    signalClose:candles[signalIndex].close,
    rawEntry,
    rawExit,
    netReturn:exitFill/entryFill-1,
    holdBars:exitIndex-entryIndex+1,
    exitReason,
  };
}
function replay(symbol,candles,window,costPerSide,mode) {
  const rsi=rsiWilder(candles,RULE.rsiPeriod);
  const trades=[];
  let nextEligible=0;
  for(let i=Math.max(RULE.trendSma,RULE.rsiPeriod);i<candles.length;i+=1){
    if(i<nextEligible || !inWindow(candles[i].timestamp,window)) continue;
    const ma200=sma(candles,i,RULE.trendSma);
    if(!(ma200>0)) continue;
    if(!(candles[i].close>ma200 && rsi[i]!=null && rsi[i]<RULE.rsiThreshold)) continue;
    const trade=executeTrade(candles,i,rsi,costPerSide,mode,window);
    if(!trade) continue;
    trades.push({symbol,...trade});
    const exitIndex=candles.findIndex(c=>dateOf(c.timestamp)===trade.exitDate);
    nextEligible=Math.max(i+1,exitIndex+1);
  }
  return {metrics:summarize(trades),trades};
}
function buyHold(candles,window,costPerSide) {
  const rows=candles.filter(c=>inWindow(c.timestamp,window));
  if(rows.length<2) return null;
  return rows.at(-1).close*(1-costPerSide)/(rows[0].open*(1+costPerSide))-1;
}
async function collectLongYahooHistory(symbol) {
  const split = Date.parse("2018-01-01T00:00:00.000Z");
  const parts = [];
  for (const [startTime, endTime] of [[START, split], [split - 7 * 86400000, END]]) {
    parts.push(await collectYahooStockHistory({
      market: "US_STOCK",
      symbol,
      startTime,
      endTime,
      timeoutMs: 20000,
    }));
  }
  const byTimestamp = new Map();
  for (const part of parts) {
    for (const candle of part.candles) byTimestamp.set(candle.timestamp, candle);
  }
  const candles = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  return {
    source: "yahoo-public-chart",
    candles,
    firstTimestamp: candles[0]?.timestamp ?? null,
    lastTimestamp: candles.at(-1)?.timestamp ?? null,
  };
}

function selfTest(){
  const candles=[]; let p=100;
  for(let i=0;i<260;i+=1){
    p*=i===230?0.90:1.001;
    candles.push({timestamp:Date.UTC(2020,0,1)+i*86400000,open:p,high:p*1.01,low:p*0.99,close:p,volume:1});
  }
  const r=rsiWilder(candles,2);
  if(!Number.isFinite(r[230])) throw new Error("SELFTEST_RSI");
  if(!(sma(candles,230,200)>0)) throw new Error("SELFTEST_SMA");
  console.log("CONNORS_RSI2_SELF_TEST_OK");
}
async function main(){
  if(process.argv.includes("--self-test")){ selfTest(); return; }
  const datasets=[];
  for(const symbol of SYMBOLS){
    const data=await collectLongYahooHistory(symbol);
    if(data.candles.length<3000) throw new Error(`${symbol}_INSUFFICIENT_HISTORY_${data.candles.length}`);
    datasets.push({symbol,candles:data.candles,report:{symbol,provider:data.source,candleCount:data.candles.length,firstDate:dateOf(data.firstTimestamp),lastDate:dateOf(data.lastTimestamp)}});
  }
  const results={};
  for(const {symbol,candles} of datasets){
    results[symbol]={};
    for(const [windowName,window] of Object.entries(WINDOWS)){
      results[symbol][windowName]={
        sourceClose:{
          normal:replay(symbol,candles,window,COST_PER_SIDE,"SOURCE_CLOSE"),
          stress15x:replay(symbol,candles,window,STRESS_COST_PER_SIDE,"SOURCE_CLOSE"),
        },
        causalNextOpen:{
          normal:replay(symbol,candles,window,COST_PER_SIDE,"NEXT_OPEN"),
          stress15x:replay(symbol,candles,window,STRESS_COST_PER_SIDE,"NEXT_OPEN"),
        },
        priceOnlyBuyHold:buyHold(candles,window,COST_PER_SIDE),
      };
    }
  }
  const aggregate={};
  for(const windowName of Object.keys(WINDOWS)){
    const source=SYMBOLS.map(s=>results[s][windowName].sourceClose.normal.metrics);
    const causal=SYMBOLS.map(s=>results[s][windowName].causalNextOpen.normal.metrics);
    const stress=SYMBOLS.map(s=>results[s][windowName].causalNextOpen.stress15x.metrics);
    aggregate[windowName]={
      symbolsPositiveSourceClose:source.filter(m=>m.compoundSequential>0).length,
      symbolsPositiveCausalNextOpen:causal.filter(m=>m.compoundSequential>0).length,
      symbolsPositiveCausalStress:stress.filter(m=>m.compoundSequential>0).length,
      meanSourceCloseCompound:mean(source.map(m=>m.compoundSequential)),
      meanCausalNextOpenCompound:mean(causal.map(m=>m.compoundSequential)),
      meanCausalStressCompound:mean(stress.map(m=>m.compoundSequential)),
      meanCausalProfitFactor:mean(causal.map(m=>m.profitFactor).filter(Number.isFinite)),
      meanCausalMaxDrawdown:mean(causal.map(m=>m.maxDrawdown)),
      meanPriceOnlyBuyHold:mean(SYMBOLS.map(s=>results[s][windowName].priceOnlyBuyHold)),
    };
  }
  const crossWindowCausalPass=Object.values(aggregate).every(row=>row.symbolsPositiveCausalStress===SYMBOLS.length);
  const report={
    schemaVersion:1,
    status:"pass",
    recipeId:RULE.id,
    market:"US_STOCK",
    purpose:"source-faithful Connors RSI2 mean-reversion baseline before any local overlay or tuning",
    source:{
      book:SOURCE_BOOK,
      secondaryRuleReference:SOURCE_REFERENCE,
      rules:{
        entry:"Close above 200-day SMA and RSI(2) below 5; buy at close",
        exit:"Exit when close is above 5-day SMA",
        stop:"No fixed stop in classic baseline",
      },
    },
    implementation:{
      parameterSearch:false,
      ruleRetuning:false,
      rsiMethod:"Wilder RSI",
      sourceCloseMode:"descriptive source-faithful close execution",
      causalNextOpenMode:"signal on close, execute next session open; conservative causality check",
      costPerSide:COST_PER_SIDE,
      stressCostPerSide:STRESS_COST_PER_SIDE,
      dividendsIncluded:false,
      corporateActionTotalReturnClaimAllowed:false,
    },
    data:{provider:"Yahoo public daily chart",datasets:datasets.map(d=>d.report),symbols:SYMBOLS},
    windows:WINDOWS,
    results,
    aggregate,
    promotionAssessment:{
      status:crossWindowCausalPass?"REFERENCE_CANDIDATE_REQUIRES_FUTURE_OOS":"RESEARCH_HOLD_CROSS_SYMBOL_OR_WINDOW_GENERALIZATION_FAILED",
      crossWindowCausalStressPassed:crossWindowCausalPass,
      automaticPromotionAllowed:false,
      economicSampleCredit:0,
      profitabilityClaimAllowed:false,
      ruleOrSymbolSelectionAfterObservationAllowed:false,
    },
    safeguards:{
      researchOnly:true,
      publicDataOnly:true,
      privateAccountRequestAllowed:false,
      orderRouteCalled:false,
      actualOrders:0,
      executionAuthority:"NONE",
      liveExecutionAllowed:false,
    },
    limitations:[
      "Yahoo owner currently uses price OHLC rather than dividend-adjusted total returns; buy-and-hold comparisons are price-only.",
      "Source-close execution is descriptive because the full close is needed to know the signal. Causal next-open is reported separately.",
      "No stop is added because that would change the classic baseline.",
      "SPY/QQQ/IWM/DIA are long-lived ETFs, not a complete US equity universe.",
      "Historical replay cannot prove future profitability and cannot change PROFITABILITY_PROVEN.",
    ],
  };
  const out=resolve(process.argv[2]??"docs/us-connors-rsi2-reference-v1.json");
  await mkdir(dirname(out),{recursive:true});
  await writeFile(out,JSON.stringify(report,null,2)+"\n","utf8");
  console.log(JSON.stringify({
    status:report.status,
    promotionStatus:report.promotionAssessment.status,
    prior:report.aggregate.PRIOR,
    mid:report.aggregate.MID,
    recent:report.aggregate.RECENT,
  }));
}
await main();
