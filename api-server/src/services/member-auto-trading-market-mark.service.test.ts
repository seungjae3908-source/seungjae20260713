import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberAutoTradingMarketMarkReader } from './member-auto-trading-market-mark.service';

const NOW=new Date('2026-10-02T03:00:00.000Z');

test('market mark reader keeps all four lanes fresh and public-only', async () => {
  const reader=createMemberAutoTradingMarketMarkReader({
    now:()=>NOW,
    stockQuoteReader:async(symbol)=>({price:symbol==='005930'?70000:200,updatedAt:new Date(NOW.getTime()-1_000).toISOString(),source:'stock-public'}),
    fetchImpl:async()=>new Response(JSON.stringify([{trade_price:100000000,timestamp:NOW.getTime()-1_000}]),{status:200,headers:{'content-type':'application/json'}}),
    futuresSnapshotReader:async()=>({price:101,markPrice:100,updatedAt:new Date(NOW.getTime()-1_000).toISOString(),source:'bitget-public-v2',isDelayed:false}),
  });
  assert.equal((await reader('KR_STOCK','005930')).price,70000);
  assert.equal((await reader('US_STOCK','AAPL')).source,'stock-public');
  assert.equal((await reader('CRYPTO_SPOT','BTC')).price,100000000);
  assert.equal((await reader('CRYPTO_FUTURES','BTCUSDT')).price,100);
});

test('stale mark fails closed', async () => {
  const reader=createMemberAutoTradingMarketMarkReader({
    now:()=>NOW,
    stockQuoteReader:async()=>({price:100,updatedAt:new Date(NOW.getTime()-120_000).toISOString()}),
  });
  await assert.rejects(()=>reader('KR_STOCK','005930'),/BACKGROUND_EXIT_MARK_STALE/);
});
