import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDirectionAwareScannerQualityIndex,
  projectQualityIndexToCurrentSymbolMap,
} from '../src/scanner-quality-index.mjs';

function packet({symbol='BTCUSDT',direction='LONG',market='CRYPTO_FUTURES'}={}){
  return {
    status:'VERIFIED_QUALITY_PACKET',
    identity:{
      market,symbol,timeframe:'60m',direction,
      strategyProfileId:`${market}_SWING_V1`,
      strategyVersion:'signal-profile-v1',
      parameterHash:'a'.repeat(64),
      researchCodeSha:'b'.repeat(40),
      datasetSnapshotHash:'c'.repeat(64),
    },
    quality:{status:'verified',oos:true,walkForward:true,costsIncluded:true,slippageIncluded:true,lookaheadGuarded:true,survivorshipGuarded:true},
    executionAuthority:'NONE',
  };
}

test('direction-aware index keeps futures LONG and SHORT quality separate',()=>{
  const index=buildDirectionAwareScannerQualityIndex([
    packet({direction:'LONG'}),
    packet({direction:'SHORT'}),
  ]);
  assert.equal(index.bySymbol.BTCUSDT.length,2);
  assert.equal(Object.keys(index.byExact).length,2);
  assert.equal(index.executionAuthority,'NONE');
});

test('current symbol-only ranking projection blocks same-symbol LONG and SHORT collision',()=>{
  const index=buildDirectionAwareScannerQualityIndex([
    packet({direction:'LONG'}),
    packet({direction:'SHORT'}),
  ]);
  const out=projectQualityIndexToCurrentSymbolMap({
    cards:[
      {symbol:'BTCUSDT',action:'LONG',direction:'LONG'},
      {symbol:'BTCUSDT',action:'SHORT',direction:'SHORT'},
    ],
    index,
  });
  assert.equal(out.status,'BLOCKED');
  assert.equal(out.safeForCurrentSymbolOnlyRanking,false);
  assert.ok(out.blockers.some(x=>x.code==='SYMBOL_ONLY_BACKTEST_MAP_CANNOT_REPRESENT_MULTIPLE_DIRECTIONS'));
  assert.deepEqual(out.backtests,{});
});

test('cash long-only single identity can project safely',()=>{
  const p=packet({symbol:'005930',direction:'LONG',market:'KR_STOCK'});
  p.identity.timeframe='60m';
  const index=buildDirectionAwareScannerQualityIndex([p]);
  const out=projectQualityIndexToCurrentSymbolMap({
    cards:[{symbol:'005930',action:'BUY',direction:'LONG'}],
    index,
  });
  assert.equal(out.status,'READY');
  assert.equal(out.safeForCurrentSymbolOnlyRanking,true);
  assert.equal(out.backtests['005930'].status,'verified');
});

test('direction mismatch never borrows opposite-side quality',()=>{
  const index=buildDirectionAwareScannerQualityIndex([packet({direction:'LONG'})]);
  const out=projectQualityIndexToCurrentSymbolMap({
    cards:[{symbol:'BTCUSDT',action:'SHORT',direction:'SHORT'}],
    index,
  });
  assert.equal(out.status,'BLOCKED');
  assert.ok(out.blockers.some(x=>x.code==='QUALITY_DIRECTION_MISSING'));
  assert.deepEqual(out.backtests,{});
});
