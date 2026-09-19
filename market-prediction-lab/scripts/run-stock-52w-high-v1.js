import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";

const DAY=86_400_000;
const LOOKBACK=252;
const TREND_MA=200;
const REBALANCE=21;
const TOP_N=3;

const SPECS=Object.freeze({
  KR_STOCK:Object.freeze({
    symbols:Object.freeze(["005490","012330","066570","028260","032830","086790","017670","096770","009150","018260","030200","034730","010950","011170","024110","033780"]),
    cost:0.0025,
  }),
  US_STOCK:Object.freeze({
    symbols:Object.freeze(["AAPL","MSFT","NVDA","AMZN","GOOGL","META","JPM","XOM","AVGO","COST","WMT","V","MA","HD","UNH","PG"]),
    cost:0.0015,
  }),
  US_SECTOR_ETF:Object.freeze({
    symbols:Object.freeze(["XLB","XLE","XLF","XLI","XLK","XLP","XLU","XLV","XLY"]),
    cost:0.0015,
  }),
});

async function save(file,value){
  await mkdir(dirname(file),{recursive:true});
  await writeFile(file,JSON.stringify(value,null,2)+"\n","utf8");
}
function sma(vals,end,period){
  const start=end-period+1;if(start<0)return null;
  let s=0;for(let i=start;i<=end;i++)s+=vals[i];return s/period;
}
function highest(vals,endExclusive,period){
  const start=endExclusive-period;if(start<0)return null;
  let h=-Infinity;for(let i=start;i<endExclusive;i++)h=Math.max(h,vals[i]);return Number.isFinite(h)?h:null;
}
function align(histories,symbols){
  const maps=Object.fromEntries(symbols.map(s=>[s,new Map(histories[s].candles.map(c=>[c.timestamp,c]))]));
  const common=[...maps[symbols[0]].keys()].filter(t=>symbols.every(s=>maps[s].has(t))).sort((a,b)=>a-b);
  if(common.length<1000)throw new Error("INSUFFICIENT_COMMON_DAILY_BARS_"+common.length);
  const opens={},closes={},highs={};
  for(const s of symbols){
    opens[s]=common.map(t=>maps[s].get(t).open);
    closes[s]=common.map(t=>maps[s].get(t).close);
    highs[s]=common.map(t=>maps[s].get(t).high);
  }
  return {timestamps:common,opens,closes,highs};
}
function weightsAt(data,symbols,openIndex){
  const signal=openIndex-1;
  if(signal<LOOKBACK||signal<TREND_MA)return Object.fromEntries(symbols.map(s=>[s,0]));
  const ranked=[];
  for(const s of symbols){
    const hi=highest(data.highs[s],signal+1,LOOKBACK);
    const ma=sma(data.closes[s],signal,TREND_MA);
    const close=data.closes[s][signal];
    if(hi&&ma&&close>ma) ranked.push({s,score:close/hi});
  }
  ranked.sort((a,b)=>b.score-a.score);
  const selected=ranked.slice(0,TOP_N);
  const w=Object.fromEntries(symbols.map(s=>[s,0]));
  if(selected.length){
    const each=1/selected.length;for(const x of selected)w[x.s]=each;
  }
  return w;
}
function summarize(curve,periods,years,fees){
  let peak=curve[0]??1,mdd=0;
  for(const e of curve){peak=Math.max(peak,e);mdd=Math.max(mdd,(peak-e)/peak);}
  const wins=periods.filter(x=>x>0),loss=periods.filter(x=>x<0);
  const gp=wins.reduce((a,b)=>a+b,0),gl=Math.abs(loss.reduce((a,b)=>a+b,0));
  const ret=(curve.at(-1)??1)/(curve[0]??1)-1;
  return {return:ret,annualizedReturn:years>0?Math.pow(Math.max(1e-9,1+ret),1/years)-1:null,
    maxDrawdown:mdd,periods:periods.length,winRate:periods.length?wins.length/periods.length:0,
    profitFactor:gl>0?gp/gl:(gp>0?null:0),feesPaid:fees};
}
function simulate(data,symbols,cost,startIndex){
  const begin=Math.max(LOOKBACK+2,TREND_MA+2,startIndex);
  let cash=1,fees=0,lastEq=1,started=false;
  const units=Object.fromEntries(symbols.map(s=>[s,0])),curve=[1],periods=[];
  for(let i=begin;i<data.timestamps.length;i++){
    const prices=Object.fromEntries(symbols.map(s=>[s,data.opens[s][i]]));
    let equity=cash+symbols.reduce((sum,s)=>sum+units[s]*prices[s],0);curve.push(equity);
    if((i-begin)%REBALANCE!==0)continue;
    if(started)periods.push(equity/lastEq-1);
    const weights=weightsAt(data,symbols,i);
    const current=Object.fromEntries(symbols.map(s=>[s,units[s]*prices[s]]));
    const targets=Object.fromEntries(symbols.map(s=>[s,weights[s]*equity]));
    const turnover=symbols.reduce((sum,s)=>sum+Math.abs(targets[s]-current[s]),0);
    const fee=turnover*cost;fees+=fee;equity=Math.max(0,equity-fee);
    for(const s of symbols)units[s]=weights[s]*equity/prices[s];
    cash=(1-Object.values(weights).reduce((a,b)=>a+b,0))*equity;
    lastEq=equity;started=true;curve.push(equity);
  }
  const i=data.timestamps.length-1,finalPrices=Object.fromEntries(symbols.map(s=>[s,data.closes[s][i]]));
  let equity=cash+symbols.reduce((sum,s)=>sum+units[s]*finalPrices[s],0);
  if(started)periods.push(equity/lastEq-1);
  const liquidation=symbols.reduce((sum,s)=>sum+Math.abs(units[s]*finalPrices[s]),0);
  const fee=liquidation*cost;fees+=fee;equity=Math.max(0,equity-fee);curve.push(equity);
  const years=(data.timestamps.at(-1)-data.timestamps[begin])/(365.25*DAY);
  return summarize(curve,periods,years,fees);
}
function buyHold(data,symbols,cost,startIndex){
  const begin=Math.max(LOOKBACK+2,TREND_MA+2,startIndex),each=1/symbols.length;
  let equity=Math.max(0,1-cost);
  const units=Object.fromEntries(symbols.map(s=>[s,each*equity/data.opens[s][begin]])),curve=[equity];
  for(let i=begin;i<data.timestamps.length;i++){
    curve.push(symbols.reduce((sum,s)=>sum+units[s]*data.opens[s][i],0));
  }
  const last=data.timestamps.length-1;
  let final=symbols.reduce((sum,s)=>sum+units[s]*data.closes[s][last],0)*(1-cost);
  curve.push(final);
  let peak=curve[0],mdd=0;for(const e of curve){peak=Math.max(peak,e);mdd=Math.max(mdd,(peak-e)/peak);}
  const years=(data.timestamps.at(-1)-data.timestamps[begin])/(365.25*DAY),ret=final/curve[0]-1;
  return {return:ret,annualizedReturn:Math.pow(Math.max(1e-9,1+ret),1/years)-1,maxDrawdown:mdd};
}

const output=resolve(process.argv[2]??"market-prediction-lab/artifacts/stock-52w-high-v1/result.json");
const endTime=Date.now(),startTime=endTime-3650*DAY;
try{
  const markets={};
  for(const [market,spec] of Object.entries(SPECS)){
    const histories={},provenance={};
    for(const symbol of spec.symbols){
      const h=await collectYahooStockHistory({market:market==="US_SECTOR_ETF"?"US_STOCK":market,symbol,startTime,endTime});
      histories[symbol]=h;provenance[symbol]={providerSymbol:h.providerSymbol,candleCount:h.candleCount,firstTimestamp:h.firstTimestamp,lastTimestamp:h.lastTimestamp,source:h.source};
    }
    const data=align(histories,spec.symbols),recent=Math.floor(data.timestamps.length*0.70);
    markets[market]={
      symbols:spec.symbols,commonBars:data.timestamps.length,costRatePerSide:spec.cost,
      full:simulate(data,spec.symbols,spec.cost,0),
      stressFull:simulate(data,spec.symbols,spec.cost*1.5,0),
      recent30pct:simulate(data,spec.symbols,spec.cost,recent),
      recent30pctStress:simulate(data,spec.symbols,spec.cost*1.5,recent),
      equalWeightBuyHold:{full:buyHold(data,spec.symbols,spec.cost,0),recent30pct:buyHold(data,spec.symbols,spec.cost,recent)},
      provenance,
    };
  }
  const report={schemaVersion:1,status:"pass",kind:"stock-52w-high-v1",researchOnly:true,publicDataOnly:true,
    liveExecutionAllowed:false,privateAccountRequestAllowed:false,actualOrders:0,fixedBeforeRun:true,lookaheadFree:true,
    formula:{score:"latest completed close / highest high over prior 252 trading days",absoluteGate:"latest close > SMA200",topN:TOP_N,
      rebalanceTradingDays:REBALANCE,execution:"completed close i-1 -> next session open i",longOnly:true},
    limitations:["individual stock universes use current large caps and have survivorship bias","sector ETF test reduces constituent survivorship bias","Yahoo public chart data"],markets};
  await save(output,report);console.log(JSON.stringify(report,null,2));
}catch(error){
  const report={schemaVersion:1,status:"fail",researchOnly:true,actualOrders:0,liveExecutionAllowed:false,error:{name:error?.name??"Error",message:String(error?.message??error).slice(0,1200)}};
  await save(output,report);console.error(JSON.stringify(report,null,2));process.exitCode=1;
}
