import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePublicScanCapacity} from '../src/public-scan-capacity.mjs';
const markets={
 KR_STOCK:{symbols:4010,minRequestsPerSymbol:2},
 US_STOCK:{symbols:12322,minRequestsPerSymbol:3},
 CRYPTO_SPOT:{symbols:294,minRequestsPerSymbol:2},
 CRYPTO_FUTURES:{symbols:820,minRequestsPerSymbol:2},
};
test('same five-minute full-roster duty cycle has explicit request-rate lower bounds but no fake quota',()=>{
 const x=evaluatePublicScanCapacity({markets,horizonMinutes:5});
 const us=x.detail.find(p=>p.market==='US_STOCK');
 assert.equal(us.requestFloor,36966);
 assert.equal(us.minimumRequestsPerSecond,123.22);
 assert.equal(us.quotaKnown,false);
 assert.equal(x.bottleneck,'PROVIDER_QUOTA_UNKNOWN');
 assert.equal(x.fullMarketGuaranteed,false);
 assert.equal(x.actual24hVerified,false);
 assert.equal(x.executionAuthority,'NONE');
});
test('insufficient rates block, large nominal quota does not certify source or trading',()=>{
 const low=evaluatePublicScanCapacity({markets,horizonMinutes:5,providerRequestsPerSecond:{
  KR_STOCK:1,US_STOCK:1,CRYPTO_SPOT:1,CRYPTO_FUTURES:1,
 }});
 assert.equal(low.bottleneck,'PROVIDER_RATE_INSUFFICIENT');
 const high=evaluatePublicScanCapacity({markets,horizonMinutes:1440,providerRequestsPerSecond:{
  KR_STOCK:1000,US_STOCK:1000,CRYPTO_SPOT:1000,CRYPTO_FUTURES:1000,
 }});
 assert.equal(high.bottleneck,'RATE_ONLY_POSSIBLE_NOT_CERTIFIED');
 assert.equal(high.fullMarketGuaranteed,false);
 assert.equal(high.liveTradingAllowed,false);
});
