import test from 'node:test';
import assert from 'node:assert/strict';
import {
 shouldProbeV3StockGap,MAX_V3_LOWER_BAR_PROBES_PER_LANE,
} from '../src/public-stock-gap-probe-policy.mjs';
test('V3 Yahoo lower-bar recovery is OFF by default after 28 unsuccessful probes',()=>{
  for(const market of ['US_STOCK','KR_STOCK']){
    for(const timeframe of ['15m','60m'])
      assert.equal(shouldProbeV3StockGap({market,timeframe,hasBlockingGap:true}),false);
  }
});
test('explicit V3-only opt-in is bounded and never touches member/Paper',()=>{
  assert.equal(MAX_V3_LOWER_BAR_PROBES_PER_LANE,2);
  for(const n of [0,1]){
    assert.equal(shouldProbeV3StockGap({
      enabled:true,market:'US_STOCK',timeframe:'15m',
      hasBlockingGap:true,attempted:n,
    }),true);
  }
  for(const n of [2,3,999]){
    assert.equal(shouldProbeV3StockGap({
      enabled:true,market:'US_STOCK',timeframe:'60m',
      hasBlockingGap:true,attempted:n,
    }),false);
  }
  for(const market of ['KR_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES']){
    assert.equal(shouldProbeV3StockGap({
      enabled:true,market,timeframe:'15m',hasBlockingGap:true,attempted:0,
    }),false);
  }
  assert.equal(shouldProbeV3StockGap({enabled:true,market:'US_STOCK',
    timeframe:'1D',hasBlockingGap:true,attempted:0}),false);
  assert.equal(shouldProbeV3StockGap({enabled:true,market:'US_STOCK',
    timeframe:'15m',hasBlockingGap:false,attempted:0}),false);
  assert.equal(shouldProbeV3StockGap({enabled:true,market:'US_STOCK',
    timeframe:'15m',hasBlockingGap:true,attempted:-1}),false);
});
