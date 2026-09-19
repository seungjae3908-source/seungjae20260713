import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";

const DAY=86_400_000;
const SPECS=Object.freeze({
  SPY:Object.freeze({market:"US_STOCK",symbol:"SPY",cost:0.0015}),
  KODEX200:Object.freeze({market:"KR_STOCK",symbol:"069500",cost:0.0025}),
});

async function save(file,value){
  await mkdir(dirname(file),{recursive:true});
  await writeFile(file,JSON.stringify(value,null,2)+"\n","utf8");
}

function calc(candles,cost){
  if(candles.length<500)throw new Error("INSUFFICIENT_BARS_"+candles.length);
  const entry=candles[0].open*(1+cost);
  const exit=candles.at(-1).close*(1-cost);
  let peak=1,mdd=0;
  for(const c of candles){
    const eq=c.close/entry;
    peak=Math.max(peak,eq);
    mdd=Math.max(mdd,(peak-eq)/peak);
  }
  const total=exit/entry-1;
  const years=(candles.at(-1).timestamp-candles[0].timestamp)/(365.25*DAY);
  return{
    return:total,
    annualizedReturn:Math.pow(1+total,1/years)-1,
    maxDrawdown:mdd,
    years,
    bars:candles.length,
  };
}

const output=resolve(process.argv[2]??"market-prediction-lab/artifacts/market-benchmarks-v1/result.json");
const endTime=Date.now(),startTime=endTime-3650*DAY;
try{
  const results={};
  for(const [id,spec] of Object.entries(SPECS)){
    const h=await collectYahooStockHistory({market:spec.market,symbol:spec.symbol,startTime,endTime});
    results[id]={
      base:calc(h.candles,spec.cost),
      stress:calc(h.candles,spec.cost*1.5),
      provenance:{providerSymbol:h.providerSymbol,candleCount:h.candleCount,firstTimestamp:h.firstTimestamp,lastTimestamp:h.lastTimestamp,source:h.source},
    };
  }
  const report={
    schemaVersion:1,status:"pass",kind:"market-benchmarks-v1",
    researchOnly:true,publicDataOnly:true,liveExecutionAllowed:false,actualOrders:0,
    methodology:"buy at first available session open and hold to final close; one entry and one exit cost",
    results,
  };
  await save(output,report);console.log(JSON.stringify(report,null,2));
}catch(error){
  const report={schemaVersion:1,status:"fail",researchOnly:true,error:{name:error?.name??"Error",message:String(error?.message??error).slice(0,1200)},actualOrders:0,liveExecutionAllowed:false};
  await save(output,report);console.error(JSON.stringify(report,null,2));process.exitCode=1;
}
