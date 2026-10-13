import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareVideoResearch, videoRequestBody, executeVideoResearch, verifyVideoCallApproval } from '../src/research-workspace-video-v7.js';
import { runVideoCli } from '../scripts/run-research-video-v7.mjs';
const now='2026-09-26T02:50:00.000Z';
const spec=()=>({schemaVersion:'research-video-spec-v7',videoUrl:'https://www.youtube.com/watch?v=TEST_VIDEO1',sourceReviewId:'TEST_ONLY',publicAccessReviewed:true,
  durationSec:600,clipStartSec:60,clipEndSec:120,model:'gemini-test-model',acceptedReportedModels:['gemini-test-model'],maxOutputTokens:1024,timeoutMs:1000});
const grant=plan=>({schemaVersion:'research-video-call-approval-v7',approvalId:'TEST_APPROVAL_ONLY',planDigest:plan.planDigest,
  notBefore:'2026-09-26T02:49:00.000Z',expiresAt:'2026-09-26T02:59:00.000Z',maxCalls:1,sourceUseApproved:true,freeTierReviewed:true,paidFallback:false,executionAuthority:'NONE'});
const payload=()=>({videoId:'TEST_VIDEO1',observations:[{atSec:70,kind:'ENTRY',description:'Synthetic description, not observed video evidence.'}],limitations:['TEST FIXTURE ONLY']});
const provider=()=>({modelVersion:'gemini-test-model',candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(payload())}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:30,totalTokenCount:130}});
const response=(body=provider(),status=200)=>new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
function harness(overrides={}) {
  const plan=prepareVideoResearch(spec()),calls=[];
  const opts={plan,loadApproval:async()=>grant(plan),reserve:async()=>true,readCredential:async()=>'TEST_ONLY_CREDENTIAL',clock:()=>now,
    fetchImpl:async(url,init)=>{calls.push({url,init});return response();},...overrides};
  return {plan,calls,opts,run:()=>executeVideoResearch(opts)};
}
for(const [key,value] of [['videoUrl','http://www.youtube.com/watch?v=TEST_VIDEO1'],['videoUrl','https://youtube.com.evil.test/watch?v=TEST_VIDEO1'],
 ['videoUrl','https://www.youtube.com/watch?v=TEST_VIDEO1&key=secret'],['videoUrl','http://127.0.0.1'],['publicAccessReviewed',false],
 ['durationSec',null],['clipStartSec',-1],['clipEndSec',601],['clipEndSec',60],['clipEndSec',400],['model','gemini-x/../y'],
 ['acceptedReportedModels',[]],['maxOutputTokens',9000],['timeoutMs',0],['timeoutMs',70000]])test(`plan rejects ${key} ${String(value)}`,()=>assert.throws(()=>prepareVideoResearch({...spec(),[key]:value}),/VIDEO_|MODEL_|YOUTUBE/));
test('unknown spec fields cannot inject tools or override endpoint',()=>assert.throws(()=>prepareVideoResearch({...spec(),tools:['execute']}),/SPEC_INVALID/));
test('plan is immutable and stable across key order',()=>{const a=spec(),b=Object.fromEntries(Object.entries(a).reverse()),p=prepareVideoResearch(a);assert.equal(p.planDigest,prepareVideoResearch(b).planDigest);a.clipEndSec=80;assert.equal(p.spec.clipEndSec,120);assert.throws(()=>{p.spec.clipEndSec=70;});});
test('video is a real media part with correct absolute clip metadata',()=>{const p=prepareVideoResearch(spec()),b=JSON.parse(videoRequestBody(p));assert.equal(b.contents[0].parts[0].fileData.fileUri,spec().videoUrl);assert.deepEqual(b.contents[0].parts[0].videoMetadata,{startOffset:'60s',endOffset:'120s',fps:1});assert.equal(b.generationConfig.maxOutputTokens,1024);assert.equal(b.tools,undefined);assert.equal(b.safetySettings,undefined);assert.equal(p.videoBytesSha256,null);});
test('serialized plans cannot be submitted without revalidation',async()=>{const h=harness();await assert.rejects(executeVideoResearch({...h.opts,plan:structuredClone(h.plan)}),/PLAN_REQUIRED/);});
test('single official POST no fallback, raw response preserved, no source promotion',async()=>{const h=harness(),r=await h.run();assert.equal(r.receipt.status,'RESPONSE_RECEIVED_REVIEW_REQUIRED');assert.equal(h.calls.length,1);assert.equal(h.calls[0].init.redirect,'error');assert.equal(h.calls[0].init.method,'POST');assert.equal(r.receipt.observations[0].semanticReview,'PENDING');assert.equal(r.receipt.observations[0].timestampVerified,false);assert.equal(r.receipt.sourceTruthVerified,false);assert.equal(r.receipt.run,null);assert.equal(r.receipt.authority.actualOrders,0);assert.equal(r.receipt.authority.autoPublish,false);assert.equal(r.receipt.responseSha256,createHash('sha256').update(r.rawResponse).digest('hex'));assert.ok(!JSON.stringify(r.receipt).includes('TEST_ONLY_CREDENTIAL'));});
test('same in-memory plan cannot be replayed',async()=>{const h=harness();await h.run();await assert.rejects(h.run(),/ALREADY_ATTEMPTED/);assert.equal(h.calls.length,1);});
test('concurrent same-plan calls cannot both send',async()=>{const h=harness(),both=await Promise.allSettled([h.run(),h.run()]);assert.equal(h.calls.length,1);assert.equal(both.filter(x=>x.status==='rejected').length,1);});
for(const [key,value] of [['planDigest','0'.repeat(64)],['freeTierReviewed',false],['paidFallback',true],['maxCalls',2],['sourceUseApproved',false],['executionAuthority','LIVE'],['expiresAt','2026-09-26T02:49:59.000Z'],['notBefore','2026-09-26T02:51:00.000Z']])test(`approval rejects ${key}`,async()=>{const h=harness();h.opts.loadApproval=async()=>({...grant(h.plan),[key]:value});const r=await h.run();assert.equal(r.receipt.status,'BLOCKED');assert.equal(h.calls.length,0);});
test('missing credentials are not a provider failure or a fallback',async()=>{const h=harness({readCredential:()=>null}),r=await h.run();assert.equal(r.receipt.reason,'VIDEO_CREDENTIAL_MISSING');assert.equal(h.calls.length,0);});
test('revocation after durable reservation sends nothing',async()=>{const h=harness();let n=0;h.opts.loadApproval=async()=>({...grant(h.plan),sourceUseApproved:++n<3});const r=await h.run();assert.equal(r.receipt.status,'BLOCKED');assert.equal(h.calls.length,0);});
test('second caller loses durable reservation even with a fresh object',async()=>{const h=harness({reserve:async()=>false}),r=await h.run();assert.equal(r.receipt.reason,'VIDEO_CALL_ALREADY_RESERVED');assert.equal(h.calls.length,0);});
test('already aborted sends nothing',async()=>{const a=new AbortController();a.abort();const h=harness({signal:a.signal}),r=await h.run();assert.equal(r.receipt.reason,'VIDEO_CALL_CANCELLED');assert.equal(h.calls.length,0);});
test('late approval timeout cannot issue a request afterwards',async()=>{let release;const h=harness({loadApproval:()=>new Promise(r=>{release=r;})});const r=await h.run();assert.equal(r.receipt.status,'BLOCKED');release(grant(h.plan));await new Promise(r=>setTimeout(r,10));assert.equal(h.calls.length,0);});
test('hung transport is bounded and not retried',async()=>{const h=harness();h.opts.fetchImpl=async()=>{h.calls.push(1);return new Promise(()=>{});};const r=await h.run();assert.equal(r.receipt.status,'FAILED_OR_UNCERTAIN');assert.equal(r.receipt.callsAttempted,1);assert.equal(h.calls.length,1);});
test('429 response is retained and never retried',async()=>{const h=harness({fetchImpl:async()=>response({error:{message:'quota exceeded'}},429)}),r=await h.run();assert.equal(r.receipt.reason,'VIDEO_RATE_LIMITED');assert.equal(r.receipt.callsAttempted,1);assert.ok(r.rawResponse);});
test('nonJSON provider failure does not become analysis',async()=>{const h=harness({fetchImpl:async()=>new Response('<html>error</html>',{status:502})}),r=await h.run();assert.equal(r.receipt.status,'FAILED_OR_UNCERTAIN');assert.equal(r.receipt.observations,undefined);});
for(const [name,mutate,reason] of [
 ['blocked',b=>b.promptFeedback={blockReason:'SAFETY'},'VIDEO_PROVIDER_BLOCKED'],
 ['truncated',b=>b.candidates[0].finishReason='MAX_TOKENS','VIDEO_RESPONSE_INCOMPLETE'],
 ['missing model',b=>delete b.modelVersion,'VIDEO_REPORTED_MODEL_UNREVIEWED'],
 ['changed model',b=>b.modelVersion='gemini-other','VIDEO_REPORTED_MODEL_UNREVIEWED'],
 ['two candidates',b=>b.candidates.push(b.candidates[0]),'VIDEO_RESPONSE_INCOMPLETE'],
 ['tool',b=>b.candidates[0].content.parts=[{functionCall:{name:'trade'}}],'VIDEO_RESPONSE_PARTS_INVALID'],
 ['bad json',b=>b.candidates[0].content.parts[0].text='no json','VIDEO_OUTPUT_JSON_INVALID']
])test(`raw response ${name} rejected`,async()=>{const b=provider();mutate(b);const h=harness({fetchImpl:async()=>response(b)}),r=await h.run();assert.equal(r.receipt.reason,reason);assert.ok(r.rawResponse);});
for(const [name,mutate,reason] of [
 ['wrong video',p=>p.videoId='ANOTHER1234','VIDEO_OUTPUT_SCHEMA_INVALID'],
 ['relative time',p=>p.observations[0].atSec=10,'VIDEO_OBSERVATION_INVALID'],
 ['end boundary',p=>p.observations[0].atSec=120,'VIDEO_OBSERVATION_INVALID'],
 ['time string',p=>p.observations[0].atSec='01:10','VIDEO_OBSERVATION_INVALID'],
 ['unknown kind',p=>p.observations[0].kind='ORDER','VIDEO_OBSERVATION_INVALID'],
 ['duplicate',p=>p.observations.push(p.observations[0]),'VIDEO_DUPLICATE_OBSERVATION'],
 ['authority',p=>p.executionAuthority='LIVE','VIDEO_OUTPUT_SCHEMA_INVALID']
])test(`model claims ${name} rejected`,async()=>{const p=payload();mutate(p);const b=provider();b.candidates[0].content.parts[0].text=JSON.stringify(p);const h=harness({fetchImpl:async()=>response(b)}),r=await h.run();assert.equal(r.receipt.reason,reason);});
test('no observations is insufficient evidence not a winning strategy',async()=>{const p=payload();p.observations=[];const b=provider();b.candidates[0].content.parts[0].text=JSON.stringify(p);const r=await harness({fetchImpl:async()=>response(b)}).run();assert.equal(r.receipt.status,'INSUFFICIENT_EVIDENCE');assert.equal(r.receipt.missingRuleKinds.length,5);});
test('echoed credential is not saved in raw bytes',async()=>{const r=await harness({fetchImpl:async()=>response({error:'TEST_ONLY_CREDENTIAL'})}).run();assert.equal(r.receipt.reason,'VIDEO_RESPONSE_SENSITIVE');assert.equal(r.rawResponse,null);assert.ok(r.receipt.responseSha256);});
test('oversized stream cannot be retained as a valid result',async()=>{const r=await harness({fetchImpl:async()=>response('x'.repeat(256*1024+1))}).run();assert.equal(r.receipt.reason,'VIDEO_RESPONSE_TOO_LARGE');assert.equal(r.rawResponse,null);});
test('slow response stream deadline remains enforced',async()=>{let cancel=false;const r=await harness({fetchImpl:async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancel=true;}}),{headers:{'content-type':'application/json'}})}).run();assert.equal(r.receipt.status,'FAILED_OR_UNCERTAIN');assert.equal(r.receipt.callsAttempted,1);assert.equal(cancel,true);});
test('raw provider errors never leak into the receipt',async()=>{const r=await harness({fetchImpl:async()=>{throw new Error('private internal account info');}}).run();assert.equal(r.receipt.reason,'VIDEO_EXECUTION_FAILED');assert.ok(!JSON.stringify(r).includes('private internal'));});

async function cliFixture(t) {
 const root=await mkdtemp(join(tmpdir(),'video-v7-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'spec.json');await writeFile(file,JSON.stringify(spec()),{mode:0o600});return {root,file};
}
test('CLI prepare default never accesses key or network',async t=>{const f=await cliFixture(t);let calls=0;const env=new Proxy({},{get(){throw new Error('must not access key');}});const r=await runVideoCli(['--spec',f.file,'--output-root',f.root],{env,fetchImpl:async()=>{calls++;throw new Error('network');}});assert.equal(r.status,'PREPARED_NOT_EXECUTED');assert.equal(calls,0);assert.equal(r.credentialRead,false);const saved=JSON.parse(await readFile(join(f.root,r.planDigest+'-prepared','request.json'),'utf8'));assert.ok(saved.contents[0].parts[0].fileData);});
test('CLI rejects relative path and write unsafe root',async t=>{await assert.rejects(runVideoCli(['--spec','./x','--output-root','/tmp']),/ABSOLUTE/);const f=await cliFixture(t);await chmod(f.root,0o755);await assert.rejects(runVideoCli(['--spec',f.file,'--output-root',f.root]),/ROOT_UNSAFE/);});
test('CLI cannot mint approval or accept an arbitrary endpoint',async()=>{await assert.rejects(runVideoCli(['--auto-approve']),/ARGUMENTS/);await assert.rejects(runVideoCli(['--endpoint','https://evil.test']),/ARGUMENTS/);});
test('CLI publishes only offline evidence files, never workspace policy',async t=>{const f=await cliFixture(t),plan=prepareVideoResearch(spec()),approval=join(f.root,'reviewed.json');await writeFile(approval,JSON.stringify(grant(plan)),{mode:0o600});let calls=0;const r=await runVideoCli(['--spec',f.file,'--output-root',f.root,'--execute','--approval',approval],{env:{GEMINI_API_KEY:'TEST_ONLY_CREDENTIAL'},clock:()=>now,fetchImpl:async()=>{calls++;return response();}});assert.equal(r.status,'RESPONSE_RECEIVED_REVIEW_REQUIRED');assert.equal(calls,1);assert.ok((await readdir(f.root)).some(p=>p.startsWith('call-')));assert.ok(!(await readdir(f.root)).includes('policy.json'));const files=await readdir(join(f.root,r.planDigest+'-execution'));assert.deepEqual(files.sort(),['plan.json','provider-response.json','receipt.json','request.json']);});
test('CLI durable duplicate protection survives process/object recreation',async t=>{const f=await cliFixture(t),plan=prepareVideoResearch(spec()),approval=join(f.root,'reviewed.json');await writeFile(approval,JSON.stringify(grant(plan)),{mode:0o600});const args=['--spec',f.file,'--output-root',f.root,'--execute','--approval',approval];const opts={env:{GEMINI_API_KEY:'TEST_ONLY_CREDENTIAL'},clock:()=>now,fetchImpl:async()=>response()};await runVideoCli(args,opts);await assert.rejects(runVideoCli(args,opts),/RUN_ALREADY_EXISTS/);});
test('CLI missing key records blocked with no fake response',async t=>{const f=await cliFixture(t),plan=prepareVideoResearch(spec()),approval=join(f.root,'reviewed.json');await writeFile(approval,JSON.stringify(grant(plan)),{mode:0o600});const r=await runVideoCli(['--spec',f.file,'--output-root',f.root,'--execute','--approval',approval],{env:{},clock:()=>now});assert.equal(r.status,'BLOCKED');assert.equal(r.callsAttempted,0);assert.ok(!(await readdir(join(f.root,r.planDigest+'-execution'))).includes('provider-response.json'));});
test('real command help works without runtime or credentials',()=>{const r=spawnSync(process.execPath,['packages/external-research/scripts/run-research-video-v7.mjs','--help'],{encoding:'utf8'});assert.equal(r.status,0);assert.match(r.stdout,/Prepare only/);});
