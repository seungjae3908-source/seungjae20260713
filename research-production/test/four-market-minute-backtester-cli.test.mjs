import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const command=new URL('../bin/four-market-minute-backtester-source-status.mjs',
  import.meta.url).pathname;

test('backtester data-readiness command is inert with no owner flag',async()=>{
  const dry=spawnSync(process.execPath,[command,'--dry-run'],{
    encoding:'utf8',timeout:8000,env:{PATH:process.env.PATH},
  });
  assert.equal(dry.status,0,dry.stderr);
  const d=JSON.parse(dry.stdout);
  assert.equal(d.status,'DISABLED');
  assert.equal(d.providerGETCount,0);
  assert.equal(d.archiveFilesWritten,0);
  assert.equal(d.executionAuthority,'NONE');
  const noApproval=spawnSync(process.execPath,[
    command,'--inspect','--market=CRYPTO_SPOT','--symbol=BTC',
    '--startDate=2026-10-09','--endDate=2026-10-09',
  ],{encoding:'utf8',timeout:8000,env:{PATH:process.env.PATH}});
  assert.equal(noApproval.status,2);
  const rejected=JSON.parse(noApproval.stdout);
  assert.equal(rejected.status,'BLOCKED');
  assert.equal(rejected.reason,'BACKTEST_SOURCE_OWNER_READONLY_APPROVAL_REQUIRED');
  assert.equal(rejected.executionAuthority,'NONE');
});
test('CLI has no source bar export, order, mutation or operational timer path',async()=>{
  const source=await readFile(command,'utf8');
  assert.match(source,/RESEARCH_MINUTE_SOURCE_READONLY_ENABLED/);
  assert.match(source,/RESEARCH_CODE_SHA/);
  assert.match(source,/--inspect/);
  assert.match(source,/archiveFilesWritten:0/);
  assert.doesNotMatch(source,/systemctl|pm2|placeOrder|sendOrder|fetchCryptoMinutePage/);
});
