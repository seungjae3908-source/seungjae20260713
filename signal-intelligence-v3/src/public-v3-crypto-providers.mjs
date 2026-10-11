// Public research-only crypto provider adapter for Signal V3.
// Stable symbol-index pagination is never injected into the shared
// CryptoSignalScannerService/Paper bundle or ordinary member rankings.
// Quotation endpoints only. No private provider API, orders or credentials.
import {createHash} from 'node:crypto';

const UPBIT='https://api.upbit.com';
const BITGET='https://api.bitget.com';
const TIMEOUT=3500;
const finite=value=>{const n=Number(value);return Number.isFinite(n)?n:null;};
const text=value=>typeof value==='string'?value.trim():'';
const ascii=(a,b)=>a<b?-1:a>b?1:0;
const fail=reason=>{throw new Error('PUBLIC_V3_CRYPTO_'+reason);};

function normalizeCandles(rows, now) {
  const map=new Map();
  for(const row of rows){
    const time=Number(row.time);
    if(!Number.isFinite(time)||time<=0||time>now+60000)continue;
    if(![row.open,row.high,row.low,row.close].every(x=>Number.isFinite(x)&&x>0)
      ||!Number.isFinite(row.volume)||row.volume<0)continue;
    map.set(time,{
      ...row,time,
      high:Math.max(row.high,row.open,row.close),
      low:Math.min(row.low,row.open,row.close),
      quoteVolume:Number.isFinite(row.quoteVolume)&&row.quoteVolume>=0?row.quoteVolume:null,
    });
  }
  return [...map.values()].sort((a,b)=>a.time-b.time);
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
        return normalizeCandles(rows.map(r=>({
          time:finite(r?.timestamp)??Date.parse(text(r?.candle_date_time_utc)),
          open:finite(r?.opening_price)??NaN,high:finite(r?.high_price)??NaN,
          low:finite(r?.low_price)??NaN,close:finite(r?.trade_price)??NaN,
          volume:finite(r?.candle_acc_trade_volume)??NaN,
          quoteVolume:finite(r?.candle_acc_trade_price),
        })),now());
      }
      if(market!=='futures')fail('UNSUPPORTED_MARKET');
      const granularity=timeframe==='60m'?'1H':timeframe;
      if(!['1m','3m','5m','15m','1H','4H','1D'].includes(granularity))fail('UNSUPPORTED_TIMEFRAME');
      const payload=await request(BITGET+'/api/v2/mix/market/candles?symbol='
        +encodeURIComponent(symbol)+'&productType=USDT-FUTURES&granularity='+encodeURIComponent(granularity)+'&limit=200',signal);
      if(text(payload?.code)!=='00000'||!Array.isArray(payload?.data))
        fail('BITGET_'+(text(payload?.code)||'INVALID_CANDLES'));
      return normalizeCandles(payload.data.filter(Array.isArray).map(row=>({
        time:finite(row[0])??NaN,open:finite(row[1])??NaN,high:finite(row[2])??NaN,
        low:finite(row[3])??NaN,close:finite(row[4])??NaN,volume:finite(row[5])??NaN,
        quoteVolume:finite(row[6]),
      })),now());
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
  };
  return Object.freeze(publicProviders);
}
