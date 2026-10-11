import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPublicStockCandleSource } from '../src/public-stock-candle-binding.mjs';

const at=Date.parse('2026-10-11T05:00:00.000Z');
test('Signal V3 public binding covers the actual stock-scanner metadata path',async()=>{
  const oldCandles=async()=>{throw Error('UNEXPECTED_APP_FALLBACK_CANDLES');};
  const oldMeta=async()=>{throw Error('UNEXPECTED_APP_FALLBACK_META');};
  const service={getCandles:oldCandles,getCandlesMeta:oldMeta};
  const requests=[];
  const publicFetch=async (ticker,frame)=>{
    requests.push([ticker,frame]);
    return [{time:new Date(at-60_000).toISOString(),open:9,high:11,low:8,close:10,volume:100}];
  };
  const restore=bindPublicStockCandleSource(service,publicFetch,{now:()=>at});
  const meta=await service.getCandlesMeta('005930','15m');
  assert.equal(meta.provider,'yahoo-public');
  assert.equal(meta.fetchedAt,new Date(at).toISOString());
  assert.equal(meta.candles[0].close,10);
  assert.equal((await service.getCandles('AAPL','60m'))[0].close,10);
  assert.deepEqual(requests,[['005930','15m'],['AAPL','60m']]);
  restore();restore();
  assert.equal(service.getCandles,oldCandles);
  assert.equal(service.getCandlesMeta,oldMeta);
});

test('public source failure or empty bars never fall back into app metadata',async()=>{
  let unsafeCalls=0;
  const oldCandles=async()=>{unsafeCalls++;return [];};
  const oldMeta=async()=>{unsafeCalls++;return {candles:[]};};
  const service={getCandles:oldCandles,getCandlesMeta:oldMeta};
  const restore=bindPublicStockCandleSource(service,async ticker=>{
    if(ticker==='FAIL')throw Error('PUBLIC_SOURCE_UNAVAILABLE');
    return [];
  },{now:()=>at});
  assert.deepEqual((await service.getCandlesMeta('EMPTY','15m')).candles,[]);
  await assert.rejects(service.getCandlesMeta('FAIL','15m'),/PUBLIC_SOURCE_UNAVAILABLE/);
  assert.equal(unsafeCalls,0);
  restore();
  assert.equal(service.getCandles,oldCandles);
  assert.equal(service.getCandlesMeta,oldMeta);
});

test('binding rejects malformed providers without leaving a partial override',()=>{
  const getCandles=async()=>[],service={getCandles,getCandlesMeta:async()=>({candles:[]})};
  assert.throws(()=>bindPublicStockCandleSource(service,null),/PUBLIC_STOCK_BINDING_INVALID/);
  assert.equal(service.getCandles,getCandles);
});
