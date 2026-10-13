'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REPOSITORY, OWNER, WORKFLOW, HOST_JOB, isStaleWaitingAudit,
  cancelStaleWaitingAudits, safeFailureCode, revalidateWithReceipt, finishReceipt,
} = require('../scripts/research-audit-approval-lifecycle.cjs');
const old = 'a'.repeat(40), current = 'b'.repeat(40), next = 'c'.repeat(40);
const context = () => ({ eventName: 'push', ref: 'refs/heads/main', sha: current,
  repo: { owner: OWNER, repo: 'seungjae20260713' }, runId: 50 });
const waiting = () => ({ id: 20, run_attempt: 2, path: WORKFLOW, event: 'issue_comment', head_branch: 'main',
  head_sha: old, status: 'waiting', conclusion: null, actor: { login: OWNER },
  repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY } });
function mock({ runs = [waiting()], fresh, jobs, mains, cancelStatus = 202, cancelError, failList = false } = {}) {
  let mainIndex = 0, fetchIndex = 0;
  const cancelled = [], pages = [];
  const github = { rest: { repos: { getBranch: async () => ({ data: { commit: {
    sha: mains ? mains[Math.min(mainIndex++, mains.length - 1)] : current } } }) }, actions: {
    listWorkflowRunsForRepo: 'runs', listJobsForWorkflowRun: 'jobs',
    getWorkflowRun: async ({ run_id }) => ({ data: fresh ? fresh[Math.min(fetchIndex++, fresh.length - 1)] : runs.find(x => x.id === run_id) }),
    cancelWorkflowRun: async ({ run_id }) => { if (cancelError) throw cancelError; cancelled.push(run_id); return {status: cancelStatus}; },
  } }, paginate: async (api, options) => {
    pages.push({ api, options }); if (failList) throw new Error('NETWORK_DENIED');
    return api === 'runs' ? runs : (jobs ?? [{name: 'authorize', status: 'completed'}, {name: HOST_JOB, status: 'waiting'}]).map(job=>({run_id:20,...job}));
  } };
  return {github, cancelled, pages};
}
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-audit-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'preflight-status.json'), 'utf8'));
const stages = value => Object.fromEntries(['app_identity','ssh_config','host_audit','audit_receipt','app_after'].map(k => [k,value]));

test('cancel only stale waiting same-repository owner read-only audits', async () => {
  const m = mock(); const r = await cancelStaleWaitingAudits({github:m.github,context:context()});
  assert.deepEqual(m.cancelled, [20]); assert.equal(r.status,'COMPLETE');
  assert.equal(r.cancellations[0].status,'CANCELLATION_REQUESTED');
  assert.equal(r.approvals,0); assert.equal(r.retargets,0); assert.equal(r.hostAccesses,0);
  assert.equal(m.pages[1].options.filter,'latest');
});
for (const [label, change] of [
  ['current candidate', r => {r.head_sha=current;}],
  ['running audit', r => {r.status='in_progress';}],
  ['completed audit', r => {r.status='completed';r.conclusion='success';}],
  ['unknown state', r => {r.status='unknown';}],
  ['wrong repository', r => {r.repository.full_name='other/repo';}],
  ['fork', r => {r.head_repository.full_name='other/repo';}],
  ['non-owner actor', r => {r.actor.login='other';}],
  ['pull-request test', r => {r.event='pull_request';}],
  ['non-main branch', r => {r.head_branch='preview';}],
  ['invalid SHA', r => {r.head_sha='main';}],
  ['invalid run ID', r => {r.id=0;}],
  ['real activation', r => {r.path='.github/workflows/research-production-activation.yml';}],
  ['Telegram', r => {r.path='.github/workflows/telegram-production-code-only-deploy.yml';}],
  ['Paper', r => {r.path='.github/workflows/production-automatic-paper-only-gate.yml';}],
  ['LIVE', r => {r.path='.github/workflows/production-automatic-trading-gate.yml';}],
]) test('never cancel '+label, async () => {
  const r=waiting();change(r);assert.equal(isStaleWaitingAudit(r,current),false);
  const m=mock({runs:[r]});await cancelStaleWaitingAudits({github:m.github,context:context()});assert.deepEqual(m.cancelled,[]);
});
test('obsolete push and subsequent main changes perform no cancellation',async()=>{
  for(const mains of [[next],[current,next],[current,current,next]]){
    const m=mock({mains});const r=await cancelStaleWaitingAudits({github:m.github,context:context()});
    assert.deepEqual(m.cancelled,[]);assert.match(r.status,/NO_ACTION|NO_FURTHER_ACTION/u);
  }
});
test('freshly approved in-progress job is never cancelled',async()=>{
  const active={...waiting(),status:'in_progress'};
  for(const fresh of [[active],[waiting(),active]]){
    const m=mock({fresh});await cancelStaleWaitingAudits({github:m.github,context:context()});assert.deepEqual(m.cancelled,[]);
  }
});
test('any observed active job prevents cancellation',async()=>{
  const m=mock({jobs:[{name:HOST_JOB,status:'in_progress'}]});
  await cancelStaleWaitingAudits({github:m.github,context:context()});assert.deepEqual(m.cancelled,[]);
});
test('wrong waiting job prevents cancellation',async()=>{
  const m=mock({jobs:[{name:'activate',status:'waiting'}]});
  await cancelStaleWaitingAudits({github:m.github,context:context()});assert.deepEqual(m.cancelled,[]);
});
test('same run returned twice is never cancelled twice',async()=>{
  const m=mock({runs:[waiting(),waiting()]});await cancelStaleWaitingAudits({github:m.github,context:context()});assert.deepEqual(m.cancelled,[20]);
});
test('failed complete listing never becomes empty/successful result',async()=>{
  const m=mock({failList:true});await assert.rejects(cancelStaleWaitingAudits({github:m.github,context:context()}));assert.deepEqual(m.cancelled,[]);
});
test('cancel API rejection is reported without retries or secret disclosure',async()=>{
  const m=mock({cancelError:Object.assign(Error('Authorization: secret'),{status:403})});
  const r=await cancelStaleWaitingAudits({github:m.github,context:context()});
  assert.equal(r.status,'INCOMPLETE');assert.equal(r.errors[0].httpStatus,403);assert.equal(JSON.stringify(r).includes('secret'),false);
});
test('non-202 cancellation is not reported as accepted',async()=>{
  const m=mock({cancelStatus:204});const r=await cancelStaleWaitingAudits({github:m.github,context:context()});
  assert.equal(r.status,'INCOMPLETE');assert.deepEqual(r.cancellations,[]);
});
test('only the exact repository main push may sweep',async()=>{
  for(const update of [{eventName:'issue_comment'},{ref:'refs/heads/develop'},{sha:'main'},{repo:{owner:'foreign',repo:'repo'}}]){
    const m=mock();await assert.rejects(cancelStaleWaitingAudits({github:m.github,context:{...context(),...update}}));assert.deepEqual(m.cancelled,[]);
  }
});
test('valid proof retains evidence before/after revalidation but is not operating PASS',async t=>{
  const dir=temp(t), m=mock();
  const p=await revalidateWithReceipt({github:m.github,context:context(),targetSha:current,attempt:2,evidenceDirectory:dir,
    authorize:async()=>{assert.equal(read(dir).status,'AUTHORIZATION_PENDING');return {targetSha:current,executionAuthority:'NONE'};}});
  assert.equal(p.targetSha,current);assert.equal(read(dir).status,'AUTHORIZED_NOT_AUDITED');
  assert.equal(read(dir).fullyFunctional,false);assert.equal(read(dir).runAttempt,2);
});
test('main drift after approval preserves expected/observed SHA and never retargets',async t=>{
  const dir=temp(t),m=mock();let calls=0;
  await assert.rejects(revalidateWithReceipt({github:m.github,context:context(),targetSha:old,attempt:2,evidenceDirectory:dir,
    authorize:async()=>{calls++;throw Error('RESEARCH_ISOLATED_CURRENT_MAIN_MOVED');}}),/CURRENT_MAIN_MOVED/u);
  const r=read(dir);assert.equal(r.targetSha,old);assert.equal(r.observedMainSha,current);
  assert.equal(r.hostAuditAttempted,false);assert.equal(r.status,'BLOCKED');assert.equal(calls,1);
  assert.equal(fs.existsSync(path.join(dir,'code-proof.json')),false);
});
test('unknown error is sanitized; no raw token or SSH message reaches artifact',async t=>{
  const dir=temp(t);
  await assert.rejects(revalidateWithReceipt({github:mock().github,context:context(),targetSha:old,attempt:1,evidenceDirectory:dir,
    authorize:async()=>{throw Error('password=secret /etc/provider');}}),/REVALIDATION_FAILED/u);
  assert.equal(JSON.stringify(read(dir)).includes('secret'),false);
  assert.equal(safeFailureCode(Error('RESEARCH_ISOLATED_FAIL\nsecret')),'RESEARCH_ISOLATED_REVALIDATION_FAILED');
});
test('failed main observation remains null, not invented known main',async t=>{
  const dir=temp(t),m=mock();m.github.rest.repos.getBranch=async()=>{throw Error('network');};
  await assert.rejects(revalidateWithReceipt({github:m.github,context:context(),targetSha:old,attempt:1,evidenceDirectory:dir,
    authorize:async()=>{throw Error('RESEARCH_ISOLATED_CURRENT_MAIN_MOVED');}}));assert.equal(read(dir).observedMainSha,null);
});
test('failed guard reason survives final skipped cleanup steps',async t=>{
  const dir=temp(t);await assert.rejects(revalidateWithReceipt({github:mock().github,context:context(),targetSha:old,attempt:1,evidenceDirectory:dir,
    authorize:async()=>{throw Error('RESEARCH_ISOLATED_CURRENT_MAIN_MOVED');}}));
  const r=finishReceipt({outcomes:stages('skipped'),evidenceDirectory:dir});
  assert.equal(r.reasonCode,'RESEARCH_ISOLATED_CURRENT_MAIN_MOVED');assert.equal(r.hostAuditCompleted,false);
});
for(const bad of ['failure','skipped','cancelled']) test('later '+bad+' cannot appear as complete audit',async t=>{
  const dir=temp(t);await revalidateWithReceipt({github:mock().github,context:context(),targetSha:current,attempt:2,evidenceDirectory:dir,
    authorize:async()=>({targetSha:current,executionAuthority:'NONE'})});
  const r=finishReceipt({outcomes:{...stages('success'),host_audit:bad},evidenceDirectory:dir});
  assert.equal(r.status,'AUDIT_NOT_COMPLETED');assert.equal(r.hostAuditCompleted,false);assert.equal(r.fullyFunctional,false);
});
test('complete read-only audit is still not activation or profitability proof',async t=>{
  const dir=temp(t);await revalidateWithReceipt({github:mock().github,context:context(),targetSha:current,attempt:2,evidenceDirectory:dir,
    authorize:async()=>({targetSha:current,executionAuthority:'NONE'})});
  const r=finishReceipt({outcomes:stages('success'),evidenceDirectory:dir});
  assert.equal(r.status,'READONLY_AUDIT_COMPLETED');assert.equal(r.activationGranted,false);assert.equal(r.fullyFunctional,false);
});
test('invalid identities and forged proof are not retained as permission',async t=>{
  const dir=temp(t),base={github:mock().github,context:context(),targetSha:current,attempt:1,evidenceDirectory:dir};
  await assert.rejects(revalidateWithReceipt({...base,attempt:0,authorize:async()=>null}));
  await assert.rejects(revalidateWithReceipt({...base,authorize:async()=>({targetSha:old,executionAuthority:'LIVE'})}));
  assert.equal(read(dir).status,'BLOCKED');
});

test('workflow retains exact-main and human gates while adding per-attempt failure artifacts',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../workflows/research-isolated-release.yml'),'utf8');
  for(const token of ['environment: production','actions: read','await revalidateWithReceipt({github,context,authorize,',
    'test "$(gh api "repos/${GITHUB_REPOSITORY}/branches/main" --jq \'.commit.sha\')" = "$RESEARCH_TARGET_SHA"',
    'StrictHostKeyChecking=yes','preflight-status.json','-attempt-${{ github.run_attempt }}']) assert.ok(source.includes(token),token);
  assert.ok(!source.includes('continue-on-error: true'));
  assert.ok(source.includes("if: always() && hashFiles('research-isolated-evidence/preflight-status.json') != ''"));
});
test('cleanup workflow has no production environment, secrets or activation dispatch',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../workflows/research-audit-approval-lifecycle.yml'),'utf8');
  for(const token of ['environment: production','secrets.','reviewPendingDeployments','createWorkflowDispatch','ssh '])
    assert.ok(!source.includes(token),token);
  assert.ok(source.includes("github.event_name == 'push'"));assert.ok(source.includes('actions: write'));
});
test('sweeper implementation cannot approve, merge, retarget or deploy',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../scripts/research-audit-approval-lifecycle.cjs'),'utf8');
  for(const method of ['reviewPendingDeployments','createWorkflowDispatch','updateRef','createRef','execFileSync','spawnSync'])
    assert.ok(!source.includes(method),method);
});

test('inconsistent API run identities never authorize cancellation',async()=>{
  const m=mock({fresh:[{...waiting(),id:999}]});const r=await cancelStaleWaitingAudits({github:m.github,context:context()});
  assert.deepEqual(m.cancelled,[]);assert.equal(r.status,'INCOMPLETE');
});
test('different attempt or foreign job list cannot authorize cancellation',async()=>{
  for(const options of [{fresh:[waiting(),{...waiting(),run_attempt:3}]},{jobs:[{name:HOST_JOB,status:'waiting',run_id:999}]}]){
    const m=mock(options);await cancelStaleWaitingAudits({github:m.github,context:context()});assert.deepEqual(m.cancelled,[]);
  }
});
