import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const file = new URL('../../.github/workflows/research-market-watch-main-ci-bridge.yml',import.meta.url);
test('exact-main Application CI dispatch bridge accepts only canonical owner command',async()=>{
 const c=await readFile(file,'utf8');
 for(const part of [
  'github.event.issue.number == 1102',
  'github.event.comment.user.login == github.repository_owner',
  "github.event.comment.author_association == 'OWNER'",
  "startsWith(github.event.comment.body, '/validate-market-watch-main ')",
  'WATCH_CI_MAIN_SHA_MISMATCH','WATCH_CI_RESEARCH_ANCESTRY_MISMATCH_',
  'for(const n of [1743,1764])',
  "['ahead','identical'].includes(ancestry)",
 ])assert.ok(c.includes(part),part);
});
test('bridge dispatches exactly immutable current-main Application CI, and dedupes before running',async()=>{
 const c=await readFile(file,'utf8');
 assert.match(c,/github\.rest\.actions\.createWorkflowDispatch\(/);
 assert.match(c,/workflow_id:'futures-public-network-smoke\.yml'/);
 assert.match(c,/ref:'main'/);
 assert.match(c,/inputs:\{target_sha:target\}/);
 assert.match(c,/head_sha:target,per_page:100/);
 assert.match(c,/EXACT_MAIN_APPLICATION_CI_ALREADY_PRESENT/);
 assert.match(c,/if\(next!==target\)/);
 assert.match(c,/EXACT_MAIN_APPLICATION_CI_DISPATCHED_FOR/);
});
test('bridge cannot remotely deploy, change DB or touch auto-trading permissions',async()=>{
 const c=await readFile(file,'utf8');
 assert.doesNotMatch(c,/ssh -|systemctl|curl.*prod|kubectl|placeOrder\(|executeSql\(|supabase\.from\(/i);
 assert.doesNotMatch(c,/gh workflow run|workflow_id:'production-deploy\.yml'|workflow_id:'research-production-activation\.yml'/);
 assert.ok(c.includes('production_deployed: false'));
 assert.ok(c.includes('research_service_activated: false'));
 assert.ok(c.includes('real_orders: 0'));
 assert.ok(c.includes('paper_orders: 0'));
 assert.ok(c.includes('replit_used: false'));
});
test('PR validation cannot call actions dispatch',async()=>{
 const c=await readFile(file,'utf8');
 const val=c.slice(c.indexOf('  validate:'),c.indexOf('  dispatch-main-ci:'));
 assert.ok(val.includes("github.event_name == 'pull_request'"));
 assert.ok(val.includes('contents: read'));
 assert.doesNotMatch(val,/actions: write|createWorkflowDispatch/);
 const dispatch=c.slice(c.indexOf('  dispatch-main-ci:'));
 assert.ok(dispatch.includes('actions: write'));
});
