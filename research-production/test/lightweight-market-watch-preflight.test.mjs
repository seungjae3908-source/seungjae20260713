import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
test('three absent evidence sources are INCOMPLETE, not a 24h activation PASS',async()=>{
  await workspace(async root=>{
    const run=execute(root);
    assert.equal(run.status,0,run.stdout+' '+run.stderr);
    const row=JSON.parse(run.stdout);
    assert.equal(row.contract,'public-market-watch-preflight-v1');
    assert.equal(row.status,'INCOMPLETE');
    assert.equal(row.checks.marketWatch,'MISSING');
    assert.equal(row.checks.cadence,'MISSING');
    assert.equal(row.checks.capacity,'INSUFFICIENT_HISTORY');
    assert.equal(row.blockers.length,3);
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
  ]) assert.match(file,new RegExp(helper.replaceAll('.','\\.')));
  assert.match(file,/spawnSync\(process\.execPath/u);
  assert.doesNotMatch(file,/systemctl|kubectl|docker\s+run|child_process.*execSync|placeOrder\(|fetch\(|supabase\.from\(/iu);
  assert.match(file,/deploymentApproved: false/u);
  assert.match(file,/executionAuthority: 'NONE'/u);
});
