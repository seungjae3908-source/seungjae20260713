import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow = fs.readFileSync('.github/workflows/application-fast-ci.yml','utf8');
const from=workflow.indexOf('      - name: Dispatch exact-head canonical Application CI once');
const scriptIndex=workflow.indexOf('          script: |\n',from);
const to=workflow.indexOf('      - name: Boundary',scriptIndex);
const script=workflow.slice(scriptIndex+'          script: |\n'.length,to)
  .split('\n').filter(Boolean).map(line=>line.startsWith('            ')
    ? line.slice(12) : line).join('\n');
test('Telegram scoped QA must finish before Full CI, without retry-to-pass',()=>{
 assert.ok(from>0&&scriptIndex>from&&to>scriptIndex);
 for(const fragment of [
  "headRef.startsWith('drift/telegram-')",
  "const qaWorkflowId = 'telegram-only-staging-qa.yml'",
  "event: 'pull_request'",
  'String(run.head_sha || \'\').toLowerCase() === targetSha',
  'TELEGRAM_SCOPED_QA_FAILED_EXACT_SHA',
  'TELEGRAM_SCOPED_QA_NOT_SUCCESS_EXACT_SHA',
  "run.status === 'completed' && run.conclusion === 'success'",
 ])assert.ok(script.includes(fragment),fragment);
 const guard=script.indexOf('const telegramScope');
 const dispatch=script.indexOf('github.rest.actions.createWorkflowDispatch');
 assert.ok(guard>0&&dispatch>guard);
 assert.equal((script.match(/createWorkflowDispatch\(/g)||[]).length,1);
 const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
 assert.doesNotThrow(()=>new AsyncFunction('github','context','core','process',script));
});
test('non-Telegram PRs retain their existing exact-head Fast-to-Full behavior',()=>{
 assert.ok(script.includes("const workflowId = 'futures-public-network-smoke.yml'"));
 assert.ok(script.includes("if (telegramScope)"));
 assert.ok(script.includes("const reusable = exactRuns.find"));
 assert.ok(script.includes("if (reusable)"));
 assert.ok(workflow.includes('node --test .github/tests/browser-adaptive-github-read.test.mjs .github/tests/telegram-dispatch-scoped-qa.test.mjs'));
});
