import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { simulateStockSwingStrategy } from "../src/stock-swing-optimizer.js";

const DAY=86_400_000;
const DATA_START=Date.parse("2024-01-01T00:00:00.000Z");
const TRAIN_START=Date.parse("2024-06-01T00:00:00.000Z");
const TRAIN_END=Date.parse("2025-10-01T00:00:00.000Z");
const VALID_START=Date.parse("2025-10-01T00:00:00.000Z");
const VALID_END=Date.parse("2026-03-29T00:00:00.000Z");
const TEST_START=Date.parse("2026-03-29T00:00:00.000Z");
const TEST_END=Date.parse("2026-09-29T00:00:00.000Z");
const COST=0.0015, STRESS=COST*1.5;
const BUCKETS=Object.freeze({
  MID:Object.freeze({minCap:2_000_000_000,maxCap:10_000_000_000,limit:100,minDollarVolume:5_000_000}),
  SMALL:Object.freeze({minCap:300_000_000,maxCap:2_000_000_000,limit:120,minDollarVolume:2_000_000}),
});

function num(v){const n=Number(String(v??"").replace(/[$,% ,]/g,""));return Number.isFinite(n)?n:null;}
function securityEligible(row){
  const s=String(row.symbol??"").trim().toUpperCase(), name=String(row.name??""), industry=String(row.industry??"");
  if(!/^[A-Z][A-Z0-9.-]{0,9}$/.test(s))return false;
  if(/(Warrant|Rights?|Units?|Preferred|Depositary Preferred)/i.test(name))return false;
  if(/Blank Checks/i.test(industry)||/Acquisition Corp/i.test(name))return false;
  if(/[RWU]$/.test(s)&&s.length>=4)return false;
  return true;
}
async function fetchUniverse(){
  const url="https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true";
  const r=await fetch(url,{headers:{accept:"application/json,text/plain,*/*","accept-language":"en-US,en;q=0.9","user-agent":"Mozilla/5.0 Chrome/120"}});
  if(!r.ok)throw new Error(`NASDAQ_HTTP_${r.status}`);
  const rows=(await r.json())?.data?.rows;
  if(!Array.isArray(rows)||rows.length<1000)throw new Error("NASDAQ_UNIVERSE_INSUFFICIENT");
  return rows.map(row=>{
    const price=num(row.lastsale), volume=num(row.volume), marketCap=num(row.marketCap);
    return {symbol:String(row.symbol??"").trim().toUpperCase(),name:String(row.name??""),industry:String(row.industry??""),price,volume,marketCap,
      dollarVolume:price!=null&&volume!=null?price*volume:null,securityEligible:securityEligible(row)};
  });
}
function select(rows){
  const selected={MID:[],SMALL:[]}, diag={rawRows:rows.length,bucketCounts:{MID:0,SMALL:0},liquidityEligible:{MID:0,SMALL:0}};
  for(const row of rows){
    if(!row.securityEligible||!(row.price>=2)||!(row.marketCap>0)||!(row.dollarVolume>=0))continue;
    for(const [k,cfg] of Object.entries(BUCKETS)){
      if(row.marketCap>=cfg.minCap&&row.marketCap<cfg.maxCap){diag.bucketCounts[k]++; if(row.dollarVolume>=cfg.minDollarVolume)selected[k].push(row);}
    }
  }
  for(const [k,cfg] of Object.entries(BUCKETS)){
    diag.liquidityEligible[k]=selected[k].length;
    selected[k]=selected[k].sort((a,b)=>b.dollarVolume-a.dollarVolume||b.marketCap-a.marketCap||a.symbol.localeCompare(b.symbol)).slice(0,cfg.limit);
  }
  return {selected,diag};
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function history(symbol){
  let last;
  for(let i=0;i<3;i++){try{return await collectYahooStockHistory({market:"US_STOCK",symbol,startTime:DATA_START,endTime:TEST_END,timeoutMs:15_000});}
    catch(e){last=e;await sleep(300*(i+1));}}
  throw last;
}
async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let next=0;
  async function w(){for(;;){const i=next++;if(i>=items.length)return;try{out[i]={ok:true,value:await fn(items[i])};}catch(e){out[i]={ok:false,error:String(e?.message??e)};}}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>w()));return out;
}
function idxRange(candles,startMs,endMs){
  const s=candles.findIndex(c=>c.timestamp>=startMs);let e=candles.length-1;while(e>=0&&candles[e].timestamp>=endMs)e--;
  return s>=0&&e>s?{startIndex:s,endIndex:e}:null;
}
function tradeMetrics(trades){
  const rs=trades.map(t=>t.netReturn).filter(Number.isFinite), wins=rs.filter(x=>x>0), losses=rs.filter(x=>x<0);
  const gp=wins.reduce((a,b)=>a+b,0), gl=Math.abs(losses.reduce((a,b)=>a+b,0));
  return {tradeCount:rs.length,winRate:rs.length?wins.length/rs.length:0,expectancy:rs.length?rs.reduce((a,b)=>a+b,0)/rs.length:0,
    profitFactor:gl>0?gp/gl:gp>0?999:null};
}
function median(v){if(!v.length)return null;const x=[...v].sort((a,b)=>a-b),m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function evaluate(rows,params,range,cost){
  const all=[], symbolReturns=[], active=[];
  for(const row of rows){
    const r=idxRange(row.candles,range.start,range.end);if(!r)continue;
    const sim=simulateStockSwingStrategy({candles:row.candles,params,costRatePerSide:cost,...r});
    symbolReturns.push(sim.metrics.netReturn);
    if(sim.metrics.tradeCount>0)active.push(sim.metrics.netReturn);
    all.push(...sim.trades);
  }
  const base=tradeMetrics(all), pos=active.filter(x=>x>0).length;
  return {...base,evaluatedSymbols:symbolReturns.length,activeSymbols:active.length,positiveActiveSymbols:pos,
    positiveActiveRatio:active.length?pos/active.length:0,medianSymbolReturn:median(symbolReturns),
    equalWeightSymbolReturn:symbolReturns.length?symbolReturns.reduce((a,b)=>a+b,0)/symbolReturns.length:null};
}
function score(s){
  if(s.tradeCount<20)return -1e9;
  const pf=Number.isFinite(s.profitFactor)?Math.min(s.profitFactor,4):4;
  return s.expectancy*200+(pf-1)*2+s.positiveActiveRatio*3+(s.medianSymbolReturn??0)*20+Math.min(2,s.tradeCount/150);
}
function passes(s){return s.tradeCount>=20&&s.expectancy>0&&s.profitFactor>=1.05&&s.positiveActiveRatio>=0.5;}
function midGrid(){
  const g=[];
  for(const breakoutLookback of [10,20,40])for(const maPeriod of [20,60,120])for(const atrStopMultiplier of [1.5,2,2.5])
  for(const rewardRisk of [1.5,2])for(const maxHoldBars of [5,10])for(const minRelativeVolume of [1,1.2,1.5])for(const maxGapPercent of [4,7])
    g.push({breakoutLookback,maPeriod,atrPeriod:14,atrStopMultiplier,rewardRisk,maxHoldBars,relativeVolumePeriod:20,minRelativeVolume,maxGapPercent});
  return g;
}
function smallGrid(){
  const g=[];
  for(const breakoutLookback of [5,10,20])for(const maPeriod of [20,60])for(const atrStopMultiplier of [1.5,2,2.5])
  for(const rewardRisk of [1.5,2,3])for(const maxHoldBars of [3,5,10])for(const minRelativeVolume of [1.2,1.5,2])for(const maxGapPercent of [5,10])
    g.push({breakoutLookback,maPeriod,atrPeriod:14,atrStopMultiplier,rewardRisk,maxHoldBars,relativeVolumePeriod:20,minRelativeVolume,maxGapPercent});
  return g;
}
function optimize(rows,grid){
  const trainRange={start:TRAIN_START,end:TRAIN_END}, validRange={start:VALID_START,end:VALID_END}, testRange={start:TEST_START,end:TEST_END};
  const trained=grid.map(params=>({params,train:evaluate(rows,params,trainRange,COST)})).sort((a,b)=>score(b.train)-score(a.train));
  const finalists=trained.slice(0,30).map(x=>({...x,validation:evaluate(rows,x.params,validRange,COST)})).sort((a,b)=>score(b.validation)-score(a.validation));
  const selected=finalists.find(x=>passes(x.validation))??finalists[0];
  const test=evaluate(rows,selected.params,testRange,COST), stressed=evaluate(rows,selected.params,testRange,STRESS);
  return {gridCandidates:grid.length,selectedParams:selected.params,train:selected.train,validation:selected.validation,test,stressedTest:stressed,
    gates:{validationPassed:passes(selected.validation),testPassed:passes(test),stressPassed:passes(stressed)},
    status:passes(selected.validation)&&passes(test)&&passes(stressed)?"research_candidate":"research_hold"};
}
async function main(){
  const {selected,diag}=select(await fetchUniverse());
  const flat=[];for(const [bucket,rows] of Object.entries(selected))for(const row of rows)flat.push({...row,bucket});
  const fetched=await mapLimit(flat,5,async row=>{
    const h=await history(row.symbol);
    const testIdx=h.candles.findIndex(c=>c.timestamp>=TEST_START);
    if(testIdx<130)throw new Error(`HISTORY_TOO_SHORT:${row.symbol}:${testIdx}`);
    return {...row,candles:h.candles};
  });
  const ok=fetched.filter(x=>x.ok).map(x=>x.value), bad=fetched.filter(x=>!x.ok);
  const mid=ok.filter(x=>x.bucket==="MID"), small=ok.filter(x=>x.bucket==="SMALL");
  const result={
    schemaVersion:1,status:"pass",market:"US_STOCK",purpose:"bucket-specific challenger routing",
    universe:{...diag,selectedCounts:{MID:selected.MID.length,SMALL:selected.SMALL.length},historyAttempts:flat.length,historySuccesses:ok.length,historyFailures:bad.length},
    windows:{train:[new Date(TRAIN_START).toISOString(),new Date(TRAIN_END).toISOString()],validation:[new Date(VALID_START).toISOString(),new Date(VALID_END).toISOString()],test:[new Date(TEST_START).toISOString(),new Date(TEST_END).toISOString()]},
    selectionContract:{testUsedForSelection:false,currentSnapshotUsedForUniverse:true,currentSnapshotBiasAcknowledged:true},
    MID:{strategyFamily:"breakout",historySymbols:mid.length,...optimize(mid,midGrid())},
    SMALL:{strategyFamily:"high_rvol_breakout",historySymbols:small.length,...optimize(small,smallGrid())},
    costs:{normalPerSide:COST,stressPerSide:STRESS},
    safety:{researchOnly:true,liveExecutionAllowed:false,privateAccountRequestAllowed:false,executionAuthority:"NONE"},
    limitations:["Current market-cap/liquidity snapshot creates survivorship and selection bias.","No point-in-time catalyst/float/dilution filter yet.","Daily OHLC uses conservative stop-first same-bar handling from the shared simulator.","This challenger cannot promote profitability or trading authority."],
  };
  const out=resolve(process.argv[2]??"docs/us-equity-bucket-router-v2.json");await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(result,null,2)+"\n","utf8");console.log(JSON.stringify(result,null,2));
}
await main();
