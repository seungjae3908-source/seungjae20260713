import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectUpbitSpotHistory } from "../src/upbit-spot-history.js";

const DAY=86_400_000;
const BARS_PER_DAY=6;
const LOOKBACK=30*BARS_PER_DAY;
const REBALANCE=7*BARS_PER_DAY;
const BTC_TREND=200*BARS_PER_DAY;
const SYMBOLS=Object.freeze(["BTC","ETH","XRP","SOL","ADA","DOGE","LINK","DOT"]);
const COSTS=Object.freeze({base:0.0015,stress:0.00225});

async function save(file,value){
  await mkdir(dirname(file),{recursive:true});
  await writeFile(file,JSON.stringify(value,null,2)+"\n","utf8");
}

function metrics(curve,periodReturns,years,fees){
  let peak=curve[0]??1,mdd=0;
  for(const e of curve){
    peak=Math.max(peak,e);
    mdd=Math.max(mdd,(peak-e)/peak);
  }
  const wins=periodReturns.filter(x=>x>0);
  const losses=periodReturns.filter(x=>x<0);
  const gp=wins.reduce((a,b)=>a+b,0);
  const gl=Math.abs(losses.reduce((a,b)=>a+b,0));
  const ret=(curve.at(-1)??1)/(curve[0]??1)-1;
  return {
    return:ret,
    annualizedReturn:years>0?Math.pow(Math.max(1e-9,1+ret),1/years)-1:null,
    maxDrawdown:mdd,
    rebalancePeriods:periodReturns.length,
    winRate:periodReturns.length?wins.length/periodReturns.length:0,
    profitFactor:gl>0?gp/gl:(gp>0?null:0),
    feesPaid:fees,
  };
}

function sma(values,endIndex,period){
  const start=endIndex-period+1;
  if(start<0) return null;
  let sum=0;
  for(let i=start;i<=endIndex;i++) sum+=values[i];
  return sum/period;
}

function targetWeights(data,openIndex,mode){
  const signalIndex=openIndex-1;
  const oldIndex=signalIndex-LOOKBACK;
  if(oldIndex<0) return Object.fromEntries(SYMBOLS.map(s=>[s,0]));
  const ranked=SYMBOLS.map(s=>({
    s,
    mom:data.closes[s][signalIndex]/data.closes[s][oldIndex]-1,
  })).sort((a,b)=>b.mom-a.mom);

  let selected=ranked.slice(0,2);
  if(mode==="positive_only" || mode==="positive_btc200"){
    selected=selected.filter(x=>x.mom>0);
  }
  if(mode==="positive_btc200"){
    const btcMa=sma(data.closes.BTC,signalIndex,BTC_TREND);
    if(btcMa==null || data.closes.BTC[signalIndex]<=btcMa) selected=[];
  }

  const weights=Object.fromEntries(SYMBOLS.map(s=>[s,0]));
  if(selected.length){
    const w=1/selected.length;
    for(const x of selected) weights[x.s]=w;
  }
  return weights;
}

function simulate(data,mode,costRate,startIndex){
  const {timestamps,opens,closes}=data;
  const minimum=Math.max(LOOKBACK+1, mode==="positive_btc200"?BTC_TREND+1:LOOKBACK+1);
  const begin=Math.max(minimum,startIndex);
  let cash=1;
  const units=Object.fromEntries(SYMBOLS.map(s=>[s,0]));
  const curve=[1];
  const periodReturns=[];
  let fees=0;
  let lastRebalanceEquity=1;
  let haveRebalanced=false;

  for(let i=begin;i<timestamps.length;i++){
    const prices=Object.fromEntries(SYMBOLS.map(s=>[s,opens[s][i]]));
    let equity=cash+SYMBOLS.reduce((sum,s)=>sum+units[s]*prices[s],0);
    curve.push(equity);

    if((i-begin)%REBALANCE!==0) continue;

    if(haveRebalanced){
      periodReturns.push(equity/lastRebalanceEquity-1);
    }

    // STRICT NO-LOOKAHEAD:
    // decision uses only closes through i-1; execution occurs at open[i].
    const weights=targetWeights(data,i,mode);
    const current=Object.fromEntries(SYMBOLS.map(s=>[s,units[s]*prices[s]]));
    const preFeeTargets=Object.fromEntries(SYMBOLS.map(s=>[s,weights[s]*equity]));
    const turnover=SYMBOLS.reduce((sum,s)=>sum+Math.abs(preFeeTargets[s]-current[s]),0);
    const fee=turnover*costRate;
    fees+=fee;
    equity=Math.max(0,equity-fee);

    for(const s of SYMBOLS) units[s]=weights[s]*equity/prices[s];
    const invested=Object.values(weights).reduce((a,b)=>a+b,0);
    cash=(1-invested)*equity;
    lastRebalanceEquity=equity;
    haveRebalanced=true;
    curve.push(equity);
  }

  const i=timestamps.length-1;
  const finalPrices=Object.fromEntries(SYMBOLS.map(s=>[s,closes[s][i]]));
  let equity=cash+SYMBOLS.reduce((sum,s)=>sum+units[s]*finalPrices[s],0);
  if(haveRebalanced) periodReturns.push(equity/lastRebalanceEquity-1);
  const liquidation=SYMBOLS.reduce((sum,s)=>sum+Math.abs(units[s]*finalPrices[s]),0);
  const fee=liquidation*costRate;
  fees+=fee;
  equity=Math.max(0,equity-fee);
  curve.push(equity);

  const years=(timestamps.at(-1)-timestamps[begin])/(365.25*DAY);
  return metrics(curve,periodReturns,years,fees);
}

function align(histories){
  const maps=Object.fromEntries(SYMBOLS.map(s=>[s,new Map(histories[s].candles.map(c=>[c.timestamp,c]))]));
  const common=[...maps[SYMBOLS[0]].keys()]
    .filter(t=>SYMBOLS.every(s=>maps[s].has(t)))
    .sort((a,b)=>a-b);
  if(common.length<1500) throw new Error("INSUFFICIENT_COMMON_BARS_"+common.length);
  const opens={},closes={};
  for(const s of SYMBOLS){
    opens[s]=common.map(t=>maps[s].get(t).open);
    closes[s]=common.map(t=>maps[s].get(t).close);
  }
  return {timestamps:common,opens,closes};
}

const output=resolve(process.argv[2]??"market-prediction-lab/artifacts/upbit-mom30-top2-v1/result.json");
try{
  const endTime=Date.now();
  const startTime=endTime-730*DAY;
  const histories={};
  const provenance={};
  for(const s of SYMBOLS){
    const h=await collectUpbitSpotHistory({symbol:s,startTime,endTime,maxPages:40,minIntervalMs:120});
    histories[s]=h;
    provenance[s]={
      providerMarket:h.providerMarket,
      candleCount:h.candleCount,
      firstTimestamp:h.firstTimestamp,
      lastTimestamp:h.lastTimestamp,
    };
  }
  const data=align(histories);
  const recentStart=Math.floor(data.timestamps.length*0.70);
  const results={};
  for(const mode of ["top2","positive_only","positive_btc200"]){
    results[mode]={
      full:{
        base:simulate(data,mode,COSTS.base,0),
        stress:simulate(data,mode,COSTS.stress,0),
      },
      recent30pct:{
        base:simulate(data,mode,COSTS.base,recentStart),
        stress:simulate(data,mode,COSTS.stress,recentStart),
      },
    };
  }
  const report={
    schemaVersion:2,
    status:"pass",
    kind:"upbit-mom30-top2-v1",
    researchOnly:true,
    publicDataOnly:true,
    liveExecutionAllowed:false,
    privateAccountRequestAllowed:false,
    actualOrders:0,
    lookaheadFree:true,
    formula:{
      lookbackDays:30,
      rebalanceDays:7,
      topCount:2,
      btcTrendDays:200,
      modes:["top2","positive_only","positive_btc200"],
      execution:"signal from completed bar i-1; rebalance at next 4h bar open i",
      longOnly:true,
    },
    costs:COSTS,
    symbols:SYMBOLS,
    commonBars:data.timestamps.length,
    provenance,
    results,
  };
  await save(output,report);
  console.log(JSON.stringify(report,null,2));
}catch(error){
  const report={
    schemaVersion:2,status:"fail",researchOnly:true,
    error:{name:error?.name??"Error",message:String(error?.message??error).slice(0,1200)},
    actualOrders:0,liveExecutionAllowed:false,
  };
  await save(output,report);
  console.error(JSON.stringify(report,null,2));
  process.exitCode=1;
}
