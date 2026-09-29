import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { simulateStockPullbackStrategy } from "../src/stock-pullback-optimizer.js";

const DAY = 86_400_000;
const EVAL_START = Date.parse("2026-03-29T00:00:00.000Z");
const EVAL_END = Date.parse("2026-09-29T00:00:00.000Z");
const WARMUP_START = EVAL_START - 420 * DAY;
const COST = 0.0015;
const STRESS_COST = COST * 1.5;
const PARAMS = Object.freeze({
  trendMaPeriod: 200,
  slopeLookback: 5,
  pullbackLookback: 5,
  minPullbackAtr: 0.5,
  maxPullbackAtr: 2.5,
  atrStopMultiplier: 2.5,
  rewardRisk: 2,
  maxHoldBars: 10,
  minRelativeVolume: 1,
  maxGapPercent: 4,
});
const BUCKETS = Object.freeze({
  LARGE: Object.freeze({ minCap: 10_000_000_000, maxCap: Infinity, limit: 80, minDollarVolume: 10_000_000 }),
  MID: Object.freeze({ minCap: 2_000_000_000, maxCap: 10_000_000_000, limit: 100, minDollarVolume: 5_000_000 }),
  SMALL: Object.freeze({ minCap: 300_000_000, maxCap: 2_000_000_000, limit: 120, minDollarVolume: 2_000_000 }),
});

function num(value) {
  const parsed = Number(String(value ?? "").replace(/[$,% ,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}
function mean(values) { return values.length ? values.reduce((a,b)=>a+b,0) / values.length : null; }
function median(values) {
  if (!values.length) return null;
  const v=[...values].sort((a,b)=>a-b), m=Math.floor(v.length/2);
  return v.length%2 ? v[m] : (v[m-1]+v[m])/2;
}
function securityEligible(row) {
  const symbol = String(row.symbol ?? "").trim().toUpperCase();
  const name = String(row.name ?? "");
  const industry = String(row.industry ?? "");
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return false;
  if (/(Warrant|Rights?|Units?|Preferred|Depositary Preferred)/i.test(name)) return false;
  if (/Blank Checks/i.test(industry) || /Acquisition Corp/i.test(name)) return false;
  if (/[RWU]$/.test(symbol) && symbol.length >= 4) return false;
  return true;
}
function bucketFor(cap) {
  for (const [name,b] of Object.entries(BUCKETS)) if (cap >= b.minCap && cap < b.maxCap) return name;
  return null;
}
async function fetchUniverse() {
  const url="https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true";
  const response=await fetch(url,{headers:{
    accept:"application/json,text/plain,*/*",
    "accept-language":"en-US,en;q=0.9",
    "user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  }});
  if (!response.ok) throw new Error(`NASDAQ_UNIVERSE_HTTP_${response.status}`);
  const payload=await response.json();
  const rows=payload?.data?.rows;
  if (!Array.isArray(rows) || rows.length < 1000) throw new Error("NASDAQ_UNIVERSE_INSUFFICIENT");
  return rows.map((row)=>{
    const price=num(row.lastsale), volume=num(row.volume), marketCap=num(row.marketCap);
    return {
      symbol:String(row.symbol ?? "").trim().toUpperCase(),
      name:String(row.name ?? "").replace(/\s+/g," ").trim(),
      sector:String(row.sector ?? ""),
      industry:String(row.industry ?? ""),
      price,
      volume,
      marketCap,
      dollarVolume: price != null && volume != null ? price*volume : null,
      securityEligible:securityEligible(row),
    };
  });
}
function selectUniverse(rows) {
  const grouped=Object.fromEntries(Object.keys(BUCKETS).map((k)=>[k,[]]));
  const diagnostics={rawRows:rows.length,eligibleSecurityRows:0,bucketCounts:{},liquidityEligibleCounts:{}};
  for (const row of rows) {
    if (!row.securityEligible || !(row.price >= 2) || !(row.marketCap > 0) || !(row.dollarVolume >= 0)) continue;
    diagnostics.eligibleSecurityRows += 1;
    const bucket=bucketFor(row.marketCap);
    if (!bucket) continue;
    grouped[bucket].push(row);
  }
  const selected={};
  for (const [bucket,rowsForBucket] of Object.entries(grouped)) {
    diagnostics.bucketCounts[bucket]=rowsForBucket.length;
    const cfg=BUCKETS[bucket];
    const liquid=rowsForBucket.filter((r)=>r.dollarVolume >= cfg.minDollarVolume);
    diagnostics.liquidityEligibleCounts[bucket]=liquid.length;
    selected[bucket]=liquid.sort((a,b)=>b.dollarVolume-a.dollarVolume || b.marketCap-a.marketCap || a.symbol.localeCompare(b.symbol)).slice(0,cfg.limit);
  }
  return {selected,diagnostics};
}
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
async function historyWithRetry(symbol) {
  let last;
  for (let attempt=0;attempt<3;attempt+=1) {
    try {
      return await collectYahooStockHistory({market:"US_STOCK",symbol,startTime:WARMUP_START,endTime:EVAL_END,timeoutMs:15_000});
    } catch (error) {
      last=error;
      await sleep(400*(attempt+1));
    }
  }
  throw last;
}
async function mapLimit(items, limit, fn) {
  const out=new Array(items.length); let next=0;
  async function worker() {
    while (true) {
      const i=next++; if (i>=items.length) return;
      try { out[i]={ok:true,value:await fn(items[i],i)}; }
      catch (error) { out[i]={ok:false,error:String(error?.message ?? error)}; }
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>worker()));
  return out;
}
function windowFor(candles) {
  const startIndex=candles.findIndex((c)=>c.timestamp>=EVAL_START);
  let endIndex=candles.length-1;
  while(endIndex>=0 && candles[endIndex].timestamp>=EVAL_END) endIndex-=1;
  return startIndex>=0 && endIndex>startIndex ? {startIndex,endIndex} : null;
}
function summarizeTrades(trades) {
  const returns=trades.map((t)=>t.netReturn).filter(Number.isFinite);
  const wins=returns.filter((x)=>x>0), losses=returns.filter((x)=>x<0);
  const gp=wins.reduce((a,b)=>a+b,0), gl=Math.abs(losses.reduce((a,b)=>a+b,0));
  let equity=1,peak=1,maxDrawdown=0;
  for(const r of returns){equity*=Math.max(0.000001,1+r);peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak);}
  return {
    tradeCount:returns.length,
    winRate:returns.length?wins.length/returns.length:0,
    expectancy:returns.length?returns.reduce((a,b)=>a+b,0)/returns.length:0,
    profitFactor:gl>0?gp/gl:gp>0?999:null,
    maxDrawdown,
    tradeChainNetReturn:equity-1,
  };
}
function evaluateDatasets(rows,costRatePerSide) {
  const perSymbol={}, allTrades=[];
  for(const row of rows) {
    const win=windowFor(row.candles); if(!win) continue;
    const sim=simulateStockPullbackStrategy({candles:row.candles,params:PARAMS,costRatePerSide,...win});
    perSymbol[row.symbol]={...sim.metrics,marketCap:row.marketCap,dollarVolume:row.dollarVolume};
    for(const trade of sim.trades) allTrades.push({symbol:row.symbol,...trade});
  }
  const symbolReturns=Object.values(perSymbol).map((x)=>x.netReturn).filter(Number.isFinite);
  const active=Object.values(perSymbol).filter((x)=>x.tradeCount>0);
  const positive=active.filter((x)=>x.netReturn>0);
  return {
    ...summarizeTrades(allTrades),
    evaluatedSymbols:Object.keys(perSymbol).length,
    activeSymbols:active.length,
    positiveActiveSymbols:positive.length,
    positiveActiveSymbolRatio:active.length?positive.length/active.length:0,
    equalWeightSymbolReturn:symbolReturns.length?mean(symbolReturns):null,
    medianSymbolReturn:median(symbolReturns),
    perSymbol,
  };
}
async function main() {
  const universe=await fetchUniverse();
  const {selected,diagnostics}=selectUniverse(universe);
  const flat=[];
  for(const [bucket,rows] of Object.entries(selected)) for(const row of rows) flat.push({...row,bucket});
  const histories=await mapLimit(flat,5,async(row)=>{
    const h=await historyWithRetry(row.symbol);
    const evalStartIndex=h.candles.findIndex((c)=>c.timestamp>=EVAL_START);
    if(evalStartIndex<206) throw new Error(`HISTORY_WARMUP_INSUFFICIENT:${row.symbol}:${evalStartIndex}`);
    return {...row,candles:h.candles,providerSymbol:h.providerSymbol};
  });
  const successes=histories.filter((x)=>x.ok).map((x)=>x.value);
  const failures=histories.filter((x)=>!x.ok);
  const reportBuckets={};
  for(const bucket of Object.keys(BUCKETS)) {
    const rows=successes.filter((x)=>x.bucket===bucket);
    reportBuckets[bucket]={
      snapshotSelected:selected[bucket].length,
      historySucceeded:rows.length,
      historyFailed:selected[bucket].length-rows.length,
      normal:evaluateDatasets(rows,COST),
      stressed:evaluateDatasets(rows,STRESS_COST),
    };
  }
  const report={
    schemaVersion:1,
    status:"pass",
    market:"US_STOCK",
    purpose:"broad-universe frequency and transferability research",
    snapshotSource:"Nasdaq public stock screener current snapshot",
    evaluationWindow:{startInclusive:new Date(EVAL_START).toISOString(),endExclusive:new Date(EVAL_END).toISOString(),warmupStart:new Date(WARMUP_START).toISOString()},
    fixedStrategy:{family:"trend_pullback_v1",parameters:PARAMS,retuned:false},
    costs:{normalPerSide:COST,stressPerSide:STRESS_COST},
    universe:{...diagnostics,selectedCounts:Object.fromEntries(Object.entries(selected).map(([k,v])=>[k,v.length])),historyAttempts:flat.length,historySuccesses:successes.length,historyFailures:failures.length},
    buckets:reportBuckets,
    failedHistoryExamples:failures.slice(0,20).map((x)=>x.error),
    safety:{researchOnly:true,liveExecutionAllowed:false,privateAccountRequestAllowed:false,executionAuthority:"NONE"},
    evidenceLimits:[
      "Current market-cap and liquidity snapshot is used to choose symbols, so this is not point-in-time historical universe proof.",
      "Survivorship and current-liquidity selection bias remain; results are challenger research only.",
      "The experiment intentionally keeps the large-cap V1 formula frozen to isolate the effect of universe expansion.",
      "Small-cap catalyst/news/float/dilution filters are not yet added; those belong to a separate challenger.",
    ],
  };
  const output=resolve(process.argv[2]??"docs/us-equity-universe-expansion-v1.json");
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(report,null,2)+"\n","utf8");
  console.log(JSON.stringify(report,null,2));
}
await main();
