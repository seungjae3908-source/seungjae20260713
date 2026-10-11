import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {getPublicScannerProfileSet,PUBLIC_V3_FUTURES_STAGE_TWO_LIMIT} from '../src/public-scanner-profiles.mjs';
test('research defaults stay unchanged and opt-in UI profile matches all four markets',async()=>{
  assert.deepEqual(getPublicScannerProfileSet().map(x=>x.timeframe),['15m','60m','1D']);
  assert.deepEqual(getPublicScannerProfileSet('MEMBER_UI').map(x=>x.timeframe),['5m','4H','1D']);
  assert.throws(()=>getPublicScannerProfileSet('LIVE_ORDERS'),/PROFILE_UNSUPPORTED/);
  assert.equal(PUBLIC_V3_FUTURES_STAGE_TWO_LIMIT,10);
  const ui=await readFile(new URL('../../stock-analyzer/src/lib/signal-scanner-profile.ts',import.meta.url),'utf8');
  for(const market of ['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES']){
    const index=ui.indexOf(market+': {');
    assert.ok(index>=0,market);
    const section=ui.slice(index,ui.indexOf('\n  },',index));
    assert.match(section,/scalping: \{ timeframe: '5m'/,market);
    assert.match(section,/swing: \{ timeframe: '4H'/,market);
    assert.match(section,/position: \{ timeframe: '1D'/,market);
  }
});
