import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeV3UpbitCandles} from '../src/public-v3-upbit-candles.mjs';
const M=60000,T=Date.parse('2026-10-12T03:00:00Z');
function row(ms,x={}){return {market:'KRW-BTC',
  candle_date_time_utc:new Date(ms).toISOString().slice(0,19),
  timestamp:ms+14*M+59000,opening_price:100,high_price:110,
  low_price:90,trade_price:105,candle_acc_trade_volume:5,
  candle_acc_trade_price:525,...x};}
const read=(rows,nowMs=T+46*M,timeframe='15m')=>
  normalizeV3UpbitCandles(rows,{symbol:'BTC',timeframe,nowMs});
test('UTC candle opening is not Upbit last-trade timestamp',()=>{
  const bars=read([row(T+30*M),row(T),row(T+15*M)]);
  assert.deepEqual(bars.map(x=>x.time),[T,T+15*M,T+30*M]);
  assert.notEqual(bars[0].time,row(T).timestamp);
  assert.ok(bars.every(x=>x.high===110&&x.low===90&&x.quoteVolume===525));
});
test('exclude forming bars without inventing no-trade intervals',()=>{
  assert.deepEqual(read([row(T+45*M),row(T),row(T+30*M)]).map(x=>x.time),[T,T+30*M]);
});
test('daily UTC midnight candle is not last tick or KST conversion',()=>{
  const d=Date.parse('2026-10-11T00:00:00Z');
  assert.equal(read([row(d)],d+24*60*M,'1D')[0].time,d);
});
test('wrong price bounds and negative volume are rejected, never auto repaired',()=>{
  for(const v of [{high_price:99},{low_price:106},{opening_price:0},
    {high_price:NaN},{candle_acc_trade_volume:-1},{candle_acc_trade_price:-1}])
    assert.throws(()=>read([row(T,v)]),/INVALID_OHLC/);
});
test('wrong market, duplicate, missing UTC, misalignment and future are rejected',()=>{
  assert.throws(()=>read([row(T,{market:'KRW-ETH'})]),/INVALID_IDENTITY/);
  assert.throws(()=>read([row(T,{candle_date_time_utc:null})]),/INVALID_IDENTITY/);
  assert.throws(()=>read([row(T),row(T)]),/INVALID_CANDLE_TIME/);
  assert.throws(()=>read([row(T+M)]),/INVALID_CANDLE_TIME/);
  assert.throws(()=>read([row(T+60*M)]),/INVALID_CANDLE_TIME/);
  assert.throws(()=>read([row(T,{candle_date_time_utc:'2026-02-30T00:00:00'})]),/INVALID_CANDLE_TIME/);
  assert.throws(()=>read([row(T)],T+46*M,'2H'),/INVALID_INPUT/);
});
