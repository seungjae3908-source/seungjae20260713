import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  verifiedSignalV3Coverage, classifySignalV3HealthAndSource,
  verifiedSignalV3Cycle, boundedSignalV3Read, runReadOnlySignalV3Predeploy,
} from '../../ops/telegram-predeploy-signal-health.mjs';

const sha='b'.repeat(40);
const now=Date.parse('2026-10-11T03:45:00.000Z');
const coverage=()=>({
  serviceSha:sha,generatedAt:new Date(now-60_000).toISOString(),
  safety:{executionAuthority:'NONE',privateTradingApiAllowed:false,realOrderAllowed:false},
  events:[],publicDataOnly:true,profile:{fullStrategyCoverage:true},
  coverage:['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES'].flatMap(market=>
    [{strategy:'SCALPING',timeframe:'15m'},{strategy:'SWING',timeframe:'60m'},
      {strategy:'MID_LONG',timeframe:'1D'}].map(mode=>({
      market,...mode,totalUniverse:100,cursorBefore:0,cursorAfter:20,
      lastGoodPreserved:false,cursorRotatedBlockedOnly:false,
      universePartial:false,universeStale:false,
      universeSource:market==='KR_STOCK'?'krx-symbol-master':
        market==='US_STOCK'?'nasdaq-trader-public-directory':
          market==='CRYPTO_SPOT'?'upbit-public':'bitget-public',
      responseDataState:'complete',status:'VALID_NO_TRADE',
      providerErrors:0,universeProviderErrors:0,timeouts:0,
      scannedCards:0,retainedFromBatch:0,
    }))),
});
const health=()=>({
  ok:true,service:'signal-intelligence-v3',serviceSha:sha,
  snapshotAgeMs:60_000,snapshotReady:true,snapshotFresh:true,
  executionAuthority:'NONE',privateTradingApiAllowed:false,realOrderAllowed:false,
});
const source=()=>({ok:true,serviceSha:sha,executionAuthority:'NONE',
  snapshot:coverage()});
test('true source readiness includes all 12 verified markets/strategies, no fake PASS',()=>{
  assert.equal(verifiedSignalV3Coverage(coverage()),true);
  const ok=classifySignalV3HealthAndSource(health(),source(),now);
  assert.deepEqual(ok,{ok:true,code:'TELEGRAM_PREDEPLOY_SIGNAL_V3_FRESH_PASS'});
  for(const mutation of [
    s=>s.coverage.pop(),
    s=>s.coverage[0].status='SEARCH_FAILURE',
    s=>s.coverage[0].status='BLOCKED_DATA',
    s=>s.coverage[0].universePartial=true,
    s=>s.coverage[0].universeStale=true,
    s=>s.coverage[0].timeouts=1,
    s=>s.coverage[0].providerErrors=2,
    s=>s.coverage[0].universeSource='untrusted-public-roster',
    s=>s.coverage[0].responseDataState='stale',
    s=>s.coverage[1].strategy=s.coverage[0].strategy,
  ]){
    const snap=coverage(); mutation(snap);
    assert.equal(verifiedSignalV3Coverage(snap),false);
    assert.equal(classifySignalV3HealthAndSource(health(),{
      ok:true,serviceSha:sha,executionAuthority:'NONE',snapshot:snap},now).ok,false);
  }
});
test('fresh timestamp alone cannot conceal stale, forged or contradictory evidence',()=>{
  const s=source(),h=health();
  const expectBad=()=>assert.equal(classifySignalV3HealthAndSource(h,s,now).ok,false);
  s.snapshot.generatedAt=new Date(now-20*60_000).toISOString();
  expectBad();
  s.snapshot.generatedAt=new Date(now-60_000).toISOString();
  h.snapshotAgeMs=19*60_000;
  expectBad();
  h.snapshotAgeMs=60_000;
  s.snapshot.serviceSha='c'.repeat(40);
  expectBad();
  s.snapshot.serviceSha=sha;
  s.snapshot.safety.realOrderAllowed=true;
  expectBad();
});
test('fixed systemd units and recent successful oneshot are required',()=>{
  const make=(cycleResult='success',startedAt=120_000_000,exit=0)=>({
    execImpl:(command,args)=>{
      assert.equal(command,'systemctl');
      assert.equal(args[0],'show');
      const unit=args.at(-1);
      if(unit.endsWith('-cycle.service'))
        return 'LoadState=loaded\nActiveState=inactive\nResult='+cycleResult+
          '\nExecMainStatus='+exit+'\nExecMainStartTimestampMonotonic='+startedAt+'\n';
      return 'LoadState=loaded\nActiveState=active\n';
    },
    uptimeReadImpl:()=> '130.0 0',
  });
  assert.equal(verifiedSignalV3Cycle(make()),true);
  assert.equal(verifiedSignalV3Cycle(make('exit-code',120_000_000,1)),false);
  assert.equal(verifiedSignalV3Cycle(make('success',0)),false);
  assert.equal(verifiedSignalV3Cycle({
    ...make(),uptimeReadImpl:()=> '1500.0 0'}),false);
  assert.equal(verifiedSignalV3Cycle({
    ...make(),uptimeReadImpl:()=>{throw Error('PRIVATE_LOCAL_PATH')}}),false);
});
test('fixed loopback GET never leaks payload or requests unknown endpoints',async()=>{
  const getImpl=(url,opts,respond)=>{
    assert.equal(opts.method,'GET');
    assert.ok(['http://127.0.0.1:8790/health',
      'http://127.0.0.1:8790/v1/signals'].includes(url));
    const req=new EventEmitter();req.destroy=()=>{};
    queueMicrotask(()=>{
      const res=new EventEmitter();res.statusCode=200;
      respond(res);res.emit('data',Buffer.from(JSON.stringify({safe:true,secret:'PRIVATE_TOKEN'})));
      res.emit('end');
    });
    return req;
  };
  const data=await boundedSignalV3Read('/health',{getImpl});
  assert.equal(data.safe,true);
  assert.equal(await boundedSignalV3Read('/internal/rescan',{getImpl}),null);
});
test('runtime read-only mode returns bounded GO/NO_GO and never grants live authority',async()=>{
  const result=await runReadOnlySignalV3Predeploy({
    cycle:()=>true,
    read:async path=>path==='/health'?health():source(),
    now:()=>now,
  });
  assert.equal(result.code,'TELEGRAM_PREDEPLOY_SIGNAL_V3_FRESH_PASS');
  const denied=await runReadOnlySignalV3Predeploy({
    cycle:()=>false,read:()=>{throw Error('SHOULD_NOT_RUN');},now:()=>now,
  });
  assert.deepEqual(denied,{ok:false,code:'TELEGRAM_PREDEPLOY_SIGNAL_V3_NOT_READY'});
});

test('fail closed for mismatched market sources, cursor replays and forged lane counts',()=>{
  const baseline=coverage();
  assert.equal(verifiedSignalV3Coverage(baseline),true);
  const broken=[
    ['market/source mismatch',row=>{row.universeSource='bitget-public';}],
    ['cursor missing',row=>{delete row.cursorBefore;}],
    ['cursor repeated',row=>{row.cursorAfter=row.cursorBefore;}],
    ['cursor out of range',row=>{row.cursorAfter=row.totalUniverse+1;}],
    ['cursor negative',row=>{row.cursorBefore=-1;}],
    ['historically preserved success',row=>{row.lastGoodPreserved=true;}],
    ['blocked-only rotation hidden under success',row=>{row.cursorRotatedBlockedOnly=true;}],
    ['provider outcome contradicts success',row=>{row.outcome='PROVIDER_FAILURE';}],
    ['silent retained candidates on no-trade',row=>{row.retainedFromBatch=1;}],
    ['candidate count above scanned count',row=>{
      row.status='CANDIDATES_AVAILABLE';row.scannedCards=1;row.retainedFromBatch=2;
    }],
    ['candidate status without adopted V3 inputs',row=>{
      row.status='CANDIDATES_AVAILABLE';row.scannedCards=1;row.retainedFromBatch=0;
    }],
    ['no-trade status contradicts upstream candidate outcome',row=>{
      row.outcome='CANDIDATES_AVAILABLE';
    }],
  ];
  for(const [label,change] of broken){
    const shot=coverage();
    change(shot.coverage[0]);
    assert.equal(verifiedSignalV3Coverage(shot),false,label);
    assert.equal(classifySignalV3HealthAndSource(health(),{
      ok:true,serviceSha:sha,executionAuthority:'NONE',snapshot:shot,
    },now).ok,false,label);
  }
  const genuine=coverage();
  const row=genuine.coverage[0];
  row.status='CANDIDATES_AVAILABLE';row.scannedCards=2;row.retainedFromBatch=2;
  assert.equal(verifiedSignalV3Coverage(genuine),true);
  assert.equal(classifySignalV3HealthAndSource(health(),{
    ok:true,serviceSha:sha,executionAuthority:'NONE',snapshot:genuine,
  },now).ok,true);
});
