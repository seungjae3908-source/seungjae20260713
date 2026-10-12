import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUpbitKrwMinuteRoster, normalizeBitgetUsdtMinuteRoster,
  verifyPublicMinuteRoster, assessMinuteArchiveCapacity,
  assessMinuteManifestCapacity, proposeCurrentCryptoMinuteManifest,
  probePublicCurrentCryptoRosters, PUBLIC_ROSTER_FETCH_LIMITS,
} from '../src/four-market-minute-roster-capacity-v1.mjs';

const NOW=Date.parse('2026-10-12T09:00:00.000Z');
const START=NOW-120_000;
const event=(warning=false,caution=false)=>({
  warning,caution:{
    PRICE_FLUCTUATIONS:caution,
    TRADING_VOLUME_SOARING:false,
    DEPOSIT_AMOUNT_SOARING:false,
    GLOBAL_PRICE_DIFFERENCES:false,
    CONCENTRATION_OF_SMALL_ACCOUNTS:false,
  },
});
const upbit=[
  {market:'KRW-BTC',market_event:event(false,false)},
  {market:'KRW-ETH',market_event:event(true,false)},
  {market:'BTC-XRP',market_event:event()},
  {market:'KRW-XRP',market_event:event(false,true)},
];
const bitget={code:'00000',data:[
  {symbol:'BTCUSDT',symbolStatus:'normal',symbolType:'perpetual',quoteCoin:'USDT',isRwa:'NO'},
  {symbol:'ETHUSDT',symbolStatus:'limit_open',symbolType:'perpetual',quoteCoin:'USDT',isRwa:'NO'},
  {symbol:'OLDUSDT',symbolStatus:'off',symbolType:'perpetual',quoteCoin:'USDT',isRwa:'NO'},
  {symbol:'RWAUSDT',symbolStatus:'normal',symbolType:'perpetual',quoteCoin:'USDT',isRwa:'YES'},
  {symbol:'UNKUSDT',symbolStatus:'listed',symbolType:'perpetual',quoteCoin:'USDT'},
]};

test('Upbit current market_event warnings are retained for research but clearly marked restricted',()=>{
  const r=normalizeUpbitKrwMinuteRoster(upbit,NOW);
  assert.deepEqual(r.symbols,['BTC','ETH','XRP']);
  assert.deepEqual(r.restrictedSymbols,['ETH','XRP']);
  assert.equal(r.excludedCount,1);
  assert.equal(r.historicalPITProven,false);
  assert.equal(r.canTrade,false);
  assert.equal(verifyPublicMinuteRoster(r),r);
});
test('Upbit 2024 removed market_warning cannot substitute for missing market_event',()=>{
  assert.throws(()=>normalizeUpbitKrwMinuteRoster([{
    market:'KRW-BTC',market_warning:'NONE',
  }],NOW),/MINUTE_UPBIT_EVENT_UNVERIFIED/);
  assert.throws(()=>normalizeUpbitKrwMinuteRoster([{
    market:'KRW-BTC',market_event:{warning:'false',caution:{X:false}},
  }],NOW),/MINUTE_UPBIT_EVENT_UNVERIFIED/);
  assert.throws(()=>normalizeUpbitKrwMinuteRoster([
    upbit[0],upbit[0],
  ],NOW),/MINUTE_ROSTER_DUPLICATE/);
  assert.throws(()=>normalizeUpbitKrwMinuteRoster([{
    market:'KRW-../BAD',market_event:event(),
  }],NOW),/MINUTE_UPBIT_SYMBOL_INVALID/);
});
test('Bitget current USDT perpetual roster excludes offline and RWA, retains high-risk public sources for review',()=>{
  const r=normalizeBitgetUsdtMinuteRoster(bitget,NOW);
  assert.deepEqual(r.symbols,['BTCUSDT','ETHUSDT','UNKUSDT']);
  assert.deepEqual(r.restrictedSymbols,['ETHUSDT','UNKUSDT']);
  assert.equal(r.excludedCount,2);
  assert.equal(verifyPublicMinuteRoster(r),r);
  assert.equal(r.independentUniverseProof,false);
});
test('Bitget duplicates/invalid status and contradictory quote currencies are blocked',()=>{
  assert.throws(()=>normalizeBitgetUsdtMinuteRoster({code:'00000',data:[
    bitget.data[0],bitget.data[0],
  ]},NOW),/MINUTE_BITGET_DUPLICATE_SYMBOL/);
  assert.throws(()=>normalizeBitgetUsdtMinuteRoster({code:'30000',data:bitget.data},NOW),
    /MINUTE_BITGET_ROSTER_INVALID/);
  assert.throws(()=>normalizeBitgetUsdtMinuteRoster({code:'00000',data:[
    {...bitget.data[0],quoteCoin:'USD'},
  ]},NOW),/MINUTE_BITGET_ROSTER_INVALID/);
  assert.throws(()=>normalizeBitgetUsdtMinuteRoster({code:'00000',data:[
    {...bitget.data[0],symbolStatus:'mystery'},
  ]},NOW),/MINUTE_BITGET_ROSTER_INVALID/);
});
test('current roster identities cannot be modified or upgraded to trading permission',()=>{
  const r=normalizeUpbitKrwMinuteRoster(upbit,NOW);
  assert.throws(()=>verifyPublicMinuteRoster({...r,symbols:['BTC','XRP']}),/DIGEST_MISMATCH/);
  assert.throws(()=>verifyPublicMinuteRoster({...r,canTrade:true}),/ATTESTATION_INVALID/);
  assert.throws(()=>verifyPublicMinuteRoster({...r,historicalPITProven:true}),/ATTESTATION_INVALID/);
});
test('known 294+466 crypto contracts exceed 16 requests per 5min even without retry budget',()=>{
  const r=assessMinuteArchiveCapacity({cryptoSpotSymbols:294,cryptoFuturesSymbols:466});
  assert.equal(r.status,'CAPACITY_MODEL_INSUFFICIENT');
  assert.equal(r.dailyRequired,9120);
  assert.equal(r.dailyAvailable,4608);
  assert.equal(r.minActionsPerCycleNoHeadroom,32);
  assert.equal(r.minActionsPerCycleWithHeadroom,38);
  assert.equal(r.modeledCapacitySufficient,false);
  assert.equal(r.continuous24hProven,false);
  assert.equal(r.executionAuthority,'NONE');
});
test('small subset is only mathematically possible, never 24h or live market proof',()=>{
  const r=assessMinuteArchiveCapacity({cryptoSpotSymbols:1,cryptoFuturesSymbols:1});
  assert.equal(r.status,'CAPACITY_MODEL_POSSIBLE');
  assert.equal(r.modeledCapacitySufficient,true);
  assert.equal(r.hostCapacityVerified,false);
  assert.equal(r.providerRateBudgetVerified,false);
  assert.equal(r.fourMarketCoverageProven,false);
});
test('stock session throughput is explicitly unknown, not silently counted as crypto 24/7',()=>{
  const r=assessMinuteArchiveCapacity({
    cryptoSpotSymbols:1,stockSymbols:10,
  });
  assert.equal(r.status,'STOCK_SESSION_NOT_MODELLED');
  assert.equal(r.modeledCapacitySufficient,false);
});
test('manifest excludes BACKFILL from recurring capacity, includes CONTINUOUS only',()=>{
  const r=assessMinuteManifestCapacity({
    ranges:[
      {market:'KR_STOCK',symbol:'005930',mode:'BACKFILL'},
      {market:'CRYPTO_SPOT',symbol:'BTC',mode:'CONTINUOUS'},
      {market:'CRYPTO_FUTURES',symbol:'BTCUSDT',mode:'CONTINUOUS'},
    ],
  });
  assert.equal(r.cryptoSpotSymbols,1);
  assert.equal(r.cryptoFuturesSymbols,1);
  assert.equal(r.stockSymbols,0);
  assert.equal(r.status,'CAPACITY_MODEL_POSSIBLE');
});
test('public current roster proposes ALL symbol tasks but does not activate/approve',()=>{
  const spot=normalizeUpbitKrwMinuteRoster(upbit,NOW);
  const futures=normalizeBitgetUsdtMinuteRoster(bitget,NOW);
  const plan=proposeCurrentCryptoMinuteManifest({
    upbit:spot,bitget:futures,startMs:START,nowMs:NOW,
  });
  assert.equal(plan.status,'REQUIRES_OPERATOR_APPROVAL');
  assert.equal(plan.manifest.ranges.length,6);
  assert.equal(plan.capacity.status,'CAPACITY_MODEL_POSSIBLE');
  assert.equal(plan.admitted,false);
  assert.equal(plan.automaticActivation,false);
  assert.equal(plan.historicalPITProven,false);
  assert.equal(plan.executionAuthority,'NONE');
  assert.deepEqual(plan.sourceDigests,[spot.digest,futures.digest]);
});
test('stale roster and forged proof cannot create a usable automatic proposal',()=>{
  const spot=normalizeUpbitKrwMinuteRoster(upbit,NOW);
  const futures=normalizeBitgetUsdtMinuteRoster(bitget,NOW);
  assert.throws(()=>proposeCurrentCryptoMinuteManifest({
    upbit:spot,bitget:futures,startMs:START,nowMs:NOW+16*60_000,
  }),/STALE_OR_FUTURE/);
  assert.throws(()=>proposeCurrentCryptoMinuteManifest({
    upbit:{...spot,restrictedSymbols:['BTC']},bitget:futures,
    startMs:START,nowMs:NOW,
  }),/DIGEST_MISMATCH/);
  assert.throws(()=>proposeCurrentCryptoMinuteManifest({
    upbit:spot,bitget:futures,startMs:START+1,nowMs:NOW,
  }),/START_INVALID/);
});
test('invalid capacity inputs fail closed and cannot fabricate continuous budget',()=>{
  for(const input of [
    {cryptoSpotSymbols:-1},
    {cryptoFuturesSymbols:Infinity},
    {actionsPerCycle:-1},
    {cycleMinutes:0},
    {cycleMinutes:7},
    {windowMinutes:0},
    {headroomPercent:300},
  ]) assert.throws(()=>assessMinuteArchiveCapacity(input),/MINUTE_CAPACITY_/);
});


test('roster public provider probe is disabled by default and performs zero network calls',async()=>{
  let calls=0;
  const r=await probePublicCurrentCryptoRosters({fetchImpl:async()=>{
    calls++;throw Error('No public calls without explicit enable');
  }});
  assert.equal(r.status,'DISABLED');
  assert.equal(r.publicProviderCalls,0);
  assert.equal(calls,0);
});
test('opt-in current public roster probe calls only two official GET endpoints and never admits orders',async()=>{
  const seen=[];
  const fetchImpl=async(url,init)=>{
    seen.push({url,init});
    const response=url.includes('api.upbit.com')?upbit:bitget;
    return Response.json(response);
  };
  const r=await probePublicCurrentCryptoRosters({enabled:true,fetchImpl,now:()=>NOW});
  assert.equal(seen.length,2);
  assert.equal(new URL(seen[0].url).hostname,'api.upbit.com');
  assert.equal(new URL(seen[0].url).searchParams.get('is_details'),'true');
  assert.equal(new URL(seen[1].url).hostname,'api.bitget.com');
  assert.equal(new URL(seen[1].url).searchParams.get('productType'),'USDT-FUTURES');
  assert.equal(seen.every(v=>v.init.method==='GET'),true);
  assert.equal(seen.every(v=>v.init.redirect==='error'),true);
  assert.equal(r.publicProviderCalls,2);
  assert.equal(r.upbit.symbols.length,3);
  assert.equal(r.bitget.symbols.length,3);
  assert.equal(r.capacity.cryptoSpotSymbols,3);
  assert.equal(r.capacity.cryptoFuturesSymbols,3);
  assert.equal(r.archiveFilesWritten,0);
  assert.equal(r.historicalPITProven,false);
  assert.equal(r.tradingAuthority,'NONE');
});
test('roster probe rejects oversized pages and partial provider failures without pretending full coverage',async()=>{
  assert.equal(PUBLIC_ROSTER_FETCH_LIMITS.publicCallsPerProbe,2);
  await assert.rejects(probePublicCurrentCryptoRosters({
    enabled:true,now:()=>NOW,fetchImpl:async()=>( {
      ok:true,headers:{get:()=>String(3*1024*1024)},text:async()=>JSON.stringify(upbit),
    }),
  }),/MINUTE_ROSTER_PROVIDER_BODY_OVERSIZE/);
  let calls=0;
  await assert.rejects(probePublicCurrentCryptoRosters({
    enabled:true,now:()=>NOW,fetchImpl:async url=>{
      calls++;
      return calls===1?Response.json(upbit):Response.json({error:'down'},{status:503});
    },
  }),/MINUTE_ROSTER_PROVIDER_HTTP_BLOCKED/);
  assert.equal(calls,2);
});
