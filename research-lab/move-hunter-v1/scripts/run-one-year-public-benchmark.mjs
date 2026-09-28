import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { collectYahooStockHistory } from '../../../market-prediction-lab/src/yahoo-stock-history.js';
import { collectUpbitSpotHistory } from '../../../market-prediction-lab/src/upbit-spot-history.js';
import {
  BinanceFuturesPublicClient,
  collectBinanceFuturesDailyKlines,
  collectBinanceFuturesFundingRates,
} from '../../../market-prediction-lab/src/binance-futures-history.js';
import { replayLongCashRunnerPortfolio } from '../src/portfolio.mjs';
import {
  ONE_DAY_MS,
  ONE_YEAR_BENCHMARK_START_MS,
  ONE_YEAR_BENCHMARK_END_MS,
  ONE_YEAR_FULL_STACK_GATE_V1,
  aggregateFourHourCandlesToUtcDaily,
  buildOneYearCandidateTimeline,
  buildSequentialRunnerTrials,
} from '../src/one-year-public-benchmark.mjs';

const WARMUP_START_MS = ONE_YEAR_BENCHMARK_START_MS - 140 * ONE_DAY_MS;
const INITIAL_CAPITAL = 1_000_000;
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));

const UNIVERSES = Object.freeze({
  KR_STOCK: Object.freeze(['005930','000660','035420','005380','068270']),
  US_STOCK: Object.freeze(['AAPL','MSFT','NVDA','AMZN','META']),
  CRYPTO_SPOT: Object.freeze(['BTC','ETH','XRP','SOL','ADA']),
  CRYPTO_FUTURES: Object.freeze(['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT']),
});
const COSTS = Object.freeze({
  KR_STOCK: Object.freeze({feeBps:5,slippageBps:5,spreadBps:5,taxBps:18,assumption:'CONSERVATIVE_RESEARCH_ASSUMPTION_NOT_BROKER_SCHEDULE'}),
  US_STOCK: Object.freeze({feeBps:5,slippageBps:5,spreadBps:5,taxBps:0,assumption:'CONSERVATIVE_RESEARCH_ASSUMPTION_NOT_BROKER_SCHEDULE'}),
  CRYPTO_SPOT: Object.freeze({feeBps:5,slippageBps:5,spreadBps:5,taxBps:0,assumption:'CONSERVATIVE_RESEARCH_ASSUMPTION_NOT_EXCHANGE_FEE_SCHEDULE'}),
  CRYPTO_FUTURES: Object.freeze({feeBps:6,slippageBps:5,spreadBps:3,taxBps:0,assumption:'CONSERVATIVE_RESEARCH_ASSUMPTION_PLUS_ACTUAL_PUBLIC_FUNDING_HISTORY'}),
});

function source(market) {
  if (market === 'CRYPTO_SPOT') return {sourceId:'UPBIT_PUBLIC_4H_AGG_1D',originalSourceId:'UPBIT_PUBLIC_CANDLES',sourceType:'PUBLIC_MARKET_OHLCV_AGGREGATED',sourceUrl:'https://api.upbit.com/'};
  if (market === 'CRYPTO_FUTURES') return {sourceId:'BINANCE_USDM_PUBLIC_1D',originalSourceId:'BINANCE_USDM_PUBLIC_REST',sourceType:'PUBLIC_MARKET_OHLCV',sourceUrl:'https://fapi.binance.com/'};
  return {sourceId:`YAHOO_PUBLIC_${market}_1D`,originalSourceId:'YAHOO_PUBLIC_CHART',sourceType:'PUBLIC_MARKET_OHLCV',sourceUrl:'https://query1.finance.yahoo.com/'};
}
function runnerCandles(rows){ return rows.map(row=>({ts:Number(row.ts??row.timestamp),open:row.open,high:row.high,low:row.low,close:row.close,volume:row.volume??0})); }

async function collectStocks(market) {
  const datasets=[], failures=[];
  for (const symbol of UNIVERSES[market]) {
    try {
      const result = await collectYahooStockHistory({market,symbol,startTime:WARMUP_START_MS,endTime:ONE_YEAR_BENCHMARK_END_MS+1,timeoutMs:20_000});
      datasets.push({market,symbol,candles:runnerCandles(result.candles),fundingRates:[],provider:result.source,providerSymbol:result.providerSymbol});
    } catch (error) {
      failures.push({market,symbol,error:error instanceof Error?error.message:String(error)});
    }
    await sleep(250);
  }
  return {datasets,failures};
}
async function collectSpot() {
  const datasets=[],failures=[];
  for(const symbol of UNIVERSES.CRYPTO_SPOT){
    try{
      const result=await collectUpbitSpotHistory({symbol,timeframe:'4h',startTime:WARMUP_START_MS,endTime:ONE_YEAR_BENCHMARK_END_MS+1,maxPages:40,minIntervalMs:120});
      const daily=aggregateFourHourCandlesToUtcDaily(runnerCandles(result.candles));
      datasets.push({market:'CRYPTO_SPOT',symbol,candles:daily,fundingRates:[],provider:result.source});
    }catch(error){ failures.push({market:'CRYPTO_SPOT',symbol,error:error instanceof Error?error.message:String(error)}); }
  }
  return {datasets,failures};
}
async function collectFutures() {
  const client=new BinanceFuturesPublicClient();
  const datasets=[],failures=[];
  for(const symbol of UNIVERSES.CRYPTO_FUTURES){
    try{
      const [klines,funding]=await Promise.all([
        collectBinanceFuturesDailyKlines({client,symbol,startTime:WARMUP_START_MS,endTime:ONE_YEAR_BENCHMARK_END_MS}),
        collectBinanceFuturesFundingRates({client,symbol,startTime:WARMUP_START_MS,endTime:ONE_YEAR_BENCHMARK_END_MS}),
      ]);
      datasets.push({market:'CRYPTO_FUTURES',symbol,candles:runnerCandles(klines.candles),fundingRates:funding.records,provider:klines.provider});
    }catch(error){ failures.push({market:'CRYPTO_FUTURES',symbol,error:error instanceof Error?error.message:String(error)}); }
  }
  return {datasets,failures};
}

function buildMarketResearch(market,datasets,side='LONG'){
  const timelines=[];
  for(const dataset of datasets){
    const timeline=buildOneYearCandidateTimeline({
      market,symbol:dataset.symbol,side,timeframe:'1D',candles:dataset.candles,intervalMs:ONE_DAY_MS,source:source(market),
    });
    timelines.push({dataset,timeline});
  }
  if(market!=='CRYPTO_FUTURES'){
    const candidates=timelines.flatMap(x=>x.timeline.candidates);
    const candlesBySymbol=Object.fromEntries(timelines.map(x=>[x.dataset.symbol,x.dataset.candles]));
    const controls=Object.fromEntries(timelines.map(x=>[x.dataset.symbol,x.timeline.runnerControlByTs]));
    const fixed=replayLongCashRunnerPortfolio({
      candidates,candlesBySymbol,runnerControlBySymbol:{},indicatorExitEnabled:false,presetName:'LONG_RUNNER_3ATR',
      costs:COSTS[market],initialCapital:INITIAL_CAPITAL,riskFraction:.005,aggregateInitialRiskCap:.02,
      maxPositions:5,symbolExposureCap:.20,themeExposureCap:1,maxGrossExposure:1,
    });
    const adaptive=replayLongCashRunnerPortfolio({
      candidates,candlesBySymbol,runnerControlBySymbol:controls,indicatorExitEnabled:false,presetName:'LONG_RUNNER_3ATR',
      costs:COSTS[market],initialCapital:INITIAL_CAPITAL,riskFraction:.005,aggregateInitialRiskCap:.02,
      maxPositions:5,symbolExposureCap:.20,themeExposureCap:1,maxGrossExposure:1,
    });
    return {market,side:'LONG',status:datasets.length>=3?'OBSERVED_HISTORY_RESEARCH_ONLY':'BLOCKED_DATA_INSUFFICIENT_SYMBOL_COVERAGE',
      symbolCount:datasets.length,candidateCount:candidates.length,fixed,adaptive,
      timelineDiagnostics:Object.fromEntries(timelines.map(x=>[x.dataset.symbol,x.timeline.diagnostics])),
      fullStackGate:ONE_YEAR_FULL_STACK_GATE_V1,costs:COSTS[market]};
  }
  const fixedTrials=[],adaptiveTrials=[];
  let fundingReturnFixed=0,fundingReturnAdaptive=0;
  for(const {dataset,timeline} of timelines){
    const fixed=buildSequentialRunnerTrials({candidates:timeline.candidates,candles:dataset.candles,runnerControlByTs:{},fundingRates:dataset.fundingRates,costs:COSTS[market],useAdaptiveTrail:false});
    const adaptive=buildSequentialRunnerTrials({candidates:timeline.candidates,candles:dataset.candles,runnerControlByTs:timeline.runnerControlByTs,fundingRates:dataset.fundingRates,costs:COSTS[market],useAdaptiveTrail:true});
    fixedTrials.push(...fixed.trials); adaptiveTrials.push(...adaptive.trials);
    fundingReturnFixed+=fixed.totalFundingReturn; fundingReturnAdaptive+=adaptive.totalFundingReturn;
  }
  fixedTrials.sort((a,b)=>a.exitTs-b.exitTs); adaptiveTrials.sort((a,b)=>a.exitTs-b.exitTs);
  const summarize = trials => {
    const wins=trials.filter(x=>x.netReturn>0), losses=trials.filter(x=>x.netReturn<0);
    const gain=wins.reduce((s,x)=>s+x.netReturn,0), loss=-losses.reduce((s,x)=>s+x.netReturn,0);
    let equity=1,peak=1,mdd=0;
    for(const t of trials){equity*=1+t.netReturn;peak=Math.max(peak,equity);mdd=Math.max(mdd,1-equity/peak);}
    return {n:trials.length,winRate:trials.length?wins.length/trials.length:0,avgNetReturn:trials.length?trials.reduce((s,x)=>s+x.netReturn,0)/trials.length:0,
      profitFactor:loss>0?gain/loss:(gain>0?null:0),compoundedReturn:equity-1,maxDrawdown:mdd};
  };
  return {market,side,status:datasets.length>=3?'OBSERVED_HISTORY_RESEARCH_ONLY':'BLOCKED_DATA_INSUFFICIENT_SYMBOL_COVERAGE',
    symbolCount:datasets.length,candidateCount:timelines.reduce((s,x)=>s+x.timeline.candidates.length,0),
    fixed:{summary:summarize(fixedTrials),totalFundingReturn:fundingReturnFixed},
    adaptive:{summary:summarize(adaptiveTrials),totalFundingReturn:fundingReturnAdaptive},
    timelineDiagnostics:Object.fromEntries(timelines.map(x=>[x.dataset.symbol,x.timeline.diagnostics])),
    fullStackGate:ONE_YEAR_FULL_STACK_GATE_V1,costs:COSTS[market]};
}

function fmt(v,p=2){ return Number.isFinite(v)?v.toFixed(p):'N/A'; }
function pct(v){ return Number.isFinite(v)?`${(v*100).toFixed(2)}%`:'N/A'; }
function marketRow(row){
  const cash=row.market!=='CRYPTO_FUTURES';
  const f=cash?row.fixed:{...row.fixed.summary};
  const a=cash?row.adaptive:{...row.adaptive.summary};
  const fixedReturn=cash?f.netReturn:f.compoundedReturn;
  const adaptiveReturn=cash?a.netReturn:a.compoundedReturn;
  const fixedN=cash?f.tradeCount:f.n, adaptiveN=cash?a.tradeCount:a.n;
  const fixedWr=cash?f.winRate:f.winRate, adaptiveWr=cash?a.winRate:a.winRate;
  const fixedPf=f.profitFactor, adaptivePf=a.profitFactor;
  const fixedDd=cash?f.maxDrawdown:f.maxDrawdown, adaptiveDd=cash?a.maxDrawdown:a.maxDrawdown;
  return `| ${row.market} | ${row.side} | ${row.status} | ${row.symbolCount} | ${row.candidateCount} | ${fixedN} | ${pct(fixedReturn)} | ${pct(fixedWr)} | ${fmt(fixedPf)} | ${pct(fixedDd)} | ${adaptiveN} | ${pct(adaptiveReturn)} | ${pct(adaptiveWr)} | ${fmt(adaptivePf)} | ${pct(adaptiveDd)} |`;
}

async function main(){
  const [kr,us,spot,futures]=await Promise.all([collectStocks('KR_STOCK'),collectStocks('US_STOCK'),collectSpot(),collectFutures()]);
  const results=[
    buildMarketResearch('KR_STOCK',kr.datasets,'LONG'),
    buildMarketResearch('US_STOCK',us.datasets,'LONG'),
    buildMarketResearch('CRYPTO_SPOT',spot.datasets,'LONG'),
    buildMarketResearch('CRYPTO_FUTURES',futures.datasets,'LONG'),
    buildMarketResearch('CRYPTO_FUTURES',futures.datasets,'SHORT'),
  ];
  const failures=[...kr.failures,...us.failures,...spot.failures,...futures.failures];
  const output={
    schemaVersion:'move-hunter-one-year-four-market-public-benchmark/v1',
    window:{startTime:ONE_YEAR_BENCHMARK_START_MS,endTime:ONE_YEAR_BENCHMARK_END_MS,start:new Date(ONE_YEAR_BENCHMARK_START_MS).toISOString(),end:new Date(ONE_YEAR_BENCHMARK_END_MS).toISOString()},
    warmupStart:new Date(WARMUP_START_MS).toISOString(),
    universes:UNIVERSES,results,providerFailures:failures,
    truth:{historicalReplayOnly:true,fullStackBacktestBlocked:true,fullStackBlocker:ONE_YEAR_FULL_STACK_GATE_V1.blocker,
      pointInTimeNewsDisclosureAiBound:false,independentOos:false,profitabilityProven:false,economicSampleCredit:0,executionAuthority:'NONE',
      replitUsed:false,privateApiUsed:false,realOrders:0},
  };
  const jsonPath=process.argv[2]??'research-lab/move-hunter-v1/docs/one-year-four-market-public-benchmark-20260928.json';
  const mdPath=process.argv[3]??'research-lab/move-hunter-v1/docs/one-year-four-market-public-benchmark-20260928.md';
  await mkdir(dirname(jsonPath),{recursive:true});
  await writeFile(jsonPath,JSON.stringify(output,null,2)+'\n','utf8');
  const lines=[
    '# Move Hunter — 1Y four-market public-data benchmark',
    '',
    `Window: ${output.window.start} → ${output.window.end}`,
    '',
    'This is observed-history research only. It is not pristine OOS, Forward evidence, or a profitability claim.',
    `Full stack (news/disclosure/AI) status: **BLOCKED** — ${output.truth.fullStackBlocker}.`,
    '',
    '| Market | Side | Status | Symbols | Candidates | Fixed N | Fixed Return | Fixed Win | Fixed PF | Fixed MDD | Adaptive N | Adaptive Return | Adaptive Win | Adaptive PF | Adaptive MDD |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...results.map(marketRow),
    '',
    `Provider failures: ${failures.length}`,
    ...failures.map(x=>`- ${x.market} ${x.symbol}: ${x.error}`),
    '',
    'Safety: historical only; economicSampleCredit=0; PROFITABILITY_PROVEN=false; executionAuthority=NONE; Replit not used.',
  ];
  await writeFile(mdPath,lines.join('\n')+'\n','utf8');
  console.log(JSON.stringify({jsonPath,mdPath,results:results.map(r=>({market:r.market,side:r.side,status:r.status,symbolCount:r.symbolCount,candidateCount:r.candidateCount})),providerFailures:failures},null,2));
}
await main();
