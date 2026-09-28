import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { collectYahooStockHistory } from '../../../market-prediction-lab/src/yahoo-stock-history.js';
import { collectUpbitSpotHistory } from '../../../market-prediction-lab/src/upbit-spot-history.js';
import {
  BinanceFuturesPublicClient,
  collectBinanceFuturesDailyKlines,
  collectBinanceFuturesFundingRates,
} from '../../../market-prediction-lab/src/binance-futures-history.js';
import { BitgetPublicClient } from '../../../market-prediction-lab/src/bitget-public-client.js';
import {
  collectVisionFuturesDailyKlines,
  collectVisionFuturesFunding,
} from '../../../market-prediction-lab/src/binance-vision-futures-archive.js';
import { collectBitgetCandles } from '../../../market-prediction-lab/src/bitget-candle-collector.js';
import { collectFundingRateHistory as collectBitgetFundingRateHistory } from '../../../market-prediction-lab/src/derivatives-history.js';
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

const INITIAL_CAPITAL = 1_000_000;
const BENCHMARK_DAYS = 365;
const WARMUP_DAYS = 140;
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

function source(market, provider = '') {
  if (market === 'CRYPTO_SPOT') return {sourceId:'UPBIT_PUBLIC_4H_AGG_1D',originalSourceId:'UPBIT_PUBLIC_CANDLES',sourceType:'PUBLIC_MARKET_OHLCV_AGGREGATED',sourceUrl:'https://api.upbit.com/'};
  if (market === 'CRYPTO_FUTURES' && String(provider).includes('composite')) {
    return {
      sourceId:'BINANCE_VISION_BITGET_COMPOSITE_1D',
      originalSourceId:'PUBLIC_CROSS_VENUE_COMPOSITE',
      sourceType:'PUBLIC_MARKET_OHLCV_CROSS_VENUE_COMPOSITE',
      sourceUrl:'https://data.binance.vision/',
    };
  }
  if (market === 'CRYPTO_FUTURES' && String(provider).includes('vision')) {
    return {sourceId:'BINANCE_VISION_USDM_1D',originalSourceId:'BINANCE_VISION_CHECKSUM_ARCHIVE',sourceType:'PUBLIC_MARKET_OHLCV_ARCHIVE',sourceUrl:'https://data.binance.vision/'};
  }
  if (market === 'CRYPTO_FUTURES' && String(provider).includes('bitget')) {
    return {sourceId:'BITGET_PUBLIC_V2_1D',originalSourceId:'BITGET_PUBLIC_HISTORY_CANDLES',sourceType:'PUBLIC_MARKET_OHLCV',sourceUrl:'https://api.bitget.com/'};
  }
  if (market === 'CRYPTO_FUTURES') return {sourceId:'BINANCE_USDM_PUBLIC_1D',originalSourceId:'BINANCE_USDM_PUBLIC_REST',sourceType:'PUBLIC_MARKET_OHLCV',sourceUrl:'https://fapi.binance.com/'};
  return {sourceId:`YAHOO_PUBLIC_${market}_1D`,originalSourceId:'YAHOO_PUBLIC_CHART',sourceType:'PUBLIC_MARKET_OHLCV',sourceUrl:'https://query1.finance.yahoo.com/'};
}
function runnerCandles(rows){ return rows.map(row=>({ts:Number(row.ts??row.timestamp),open:row.open,high:row.high,low:row.low,close:row.close,volume:row.volume??0})); }

async function collectStocks(market, window) {
  const datasets=[], failures=[];
  for (const symbol of UNIVERSES[market]) {
    try {
      const result = await collectYahooStockHistory({market,symbol,startTime:window.warmupStart,endTime:window.endTime+1,timeoutMs:20_000});
      datasets.push({market,symbol,candles:runnerCandles(result.candles),fundingRates:[],provider:result.source,providerSymbol:result.providerSymbol});
    } catch (error) {
      failures.push({market,symbol,error:error instanceof Error?error.message:String(error)});
    }
    await sleep(250);
  }
  return {datasets,failures};
}
async function collectSpot(window) {
  const datasets=[],failures=[];
  for(const symbol of UNIVERSES.CRYPTO_SPOT){
    try{
      const result=await collectUpbitSpotHistory({symbol,timeframe:'4h',startTime:window.warmupStart,endTime:window.endTime+1,maxPages:40,minIntervalMs:120});
      const daily=aggregateFourHourCandlesToUtcDaily(runnerCandles(result.candles));
      datasets.push({market:'CRYPTO_SPOT',symbol,candles:daily,fundingRates:[],provider:result.source});
    }catch(error){ failures.push({market:'CRYPTO_SPOT',symbol,error:error instanceof Error?error.message:String(error)}); }
  }
  return {datasets,failures};
}
function strictDailyCoverage(candles, label, window) {
  const rows=runnerCandles(candles).sort((a,b)=>a.ts-b.ts);
  const expectedLast=Math.floor(window.endTime/ONE_DAY_MS)*ONE_DAY_MS;
  const minimumRows=BENCHMARK_DAYS+WARMUP_DAYS-5;
  if(rows.length<minimumRows) throw new Error(`${label}_DAILY_COVERAGE_TOO_SHORT:${rows.length}`);
  if(rows[0].ts>window.warmupStart+ONE_DAY_MS) throw new Error(`${label}_START_COVERAGE_MISSING`);
  if(rows.at(-1).ts<expectedLast) throw new Error(`${label}_END_COVERAGE_MISSING`);
  for(let i=1;i<rows.length;i+=1){
    if(rows[i].ts-rows[i-1].ts!==ONE_DAY_MS) {
      throw new Error(`${label}_DAILY_GAP:${rows[i-1].ts}->${rows[i].ts}`);
    }
  }
  return rows;
}

function strictFundingTailCoverage(records, startTime, endTime, label) {
  const rows=[...records].sort((a,b)=>a.timestamp-b.timestamp);
  if(rows.length===0) throw new Error(`${label}_EMPTY`);
  if(rows[0].timestamp>startTime+12*60*60*1000) throw new Error(`${label}_START_COVERAGE_MISSING`);
  if(rows.at(-1).timestamp<endTime-12*60*60*1000) throw new Error(`${label}_END_COVERAGE_MISSING`);
  for(let i=1;i<rows.length;i+=1){
    if(rows[i].timestamp-rows[i-1].timestamp>12*60*60*1000) throw new Error(`${label}_GAP_TOO_LARGE`);
  }
  return rows;
}

function uniqueFunding(rows) {
  const map=new Map();
  for(const row of rows){
    const existing=map.get(row.timestamp);
    if(existing && existing.rate!==row.rate) throw new Error(`FUNDING_CONFLICT_AT_${row.timestamp}`);
    map.set(row.timestamp,row);
  }
  return [...map.values()].sort((a,b)=>a.timestamp-b.timestamp);
}

async function collectVisionBitgetCompositeFutures({symbol,bitget,window}) {
  const recent=await collectBitgetCandles({
    client:bitget,
    market:'CRYPTO_FUTURES',
    symbol,
    timeframe:'1d',
    startTime:window.warmupStart,
    endTime:window.endTime+1,
    maxCandles:1_000,
    productType:'usdt-futures',
  });
  const recentRows=runnerCandles(recent.candles).sort((a,b)=>a.ts-b.ts);
  if(recentRows.length<60) throw new Error(`BITGET_RECENT_DAILY_TOO_SHORT:${recentRows.length}`);
  const expectedLast=Math.floor(window.endTime/ONE_DAY_MS)*ONE_DAY_MS;
  if(recentRows.at(-1).ts<expectedLast) throw new Error('BITGET_RECENT_END_COVERAGE_MISSING');
  for(let i=1;i<recentRows.length;i+=1){
    if(recentRows[i].ts-recentRows[i-1].ts!==ONE_DAY_MS) {
      throw new Error(`BITGET_RECENT_DAILY_GAP:${recentRows[i-1].ts}->${recentRows[i].ts}`);
    }
  }

  const crossoverTimestamp=recentRows[0].ts;
  if(crossoverTimestamp<=window.warmupStart+30*ONE_DAY_MS) {
    throw new Error('COMPOSITE_CROSSOVER_TOO_EARLY_FOR_ARCHIVE_VALUE');
  }
  const archiveEnd=crossoverTimestamp-1;

  const [archiveCandles,archiveFunding,recentFunding]=await Promise.all([
    collectVisionFuturesDailyKlines({
      symbol,
      startTime:window.warmupStart,
      endTime:archiveEnd,
      concurrency:4,
    }),
    collectVisionFuturesFunding({
      symbol,
      startTime:window.warmupStart,
      endTime:archiveEnd,
      concurrency:4,
    }),
    collectBitgetFundingRateHistory({
      client:bitget,
      symbol,
      startTime:crossoverTimestamp,
      endTime:window.endTime,
      productType:'usdt-futures',
      pageSize:100,
      maxPages:20,
    }),
  ]);

  const tailFunding=strictFundingTailCoverage(
    recentFunding.records,
    crossoverTimestamp,
    window.endTime,
    'BITGET_RECENT_FUNDING',
  );
  const candles=strictDailyCoverage(
    [...archiveCandles.candles,...recentRows],
    'BINANCE_VISION_BITGET_COMPOSITE',
    window,
  );
  const fundingRates=uniqueFunding([...archiveFunding.records,...tailFunding]);

  return {
    market:'CRYPTO_FUTURES',
    symbol,
    candles,
    fundingRates,
    provider:'binance-vision-monthly+bitget-public-v2-recent-composite',
    fundingProvider:'binance-vision-monthly+bitget-public-v2-recent-composite',
    providerFallbackUsed:true,
    crossVenueComposite:true,
    crossoverTimestamp,
    archiveChecksumVerified:archiveCandles.checksumVerified===true
      && archiveFunding.checksumVerified===true,
  };
}

async function collectFutures(window) {
  const binance=new BinanceFuturesPublicClient();
  const bitget=new BitgetPublicClient({timeoutMs:20_000,maxRetries:3,minIntervalMs:150});
  const datasets=[],failures=[];
  for(const symbol of UNIVERSES.CRYPTO_FUTURES){
    let binanceFailure=null;
    try{
      const [klines,funding]=await Promise.all([
        collectBinanceFuturesDailyKlines({
          client:binance,symbol,startTime:window.warmupStart,endTime:window.endTime,
        }),
        collectBinanceFuturesFundingRates({
          client:binance,symbol,startTime:window.warmupStart,endTime:window.endTime,
        }),
      ]);
      const candles=strictDailyCoverage(klines.candles,'BINANCE_API',window);
      datasets.push({
        market:'CRYPTO_FUTURES',
        symbol,
        candles,
        fundingRates:funding.records,
        provider:klines.provider,
        fundingProvider:funding.provider,
        providerFallbackUsed:false,
        crossVenueComposite:false,
        archiveChecksumVerified:null,
      });
      continue;
    }catch(error){
      binanceFailure=error instanceof Error?error.message:String(error);
    }

    try{
      const composite=await collectVisionBitgetCompositeFutures({symbol,bitget,window});
      datasets.push({...composite,primaryProviderFailure:binanceFailure});
    }catch(error){
      failures.push({
        market:'CRYPTO_FUTURES',
        symbol,
        error:`BINANCE_API: ${binanceFailure}; CROSS_VENUE_COMPOSITE: ${error instanceof Error?error.message:String(error)}`,
      });
    }
  }
  return {datasets,failures};
}

function buildMarketResearch(market,datasets,side='LONG',window){
  const timelines=[];
  for(const dataset of datasets){
    const timeline=buildOneYearCandidateTimeline({
      market,symbol:dataset.symbol,side,timeframe:'1D',candles:dataset.candles,intervalMs:ONE_DAY_MS,source:source(market,dataset.provider),
      startTime:window.startTime,endTime:window.endTime,
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
  const window=Object.freeze({
    startTime:ONE_YEAR_BENCHMARK_START_MS,
    endTime:ONE_YEAR_BENCHMARK_END_MS,
    warmupStart:ONE_YEAR_BENCHMARK_START_MS-WARMUP_DAYS*ONE_DAY_MS,
  });
  const [kr,us,spot,futures]=await Promise.all([
    collectStocks('KR_STOCK',window),collectStocks('US_STOCK',window),collectSpot(window),collectFutures(window),
  ]);
  const results=[
    buildMarketResearch('KR_STOCK',kr.datasets,'LONG',window),
    buildMarketResearch('US_STOCK',us.datasets,'LONG',window),
    buildMarketResearch('CRYPTO_SPOT',spot.datasets,'LONG',window),
    buildMarketResearch('CRYPTO_FUTURES',futures.datasets,'LONG',window),
    buildMarketResearch('CRYPTO_FUTURES',futures.datasets,'SHORT',window),
  ];
  const failures=[...kr.failures,...us.failures,...spot.failures,...futures.failures];
  const output={
    schemaVersion:'move-hunter-one-year-four-market-public-benchmark/v1',
    window:{
      startTime:window.startTime,endTime:window.endTime,
      start:new Date(window.startTime).toISOString(),end:new Date(window.endTime).toISOString(),
      resolutionPolicy:'FIXED_2025_09_28_TO_2026_09_27',
    },
    warmupStart:new Date(window.warmupStart).toISOString(),
    universes:UNIVERSES,results,providerFailures:failures,
    providers:{
      futures:futures.datasets.map(x=>({
        symbol:x.symbol,provider:x.provider,fundingProvider:x.fundingProvider??null,
        providerFallbackUsed:x.providerFallbackUsed===true,
        crossVenueComposite:x.crossVenueComposite===true,
        crossoverTimestamp:x.crossoverTimestamp??null,
        archiveChecksumVerified:x.archiveChecksumVerified??null,
        primaryProviderFailure:x.primaryProviderFailure??null,
      })),
    },
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
