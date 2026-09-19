import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";

const DAY=86_400_000;
const MOM_LONG=252;
const SKIP_RECENT=21;
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
});

async function save(file,value){
  await mkdir(dirname(file),{recursive:true});
  await writeFile(file,JSON.stringify(value,null,2)+"\n","utf8");
}

function sma(values,endIndex,period){
  const start=endIndex-period+1;
  if(start<0)return null;
  let sum=0;
  for(let i=start;i<=endIndex;i++)sum+=values[i];
  return sum/period;
}

function align(histories,symbols){
  const maps=Object.fromEntries(symbols.map(s=>[s,new Map(histories[s].candles.map(c=>[c.timestamp,c]))]));
  const common=[...maps[symbols[0]].keys()].filter(t=>symbols.every(s=>maps[s].has(t))).sort((a,b)=>a-b);
  if(common.length<1000)throw new Error("INSUFFICIENT_COMMON_DAILY_BARS_"+common.length);
  const opens={},closes={};
  for(const s of symbols){
    opens[s]=common.map(t=>maps[s].get(t).open);
    closes[s]=common.map(t=>maps[s].get(t).close);
  }
  return {timestamps:common,opens,closes};
}

function targetWeights(data,symbols,openIndex){
  const signal=openIndex-1;
  const old=signal-MOM_LONG;
  const recentEnd=signal-SKIP_RECENT;
  if(old<0||recentEnd<=old)return Object.fromEntries(symbols.map(s=>[s,0]));
  const ranked=[];
  for(const s of symbols){
    const ma=sma(data.closes[s],signal,TREND_MA);
    const mom=data.closes[s][recentEnd]/data.closes[s][old]-1;
    const trend=ma!=null&&data.closes[s][signal]>ma;
    if(mom>0&&trend)ranked.push({s,mom});
  }
  ranked.sort((a,b)=>b.mom-a.mom);
  const selected=ranked.slice(0,TOP_N);
  const weights=Object.fromEntries(symbols.map(s=>[s,0]));
  if(selected.length){
    const w=1/selected.length;
    for(const x of selected)weights[x.s]=w;
  }
  return weights;
}

function summarize(curve,periods,years,fees){
  let peak=curve[0]??1,mdd=0;
  for(const e of curve){peak=Math.max(peak,e);mdd=Math.max(mdd,(peak-e)/peak);}
  const wins=periods.filter(x=>x>0),losses=periods.filter(x=>x<0);
  const gp=wins.reduce((a,b)=>a+b,0),gl=Math.abs(losses.reduce((a,b)=>a+b,0));
  const ret=(curve.at(-1)??1)/(curve[0]??1)-1;
  return{
    return:ret,
    annualizedReturn:years>0?Math.pow(Math.max(1e-9,1+ret),1/years)-1:null,
    maxDrawdown:mdd,
    periods:periods.length,
    winRate:periods.length?wins.length/periods.length:0,
    profitFactor:gl>0?gp/gl:(gp>0?null:0),
    feesPaid:fees,
  };
}

function simulate(data,symbols,cost,startIndex){
  const minStart=Math.max(MOM_LONG+2,TREND_MA+2);
  const begin=Math.max(minStart,startIndex);
  let cash=1,fees=0,lastEq=1,started=false;
  const units=Object.fromEntries(symbols.map(s=>[s,0]));
  const curve=[1],periods=[];
  for(let i=begin;i<data.timestamps.length;i++){
    const prices=Object.fromEntries(symbols.map(s=>[s,data.opens[s][i]]));
    let equity=cash+symbols.reduce((sum,s)=>sum+units[s]*prices[s],0);
    curve.push(equity);
    if((i-begin)%REBALANCE!==0)continue;
    if(started)periods.push(equity/lastEq-1);
    const weights=targetWeights(data,symbols,i);
    const current=Object.fromEntries(symbols.map(s=>[s,units[s]*prices[s]]));
    const target=Object.fromEntries(symbols.map(s=>[s,weights[s]*equity]));
    const turnover=symbols.reduce((sum,s)=>sum+Math.abs(target[s]-current[s]),0);
    const fee=turnover*cost;fees+=fee;equity=Math.max(0,equity-fee);
    for(const s of symbols)units[s]=weights[s]*equity/prices[s];
    cash=(1-Object.values(weights).reduce((a,b)=>a+b,0))*equity;
    lastEq=equity;started=true;curve.push(equity);
  }
  const i=data.timestamps.length-1;
  const finalPrices=Object.fromEntries(symbols.map(s=>[s,data.closes[s][i]]));
  let equity=cash+symbols.reduce((sum,s)=>sum+units[s]*finalPrices[s],0);
  if(started)periods.push(equity/lastEq-1);
  const liquidation=symbols.reduce((sum,s)=>sum+Math.abs(units[s]*finalPrices[s]),0);
  const fee=liquidation*cost;fees+=fee;equity=Math.max(0,equity-fee);curve.push(equity);
  const years=(data.timestamps.at(-1)-data.timestamps[begin])/(365.25*DAY);
  return summarize(curve,periods,years,fees);
}

const output=resolve(process.argv[2]??"market-prediction-lab/artifacts/stock-dual-momentum-v1/result.json");
const endTime=Date.now(),startTime=endTime-3650*DAY;
const markets={};
try{
  for(const [market,spec] of Object.entries(SPECS)){
    const histories={},provenance={};
    for(const symbol of spec.symbols){
      const h=await collectYahooStockHistory({market,symbol,startTime,endTime});
      histories[symbol]=h;
      provenance[symbol]={providerSymbol:h.providerSymbol,candleCount:h.candleCount,firstTimestamp:h.firstTimestamp,lastTimestamp:h.lastTimestamp,source:h.source};
    }
    const data=align(histories,spec.symbols);
    const recentStart=Math.floor(data.timestamps.length*0.70);
    markets[market]={
      symbols:spec.symbols,
      commonBars:data.timestamps.length,
      costRatePerSide:spec.cost,
      full:simulate(data,spec.symbols,spec.cost,0),
      stressFull:simulate(data,spec.symbols,spec.cost*1.5,0),
      recent30pct:simulate(data,spec.symbols,spec.cost,recentStart),
      recent30pctStress:simulate(data,spec.symbols,spec.cost*1.5,recentStart),
      provenance,
    };
  }
  const report={
    schemaVersion:1,status:"pass",kind:"stock-dual-momentum-12-1-v1",
    researchOnly:true,publicDataOnly:true,liveExecutionAllowed:false,privateAccountRequestAllowed:false,actualOrders:0,
    fixedBeforeRun:true,lookaheadFree:true,
    formula:{
      rank:"12-1 momentum = close[t-1month] / close[t-12months] - 1",
      absoluteGate:"momentum > 0 and latest completed close > SMA200",
      topN:TOP_N,rebalanceTradingDays:REBALANCE,
      execution:"signal from completed daily close i-1; trade at next session open i",
      longOnly:true,
    },
    limitations:["fixed current large-cap universe creates survivorship bias","Yahoo public chart data","no point-in-time index membership"],
    markets,
  };
  await save(output,report);console.log(JSON.stringify(report,null,2));
}catch(error){
  const report={schemaVersion:1,status:"fail",researchOnly:true,error:{name:error?.name??"Error",message:String(error?.message??error).slice(0,1200)},actualOrders:0,liveExecutionAllowed:false};
  await save(output,report);console.error(JSON.stringify(report,null,2));process.exitCode=1;
}
