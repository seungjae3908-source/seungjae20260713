import test from 'node:test';
import assert from 'node:assert/strict';
import { familyReadiness, MARKET_RESEARCH_LANES, calculateMarketSpecializedSignal } from '../src/market-specialized-alpha-families.js';
import { buildV7Candidates, calculateV7Signal } from '../src/v7-vwap-mean-reversion.js';
import { buildV8Candidates, calculateV8Signal } from '../src/v8-opening-range-retest.js';
import { buildV9Candidates, calculateV9Signal } from '../src/v9-relative-strength.js';
import { buildV10Candidates, calculateV10Signal } from '../src/v10-derivatives-positioning.js';

function candle(timestamp, close, {open=close, high=close, low=close, volume=100, sessionDate, sessionMinute}={}) {
  return {timestamp, open, high, low, close, volume, ...(sessionDate!==undefined?{sessionDate}:{}), ...(sessionMinute!==undefined?{sessionMinute}:{})};
}

test('10 research lanes preserve market/style/direction separation without performance assumptions', () => {
  assert.equal(Object.keys(MARKET_RESEARCH_LANES).length,10);
  assert.deepEqual(MARKET_RESEARCH_LANES.KR_STOCK_SCALPING.candidateFamilies.includes('V8'),true);
  assert.deepEqual(MARKET_RESEARCH_LANES.US_STOCK_SWING.candidateFamilies.includes('V9'),true);
  assert.deepEqual(MARKET_RESEARCH_LANES.CRYPTO_SPOT_SCALPING.direction,'LONG');
  assert.deepEqual(MARKET_RESEARCH_LANES.BINANCE_FUTURES_SCALPING_SHORT.direction,'SHORT');
  assert.deepEqual(MARKET_RESEARCH_LANES.BINANCE_FUTURES_SCALPING_SHORT.candidateFamilies.includes('V10'),true);
});

test('specialized signal dispatcher is explicit and fail closed for unknown versions', () => {
  assert.throws(() => calculateMarketSpecializedSignal({version:'V11'}),/unsupported market-specialized version/);
});

test('bounded candidate grids stay within research budget', () => {
  assert.equal(buildV7Candidates().length, 36);
  assert.equal(buildV8Candidates().length, 48);
  assert.equal(buildV9Candidates().length, 24);
  assert.equal(buildV10Candidates().length, 48);
});

test('V7 long mean reversion requires prior stretch then reclaim and blocks high RVOL', () => {
  const candles=[];
  for(let i=0;i<25;i++) candles.push(candle(i,100,{open:100,high:101,low:99,volume:100}));
  candles[23]=candle(23,96,{open:98,high:98,low:95,volume:100});
  candles[24]=candle(24,99,{open:97,high:100,low:97,volume:100});
  const atr=new Array(25).fill(2);
  const signal=calculateV7Signal({market:'CRYPTO_SPOT',side:'long',candles,atr,index:24,filter:{vwapLookback:20,stretchAtr:1.5,reclaimAtr:0.5,maxEntryRvol:2.5}});
  assert.ok(signal);
  assert.equal(signal.family,'V7_VWAP_MEAN_REVERSION');
  candles[24]={...candles[24],volume:1000};
  assert.equal(calculateV7Signal({market:'CRYPTO_SPOT',side:'long',candles,atr,index:24,filter:{vwapLookback:20,stretchAtr:1.5,reclaimAtr:0.5,maxEntryRvol:2.5}}),null);
});

test('V7 cash short is fail closed', () => {
  assert.equal(calculateV7Signal({market:'US_STOCK',side:'short',candles:[],atr:[],index:0,filter:{vwapLookback:20,stretchAtr:1,reclaimAtr:.25,maxEntryRvol:2}}),null);
});

test('V8 uses provider session metadata and does not mix sessions', () => {
  const rows=[]; const atr=[];
  for(let i=0;i<6;i++){ rows.push(candle(i,100,{open:100,high:101,low:99,volume:100,sessionDate:'2026-08-11',sessionMinute:i*15})); atr.push(1); }
  rows.push(candle(10,100,{open:100,high:101,low:99,volume:100,sessionDate:'2026-08-12',sessionMinute:0})); atr.push(1);
  rows.push(candle(11,100.5,{open:100,high:102,low:99.5,volume:100,sessionDate:'2026-08-12',sessionMinute:15})); atr.push(1);
  rows.push(candle(12,102.2,{open:101,high:102.5,low:100.8,volume:160,sessionDate:'2026-08-12',sessionMinute:30})); atr.push(1);
  rows.push(candle(13,102.25,{open:101.8,high:102.6,low:101.7,volume:160,sessionDate:'2026-08-12',sessionMinute:45})); atr.push(1);
  const signal=calculateV8Signal({market:'US_STOCK',side:'long',candles:rows,atr,index:9,filter:{openingRangeMinutes:30,breakoutRecencyBars:1,breakoutBufferAtr:0,retestToleranceAtr:.5,minRvol:1}});
  assert.ok(signal);
  assert.equal(signal.openingRangeHigh,102);
  const bad={...rows[9]}; delete bad.sessionMinute; const badRows=[...rows]; badRows[9]=bad;
  assert.equal(calculateV8Signal({market:'US_STOCK',side:'long',candles:badRows,atr,index:9,filter:{openingRangeMinutes:30,breakoutRecencyBars:1,breakoutBufferAtr:0,retestToleranceAtr:.5,minRvol:1}}),null);
});

test('V9 requires exact benchmark timestamps and relative strength threshold', () => {
  const asset=[]; const bench=[];
  for(let i=0;i<=40;i++){
    asset.push(candle(i,100*(1+i*0.003)));
    bench.push(candle(i,100*(1+i*0.001)));
  }
  const signal=calculateV9Signal({market:'US_STOCK',side:'long',candles:asset,index:40,benchmarkCandles:bench,filter:{lookbackBars:20,minRelativeReturn:.02,minAssetReturn:-.02,requireAcceleration:false}});
  assert.ok(signal);
  const missing=bench.filter(x=>x.timestamp!==40);
  assert.equal(calculateV9Signal({market:'US_STOCK',side:'long',candles:asset,index:40,benchmarkCandles:missing,filter:{lookbackBars:20,minRelativeReturn:.02,minAssetReturn:-.02,requireAcceleration:false}}),null);
});

test('V10 requires same-venue point-in-time OI funding basis and supports long/short', () => {
  const candles=[];
  for(let i=0;i<=12;i++) candles.push(candle(i*1000,100+i));
  const derivatives={
    priceVenue:'BINANCE_USDM',
    openInterest:{venue:'BINANCE_USDM',rows:[{timestamp:0,openInterest:100},{timestamp:4000,openInterest:101},{timestamp:12000,openInterest:105}]},
    funding:{venue:'BINANCE_USDM',rows:[{timestamp:0,rate:.0002},{timestamp:12000,rate:.0003},{timestamp:13000,rate:.9}]},
    basis:{venue:'BINANCE_USDM',rows:[{timestamp:0,basis:.002},{timestamp:12000,basis:.003}]},
    maxStalenessMs:{openInterest:12000,funding:12000,basis:12000},
  };
  const filter={lookbackBars:4,minOiChange:.01,minDirectionalReturn:.005,maxAbsFunding:.001,maxAbsBasis:.01};
  const signal=calculateV10Signal({market:'CRYPTO_FUTURES',side:'long',candles,index:12,derivatives,filter});
  assert.ok(signal);
  assert.equal(signal.contextTimestamps.funding,12000);
  const crossVenue={...derivatives,basis:{...derivatives.basis,venue:'BITGET_USDT'}};
  assert.equal(calculateV10Signal({market:'CRYPTO_FUTURES',side:'long',candles,index:12,derivatives:crossVenue,filter}),null);
  const stale={...derivatives,funding:{venue:'BINANCE_USDM',rows:[{timestamp:0,rate:.0002}]},maxStalenessMs:{...derivatives.maxStalenessMs,funding:1000}};
  assert.equal(calculateV10Signal({market:'CRYPTO_FUTURES',side:'long',candles,index:12,derivatives:stale,filter}),null);
  const down=candles.map((x,i)=>({...x,close:120-i,open:120-i,high:120-i,low:120-i}));
  assert.ok(calculateV10Signal({market:'CRYPTO_FUTURES',side:'short',candles:down,index:12,derivatives,filter}));
});

test('readiness is fail-closed for missing specialized data', () => {
  const v7=familyReadiness({version:'V7',market:'CRYPTO_SPOT',side:'long',timeframe:'1d'});
  assert.equal(v7.ready,false);
  const v8=familyReadiness({version:'V8',market:'US_STOCK',side:'long',timeframe:'15m',sampleCandle:{}});
  assert.equal(v8.ready,false);
  const v9=familyReadiness({version:'V9',market:'CRYPTO_SPOT',side:'long',timeframe:'1d',benchmarkCandles:[]});
  assert.equal(v9.ready,false);
  const v10=familyReadiness({version:'V10',market:'CRYPTO_FUTURES',side:'long',timeframe:'15m',derivatives:null});
  assert.equal(v10.ready,false);
});
