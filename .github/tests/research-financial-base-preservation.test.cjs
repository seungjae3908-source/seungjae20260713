'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FINANCIAL_PATHS, verifyFinancialPreservation, authorizeResearchFinancialPreservation } =
  require('../scripts/research-financial-base-preservation.cjs');
const repo = 'seungjae3908-source/seungjae20260713';
const base = 'a'.repeat(40), head = 'b'.repeat(40), treeA = 'c'.repeat(40), treeB = 'd'.repeat(40);
function fixture() {
  const tree = FINANCIAL_PATHS.map((path, i) => ({path, type: 'blob', mode: '100644', sha: String(i + 1).repeat(40)}));
  return { baseSha: base, headSha: head, baseTreeSha: treeA, headTreeSha: treeB,
    baseTree: {sha: treeA, truncated: false, tree},
    headTree: {sha: treeB, truncated: false, tree: structuredClone(tree)} };
}
const context = () => ({eventName:'pull_request',repo:{owner:'seungjae3908-source',repo:'seungjae20260713'},
  payload:{pull_request:{number:1876,head:{sha:head}}}});
const pull = () => ({number:1876,state:'open',base:{ref:'main',sha:base,repo:{full_name:repo}},head:{sha:head,repo:{full_name:repo}}});
function api({ moveMain=false, moveHead=false, failRead=false, wrongCommit=false, altered=false, truncated=false }={}) {
  const value=fixture();let reads=0,pulls=0;const calls=[];
  if(altered)value.headTree.tree[0].sha='f'.repeat(40);
  if(truncated)value.headTree.truncated=true;
  const github={rest:{repos:{getBranch:async()=>{calls.push('main');return{data:{commit:{sha:moveMain&&++reads>1?head:base}}};},
    getCommit:async({ref})=>{if(failRead)throw Error('network denied');calls.push(ref);return{data:{sha:wrongCommit?head:ref,commit:{tree:{sha:ref===base?treeA:treeB}}}};}},
    pulls:{get:async()=>{const p=pull();if(moveHead&&++pulls>1)p.head.sha=base;return{data:p};}},
    git:{getTree:async({tree_sha,recursive})=>{assert.equal(recursive,'1');return{data:tree_sha===treeA?value.baseTree:value.headTree};}}}};
  return{github,calls};
}
test('exact candidate preserves all five actual current-base financial blobs',()=>{
  const result=verifyFinancialPreservation(fixture());assert.equal(result.checkedPaths,5);
  assert.equal(result.executionAuthority,'NONE');
});
test('approved new financial base is valid without perpetually pinning an old release',()=>{
  const f=fixture();f.baseTree.tree[0].sha='e'.repeat(40);f.headTree.tree[0].sha='e'.repeat(40);
  assert.equal(verifyFinancialPreservation(f).protectedFilesUnchanged,true);
});
for(let i=0;i<FINANCIAL_PATHS.length;i++)test('reject financial rollback/change: '+FINANCIAL_PATHS[i],()=>{
  const f=fixture();f.headTree.tree[i].sha='f'.repeat(40);
  assert.throws(()=>verifyFinancialPreservation(f),/PROTECTED_PATH_CHANGED/u);
});
for(const [label,mutate]of[
  ['missing file',f=>f.headTree.tree.pop()],
  ['duplicate file',f=>{f.headTree.tree[1]=f.headTree.tree[0];}],
  ['symbolic link',f=>{f.headTree.tree[0].mode='120000';}],
  ['directory',f=>{f.headTree.tree[0].type='tree';}],
  ['unrecognized file SHA',f=>{f.headTree.tree[0].sha='main';}],
  ['truncated response',f=>{f.headTree.truncated=true;}],
  ['unknown truncation',f=>{delete f.headTree.truncated;}],
  ['foreign tree',f=>{f.headTree.sha=treeA;}],
  ['missing base',f=>{f.baseSha=null;}],
])test('reject '+label,()=>{const f=fixture();mutate(f);assert.throws(()=>verifyFinancialPreservation(f));});
test('real resolver binds base and head to live PR and exact checkout using read APIs only',async()=>{
  const a=api();const proof=await authorizeResearchFinancialPreservation({github:a.github,context:context(),checkedOutSha:head});
  assert.equal(proof.baseSha,base);assert.equal(proof.headSha,head);assert.deepEqual(a.calls,['main',base,head,'main']);
});
for(const [label,opts]of Object.entries({mainMoved:{moveMain:true},headMoved:{moveHead:true},networkFailure:{failRead:true},
  commitMismatch:{wrongCommit:true},rollback:{altered:true},truncated:{truncated:true}}))
  test('resolver rejects '+label,async()=>await assert.rejects(authorizeResearchFinancialPreservation({github:api(opts).github,context:context(),checkedOutSha:head})));
for(const [label,mutate]of[
  ['foreign repo',c=>{c.repo.owner='other';}],['wrong event',c=>{c.eventName='workflow_dispatch';}],
  ['invalid pull number',c=>{c.payload.pull_request.number=0;}],['missing exact SHA',c=>{c.payload.pull_request.head.sha='branch';}],
])test('reject '+label,async()=>{const c=context();mutate(c);await assert.rejects(authorizeResearchFinancialPreservation({github:api().github,context:c,checkedOutSha:head}));});
test('reject checked out revision different from event head',async()=>await assert.rejects(
  authorizeResearchFinancialPreservation({github:api().github,context:context(),checkedOutSha:base})));
