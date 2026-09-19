import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { normalizeOptimizerCandles } from "../src/stock-swing-optimizer.js";
import { simulateStockPullbackStrategy } from "../src/stock-pullback-optimizer.js";

const DAY=86_400_000;
const SYMBOLS=Object.freeze(["AVGO","COST","WMT","V","MA","HD","UNH","PG","KO","PEP"]);
const PARAMS=Object.freeze({
  trendMaPeriod:200,
  slopeLookback:5,
  pullbackLookback:5,
  minPullbackAtr:0.5,
  maxPullbackAtr:2.5,
  atrStopMultiplier:2.5,
  rewardRisk:2,
  maxHoldBars:10,
  minRelativeVolume:1,
  maxGapPercent:4,
});
const COST=0.0015;
const STRESS=1.5;

async function save(file,value){
  await mkdir(dirname(file),{recursive:true});
  await writeFile(file,JSON.stringify(value,null,2)+"\n","utf8");
}

function summarize(results){
  const trades=results.flatMap(x=>x.simulation.trades.map(t=>({...t,symbol:x.symbol})));
  const rs=trades.map(t=>t.netReturn);
  const wins=rs.filter(x=>x>0),loss=rs.filter(x=>x<0);
  const gp=wins.reduce((a,b)=>a+b,0),gl=Math.abs(loss.reduce((a,b)=>a+b,0));
  let eq=1,peak=1,mdd=0;
  for(const r of rs){eq*=Math.max(1e-6,1+r);peak=Math.max(peak,eq);mdd=Math.max(mdd,(peak-eq)/peak);}
  return{
    tradeCount:rs.length,
    winRate:rs.length?wins.length/rs.length:0,
    expectancy:rs.length?rs.reduce((a,b)=>a+b,0)/rs.length:0,
    profitFactor:gl>0?gp/gl:(gp>0?null:0),
    netReturn:eq-1,
    maxDrawdown:mdd,
    positiveSymbols:results.filter(x=>x.simulation.metrics.expectancy>0&&x.simulation.metrics.profitFactor>1).length,
    symbolCount:results.length,
    perSymbol:Object.fromEntries(results.map(x=>[x.symbol,x.simulation.metrics])),
  };
}

function evaluate(datasets,cost,segment){
  return summarize(datasets.map(d=>{
    const candles=d.candles;
    const startIndex=segment==="recent30"?Math.floor(candles.length*0.70):undefined;
    return{symbol:d.symbol,simulation:simulateStockPullbackStrategy({candles,params:PARAMS,costRatePerSide:cost,startIndex})};
  }));
}

const output=resolve(process.argv[2]??"market-prediction-lab/artifacts/us-pullback-fresh-v1/result.json");
const endTime=Date.now(),startTime=endTime-3650*DAY;
try{
  const datasets=[],provenance=[];
  for(const symbol of SYMBOLS){
    const h=await collectYahooStockHistory({market:"US_STOCK",symbol,startTime,endTime});
    const candles=normalizeOptimizerCandles(h.candles);
    datasets.push({symbol,candles});
    provenance.push({symbol,providerSymbol:h.providerSymbol,candleCount:h.candleCount,firstTimestamp:h.firstTimestamp,lastTimestamp:h.lastTimestamp,source:h.source});
  }
  const report={
    schemaVersion:1,status:"pass",kind:"us-pullback-frozen-fresh-symbol-v1",
    researchOnly:true,publicDataOnly:true,liveExecutionAllowed:false,privateAccountRequestAllowed:false,actualOrders:0,
    paramsFrozenBeforeFreshSymbols:true,
    previousSymbols:["AAPL","MSFT","NVDA","AMZN","GOOGL","META","JPM","XOM"],
    freshSymbols:SYMBOLS,
    params:PARAMS,
    base:{full:evaluate(datasets,COST,"full"),recent30:evaluate(datasets,COST,"recent30")},
    stress:{full:evaluate(datasets,COST*STRESS,"full"),recent30:evaluate(datasets,COST*STRESS,"recent30")},
    provenance,
    limitations:["current large-cap universe has survivorship bias","fresh symbols were not used to select parameters","next-bar-open execution and conservative same-bar stop-first policy inherited from simulator"],
  };
  await save(output,report);console.log(JSON.stringify(report,null,2));
}catch(error){
  const report={schemaVersion:1,status:"fail",researchOnly:true,error:{name:error?.name??"Error",message:String(error?.message??error).slice(0,1200)},actualOrders:0,liveExecutionAllowed:false};
  await save(output,report);console.error(JSON.stringify(report,null,2));process.exitCode=1;
}
