import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectUpbitSpotHistory } from "../src/upbit-spot-history.js";

const DAY=86_400_000, BARS_PER_DAY=6, LOOKBACK=30*BARS_PER_DAY, REBALANCE=7*BARS_PER_DAY;
const SYMBOLS=Object.freeze(["BTC","ETH","XRP","SOL","ADA","DOGE","LINK","DOT"]);
const COSTS=Object.freeze({base:0.0015,stress:0.00225});

async function save(file,value){await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2)+"\n","utf8");}
function metrics(curve,periodReturns,years,fees){
  let peak=curve[0]??1,mdd=0;
  for(const e of curve){peak=Math.max(peak,e);mdd=Math.max(mdd,(peak-e)/peak);}
  const wins=periodReturns.filter(x=>x>0),loss=periodReturns.filter(x=>x<0);
  const gp=wins.reduce((a,b)=>a+b,0),gl=Math.abs(loss.reduce((a,b)=>a+b,0));
  const ret=(curve.at(-1)??1)/(curve[0]??1)-1;
  return {return:ret,annualizedReturn:years>0?Math.pow(1+ret,1/years)-1:null,maxDrawdown:mdd,
    rebalancePeriods:periodReturns.length,winRate:periodReturns.length?wins.length/periodReturns.length:0,
    profitFactor:gl>0?gp/gl:(gp>0?null:0),feesPaid:fees};
}
function simulate(data,mode,costRate,startIndex){
  const timestamps=data.timestamps, opens=data.opens, closes=data.closes;
  let cash=1,units=Object.fromEntries(SYMBOLS.map(s=>[s,0])),curve=[1],periodReturns=[],fees=0,lastPostRebalanceEquity=null;
  const begin=Math.max(LOOKBACK,startIndex);
  for(let signalIndex=begin;signalIndex<timestamps.length-1;signalIndex+=REBALANCE){
    const execIndex=signalIndex+1;
    const execPrices=Object.fromEntries(SYMBOLS.map(s=>[s,opens[s][execIndex]]));
    let equity=cash+SYMBOLS.reduce((sum,s)=>sum+units[s]*execPrices[s],0);
    const ranked=SYMBOLS.map(s=>({s,mom:closes[s][signalIndex]/closes[s][signalIndex-LOOKBACK]-1})).sort((a,b)=>b.mom-a.mom);
    let selected=ranked.slice(0,2);
    if(mode==="positive_only") selected=selected.filter(x=>x.mom>0);
    const weights=Object.fromEntries(SYMBOLS.map(s=>[s,0]));
    for(const x of selected) weights[x.s]=0.5;
    const grossTargets=Object.fromEntries(SYMBOLS.map(s=>[s,weights[s]*equity]));
    const current=Object.fromEntries(SYMBOLS.map(s=>[s,units[s]*execPrices[s]]));
    const traded=SYMBOLS.reduce((sum,s)=>sum+Math.abs(grossTargets[s]-current[s]),0);
    const fee=traded*costRate; fees+=fee; equity-=fee;
    if(lastPostRebalanceEquity!=null) periodReturns.push(equity/lastPostRebalanceEquity-1);
    for(const s of SYMBOLS) units[s]=weights[s]*equity/execPrices[s];
    cash=(1-Object.values(weights).reduce((a,b)=>a+b,0))*equity;
    lastPostRebalanceEquity=equity;
    const nextExec=Math.min(signalIndex+REBALANCE+1,timestamps.length-1);
    for(let k=execIndex;k<=nextExec;k++){
      const mark=Object.fromEntries(SYMBOLS.map(s=>[s,opens[s][k]]));
      curve.push(cash+SYMBOLS.reduce((sum,s)=>sum+units[s]*mark[s],0));
    }
  }
  const i=timestamps.length-1,prices=Object.fromEntries(SYMBOLS.map(s=>[s,closes[s][i]]));
  let equity=cash+SYMBOLS.reduce((sum,s)=>sum+units[s]*prices[s],0);
  const traded=SYMBOLS.reduce((sum,s)=>sum+Math.abs(units[s]*prices[s]),0);
  const fee=traded*costRate;fees+=fee;equity-=fee;
  if(lastPostRebalanceEquity!=null) periodReturns.push(equity/lastPostRebalanceEquity-1);
  curve.push(equity);
  const years=(timestamps.at(-1)-timestamps[begin])/(365.25*DAY);
  return metrics(curve,periodReturns,years,fees);
}
function align(histories){
  const maps=Object.fromEntries(SYMBOLS.map(s=>[s,new Map(histories[s].candles.map(c=>[c.timestamp,c]))]));
  const common=[...maps[SYMBOLS[0]].keys()].filter(t=>SYMBOLS.every(s=>maps[s].has(t))).sort((a,b)=>a-b);
  if(common.length<1500) throw new Error("INSUFFICIENT_COMMON_BARS_"+common.length);
  const opens={},closes={};
  for(const s of SYMBOLS){opens[s]=common.map(t=>maps[s].get(t).open);closes[s]=common.map(t=>maps[s].get(t).close);}
  return {timestamps:common,opens,closes};
}
const output=resolve(process.argv[2]??"market-prediction-lab/artifacts/upbit-mom30-top2-v1/result.json");
try{
  const endTime=Date.now(),startTime=endTime-730*DAY,histories={},provenance={};
  for(const s of SYMBOLS){
    const h=await collectUpbitSpotHistory({symbol:s,startTime,endTime,maxPages:40,minIntervalMs:120});
    histories[s]=h;provenance[s]={providerMarket:h.providerMarket,candleCount:h.candleCount,firstTimestamp:h.firstTimestamp,lastTimestamp:h.lastTimestamp};
  }
  const data=align(histories), testStart=Math.floor(data.timestamps.length*0.70);
  const results={};
  for(const mode of ["top2","positive_only"]){
    results[mode]={
      full:{base:simulate(data,mode,COSTS.base,LOOKBACK),stress:simulate(data,mode,COSTS.stress,LOOKBACK)},
      recent30pct:{base:simulate(data,mode,COSTS.base,testStart),stress:simulate(data,mode,COSTS.stress,testStart)},
    };
  }
  const report={schemaVersion:1,status:"pass",kind:"upbit-mom30-top2-v1",researchOnly:true,publicDataOnly:true,
    liveExecutionAllowed:false,privateAccountRequestAllowed:false,actualOrders:0,
    formula:{lookbackDays:30,rebalanceDays:7,topCount:2,modes:["top2","positive_only"],execution:"rank using completed 4h close; rebalance at next 4h bar open",longOnly:true},
    costs:COSTS,symbols:SYMBOLS,commonBars:data.timestamps.length,provenance,results};
  await save(output,report);console.log(JSON.stringify(report,null,2));
}catch(error){
  const report={schemaVersion:1,status:"fail",researchOnly:true,error:{name:error?.name??"Error",message:String(error?.message??error).slice(0,1200)},actualOrders:0,liveExecutionAllowed:false};
  await save(output,report);console.error(JSON.stringify(report,null,2));process.exitCode=1;
}