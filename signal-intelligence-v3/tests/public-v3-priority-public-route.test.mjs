import test from 'node:test';
import assert from 'node:assert/strict';
import {validV3PublicPriorityRequest as valid}
 from '../src/public-v3-priority-public-route.mjs';
test('Stage-2 research only admits bounded public quotation GETs',()=>{
 for(const link of [
  'https://api.upbit.com/v1/market/all?isDetails=true',
  'https://api.upbit.com/v1/ticker?markets=KRW-BTC',
  'https://api.upbit.com/v1/candles/minutes/15?market=KRW-BTC&count=200',
  'https://api.upbit.com/v1/candles/days?market=KRW-BTC&count=200',
  'https://api.upbit.com/v1/orderbook?markets=KRW-BTC&level=0',
 ])assert.equal(valid(link,'spot'),true,link);
 for(const link of [
  'https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES',
  'https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=15m&limit=200',
 ])assert.equal(valid(link,'futures'),true,link);
});
test('Stage-2 fails closed for private orders, credentials and unexpected endpoints',()=>{
 for(const [link,market] of [
  ['https://api.upbit.com/v1/orders?market=KRW-BTC','spot'],
  ['https://api.upbit.com/v1/accounts?market=KRW-BTC','spot'],
  ['https://api.bitget.com/api/v2/mix/order/place-order?symbol=BTCUSDT','futures'],
  ['http://api.upbit.com/v1/ticker?markets=KRW-BTC','spot'],
  ['https://user:pass@api.upbit.com/v1/ticker?markets=KRW-BTC','spot'],
  ['https://api.upbit.com/v1/ticker?markets=KRW-BTC&api_key=secret','spot'],
  ['https://api.upbit.com/v1/ticker?markets=KRW-BTC&markets=KRW-ETH','spot'],
  ['https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES#admin','futures'],
  ['https://api.upbit.example/v1/ticker?markets=KRW-BTC','spot'],
 ])assert.equal(valid(link,market),false,link);
 assert.equal(valid('https://api.upbit.com/v1/ticker?markets=KRW-BTC','spot','POST'),false);
});
