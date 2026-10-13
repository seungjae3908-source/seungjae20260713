'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {resolveResearchTargetCi,assertSameCodeProof,proofDigest}=require('../scripts/research-target-ci-provenance.cjs');
const {REQUIRED_PRODUCTION_STATUSES}=require('../../api-server/scripts/production-ci-provenance.cjs');
const repo='seungjae3908-source/seungjae20260713',target='a'.repeat(40),head='b'.repeat(40),tree='c'.repeat(40);
const url=id=>`https://github.com/${repo}/actions/runs/${id}`;
const workflow='.github/workflows/futures-public-network-smoke.yml';
const statuses=id=>REQUIRED_PRODUCTION_STATUSES.map((context,i)=>({id:i+1,context,state:'success',target_url:url(id),created_at:'2026-10-13T01:00:00Z'}));
const context=()=>({eventName:'issue_comment',ref:'refs/heads/main',sha:target,actor:'seungjae3908-source',runId:900,
 repo:{owner:'seungjae3908-source',repo:'seungjae20260713'},payload:{action:'created',issue:{number:1102,state:'open'},
 comment:{author_association:'OWNER',user:{login:'seungjae3908-source'},body:'/activate-research-production '+target}}});
function fixture({direct=false}={}) {
 const f={mains:[target],runs:[],targetStatuses:[],headStatuses:statuses(100),active:[],calls:[],targetRunReads:0,targetStatusReads:0};
 const meta={repository:{full_name:repo},head_repository:{full_name:repo},run_attempt:1};
 f.ci={...meta,id:100,name:'Application CI',path:workflow,head_sha:head,head_branch:'research/test',event:'workflow_dispatch',status:'completed',conclusion:'success',updated_at:'2026-10-13T01:00:00Z'};
 f.post={...meta,id:200,name:'Post-Merge Release Provenance',path:'.github/workflows/post-merge-release-provenance.yml',head_sha:target,head_branch:'main',event:'push',status:'completed',conclusion:'success'};
 f.mainRun={...meta,id:300,name:'Application CI',path:workflow,head_sha:target,head_branch:'main',event:'workflow_dispatch',status:'completed',conclusion:'success'};
 f.pr={number:10,state:'closed',merged_at:'2026-10-13T02:00:00Z',merge_commit_sha:target,
  base:{ref:'main',repo:{full_name:repo}},head:{ref:'research/test',sha:head,repo:{full_name:repo}}};
 f.commits={[target]:{sha:target,commit:{tree:{sha:tree}}},[head]:{sha:head,commit:{tree:{sha:tree}}}};
 f.targetStatuses=direct?statuses(300):[{id:20,context:'post-merge-provenance/verified',state:'success',target_url:url(200),created_at:'2026-10-13T02:10:00Z'}];
 f.runs=direct?[f.mainRun]:[];f.headRuns=[f.ci];f.related=[{number:10}];
 let mi=0;
 f.github={rest:{repos:{listCommitStatusesForRef:'statuses',listPullRequestsAssociatedWithCommit:'prs',
 getBranch:async()=>{f.calls.push('main');return{data:{commit:{sha:f.mains[Math.min(mi++,f.mains.length-1)]}}};},
 getCommit:async({ref})=>({data:f.commits[ref]})},pulls:{get:async()=>({data:f.pr})},actions:{listWorkflowRunsForRepo:'runs',
 getWorkflowRun:async({run_id})=>{f.calls.push('run:'+run_id);return{data:[f.ci,f.post,f.mainRun,...f.headRuns,...f.runs].find(r=>r.id===run_id)};}}},
 paginate:async(api,options)=>{
  f.calls.push(api);
  if(f.networkError)throw Error('token=do-not-log');
  if(api==='statuses'){
   if(options.ref===head)return f.headStatuses;
   f.targetStatusReads++;return f.targetStatusReads>1&&f.laterStatuses?f.laterStatuses:f.targetStatuses;
  }
  if(api==='prs')return f.related;
  if(api==='runs'){
   if(options.status)return f.active;
   if(options.head_sha===head)return f.headRuns;
   f.targetRunReads++;return f.targetRunReads>1&&f.laterRuns?f.laterRuns:f.runs;
  }
  throw Error('UNEXPECTED_API');
 }};
 return f;
}
const resolve=f=>resolveResearchTargetCi({github:f.github,context:context(),targetSha:target});
test('canonical Required6 and identical merged tree works without rerunning main Full CI',async()=>{
 const f=fixture(),p=await resolve(f);assert.equal(p.testedHeadSha,head);assert.equal(p.targetSha,target);
 assert.equal(p.requiredCiRunId,100);assert.equal(p.postMergeRunId,200);assert.equal(p.sourcePullRequest,10);
 assert.equal(p.executionAuthority,'NONE');assert.equal(p.proofMode,'CANONICAL_PREMERGE_SIX_AND_IDENTICAL_MERGED_TREE');
 assert.match(proofDigest(p),/^[a-f0-9]{64}$/u);
});
test('real direct-main Required6 remains accepted',async()=>{
 const f=fixture({direct:true}),p=await resolve(f);assert.equal(p.testedHeadSha,target);assert.equal(p.requiredCiRunId,300);
 assert.equal(p.proofMode,'EXACT_CURRENT_MAIN_SIX');assert.equal(p.postMergeRunId,null);
 assert.ok(!f.calls.includes('prs'));
});
for(const state of ['failure','cancelled','timed_out','action_required','stale'])test('new direct main '+state+' never downgrades to prior proof',async()=>{
 const f=fixture({direct:true});f.mainRun.conclusion=state;await assert.rejects(resolve(f),/DIRECT_MAIN_NOT_VERIFIED/u);
 assert.ok(!f.calls.includes('prs'));
});
for(const state of ['queued','in_progress','waiting','pending'])test('nonterminal direct '+state+' cannot become release PASS',async()=>{
 const f=fixture({direct:true});f.mainRun.status=state;f.mainRun.conclusion=null;await assert.rejects(resolve(f));
});
for(const [name,mutate] of [
 ['missing required check',f=>f.headStatuses.pop()],
 ['failed required check',f=>{f.headStatuses[0].state='failure';}],
 ['mixed runs',f=>{f.headStatuses[0].target_url=url(101);}],
 ['foreign status URL',f=>{f.headStatuses[0].target_url='https://foreign.invalid/actions/runs/100';}],
 ['different merged tree',f=>{f.commits[head].commit.tree.sha='d'.repeat(40);}],
 ['unmerged PR',f=>{f.pr.merged_at=null;}],
 ['foreign PR',f=>{f.pr.head.repo.full_name='other/repo';}],
 ['missing postmerge proof',f=>{f.targetStatuses=[];}],
 ['bad postmerge proof',f=>{f.post.conclusion='failure';}],
 ['postmerge wrong target',f=>{f.post.head_sha=head;}],
 ['CI after merge',f=>{f.ci.updated_at='2026-10-13T03:00:00Z';}],
 ['wrong tested head',f=>{f.ci.head_sha=target;}],
 ['newer failed head run',f=>{f.headRuns.push({...f.ci,id:101,conclusion:'failure'});}],
 ['newer pending head run',f=>{f.headRuns.push({...f.ci,id:101,status:'in_progress',conclusion:null});}],
 ['duplicate PR match',f=>{f.related.push({number:10});}],
 ['active mutation conflict',f=>{f.active.push({id:901,event:'issue_comment',status:'in_progress',path:'.github/workflows/production-deploy.yml'});}],
])test('canonical path rejects '+name,async()=>{const f=fixture();mutate(f);await assert.rejects(resolve(f));});
for(const [name,mutate] of [
 ['missing direct check',f=>f.targetStatuses.pop()],
 ['foreign repo run',f=>{f.mainRun.repository.full_name='other/repo';}],
 ['foreign direct status',f=>{f.targetStatuses[0].target_url='https://other.invalid/actions/runs/300';}],
 ['commit lookup mismatch',f=>{f.commits[target].sha=head;}],
 ['newer direct failed run',f=>{f.runs.push({...f.mainRun,id:301,conclusion:'failure'});}],
])test('direct path rejects '+name,async()=>{const f=fixture({direct:true});mutate(f);await assert.rejects(resolve(f));});
test('orphan direct target statuses do not permit canonical fallback',async()=>{
 const f=fixture();f.targetStatuses.push(statuses(300)[0]);await assert.rejects(resolve(f),/ORPHAN_TARGET_STATUSES/u);
});
test('main changes before or during resolution fail closed',async()=>{
 for(const mains of [[head],[target,head],[target,target,head]]){
  const f=fixture();f.mains=mains;await assert.rejects(resolve(f));
 }
});
test('new target run or status observed at final read blocks an already-selected proof',async()=>{
 const f=fixture({direct:true});f.laterRuns=[{...f.mainRun,id:301,conclusion:'failure'}];await assert.rejects(resolve(f),/TARGET_RUNS_CHANGED/u);
 const g=fixture({direct:true});g.laterStatuses=[...g.targetStatuses,{...g.targetStatuses[0],id:100,state:'failure'}];await assert.rejects(resolve(g),/TARGET_STATUSES_CHANGED/u);
});
test('API failure cannot become missing data or expose credentials',async()=>{
 const f=fixture();f.networkError=true;await assert.rejects(resolve(f),error=>error.message==='RESEARCH_TARGET_CI_METADATA_UNAVAILABLE');
});
for(const [name,mutate] of [
 ['wrong command',c=>{c.payload.comment.body='/run-research-isolated '+target+' --audit';}],
 ['wrong command sha',c=>{c.payload.comment.body='/activate-research-production '+head;}],
 ['wrong owner',c=>{c.actor='other';}],
 ['wrong hub',c=>{c.payload.issue.number=1555;}],
 ['wrong ref',c=>{c.ref='refs/heads/other';}],
 ['different event sha',c=>{c.sha=head;}],
 ['PR masquerading as issue',c=>{c.payload.issue.pull_request={};}],
])test('reject '+name,async()=>{const f=fixture(),c=context();mutate(c);await assert.rejects(resolveResearchTargetCi({github:f.github,context:c,targetSha:target}));});
test('approval comparison binds all proof fields, not only target SHA',async()=>{
 const p=await resolve(fixture());assert.deepEqual(assertSameCodeProof(p,{...p}),p);
 for(const [k,v] of Object.entries({testedHeadSha:target,requiredCiRunId:101,postMergeRunId:201,sourcePullRequest:11,targetTreeSha:'d'.repeat(40)}))
  assert.throws(()=>assertSameCodeProof(p,{...p,[k]:v}),/APPROVED_PROOF_CHANGED/u);
 assert.throws(()=>proofDigest({...p,executionAuthority:'LIVE'}));
 assert.throws(()=>proofDigest({...p,secret:'not-allowed'}));
});
