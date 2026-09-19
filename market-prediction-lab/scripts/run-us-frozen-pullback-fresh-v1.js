import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { optimizeUsStockPullback } from "../src/stock-pullback-optimizer.js";

const DAY=86_400_000;
const FRESH_SEED=Object.freeze(["COST","WMT","HD","PG","KO","PEP"]);
const FRESH_HOLDOUT=Object.freeze(["UNH","JNJ","ABBV","CVX","BAC","V","MA","ORCL"]);
const FROZEN=Object.freeze({
  trendMaPeriod:200,pullbackLookback:5,maxPullbackAtr:2.5,atrStopMultiplier:2.5,
  rewardRisk:2,maxHoldBars:10,minRelativeVolume:1,maxGapPercent:4,
});
async function save(file,value){await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2)+"\n","utf8");}
async function collect(symbols,startTime,endTime){
  const out=[],prov=[];
  for(const symbol of symbols){
    const h=await collectYahooStockHistory({market:"US_STOCK",symbol,startTime,endTime});
    out.push({symbol,candles:h.candles});
    prov.push({symbol,providerSymbol:h.providerSymbol,candleCount:h.candleCount,firstTimestamp:h.firstTimestamp,lastTimestamp:h.lastTimestamp,source:h.source});
  }
  return {out,prov};
}
const output=resolve(process.argv[2]??"market-prediction-lab/artifacts/us-frozen-pullback-fresh-v1/result.json");
const endTime=Date.now(),startTime=endTime-3650*DAY;
try{
  const a=await collect(FRESH_SEED,startTime,endTime);
  const b=await collect(FRESH_HOLDOUT,startTime,endTime);
  const result=optimizeUsStockPullback({
    seedDatasets:a.out,holdoutDatasets:b.out,costRatePerSide:0.0015,stressMultiplier:1.5,
    grid:{
      trendMaPeriod:[FROZEN.trendMaPeriod],pullbackLookback:[FROZEN.pullbackLookback],
      maxPullbackAtr:[FROZEN.maxPullbackAtr],atrStopMultiplier:[FROZEN.atrStopMultiplier],
      rewardRisk:[FROZEN.rewardRisk],maxHoldBars:[FROZEN.maxHoldBars],
      minRelativeVolume:[FROZEN.minRelativeVolume],maxGapPercent:[FROZEN.maxGapPercent],
    },
  });
  const report={schemaVersion:1,status:"pass",kind:"us-frozen-pullback-fresh-v1",
    researchOnly:true,publicDataOnly:true,liveExecutionAllowed:false,privateAccountRequestAllowed:false,actualOrders:0,
    sourceParamsFrozenBeforeFreshSymbols:true,
    sourceUniverse:["AAPL","MSFT","NVDA","AMZN","GOOGL","META","JPM","XOM"],
    freshSeed:FRESH_SEED,freshHoldout:FRESH_HOLDOUT,frozenParams:FROZEN,result,provenance:[...a.prov,...b.prov]};
  await save(output,report);console.log(JSON.stringify(report,null,2));
}catch(error){
  const report={schemaVersion:1,status:"fail",researchOnly:true,actualOrders:0,liveExecutionAllowed:false,
    error:{name:error?.name??"Error",message:String(error?.message??error).slice(0,1200)}};
  await save(output,report);console.error(JSON.stringify(report,null,2));process.exitCode=1;
}