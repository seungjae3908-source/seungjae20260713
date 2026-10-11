import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const here=dirname(fileURLToPath(import.meta.url));
const source=readFileSync(resolve(here,'../../signal-intelligence-release/deploy/activate-server.sh'),'utf8');
test('new Watch → Signal V3 transport never inherits ambient approval by default',()=>{
 for(const key of ['SIGNAL_INTELLIGENCE_V3_WATCH_HANDOFF_ENABLED',
  'SIGNAL_INTELLIGENCE_V3_WATCH_OFFPAGE_RESEARCH_ENABLED']){
  assert.ok(source.includes('export '+key+'=false'),key);
  const unitLines=source.match(new RegExp('Environment='+key+'=false','g'))??[];
  assert.equal(unitLines.length,2,'server and recurring cycle must both be OFF');
  assert.ok(source.includes('    '+key+'=false \\'));
 }
 assert.match(source,/export SIGNAL_INTELLIGENCE_V3_WATCH_RESEARCH_SHA=\n/u);
 assert.equal((source.match(/Environment=SIGNAL_INTELLIGENCE_V3_WATCH_RESEARCH_SHA=/gu)??[]).length,2);
 assert.ok(source.includes('    SIGNAL_INTELLIGENCE_V3_WATCH_RESEARCH_SHA= \\'));
 assert.ok(source.includes('SIGNAL_INTELLIGENCE_EXECUTION_AUTHORITY=NONE'));
 assert.ok(source.includes('PUBLIC_ONLY_UNIVERSE=true'));
});
test('Watch state and Telegram/private authority cannot be enabled by this deploy script',()=>{
 assert.ok(!/Environment=SIGNAL_INTELLIGENCE_V3_WATCH_HANDOFF_ENABLED=true/u.test(source));
 assert.ok(!/Environment=SIGNAL_INTELLIGENCE_V3_WATCH_OFFPAGE_RESEARCH_ENABLED=true/u.test(source));
 assert.ok(!/EnvironmentFile=.*watch-bridge/u.test(source));
 assert.ok(!/chmod\s+777|chmod\s+-R\s+7|chown\s+-R\s+investment-research/u.test(source));
 assert.match(source,/Environment=LIVE_TRADING=false/u);
 assert.match(source,/Environment=PRIVATE_API_ENABLED=false/u);
 assert.match(source,/Environment=ORDER_AUTHORITY=false/u);
});
