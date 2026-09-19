import { BitgetPublicClient } from '../../market-prediction-lab/src/bitget-public-client.js';
import { collectBitgetFuturesContext } from '../../market-prediction-lab/src/bitget-candle-collector.js';
import { collectLongShortRatioHistory } from '../../market-prediction-lab/src/derivatives-history.js';
import { appendTemporalEvidenceBatchV1 } from './temporal-evidence-ledger.mjs';

function latestPriorOpenInterest(ledger,symbol,beforeTimestamp){
  return [...ledger.observations]
    .filter(row=>row.market==='CRYPTO_FUTURES'&&row.symbol===symbol&&row.feature==='openInterestRaw'&&row.observedAt<beforeTimestamp)
    .sort((a,b)=>b.observedAt-a.observedAt)[0]??null;
}

function genuineObservation({symbol,feature,value,observedAt,availableAt,source='bitget-public-v2'}){
  return Object.freeze({
    market:'CRYPTO_FUTURES',
    symbol,
    feature,
    value,
    observedAt,
    availableAt,
    recordedAt:availableAt,
    source,
    publicDataOnly:true,
    synthetic:false,
    replay:false,
    backfill:false,
    manual:false,
  });
}

export function buildCryptoFuturesTemporalObservationsV1({
  ledger,
  symbol,
  context,
  longShortRecords=[],
  collectedAt,
}={}){
  if(!ledger||!Array.isArray(ledger.observations)) throw new TypeError('temporal ledger required');
  if(typeof symbol!=='string'||!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new TypeError('symbol invalid');
  if(!context||typeof context!=='object') throw new TypeError('Bitget futures context required');
  if(!Number.isSafeInteger(collectedAt)||collectedAt<=0) throw new TypeError('collectedAt invalid');
  const observations=[];

  if(Number.isFinite(context.fundingRate)){
    const observedAt=Number.isSafeInteger(context.fundingTimestamp)&&context.fundingTimestamp>0
      ? context.fundingTimestamp
      : collectedAt;
    observations.push(genuineObservation({
      symbol,feature:'fundingRate',value:context.fundingRate,
      observedAt,availableAt:collectedAt,
    }));
  }

  if(Number.isFinite(context.openInterest)&&context.openInterest>=0){
    const observedAt=Number.isSafeInteger(context.openInterestTimestamp)&&context.openInterestTimestamp>0
      ? context.openInterestTimestamp
      : collectedAt;
    const prior=latestPriorOpenInterest(ledger,symbol,observedAt);
    observations.push(genuineObservation({
      symbol,feature:'openInterestRaw',value:context.openInterest,
      observedAt,availableAt:collectedAt,
    }));
    if(prior&&prior.value>0&&observedAt>prior.observedAt){
      observations.push(genuineObservation({
        symbol,feature:'openInterestChange',
        value:(context.openInterest-prior.value)/prior.value,
        observedAt,availableAt:collectedAt,
        source:'bitget-public-v2-derived-oi-change',
      }));
    }
  }

  for(const raw of longShortRecords){
    if(!raw||!Number.isFinite(raw.ratio)||!Number.isSafeInteger(raw.timestamp)||raw.timestamp<=0) continue;
    // Historical rows retrieved today are not granted hindsight credit. Their
    // availableAt is the actual collection time, so only future anchors may use them.
    observations.push(genuineObservation({
      symbol,feature:'longShortRatio',value:raw.ratio,
      observedAt:raw.timestamp,availableAt:collectedAt,
    }));
  }

  return Object.freeze(observations);
}

export async function collectCryptoFuturesTemporalEvidenceV1({
  ledger,
  symbols=['BTCUSDT','ETHUSDT'],
  longShortPeriod='1h',
  client=new BitgetPublicClient({minIntervalMs:1100,maxRetries:4,timeoutMs:12_000}),
  now=()=>Date.now(),
}={}){
  let current=ledger;
  const results=[];
  for(const symbol of symbols){
    const collectedAt=now();
    try{
      const [context,longShort]=await Promise.all([
        collectBitgetFuturesContext({client,symbol}),
        collectLongShortRatioHistory({client,symbol,period:longShortPeriod}),
      ]);
      const observations=buildCryptoFuturesTemporalObservationsV1({
        ledger:current,symbol,context,longShortRecords:longShort.records,collectedAt,
      });
      const before=current.observations.length;
      current=appendTemporalEvidenceBatchV1(current,observations);
      results.push(Object.freeze({
        symbol,status:'success',
        observedCount:observations.length,
        appendedCount:current.observations.length-before,
      }));
    }catch(error){
      results.push(Object.freeze({
        symbol,status:'failed',
        error:String(error?.message??error).slice(0,500),
        observedCount:0,appendedCount:0,
      }));
    }
  }
  const failedCount=results.filter(row=>row.status==='failed').length;
  return Object.freeze({
    schemaVersion:'crypto-futures-temporal-public-collection-v1',
    status:failedCount===0?'complete':'partial_failure',
    failedCount,
    results:Object.freeze(results),
    ledger:current,
    safety:Object.freeze({
      publicDataOnly:true,
      privateApi:false,
      liveTrading:false,
      realOrders:false,
      historicalCurrentValueBackfill:false,
      executionAuthority:'NONE',
    }),
  });
}
