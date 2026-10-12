import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  normalizeUpbitKrwMinuteRoster,
  normalizeBitgetUsdtMinuteRoster,
} from '../src/four-market-minute-roster-capacity-v1.mjs';

const script=new URL('../bin/public-crypto-websocket-minute.mjs',import.meta.url).pathname;
const run=(args,env={})=>spawnSync(process.execPath,[script,...args],{
  encoding:'utf8',timeout:8_000,env:{PATH:process.env.PATH,...env},
});
const event={warning:false,caution:{FLAG:false}};
const roster=(now)=>({
  upbit:normalizeUpbitKrwMinuteRoster([
    {market:'KRW-BTC',market_event:event},
  ],now),
  bitget:normalizeBitgetUsdtMinuteRoster({code:'00000',data:[{
    symbol:'BTCUSDT',symbolStatus:'normal',symbolType:'perpetual',
    quoteCoin:'USDT',isRwa:'NO',
  }]},now),
});
async function workspace(fn){
  const root=await mkdtemp(join(tmpdir(),'ws-minute-plan-'));
  try{return await fn(root);}
  finally{await rm(root,{recursive:true,force:true});}
}
test('WebSocket plan CLI is disabled by default and rejects unauthorised plan',()=>{
  for(const args of [[],['--dry-run']]){
    const x=run(args);
    assert.equal(x.status,0,x.stderr);
    const r=JSON.parse(x.stdout);
    assert.equal(r.status,'DISABLED');
    assert.equal(r.socketConnectionsOpened,0);
    assert.equal(r.publicProviderGETCount,0);
  }
  const fail=run(['--plan']);
  assert.equal(fail.status,2);
  assert.equal(JSON.parse(fail.stdout).reason,
    'WS_MINUTE_EXPLICIT_PLAN_APPROVAL_REQUIRED');
});
test('0600 sealed current roster permits READ-ONLY proposal without sockets',async()=>{
  await workspace(async root=>{
    const file=join(root,'roster.json');
    await writeFile(file,JSON.stringify(roster(Date.now()-1000)),{mode:0o600});
    const x=run(['--plan'],{
      RESEARCH_PUBLIC_WS_PLAN_ENABLED:'true',
      RESEARCH_PUBLIC_WS_ROSTER_MANIFEST:file,
    });
    assert.equal(x.status,0,x.stdout+' '+x.stderr);
    const r=JSON.parse(x.stdout);
    assert.equal(r.status,'OPERATOR_REVIEW_REQUIRED');
    assert.equal(r.symbolCount,2);
    assert.equal(r.plannedConnections,2);
    assert.deepEqual(r.venuePlanCounts,{upbit:1,bitget:1});
    assert.equal(r.readyToConnect,false);
    assert.equal(r.publicProviderGETCount,0);
    assert.equal(r.socketConnectionsOpened,0);
    assert.equal(r.archiveFilesWritten,0);
    assert.equal(r.executionAuthority,'NONE');
    await chmod(file,0o644);
    const blocked=run(['--plan'],{
      RESEARCH_PUBLIC_WS_PLAN_ENABLED:'true',
      RESEARCH_PUBLIC_WS_ROSTER_MANIFEST:file,
    });
    assert.equal(blocked.status,2);
    assert.equal(JSON.parse(blocked.stdout).reason,
      'WS_MINUTE_PRIVATE_ROSTER_FILE_UNSAFE');
  });
});
test('symlinked roster and invalid scope do not disclose arbitrary content',async()=>{
  await workspace(async root=>{
    const target=join(root,'target.json'),alias=join(root,'alias.json');
    await writeFile(target,JSON.stringify(roster(Date.now()-1000)),{mode:0o600});
    await symlink(target,alias);
    const r=run(['--plan'],{
      RESEARCH_PUBLIC_WS_PLAN_ENABLED:'true',
      RESEARCH_PUBLIC_WS_ROSTER_MANIFEST:alias,
    });
    assert.equal(r.status,2);
    const p=JSON.parse(r.stdout);
    assert.equal(p.status,'BLOCKED');
    assert.equal(p.socketConnectionsOpened,0);
    assert.equal(p.archiveFilesWritten,0);
    assert.ok(!r.stdout.includes('BTCUSDT'));
  });
});
