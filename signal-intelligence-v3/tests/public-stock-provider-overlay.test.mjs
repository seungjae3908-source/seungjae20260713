import test from 'node:test';
import assert from 'node:assert/strict';
import {withReadOnlyStockProviderOverlay} from '../src/public-stock-provider-overlay.mjs';

function fixture() {
  const data = {
    getCandles: async()=>{throw Error('PRIVATE_FALLBACK_FORBIDDEN');},
    getCandlesMeta: async()=>{throw Error('PRIVATE_META_FALLBACK_FORBIDDEN');},
    getQuote: async()=>{throw Error('PRIVATE_QUOTE_FALLBACK_FORBIDDEN');},
  };
  const universe = {get: async(market)=>({source:'original',market})};
  const original = {...data,universeGet:universe.get};
  const target = {entries:[{ticker:'A',name:'Alpha'}],totalCount:1,source:'nasdaq-trader-public-directory'};
  const events = [];
  const props = {
    marketData:data,scannerUniverse:universe,scannerMarket:'US',targetUniverse:target,
    readPublicCandles:async(ticker,tf,entry)=>{
      events.push(['candles',ticker,tf,entry?.name]);
      return [{time:'2026-10-09T13:30:00Z',open:1,high:2,low:1,close:2,volume:3}];
    },
    readPublicQuote:async(ticker,entry)=>{
      events.push(['quote',ticker,entry?.name]);
      return {price:2};
    },
  };
  return {data,universe,original,target,events,props};
}

test('public-only overlay intercepts both meta and raw candles and restores exact original provider methods',async()=>{
  const f=fixture();
  await withReadOnlyStockProviderOverlay({...f.props,operation:async()=>{
    const meta=await f.data.getCandlesMeta('a','4H');
    assert.equal(meta.provider,'yahoo-public');
    assert.equal(meta.candles.length,1);
    const candles=await f.data.getCandles('A','5m');
    assert.equal(candles.length,1);
    const quote=await f.data.getQuote('A');
    assert.deepEqual({symbol:quote.symbol,ticker:quote.ticker,name:quote.name,price:quote.price},
      {symbol:'A',ticker:'A',name:'Alpha',price:2});
    assert.equal(await f.universe.get('US'),f.target);
    assert.deepEqual(await f.universe.get('KR'),{source:'original',market:'KR'});
    await assert.rejects(withReadOnlyStockProviderOverlay({...f.props,operation:async()=>{}}),/OVERLAY_CONCURRENT/);
  }});
  assert.equal(f.data.getCandles,f.original.getCandles);
  assert.equal(f.data.getCandlesMeta,f.original.getCandlesMeta);
  assert.equal(f.data.getQuote,f.original.getQuote);
  assert.equal(f.universe.get,f.original.universeGet);
  assert.deepEqual(f.events,[
    ['candles','A','4H','Alpha'],['candles','A','5m','Alpha'],['quote','A','Alpha'],
  ]);
});

test('source failure cannot fall through to app/private provider and always restores methods',async()=>{
  const f=fixture();
  await assert.rejects(
    withReadOnlyStockProviderOverlay({...f.props,
      readPublicCandles:async()=>{throw Error('YAHOO_PROVIDER_MISSING');},
      operation:async()=>await f.data.getCandlesMeta('A','4H'),
    }),
    /YAHOO_PROVIDER_MISSING/,
  );
  assert.equal(f.data.getCandlesMeta,f.original.getCandlesMeta);
  await assert.rejects(
    withReadOnlyStockProviderOverlay({...f.props,
      readPublicQuote:async()=>null,
      operation:async()=>await f.data.getQuote('A'),
    }),/PUBLIC_STOCK_QUOTE_INVALID/,
  );
  assert.equal(f.data.getQuote,f.original.getQuote);
});

test('malformed public data cannot be passed as an apparently valid candle list',async()=>{
  const f=fixture();
  await assert.rejects(
    withReadOnlyStockProviderOverlay({...f.props,
      readPublicCandles:async()=>null,
      operation:async()=>await f.data.getCandlesMeta('A','4H'),
    }),/PUBLIC_STOCK_CANDLES_INVALID/,
  );
});

test('read-only Naver historical dayCandle can supply explicit provenance without altering Yahoo default or member scanners',async()=>{
 const f=fixture();
 const result=await withReadOnlyStockProviderOverlay({...f.props,
   readPublicCandles:async()=>({
     candles:[{time:'2026-10-09T06:30:00.000Z',open:10,high:11,low:9,close:10.5,volume:100}],
     provider:'naver-public-dayCandle',
   }),
   operation:async()=>f.data.getCandlesMeta('A','1D'),
 });
 assert.equal(result.provider,'naver-public-dayCandle');
 assert.equal(result.candles.length,1);
 assert.equal(f.data.getCandlesMeta,f.original.getCandlesMeta);
 await assert.rejects(withReadOnlyStockProviderOverlay({...f.props,
   readPublicCandles:async()=>({candles:[],provider:'secret-account'}),
   operation:async()=>f.data.getCandlesMeta('A','1D'),
 }),/PUBLIC_STOCK_CANDLES_INVALID/);
});
