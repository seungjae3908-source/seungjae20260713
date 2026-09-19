import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";

const DAY=86_400_000;
const SYMBOLS=Object.freeze(["091160","091170","091180","117700","117680","117460","140700","140710"]);
const BENCHMARK="069500";
const COST=0.0025;
const MOM_LONG=252,SKIP=21,MA=200,REBALANCE=21,TOP=3;

async function save(file,value){await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2)+"\n","utf8");}
function sma(v,end,p){const s=end-p+1;if(s<0)return null;let x=0;for(let i=s;i<=end;i++)x+=v[i];return x/p;}
function align(histories){
 const maps=Object.fromEntries(SYMBOLS.map(s=>[s,new Map(histories[s].candles.map(c=>[c.timestamp,c]))]));
 const common=[...maps[SYMBOLS[0]].keys()].filter(t=>SYMBOLS.every(s=>maps[s].has(t))).sort((a,b)=>a-b);
 if(common.length<1800)throw new Error("INSUFFICIENT_COMMON_BARS_"+common.length);
 const opens={},closes={};
 for(const s of SYMBOLS){opens[s]=common.map(t=>maps[s].get(t).open);closes[s]=common.map(t=>maps[s].get(t).close);}
 return{timestamps:common,opens,closes};
}
function weights(data,i){
 const signal=i-1,old=signal-MOM_LONG,recent=signal-SKIP;
 const ranked=[];
 if(old<0)return Object.fromEntries(SYMBOLS.map(s=>[s,0]));
 for(const s of SYMBOLS){
  const m=sma(data.closes[s],signal,MA);
  const mom=data.closes[s][recent]/data.closes[s][old]-1;
  if(mom>0&&m!=null&&data.closes[s][signal]>m)ranked.push({s,mom});
 }
 ranked.sort((a,b)=>b.mom-a.mom);
 const sel=ranked.slice(0,TOP),w=Object.fromEntries(SYMBOLS.map(s=>[s,0]));
 if(sel.length){const x=1/sel.length;for(const q of sel)w[q.s]=x;}
 return w;
}
function summarize(curve,periods,years,fees){
 let peak=curve[0],mdd=0;for(const e of curve){peak=Math.max(peak,e);mdd=Math.max(mdd,(peak-e)/peak);}
 const win=periods.filter(x=>x>0),loss=periods.filter(x=>x<0),gp=win.reduce((a,b)=>a+b,0),gl=-loss.reduce((a,b)=>a+b,0);
 const ret=curve.at(-1)-1;
 return{return:ret,annualizedReturn:Math.pow(Math.max(1e-9,1+ret),1/years)-1,maxDrawdown:mdd,periods:periods.length,winRate:win.length/periods.length,profitFactor:gl>0?gp/gl:null,feesPaid:fees};
}
function simulate(data,cost,startIndex=0){
 const begin=Math.max(MOM_LONG+2,MA+2,startIndex);let cash=1,fees=0,lastEq=1,started=false;
 const units=Object.fromEntries(SYMBOLS.map(s=>[s,0])),curve=[1],periods=[];
 for(let i=begin;i<data.timestamps.length;i++){
  const p=Object.fromEntries(SYMBOLS.map(s=>[s,data.opens[s][i]]));
  let eq=cash+SYMBOLS.reduce((z,s)=>z+units[s]*p[s],0);curve.push(eq);
  if((i-begin)%REBALANCE!==0)continue;
  if(started)periods.push(eq/lastEq-1);
  const w=weights(data,i),cur=Object.fromEntries(SYMBOLS.map(s=>[s,units[s]*p[s]]));
  const target=Object.fromEntries(SYMBOLS.map(s=>[s,w[s]*eq]));
  const turnover=SYMBOLS.reduce((z,s)=>z+Math.abs(target[s]-cur[s]),0);
  const fee=turnover*cost;fees+=fee;eq=Math.max(0,eq-fee);
  for(const s of SYMBOLS)units[s]=w[s]*eq/p[s];
  cash=(1-Object.values(w).reduce((a,b)=>a+b,0))*eq;lastEq=eq;started=true;curve.push(eq);
 }
 const i=data.timestamps.length-1,p=Object.fromEntries(SYMBOLS.map(s=>[s,data.closes[s][i]]));
 let eq=cash+SYMBOLS.reduce((z,s)=>z+units[s]*p[s],0);if(started)periods.push(eq/lastEq-1);
 const liquidation=SYMBOLS.reduce((z,s)=>z+Math.abs(units[s]*p[s]),0),fee=liquidation*cost;fees+=fee;eq-=fee;curve.push(eq);
 const years=(data.timestamps.at(-1)-data.timestamps[begin])/(365.25*DAY);
 return summarize(curve,periods,years,fees);
}
function buyhold(candles,cost){
 const e=candles[0].open*(1+cost),x=candles.at(-1).close*(1-cost);let peak=1,mdd=0;
 for(const c of candles){const q=c.close/e;peak=Math.max(peak,q);mdd=Math.max(mdd,(peak-q)/peak);}
 const ret=x/e-1,years=(candles.at(-1).timestamp-candles[0].timestamp)/(365.25*DAY);
 return{return:ret,annualizedReturn:Math.pow(1+ret,1/years)-1,maxDrawdown:mdd,bars:candles.length};
}

const output=resolve(process.argv[2]??"market-prediction-lab/artifacts/kr-sector-momentum-v1/result.json");
const end=Date.now(),start=end-3650*DAY;
try{
 const histories={},provenance={};
 for(const s of SYMBOLS){
  const h=await collectYahooStockHistory({market:"KR_STOCK",symbol:s,startTime:start,endTime:end});
  histories[s]=h;provenance[s]={providerSymbol:h.providerSymbol,candleCount:h.candleCount,firstTimestamp:h.firstTimestamp,lastTimestamp:h.lastTimestamp};
 }
 const data=align(histories),recent=Math.floor(data.timestamps.length*.70);
 const bh=await collectYahooStockHistory({market:"KR_STOCK",symbol:BENCHMARK,startTime:start,endTime:end});
 const report={schemaVersion:1,status:"pass",kind:"kr-sector-dual-momentum-v1",researchOnly:true,publicDataOnly:true,actualOrders:0,liveExecutionAllowed:false,lookaheadFree:true,
  formula:{rank:"12-1 momentum",gate:"momentum > 0 and close > SMA200",topN:TOP,rebalanceDays:REBALANCE,execution:"completed close -> next open",longOnly:true},
  symbols:SYMBOLS,commonBars:data.timestamps.length,cost:COST,
  strategy:{full:simulate(data,COST,0),stressFull:simulate(data,COST*1.5,0),recent30pct:simulate(data,COST,recent),recent30pctStress:simulate(data,COST*1.5,recent)},
  benchmark:{symbol:BENCHMARK,base:buyhold(bh.candles,COST),stress:buyhold(bh.candles,COST*1.5)},
  provenance};
 await save(output,report);console.log(JSON.stringify(report,null,2));
}catch(error){
 const report={schemaVersion:1,status:"fail",researchOnly:true,error:{name:error?.name??"Error",message:String(error?.message??error).slice(0,1200)},actualOrders:0,liveExecutionAllowed:false};
 await save(output,report);console.error(JSON.stringify(report,null,2));process.exitCode=1;
}
