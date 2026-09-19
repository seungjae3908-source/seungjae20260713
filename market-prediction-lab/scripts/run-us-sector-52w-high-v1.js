import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";

const DAY=86_400_000;
const SYMBOLS=Object.freeze(["XLB","XLE","XLF","XLI","XLK","XLP","XLU","XLV","XLY"]);
const BENCHMARK="SPY";
const COSTS=Object.freeze({base:0.0015,stress:0.00225});
const LOOKBACK=252;
const REBALANCE=21;
const TOP=3;

async function save(file,value){
  await mkdir(dirname(file),{recursive:true});
  await writeFile(file,JSON.stringify(value,null,2)+"\n","utf8");
}
function align(histories){
  const maps=Object.fromEntries(SYMBOLS.map(s=>[s,new Map(histories[s].candles.map(c=>[c.timestamp,c]))]));
  const common=[...maps[SYMBOLS[0]].keys()].filter(t=>SYMBOLS.every(s=>maps[s].has(t))).sort((a,b)=>a-b);
  if(common.length<1800) throw new Error("INSUFFICIENT_COMMON_BARS_"+common.length);
  const opens={},closes={},highs={};
  for(const s of SYMBOLS){
    opens[s]=common.map(t=>maps[s].get(t).open);
    closes[s]=common.map(t=>maps[s].get(t).close);
    highs[s]=common.map(t=>maps[s].get(t).high);
  }
  return {timestamps:common,opens,closes,highs};
}
function rollingHigh(values,end,period){
  const start=end-period+1;
  if(start<0)return null;
  let h=-Infinity;
  for(let i=start;i<=end;i++)h=Math.max(h,values[i]);
  return h;
}
function rankWeights(data,openIndex,mode){
  const signal=openIndex-1;
  if(signal<LOOKBACK)return Object.fromEntries(SYMBOLS.map(s=>[s,0]));
  const rows=SYMBOLS.map(s=>{
    const h=rollingHigh(data.highs[s],signal,LOOKBACK);
    return {s,near:data.closes[s][signal]/h};
  }).sort((a,b)=>b.near-a.near);
  const target=Object.fromEntries(SYMBOLS.map(s=>[s,0]));
  if(mode==="long_top3"){
    for(const x of rows.slice(0,TOP))target[x.s]=1/TOP;
  }else if(mode==="long_short"){
    for(const x of rows.slice(0,TOP))target[x.s]=1/(2*TOP);
    for(const x of rows.slice(-TOP))target[x.s]=-1/(2*TOP);
  }else throw new Error("BAD_MODE");
  return target;
}
function metrics(curve,periods,years,fees,turnover){
  let peak=curve[0]??1,mdd=0;
  for(const e of curve){peak=Math.max(peak,e);mdd=Math.max(mdd,(peak-e)/peak);}
  const wins=periods.filter(x=>x>0),loss=periods.filter(x=>x<0);
  const gp=wins.reduce((a,b)=>a+b,0),gl=-loss.reduce((a,b)=>a+b,0);
  const ret=curve.at(-1)-1;
  return{
    return:ret,annualizedReturn:Math.pow(Math.max(1e-9,1+ret),1/years)-1,
    maxDrawdown:mdd,periods:periods.length,winRate:periods.length?wins.length/periods.length:0,
    profitFactor:gl>0?gp/gl:null,feesPaid:fees,turnoverUnits:turnover,
  };
}
function simulate(data,mode,cost,startIndex=0){
  const begin=Math.max(LOOKBACK+2,startIndex);
  let cash=1,fees=0,turnover=0,lastEq=1,started=false;
  const units=Object.fromEntries(SYMBOLS.map(s=>[s,0]));
  const curve=[1],periods=[];
  for(let i=begin;i<data.timestamps.length;i++){
    const p=Object.fromEntries(SYMBOLS.map(s=>[s,data.opens[s][i]]));
    let eq=cash+SYMBOLS.reduce((z,s)=>z+units[s]*p[s],0);
    curve.push(eq);
    if((i-begin)%REBALANCE!==0)continue;
    if(started)periods.push(eq/lastEq-1);
    const w=rankWeights(data,i,mode);
    const current=Object.fromEntries(SYMBOLS.map(s=>[s,units[s]*p[s]]));
    const target=Object.fromEntries(SYMBOLS.map(s=>[s,w[s]*eq]));
    const tr=SYMBOLS.reduce((z,s)=>z+Math.abs(target[s]-current[s]),0);
    const fee=tr*cost;fees+=fee;turnover+=tr;eq=Math.max(0,eq-fee);
    for(const s of SYMBOLS)units[s]=w[s]*eq/p[s];
    const netWeight=Object.values(w).reduce((a,b)=>a+b,0);
    cash=(1-netWeight)*eq;
    lastEq=eq;started=true;curve.push(eq);
  }
  const i=data.timestamps.length-1,p=Object.fromEntries(SYMBOLS.map(s=>[s,data.closes[s][i]]));
  let eq=cash+SYMBOLS.reduce((z,s)=>z+units[s]*p[s],0);
  if(started)periods.push(eq/lastEq-1);
  const tr=SYMBOLS.reduce((z,s)=>z+Math.abs(units[s]*p[s]),0);
  const fee=tr*cost;fees+=fee;turnover+=tr;eq=Math.max(0,eq-fee);curve.push(eq);
  const years=(data.timestamps.at(-1)-data.timestamps[begin])/(365.25*DAY);
  return metrics(curve,periods,years,fees,turnover);
}
function buyhold(candles,cost){
  const entry=candles[0].open*(1+cost),exit=candles.at(-1).close*(1-cost);
  let peak=1,mdd=0;
  for(const c of candles){const q=c.close/entry;peak=Math.max(peak,q);mdd=Math.max(mdd,(peak-q)/peak);}
  const ret=exit/entry-1,years=(candles.at(-1).timestamp-candles[0].timestamp)/(365.25*DAY);
  return{return:ret,annualizedReturn:Math.pow(1+ret,1/years)-1,maxDrawdown:mdd,bars:candles.length};
}

const output=resolve(process.argv[2]??"market-prediction-lab/artifacts/us-sector-52w-high-v1/result.json");
const end=Date.now(),start=end-3650*DAY;
try{
  const histories={},provenance={};
  for(const s of SYMBOLS){
    const h=await collectYahooStockHistory({market:"US_STOCK",symbol:s,startTime:start,endTime:end});
    histories[s]=h;provenance[s]={providerSymbol:h.providerSymbol,candleCount:h.candleCount,firstTimestamp:h.firstTimestamp,lastTimestamp:h.lastTimestamp};
  }
  const data=align(histories),recent=Math.floor(data.timestamps.length*.70);
  const bh=await collectYahooStockHistory({market:"US_STOCK",symbol:BENCHMARK,startTime:start,endTime:end});
  const results={};
  for(const mode of ["long_top3","long_short"]){
    results[mode]={};
    for(const [name,cost] of Object.entries(COSTS)){
      results[mode][name]={full:simulate(data,mode,cost,0),recent30pct:simulate(data,mode,cost,recent)};
    }
  }
  const report={
    schemaVersion:1,status:"pass",kind:"us-sector-52w-high-v1",
    researchOnly:true,publicDataOnly:true,liveExecutionAllowed:false,privateAccountRequestAllowed:false,actualOrders:0,lookaheadFree:true,
    formula:{
      score:"latest completed close / highest high over prior 252 sessions",
      rebalanceTradingDays:REBALANCE,topCount:TOP,
      longTop3:"equal-weight top 3 sector ETFs",
      longShort:"gross 1x, long top3 + short bottom3, 1/6 absolute each; borrow costs NOT modeled",
      execution:"completed daily close i-1 -> next session open i",
    },
    symbols:SYMBOLS,costs:COSTS,commonBars:data.timestamps.length,
    benchmark:{symbol:BENCHMARK,base:buyhold(bh.candles,COSTS.base),stress:buyhold(bh.candles,COSTS.stress)},
    results,provenance,
    limitations:["sector ETF test reduces constituent survivorship bias","long-short version omits borrow availability and borrow fees","Yahoo public chart data"],
  };
  await save(output,report);console.log(JSON.stringify(report,null,2));
}catch(error){
  const report={schemaVersion:1,status:"fail",researchOnly:true,error:{name:error?.name??"Error",message:String(error?.message??error).slice(0,1200)},actualOrders:0,liveExecutionAllowed:false};
  await save(output,report);console.error(JSON.stringify(report,null,2));process.exitCode=1;
}
