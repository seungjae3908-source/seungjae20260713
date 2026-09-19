import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { optimizeStockSwingMarket } from "../src/stock-swing-optimizer.js";

const DAY=86_400_000;
const SYMBOLS=Object.freeze([
  "005490","012330","066570","028260","032830","086790","017670","096770",
  "009150","018260","030200","034730","010950","011170","024110","033780",
]);
const FROZEN=Object.freeze({
  breakoutLookback:20, maPeriod:20, atrStopMultiplier:2.5, rewardRisk:1.5,
  maxHoldBars:20, minRelativeVolume:1.2, maxGapPercent:5,
});
async function save(file,value){await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2)+"\n","utf8");}
const output=resolve(process.argv[2]??"market-prediction-lab/artifacts/kr-frozen-breakout-fresh-v1/result.json");
const endTime=Date.now(), startTime=endTime-3650*DAY;
try{
  const datasets=[];
  const provenance=[];
  for(const symbol of SYMBOLS){
    const h=await collectYahooStockHistory({market:"KR_STOCK",symbol,startTime,endTime});
    datasets.push({symbol,candles:h.candles});
    provenance.push({symbol,providerSymbol:h.providerSymbol,candleCount:h.candleCount,firstTimestamp:h.firstTimestamp,lastTimestamp:h.lastTimestamp,source:h.source});
  }
  const result=optimizeStockSwingMarket({
    market:"KR_STOCK",datasets,costRatePerSide:0.0025,stressMultiplier:1.5,
    grid:{
      breakoutLookback:[FROZEN.breakoutLookback],maPeriod:[FROZEN.maPeriod],
      atrStopMultiplier:[FROZEN.atrStopMultiplier],rewardRisk:[FROZEN.rewardRisk],
      maxHoldBars:[FROZEN.maxHoldBars],minRelativeVolume:[FROZEN.minRelativeVolume],
      maxGapPercent:[FROZEN.maxGapPercent],
    },
  });
  const report={
    schemaVersion:1,status:"pass",kind:"kr-frozen-breakout-fresh-symbol-v1",
    researchOnly:true,publicDataOnly:true,liveExecutionAllowed:false,privateAccountRequestAllowed:false,actualOrders:0,
    sourceParamsFrozenBeforeFreshSymbols:true,sourceUniverse:["005930","000660","035420"],
    freshSymbols:SYMBOLS,frozenParams:FROZEN,result,provenance,
  };
  await save(output,report); console.log(JSON.stringify(report,null,2));
}catch(error){
  const report={schemaVersion:1,status:"fail",researchOnly:true,error:{name:error?.name??"Error",message:String(error?.message??error).slice(0,1200)},actualOrders:0,liveExecutionAllowed:false};
  await save(output,report);console.error(JSON.stringify(report,null,2));process.exitCode=1;
}