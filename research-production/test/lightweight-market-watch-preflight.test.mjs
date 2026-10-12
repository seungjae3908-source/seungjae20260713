import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeWatchReadOnlyPreflight } from '../bin/lightweight-market-watch-preflight.mjs';

const SHA='a'.repeat(40);
const exe=new URL('../bin/lightweight-market-watch-preflight.mjs',import.meta.url).pathname;
async function workspace(fn) {
  const root=await mkdtemp(join(tmpdir(),'research-readonly-preflight-'));
  try{return await fn(root);} finally{await rm(root,{recursive:true,force:true});}
}
function execute(root,sha=SHA,extra={}) {
  return spawnSync(process.execPath,[exe],{
    encoding:'utf8',timeout:30_000,
    env:{...process.env,RESEARCH_STATE_ROOT:root,RESEARCH_CODE_SHA:sha,...extra},
  });
}
test('four absent evidence sources are INCOMPLETE, not a 24h activation PASS',async()=>{
  await workspace(async root=>{
    const run=execute(root);
    assert.equal(run.status,0,run.stdout+' '+run.stderr);
    const row=JSON.parse(run.stdout);
    assert.equal(row.contract,'public-market-watch-preflight-v1');
    assert.equal(row.status,'INCOMPLETE');
    assert.equal(row.checks.marketWatch,'MISSING');
    assert.equal(row.checks.cadence,'MISSING');
    assert.equal(row.checks.capacity,'INSUFFICIENT_HISTORY');
    assert.equal(row.checks.stockSources,'INCOMPLETE');
    assert.equal(row.blockers.length,4);
    assert.ok(row.blockers.includes('STOCKSOURCES_NOT_CONNECTED'));
    assert.equal(row.stockInputFreshFormatCount,0);
    assert.deepEqual(row.stockInputMarkets.map(m=>m.status),['MISSING','MISSING']);
    assert.equal(row.capacityProjectedDays,null);
    assert.equal(row.independentlyVerified24hUptime,false);
    assert.equal(row.fourMarketWholeUniverseProven,false);
    assert.equal(row.deploymentApproved,false);
    assert.equal(row.systemdEnabledOrStarted,false);
    assert.equal(row.fullCostAndOosProven,false);
    assert.equal(row.paperExecutionProven,false);
    assert.equal(row.profitabilityProven,false);
    assert.equal(row.executionAuthority,'NONE');
    assert.deepEqual(await readdir(root),[]);
  });
});
test('unsafe market-watch status symlink fails closed and never exposes private paths',async()=>{
  await workspace(async root=>{
    await mkdir(join(root,'latest'),{mode:0o700});
    const outside=join(root,'private-account-number');
    await writeFile(outside,'{"secretCredential":"DO_NOT_LEAK"}',{mode:0o600});
    await symlink(outside,join(root,'latest','lightweight-market-watch.json'));
    const run=execute(root);
    assert.equal(run.status,2,run.stdout);
    const row=JSON.parse(run.stdout);
    assert.equal(row.status,'INVALID');
    assert.equal(row.checks.marketWatch,'INVALID');
    assert.equal(row.independentlyVerified24hUptime,false);
    assert.equal(row.executionAuthority,'NONE');
    assert.equal(run.stdout.includes(root),false);
    assert.equal(run.stdout.includes('DO_NOT_LEAK'),false);
  });
});
test('bad research SHA or path cannot launch a read-only operational proof',async()=>{
  await workspace(async root=>{
    for (const [path,sha] of [[root,'bad'],['relative/root',SHA],['/',SHA]]) {
      const run=execute(path,sha);
      assert.equal(run.status,2,run.stdout);
      const row=JSON.parse(run.stdout);
      assert.equal(row.status,'INVALID');
      assert.deepEqual(row.blockers,['WATCH_PREFLIGHT_FAILED']);
      assert.equal(row.deploymentApproved,false);
      assert.equal(row.executionAuthority,'NONE');
      assert.equal(run.stdout.includes(path),false);
    }
  });
});
test('other process environment secrets never appear in the helper summary',async()=>{
  await workspace(async root=>{
    const run=execute(root,SHA,{
      TEST_PRIVATE_TRADING_API_KEY:'SECRET-USER-API-KEY-should-not-log',
    });
    assert.equal(run.status,0,run.stdout+' '+run.stderr);
    assert.equal(run.stdout.includes('SECRET-USER-API-KEY'),false);
    assert.equal(JSON.parse(run.stdout).privateApiAccessed,undefined);
  });
});
test('preflight only launches known read-only helper CLIs, no shell/provider/DB/order',async()=>{
  const file=await readFile(exe,'utf8');
  for (const helper of [
    'lightweight-market-watch-status.mjs',
    'lightweight-market-watch-cadence-status.mjs',
    'lightweight-market-watch-capacity-status.mjs',
    'stock-source-preflight.mjs',
  ]) assert.match(file,new RegExp(helper.replaceAll('.','\\.')));
  assert.match(file,/spawnSync\(process\.execPath/u);
  assert.doesNotMatch(file,/systemctl|kubectl|docker\s+run|child_process.*execSync|placeOrder\(|fetch\(|supabase\.from\(/iu);
  assert.match(file,/deploymentApproved: false/u);
  assert.match(file,/executionAuthority: 'NONE'/u);
});


test('fresh KR/US local stock files never upgrade local preflight to verified full-market coverage',async()=>{
  const NOW=Date.now();
  const input=(market)=>({
    schemaVersion:'research-stock-public-snapshot-v1', market,
    source:market==='KR_STOCK'?'KRX_RESEARCH_V1':'US_RESEARCH_V1',
    asOf:new Date(NOW-2000).toISOString(),
    completeUniverse:true,
    quotes:[{
      symbol:market==='KR_STOCK'?'005930':'MSFT',
      price:100,turnover24h:2000000000,change24hPercent:1.4,
      asOf:new Date(NOW-3000).toISOString(),
    }],
  });
  await workspace(async root=>{
    await mkdir(join(root,'market-watch-input'),{mode:0o700});
    for(const market of ['KR_STOCK','US_STOCK'])
      await writeFile(join(root,'market-watch-input',market+'.json'),JSON.stringify(input(market)),{mode:0o600});
    const run=execute(root);
    assert.equal(run.status,0,run.stderr+' '+run.stdout);
    const report=JSON.parse(run.stdout);
    assert.equal(report.checks.stockSources,'FORMAT_VALID_ONLY');
    assert.equal(report.stockInputFreshFormatCount,2);
    assert.deepEqual(report.stockInputMarkets.map(m=>m.status),[
      'FRESH_COMPLETE_CLAIM_UNVERIFIED','FRESH_COMPLETE_CLAIM_UNVERIFIED',
    ]);
    assert.equal(report.status,'INCOMPLETE');
    assert.ok(report.blockers.includes('STOCKSOURCES_UPSTREAM_UNVERIFIED'));
    assert.equal(report.fourMarketWholeUniverseProven,false);
    assert.equal(report.independentlyVerified24hUptime,false);
    assert.equal(report.executionAuthority,'NONE');
    assert.equal(run.stdout.includes('005930'),false);
    assert.equal(run.stdout.includes('MSFT'),false);
    assert.equal(run.stdout.includes(root),false);
  });
});

test('unsafe optional stock snapshot invalidates combined preflight and does not leak payload',async()=>{
  await workspace(async root=>{
    await mkdir(join(root,'market-watch-input'),{mode:0o700});
    const privateFile=join(root,'my-secret');
    await writeFile(privateFile,'do-not-print-credential',{mode:0o600});
    await symlink(privateFile,join(root,'market-watch-input','KR_STOCK.json'));
    const run=execute(root);
    assert.equal(run.status,2,run.stderr+' '+run.stdout);
    const report=JSON.parse(run.stdout);
    assert.equal(report.status,'INVALID');
    assert.equal(report.checks.stockSources,'INVALID');
    assert.equal(report.stockInputMarkets[0].status,'INVALID');
    assert.equal(report.independentlyVerified24hUptime,false);
    assert.equal(run.stdout.includes('do-not-print-credential'),false);
    assert.equal(run.stdout.includes(root),false);
  });
});


test('local per-cycle quote and candidate caps surface as blocker counts, not fake market recall', () => {
  const markets = ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'];
  const out = summarizeWatchReadOnlyPreflight({
    marketWatch: {
      status: 'PARTIAL', marketCoverageCount: 2,
      executionAuthority: 'NONE',
      markets: markets.map((market, i) => ({
        market, sourceCappedCount: i === 1 ? 2 : 0,
        qualifyingCandidateCount: i === 2 ? 13 : 0,
        candidateCappedCount: i === 2 ? 1 : 0,
      })),
    },
    cadence: { status: 'MISSING', cadenceWindowObserved: false,
      executionAuthority: 'NONE' },
    capacity: { status: 'INSUFFICIENT_HISTORY',
      retentionApplied: false, archiveVerified: false,
      deletionAllowed: false, projectedDaysAboveFloor: null },
    stockSources: {
      contract: 'public-stock-source-input-preflight-v1',
      status: 'INCOMPLETE', independentProviderVerified: false,
      marketDataRightsVerified: false, fullUniverseVerified: false,
      continuous24hProven: false, paperExecutionProven: false,
      profitabilityProven: false, executionAuthority: 'NONE',
      markets: ['KR_STOCK', 'US_STOCK'].map(market => ({
        market, status: 'MISSING', listedCount: null, observedCount: null, source: null,
      })),
    },
  });
  assert.equal(out.status, 'INCOMPLETE');
  assert.equal(out.watchedSourceCappedThisCycle, 2);
  assert.equal(out.watchedCandidatesCappedThisCycle, 1);
  assert.ok(out.blockers.includes('WATCH_SOURCE_CAP_OBSERVED'));
  assert.ok(out.blockers.includes('WATCH_CANDIDATE_CAP_OBSERVED'));
  assert.equal(out.fourMarketWholeUniverseProven, false);
  assert.equal(out.independentlyVerified24hUptime, false);
  assert.equal(out.executionAuthority, 'NONE');
});


test('read-only preflight executes via symlinked installed checkout path',async()=>{
  await workspace(async root=>{
    const linked=join(root,'linked-readonly-preflight.mjs');
    await symlink(exe,linked);
    const run=spawnSync(process.execPath,[linked],{
      encoding:'utf8',timeout:30000,
      env:{...process.env,RESEARCH_STATE_ROOT:root,RESEARCH_CODE_SHA:SHA},
    });
    assert.equal(run.status,0,run.stderr+' '+run.stdout);
    const report=JSON.parse(run.stdout);
    assert.equal(report.contract,'public-market-watch-preflight-v1');
    assert.equal(report.status,'INCOMPLETE');
    assert.equal(report.executionAuthority,'NONE');
  });
});
