import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectUpbitSpotHistory } from "../src/upbit-spot-history.js";

const DAY=86_400_000,BARS_PER_DAY=6,LOOKBACK=30*BARS_PER_DAY,REBALANCE=BARS_PER_DAY;
const SYMBOLS=Object.freeze(["BTC","ETH","XRP","SOL","ADA","DOGE","BNB","LINK"].filter(x=>x!=="BNB"));
const COSTS=Object.freeze({base:0.0015,stress:0.0025});
const DRAWDOWN_GATE=0.15;
const DERISK_MULT=0.5;

async function save(file,value){await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2)+"\n","utf8");}
function align(histories){
  const maps=Object.fromEntries(SYMBOLS.map(s=>[s,new Map(histories[s].candles.map(c=>[c.timestamp,c]))]));
  const common=[...maps.BTC.keys()].filter(t=>SYMBOLS.every(s=>maps[s].has(t))).sort((a,b)=>a-b);
  if(common.length<1500)throw new Error("INSUFFICIENT_COMMON_BARS_"+common.length);
  const opens={},closes={};for(const s of SYMBOLS){opens[s]=common.map(t=>maps[s].get(t).open);closes[s]=common.map(t=>maps[s].get(t).close);}
  return{timestamps:common,opens,closes};
}
function marketIndex(data,i,start){
  let sum=0;
  for(const s of SYMBOLS)sum+=data.closes[s][i]/data.closes[s][start];
  return sum/SYMBOLS.length;
}
function summarize(curve,periods,years,fees,exposure){
  let peak=curve[0]??1,mdd=0;for(const e of curve){peak=Math.max(peak,e);mdd=Math.max(mdd,(peak-e)/peak);}
  const wins=periods.filter(x=>x>0),loss=periods.filter(x=>x<0),gp=wins.reduce((a,b)=>a+b,0),gl=Math.abs(loss.reduce((a,b)=>a+b,0));
  const ret=(curve.at(-1)??1)/(curve[0]??1)-1;
  return{return:ret,annualizedReturn:years>0?Math.pow(Math.max(1e-9,1+ret),1/years)-1:null,maxDrawdown:mdd,
    periods:periods.length,winRate:periods.length?wins.length/periods.length:0,profitFactor:gl>0?gp/gl:(gp>0?null:0),
    feesPaid:fees,averageGrossExposure:exposure.length?exposure.reduce((a,b)=>a+b,0)/exposure.length:0};
}
function simulate(data,cost,startIndex,derisk){
  const begin=Math.max(LOOKBACK+1,startIndex),normStart=begin-LOOKBACK;
  let cash=1,fees=0,lastEq=1,started=false,indexPeak=1;
  const units=Object.fromEntries(SYMBOLS.map(s=>[s,0])),curve=[1],periods=[],exposures=[];
  for(let i=begin;i<data.timestamps.length;i++){
    const prices=Object.fromEntries(SYMBOLS.map(s=>[s,data.opens[s][i]]));
    let equity=cash+SYMBOLS.reduce((sum,s)=>sum+units[s]*prices[s],0);curve.push(equity);
    if((i-begin)%REBALANCE!==0)continue;
    if(started)periods.push(equity/lastEq-1);
    const signal=i-1;
    const idx=marketIndex(data,signal,normStart);indexPeak=Math.max(indexPeak,idx);
    const marketDd=indexPeak>0?1-idx/indexPeak:0;
    const scale=derisk&&marketDd>DRAWDOWN_GATE?DERISK_MULT:1;
    const weights=Object.fromEntries(SYMBOLS.map(s=>[s,0]));
    for(const s of SYMBOLS){
      const r30=data.closes[s][signal]/data.closes[s][signal-LOOKBACK]-1;
      if(r30>0)weights[s]=(1/SYMBOLS.length)*scale;
    }
    const gross=Object.values(weights).reduce((a,b)=>a+b,0);exposures.push(gross);
    const current=Object.fromEntries(SYMBOLS.map(s=>[s,units[s]*prices[s]]));
    const targets=Object.fromEntries(SYMBOLS.map(s=>[s,weights[s]*equity]));
    const turnover=SYMBOLS.reduce((sum,s)=>sum+Math.abs(targets[s]-current[s]),0);
    const fee=turnover*cost;fees+=fee;equity=Math.max(0,equity-fee);
    for(const s of SYMBOLS)units[s]=weights[s]*equity/prices[s];
    cash=(1-gross)*equity;lastEq=equity;started=true;curve.push(equity);
  }
  const i=data.timestamps.length-1,final=Object.fromEntries(SYMBOLS.map(s=>[s,data.closes[s][i]]));
  let equity=cash+SYMBOLS.reduce((sum,s)=>sum+units[s]*final[s],0);
  if(started)periods.push(equity/lastEq-1);
  const liquid=SYMBOLS.reduce((sum,s)=>sum+Math.abs(units[s]*final[s]),0),fee=liquid*cost;fees+=fee;equity=Math.max(0,equity-fee);curve.push(equity);
  const years=(data.timestamps.at(-1)-data.timestamps[begin])/(365.25*DAY);
  return summarize(curve,periods,years,fees,exposures);
}
function buyHold(data,cost,startIndex){
  const begin=Math.max(LOOKBACK+1,startIndex),w=1/SYMBOLS.length;
  let eq=Math.max(0,1-cost);const units=Object.fromEntries(SYMBOLS.map(s=>[s,w*eq/data.opens[s][begin]])),curve=[eq];
  for(let i=begin;i<data.timestamps.length;i++)curve.push(SYMBOLS.reduce((sum,s)=>sum+units[s]*data.opens[s][i],0));
  const last=data.timestamps.length-1;let final=SYMBOLS.reduce((sum,s)=>sum+units[s]*data.closes[s][last],0)*(1-cost);curve.push(final);
  let peak=curve[0],mdd=0;for(const e of curve){peak=Math.max(peak,e);mdd=Math.max(mdd,(peak-e)/peak);}
  const years=(data.timestamps.at(-1)-data.timestamps[begin])/(365.25*DAY),ret=final/curve[0]-1;
  return{return:ret,annualizedReturn:Math.pow(Math.max(1e-9,1+ret),1/years)-1,maxDrawdown:mdd};
}

const output=resolve(process.argv[2]??"market-prediction-lab/artifacts/upbit-risk-managed-tsmom30-v1/result.json");
try{
  const endTime=Date.now(),startTime=endTime-730*DAY,h={},prov={};
  for(const s of SYMBOLS){const x=await collectUpbitSpotHistory({symbol:s,startTime,endTime,maxPages:40,minIntervalMs:120});h[s]=x;prov[s]={providerMarket:x.providerMarket,candleCount:x.candleCount,firstTimestamp:x.firstTimestamp,lastTimestamp:x.lastTimestamp};}
  const data=align(h),recent=Math.floor(data.timestamps.length*0.70);
  const report={schemaVersion:1,status:"pass",kind:"upbit-risk-managed-tsmom30-v1",researchOnly:true,publicDataOnly:true,liveExecutionAllowed:false,privateAccountRequestAllowed:false,actualOrders:0,fixedBeforeRun:true,lookaheadFree:true,
    formula:{assetRule:"hold 1/N allocation only when trailing 30-day return > 0, otherwise cash",portfolioRule:"when equal-weight crypto index drawdown from running peak >15%, multiply all active allocations by 0.5",lookbackDays:30,drawdownGate:DRAWDOWN_GATE,deriskMultiplier:DERISK_MULT,rebalance:"daily",execution:"completed 4h close i-1 -> next 4h open i",longOnly:true},
    costs:COSTS,symbols:SYMBOLS,provenance:prov,
    full:{vanillaBase:simulate(data,COSTS.base,0,false),riskManagedBase:simulate(data,COSTS.base,0,true),riskManagedStress:simulate(data,COSTS.stress,0,true),equalWeightBuyHold:buyHold(data,COSTS.base,0)},
    recent30pct:{vanillaBase:simulate(data,COSTS.base,recent,false),riskManagedBase:simulate(data,COSTS.base,recent,true),riskManagedStress:simulate(data,COSTS.stress,recent,true),equalWeightBuyHold:buyHold(data,COSTS.base,recent)},
    limitations:["7 Upbit majors proxy differs from paper universe","equal-weight price index proxies aggregate crypto market drawdown state","fixed current universe has survivorship bias"]};
  await save(output,report);console.log(JSON.stringify(report,null,2));
}catch(error){const report={schemaVersion:1,status:"fail",researchOnly:true,actualOrders:0,liveExecutionAllowed:false,error:{name:error?.name??"Error",message:String(error?.message??error).slice(0,1200)}};await save(output,report);console.error(JSON.stringify(report,null,2));process.exitCode=1;}
