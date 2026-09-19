import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectUpbitSpotHistory } from "../src/upbit-spot-history.js";

const DAY=86_400_000;
const BARS_PER_DAY=6;
const LOOKBACK=14*BARS_PER_DAY;
const REBALANCE=7*BARS_PER_DAY;
const SYMBOLS=Object.freeze(["BTC","ETH","XRP","SOL","ADA","DOGE","LINK","DOT"]);
const COSTS=Object.freeze({base:0.0015,stress:0.00225});

async function save(file,value){
  await mkdir(dirname(file),{recursive:true});
  await writeFile(file,JSON.stringify(value,null,2)+"\n","utf8");
}

function summarize(curve,periodReturns,years,fees){
  let peak=curve[0]??1,mdd=0;
  for(const e of curve){peak=Math.max(peak,e);mdd=Math.max(mdd,(peak-e)/peak);}
  const wins=periodReturns.filter(x=>x>0),losses=periodReturns.filter(x=>x<0);
  const gp=wins.reduce((a,b)=>a+b,0),gl=Math.abs(losses.reduce((a,b)=>a+b,0));
  const ret=(curve.at(-1)??1)/(curve[0]??1)-1;
  return{
    return:ret,
    annualizedReturn:years>0?Math.pow(Math.max(1e-9,1+ret),1/years)-1:null,
    maxDrawdown:mdd,
    rebalancePeriods:periodReturns.length,
    winRate:periodReturns.length?wins.length/periodReturns.length:0,
    profitFactor:gl>0?gp/gl:(gp>0?null:0),
    feesPaid:fees,
  };
}

function align(histories){
  const maps=Object.fromEntries(SYMBOLS.map(s=>[s,new Map(histories[s].candles.map(c=>[c.timestamp,c]))]));
  const common=[...maps.BTC.keys()].filter(t=>SYMBOLS.every(s=>maps[s].has(t))).sort((a,b)=>a-b);
  if(common.length<1500) throw new Error("INSUFFICIENT_COMMON_BARS_"+common.length);
  const opens={},closes={};
  for(const s of SYMBOLS){
    opens[s]=common.map(t=>maps[s].get(t).open);
    closes[s]=common.map(t=>maps[s].get(t).close);
  }
  return {timestamps:common,opens,closes};
}

function weightsAt(data,openIndex){
  const signal=openIndex-1;
  const old=signal-LOOKBACK;
  if(old<0) return Object.fromEntries(SYMBOLS.map(s=>[s,0]));
  const ranked=SYMBOLS.map(s=>({s,mom:data.closes[s][signal]/data.closes[s][old]-1}))
    .filter(x=>x.mom>0)
    .sort((a,b)=>b.mom-a.mom)
    .slice(0,2);
  const weights=Object.fromEntries(SYMBOLS.map(s=>[s,0]));
  if(ranked.length){
    const w=1/ranked.length;
    for(const x of ranked) weights[x.s]=w;
  }
  return weights;
}

function simulate(data,costRate,startIndex){
  const begin=Math.max(LOOKBACK+1,startIndex);
  let cash=1,fees=0,lastRebalanceEquity=1,haveRebalanced=false;
  const units=Object.fromEntries(SYMBOLS.map(s=>[s,0]));
  const curve=[1],periodReturns=[];
  for(let i=begin;i<data.timestamps.length;i++){
    const prices=Object.fromEntries(SYMBOLS.map(s=>[s,data.opens[s][i]]));
    let equity=cash+SYMBOLS.reduce((sum,s)=>sum+units[s]*prices[s],0);
    curve.push(equity);
    if((i-begin)%REBALANCE!==0) continue;
    if(haveRebalanced) periodReturns.push(equity/lastRebalanceEquity-1);

    // No-lookahead: rank on completed close i-1, execute at open i.
    const weights=weightsAt(data,i);
    const current=Object.fromEntries(SYMBOLS.map(s=>[s,units[s]*prices[s]]));
    const targets=Object.fromEntries(SYMBOLS.map(s=>[s,weights[s]*equity]));
    const turnover=SYMBOLS.reduce((sum,s)=>sum+Math.abs(targets[s]-current[s]),0);
    const fee=turnover*costRate;
    fees+=fee;
    equity=Math.max(0,equity-fee);
    for(const s of SYMBOLS) units[s]=weights[s]*equity/prices[s];
    cash=(1-Object.values(weights).reduce((a,b)=>a+b,0))*equity;
    lastRebalanceEquity=equity;
    haveRebalanced=true;
    curve.push(equity);
  }

  const i=data.timestamps.length-1;
  const finalPrices=Object.fromEntries(SYMBOLS.map(s=>[s,data.closes[s][i]]));
  let equity=cash+SYMBOLS.reduce((sum,s)=>sum+units[s]*finalPrices[s],0);
  if(haveRebalanced) periodReturns.push(equity/lastRebalanceEquity-1);
  const liquidation=SYMBOLS.reduce((sum,s)=>sum+Math.abs(units[s]*finalPrices[s]),0);
  const fee=liquidation*costRate;
  fees+=fee;
  equity=Math.max(0,equity-fee);
  curve.push(equity);
  const years=(data.timestamps.at(-1)-data.timestamps[begin])/(365.25*DAY);
  return summarize(curve,periodReturns,years,fees);
}

const output=resolve(process.argv[2]??"market-prediction-lab/artifacts/upbit-mom14-winner-v1/result.json");
try{
  const endTime=Date.now(),startTime=endTime-730*DAY;
  const histories={},provenance={};
  for(const s of SYMBOLS){
    const h=await collectUpbitSpotHistory({symbol:s,startTime,endTime,maxPages:40,minIntervalMs:120});
    histories[s]=h;
    provenance[s]={providerMarket:h.providerMarket,candleCount:h.candleCount,firstTimestamp:h.firstTimestamp,lastTimestamp:h.lastTimestamp};
  }
  const data=align(histories);
  const recentStart=Math.floor(data.timestamps.length*0.70);
  const report={
    schemaVersion:1,status:"pass",kind:"upbit-mom14-winner-v1",
    researchOnly:true,publicDataOnly:true,liveExecutionAllowed:false,privateAccountRequestAllowed:false,actualOrders:0,
    fixedBeforeRun:true,lookaheadFree:true,
    formula:{
      inspiration:"large-winner crypto momentum 14d lookback / 7d holding",
      lookbackDays:14,holdingDays:7,topCount:2,
      absoluteGate:"only coins with positive 14-day return are eligible",
      execution:"signal from completed 4h close i-1; rebalance at next 4h open i",
      longOnly:true,
    },
    costs:COSTS,symbols:SYMBOLS,commonBars:data.timestamps.length,provenance,
    full:{base:simulate(data,COSTS.base,0),stress:simulate(data,COSTS.stress,0)},
    recent30pct:{base:simulate(data,COSTS.base,recentStart),stress:simulate(data,COSTS.stress,recentStart)},
    limitations:["8-coin large/liquid proxy is not the paper's full top-5%-by-size universe","fixed current universe has survivorship bias"],
  };
  await save(output,report);console.log(JSON.stringify(report,null,2));
}catch(error){
  const report={schemaVersion:1,status:"fail",researchOnly:true,actualOrders:0,liveExecutionAllowed:false,
    error:{name:error?.name??"Error",message:String(error?.message??error).slice(0,1200)}};
  await save(output,report);console.error(JSON.stringify(report,null,2));process.exitCode=1;
}
