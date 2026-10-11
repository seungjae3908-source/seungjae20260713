// Public research-only crypto provider adapter for Signal V3.
// Stable symbol-index pagination is never injected into the shared
// CryptoSignalScannerService/Paper bundle or ordinary member rankings.
// Quotation endpoints only. No private provider API, orders or credentials.
import {createHash} from 'node:crypto';

const UPBIT='https://api.upbit.com';
const BITGET='https://api.bitget.com';
const TIMEOUT=3500;
const finite=value=>{const n=Number(value);return Number.isFinite(n)?n:null;};
// Number(null) and Number('') are 0, not exchange-supplied OHLCV.
const requiredNumber=value=>value==null || value===''?NaN:Number(value);
const text=value=>typeof value==='string'?value.trim():'';
const ascii=(a,b)=>a<b?-1:a>b?1:0;
const fail=reason=>{throw new Error('PUBLIC_V3_CRYPTO_'+reason);};

// Each exchange candle is identified by its OPEN time, not its last trade.
// Do not "repair" an inconsistent high/low with Math.max()/Math.min():
// exclude the entire untrusted series so CryptoSignalScannerService reports
// INVALID_DATA rather than creating a synthetic trade candidate.
const TF_MS=Object.freeze({
  '1m':60000,'3m':180000,'5m':300000,'15m':900000,
  '60m':3600000,'4H':14400000,'1D':86400000,
});
export function upbitPublicCandleUtcStart(raw) {
  if(typeof raw!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/u.test(raw))
    return Number.NaN;
  const at=Date.parse(raw+'Z');
  return Number.isFinite(at)&&new Date(at).toISOString().slice(0,19)===raw?at:Number.NaN;
}
export function normalizePublicV3Candles(rows,now,timeframe) {
  const duration=TF_MS[timeframe];
  if(!Array.isArray(rows)||!Number.isFinite(now)||now<=0||!duration)
    fail('CANDLE_SERIES_INPUT_INVALID');
  const issues={
    malformedSourceBars:0,invalidOhlcBars:0,
    conflictingDuplicateBars:0,equivalentDuplicateBars:0,
    incompleteCurrentBarsExcluded:0,
  };
  const output=new Map();
  for(const row of rows){
    const time=row?.time;
    if(!Number.isSafeInteger(time)||time<=0||time>now+60000){
      issues.malformedSourceBars++;
      continue;
    }
    const open=row?.open,high=row?.high,low=row?.low,close=row?.close,volume=row?.volume;
    if(![open,high,low,close,volume].every(Number.isFinite)
       ||open<=0||high<=0||low<=0||close<=0||volume<0
       ||high<Math.max(open,low,close)||low>Math.min(open,high,close)
       ||(row?.quoteVolume!=null &&
         (!Number.isFinite(row.quoteVolume)||row.quoteVolume<0))){
      issues.invalidOhlcBars++;
      continue;
    }
    // Do not use an unclosed interval to claim a finished indicator.
    if(time+duration>now){
      issues.incompleteCurrentBarsExcluded++;
      continue;
    }
    const cleaned={
      time,open,high,low,close,volume,
      quoteVolume:row?.quoteVolume==null?null:row.quoteVolume,
    };
    const before=output.get(time);
    if(before){
      if(['open','high','low','close','volume','quoteVolume']
        .every(key=>before[key]===cleaned[key]))
        issues.equivalentDuplicateBars++;
      else issues.conflictingDuplicateBars++;
      continue;
    }
    output.set(time,cleaned);
  }
  const invalid=issues.malformedSourceBars+issues.invalidOhlcBars+issues.conflictingDuplicateBars>0;
  return Object.freeze({
    candles:invalid?Object.freeze([]):
      Object.freeze([...output.values()].sort((a,b)=>a.time-b.time).map(row=>Object.freeze(row))),
    rejectedSourceSeries:invalid,
    sourceInputBars:rows.length,
    ...issues,
    // A valid series can still lack sufficient historical depth; the
    // canonical scanner decides its own minimum bar count and data quality.
    fullUniverseVerified:false,
    tradeAuthority:'NONE',
  });
}
function candlePath(symbol,timeframe) {
  const market=encodeURIComponent('KRW-'+symbol);
  if(timeframe==='1D')return '/v1/candles/days?market='+market+'&count=200';
  const minutes={ '1m':1,'3m':3,'5m':5,'15m':15,'60m':60,'4H':240 }[timeframe];
  if(!minutes)fail('UNSUPPORTED_TIMEFRAME');
  return '/v1/candles/minutes/'+minutes+'?market='+market+'&count=200';
}

export function createPublicV3CryptoProviders({fetchImpl=(...args)=>globalThis.fetch(...args),now=Date.now}={}){
  if(typeof fetchImpl!=='function'||typeof now!=='function')fail('PROVIDER_INPUT_INVALID');
  const digests=new Map();
  const candleQuality=new Map();
  const emptyQuality=()=>({
    observedSeries:0,rejectedSourceSeries:0,emptyAfterClosed:0,
    malformedSourceBars:0,invalidOhlcBars:0,conflictingDuplicateBars:0,
    equivalentDuplicateBars:0,incompleteCurrentBarsExcluded:0,
  });
  const recordQuality=(market,observed)=>{
    const state=candleQuality.get(market)??emptyQuality();
    state.observedSeries++;
    if(observed.rejectedSourceSeries)state.rejectedSourceSeries++;
    if(observed.candles.length===0)state.emptyAfterClosed++;
    for(const key of ['malformedSourceBars','invalidOhlcBars',
      'conflictingDuplicateBars','equivalentDuplicateBars','incompleteCurrentBarsExcluded'])
      state[key]+=observed[key];
    candleQuality.set(market,state);
    return observed.candles;
  };
  async function request(url,signal,limitMs=TIMEOUT){
    const parsed=new URL(url);
    if(parsed.protocol!=='https:' || parsed.username||parsed.password||parsed.hash
      || !['api.upbit.com','api.bitget.com'].includes(parsed.hostname)
      || (parsed.hostname==='api.upbit.com' && !/^\/v1\/(?:market\/all|ticker|candles\/(?:days|minutes\/(?:1|3|5|15|60|240))|orderbook)$/u.test(parsed.pathname))
      || (parsed.hostname==='api.bitget.com' && !/^\/api\/v2\/mix\/market\/(?:tickers|candles)$/u.test(parsed.pathname)))
      fail('UNSAFE_ENDPOINT');
    const controller=new AbortController();
    const onAbort=()=>controller.abort(signal?.reason ?? new Error('PUBLIC_V3_ABORTED'));
    if(signal?.aborted)onAbort();else signal?.addEventListener('abort',onAbort,{once:true});
    const timer=setTimeout(()=>controller.abort(new Error('PUBLIC_V3_HTTP_TIMEOUT')),limitMs);
    try{
      if(controller.signal.aborted)throw controller.signal.reason;
      const response=await fetchImpl(url,{
        signal:controller.signal,
        headers:{Accept:'application/json','User-Agent':'signal-v3-public-only/1.0'},
      });
      if(!response.ok)throw new Error('HTTP_'+response.status);
      return await response.json();
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
  }
  function stableRows(market,rows,source,providerErrorCount=0){
    const normalized=[...rows].sort((a,b)=>ascii(a.symbol,b.symbol));
    const symbols=normalized.map(x=>String(x.symbol??'').trim().toUpperCase());
    if(!symbols.length||symbols.some(x=>!x)||new Set(symbols).size!==symbols.length)
      fail('ROSTER_DUPLICATE_OR_EMPTY');
    const digest=createHash('sha256').update(JSON.stringify([market,source,...symbols])).digest('hex');
    digests.set(market,digest);
    return {rows:normalized,source,providerErrorCount};
  }
  async function spotUniverse(signal){
    const marketRows=await request(UPBIT+'/v1/market/all?isDetails=true',signal,8000);
    if(!Array.isArray(marketRows))fail('UPBIT_MARKET_MALFORMED');
    const listed=marketRows.map(x=>({
      market:text(x?.market),name:text(x?.korean_name),
      warning:text(x?.market_warning||'NONE')!=='NONE',
    })).filter(x=>/^KRW-[A-Z0-9-]+$/u.test(x.market))
      .map(x=>({...x,symbol:x.market.slice(4)}));
    if(!listed.length)fail('UPBIT_MARKET_EMPTY');
    const names=new Map(listed.map(x=>[x.market,x]));
    const fetched=[];let providerErrors=0;
    for(let i=0;i<listed.length;i+=100){
      const batch=listed.slice(i,i+100);
      try{
        const tickers=await request(UPBIT+'/v1/ticker?markets='+encodeURIComponent(batch.map(x=>x.market).join(',')),signal,8000);
        if(!Array.isArray(tickers))fail('UPBIT_TICKERS_MALFORMED');
        fetched.push(...tickers);
      }catch(error){if(signal?.aborted)throw error;providerErrors++;}
    }
    const collected=new Map();
    for(const raw of fetched){
      const identity=text(raw?.market),entry=names.get(identity);
      const price=finite(raw?.trade_price);
      if(!entry||price===null||price<=0)continue;
      collected.set(entry.symbol,{
        symbol:entry.symbol,name:entry.name||entry.symbol,price,
        changePercent:(finite(raw.signed_change_rate)??0)*100,
        volume:finite(raw.acc_trade_volume_24h)??0,
        tradingValue:finite(raw.acc_trade_price_24h)??0,
        bid:null,ask:null,fundingRate:null,openInterest:null,
        timestamp:finite(raw.timestamp),warning:entry.warning,
      });
    }
    if(collected.size!==listed.length)providerErrors++;
    return stableRows('spot',[...collected.values()],'upbit-public',providerErrors);
  }
  async function futuresUniverse(signal){
    const payload=await request(BITGET+'/api/v2/mix/market/tickers?productType=USDT-FUTURES',signal,8000);
    if(text(payload?.code)!=='00000'||!Array.isArray(payload?.data))
      fail('BITGET_'+(text(payload?.code)||'INVALID'));
    const newest=new Map();
    for(const raw of payload.data){
      const symbol=text(raw?.symbol).toUpperCase();
      const price=finite(raw?.markPrice??raw?.lastPr);
      if(!symbol||price===null||price<=0)continue;
      const timestamp=finite(raw.ts);
      const row={
        symbol,name:symbol,price,changePercent:(finite(raw.change24h)??0)*100,
        volume:finite(raw.baseVolume)??0,tradingValue:finite(raw.usdtVolume)??0,
        bid:finite(raw.bidPr),ask:finite(raw.askPr),
        fundingRate:finite(raw.fundingRate),openInterest:finite(raw.holdingAmount),
        timestamp,warning:false,
      };
      if(!newest.has(symbol)||(timestamp??0)>=(newest.get(symbol).timestamp??0))newest.set(symbol,row);
    }
    const incomplete=newest.size!==payload.data.length;
    return stableRows('futures',[...newest.values()],'bitget-public',incomplete?1:0);
  }
  const publicProviders={
    getUniverse:(market,signal)=>market==='spot'?spotUniverse(signal):market==='futures'?futuresUniverse(signal):fail('UNSUPPORTED_MARKET'),
    async getCandles(market,symbol,timeframe,signal){
      if(market==='spot'){
        const rows=await request(UPBIT+candlePath(symbol,timeframe),signal);
        if(!Array.isArray(rows))fail('UPBIT_CANDLES_MALFORMED');
        // Upbit timestamp=LAST TICK, while candle_date_time_utc=OPEN.
        // The latter is the only correct indicator/candle key.
        const observed=normalizePublicV3Candles(rows.map(r=>({
          time:upbitPublicCandleUtcStart(r?.candle_date_time_utc),
          open:requiredNumber(r?.opening_price),high:requiredNumber(r?.high_price),
          low:requiredNumber(r?.low_price),close:requiredNumber(r?.trade_price),
          volume:requiredNumber(r?.candle_acc_trade_volume),
          quoteVolume:r?.candle_acc_trade_price==null?null:requiredNumber(r.candle_acc_trade_price),
        })),now(),timeframe);
        return recordQuality('spot',observed);
      }
      if(market!=='futures')fail('UNSUPPORTED_MARKET');
      const granularity=timeframe==='60m'?'1H':timeframe;
      if(!['1m','3m','5m','15m','1H','4H','1D'].includes(granularity))fail('UNSUPPORTED_TIMEFRAME');
      const payload=await request(BITGET+'/api/v2/mix/market/candles?symbol='
        +encodeURIComponent(symbol)+'&productType=USDT-FUTURES&granularity='+encodeURIComponent(granularity)+'&limit=200',signal);
      if(text(payload?.code)!=='00000'||!Array.isArray(payload?.data))
        fail('BITGET_'+(text(payload?.code)||'INVALID_CANDLES'));
      // Do not silently discard malformed Bitget response entries.
      const observed=normalizePublicV3Candles(payload.data.map(row=>({
        time:requiredNumber(row?.[0]),open:requiredNumber(row?.[1]),
        high:requiredNumber(row?.[2]),low:requiredNumber(row?.[3]),
        close:requiredNumber(row?.[4]),volume:requiredNumber(row?.[5]),
        quoteVolume:row?.[6]==null?null:requiredNumber(row[6]),
      })),now(),timeframe);
      return recordQuality('futures',observed);
    },
    async getSpread(market,ticker,signal){
      if(market==='futures')return {bid:ticker.bid,ask:ticker.ask};
      if(market!=='spot')fail('UNSUPPORTED_MARKET');
      const rows=await request(UPBIT+'/v1/orderbook?markets='+encodeURIComponent('KRW-'+ticker.symbol)+'&level=0',signal);
      if(!Array.isArray(rows))fail('UPBIT_ORDERBOOK_MALFORMED');
      const unit=rows[0]?.orderbook_units?.[0];
      return {bid:finite(unit?.bid_price),ask:finite(unit?.ask_price)};
    },
    now,
    readLastRosterDigest:market=>digests.get(market)??null,
    clearLastRosterDigest:market=>digests.delete(market),
    resetCandleQuality:market=>candleQuality.set(market,emptyQuality()),
    readCandleQuality:market=>Object.freeze({
      schemaVersion:'public-v3-crypto-candle-quality-v1',
      ...(candleQuality.get(market)??emptyQuality()),
      market,sourceOnly:true,fullMarketVerified:false,
      tradeAuthority:'NONE',
    }),
  };
  return Object.freeze(publicProviders);
}
