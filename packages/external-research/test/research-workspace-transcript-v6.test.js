import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { prepareTranscriptIntake, extractTranscriptRules, prepareExtractedWorkspaceDraft } from '../src/research-workspace-transcript-v6.js';
import { prepareWorkspacePublication } from '../src/research-workspace-publisher-v4.js';
import { parseResearchWorkspaceResponse } from '../../../stock-analyzer/src/lib/research-workspace-response.js';
const now='2026-09-25T06:04:00.000Z',later='2026-09-25T06:05:00.000Z';
const digest=s=>createHash('sha256').update(s).digest('hex');
const fixture=()=>({document:{sourceId:'youtube:TEST_ONLY_VIDEO',sourceUrl:'https://www.youtube.com/watch?v=TEST_ONLY_VIDEO',title:'SYNTHETIC QA ONLY',text:'Enter above the range. Stop below the low.',format:'TIMED_TRANSCRIPT',durationSec:300,retrievedAt:now},
 selections:[{id:'c1',begin:0,end:42,startSec:10,endSec:20}],
 review:{reviewId:'test-review',sourceId:'youtube:TEST_ONLY_VIDEO',documentSha256:digest('Enter above the range. Stop below the low.'),authorizedTextUse:true,maySendToProvider:true,dataClass:'SYNTHETIC'},now});
function prepare(f=fixture()){return prepareTranscriptIntake(f);}
const answer=JSON.stringify({claims:[{kind:'ENTRY',quote:'Enter above the range.'},{kind:'STOP_LOSS',quote:'Stop below the low.'}]});
async function run(plan=prepare(),a=answer){return extractTranscriptRules({plan,provider:'groq',model:'TEST_MODEL',maxCalls:8,clock:()=>later,invoker:async()=>({answer:a,model:'TEST_MODEL',generatedAt:later})});}
const source=JSON.parse(await readFile(new URL('./fixtures/research-workspace-v2/snapshot.json',import.meta.url),'utf8'));
const policy={now:later,expectedSourceHeadSha:'a'.repeat(40),maxAgeMs:3600000};
async function draft(plan=prepare(),extraction){const e=extraction??await run(plan);return prepareExtractedWorkspaceDraft({plan,extraction:e,review:{reviewId:'semantic-review',traceDigest:e.traceDigest,sourceSemanticsAccepted:true},videoEvidence:source,policy,strategyId:'TEST_TEXT',version:'v1',market:'CRYPTO_SPOT',timeframe:'5m'});}

test('exact source text and numeric conditions retained without normalization',()=>{const f=fixture();f.document.text='Enter over 149. Stop at 146.28.';f.selections[0].end=f.document.text.length;f.review.documentSha256=digest(f.document.text);const p=prepare(f);assert.equal(p.sections[0].text,f.document.text);assert.equal(p.authority.autoCompile,false);});
test('source plan cannot be silently mutated',()=>{const p=prepare();assert.throws(()=>p.sections[0].text='other');assert.throws(()=>p.coverage.entireVideoVerified=true);});
test('wrong reviewed document rejected',()=>{const f=fixture();f.document.text+=' changed';assert.throws(()=>prepare(f),/REVIEW_REQUIRED/);});
test('source ID different from reviewer rejected',()=>{const f=fixture();f.review.sourceId='youtube:other';assert.throws(()=>prepare(f),/REVIEW_REQUIRED/);});
test('unknown classification cannot become observed',()=>{const f=fixture();f.review.dataClass='REAL';assert.throws(()=>prepare(f),/REVIEW_REQUIRED/);});
test('missing permission fails intake',()=>{const f=fixture();f.review.authorizedTextUse=false;assert.throws(()=>prepare(f),/REVIEW_REQUIRED/);});
test('untrusted URL not fetched or accepted',()=>{const f=fixture();f.document.sourceUrl='http://127.0.0.1/a';assert.throws(()=>prepare(f),/URL_INVALID/);});
test('credentials in document rejected',()=>{const f=fixture();f.document.text='api_key=private-value';assert.throws(()=>prepare(f),/DOCUMENT_INVALID/);});
test('out-of-document offset rejected',()=>{const f=fixture();f.selections[0].end=9000;assert.throws(()=>prepare(f),/OFFSET/);});
test('overlapping selections rejected',()=>{const f=fixture();f.selections.push({...f.selections[0],id:'c2'});assert.throws(()=>prepare(f),/OFFSET/);});
test('too many chunks rejected before provider',()=>{const f=fixture();f.selections=Array(9).fill(f.selections[0]);assert.throws(()=>prepare(f),/SELECTION_LIMIT/);});
test('oversize source section not silently truncated',()=>{const f=fixture();f.document.text='X'.repeat(901);f.selections[0].end=901;f.review.documentSha256=digest(f.document.text);assert.throws(()=>prepare(f),/TOO_LARGE/);});
test('timed transcript cannot extrapolate duration',()=>{const f=fixture();f.document.durationSec=null;assert.throws(()=>prepare(f),/TIMING/);});
test('fake alignment for untimed document rejected',()=>{const f=fixture();f.document.format='UNTIMED_TRANSCRIPT';assert.throws(()=>prepare(f),/CANNOT_INVENT/);});
test('untimed source is readable but carries missing-video-timing blocker',()=>{const f=fixture();f.document.format='UNTIMED_TRANSCRIPT';f.selections[0].startSec=null;f.selections[0].endSec=null;const p=prepare(f);assert.deepEqual(p.blockers,['VIDEO_TIMESTAMP_ALIGNMENT_MISSING']);});
test('only selected characters count as coverage',()=>{const f=fixture();f.document.text+=' This other section was not sent.';f.review.documentSha256=digest(f.document.text);const p=prepare(f);assert.equal(p.coverage.entireSuppliedTextSelected,false);assert.equal(p.coverage.entireVideoVerified,false);});
test('missing invoker explicitly blocks without fabricated answer',async()=>{const r=await extractTranscriptRules({plan:prepare(),provider:'groq',model:'TEST_MODEL'});assert.equal(r.status,'BLOCKED');assert.equal(r.reason,'PROVIDER_NOT_CONNECTED');assert.equal(r.callsAttempted,0);});
test('provider-use permission is separate from reading source',async()=>{const f=fixture();f.review.maySendToProvider=false;let n=0;const r=await extractTranscriptRules({plan:prepare(f),provider:'groq',model:'TEST_MODEL',invoker:async()=>n++});assert.equal(n,0);assert.equal(r.reason,'SOURCE_PROVIDER_USE_NOT_REVIEWED');});
test('forged plan cannot invoke provider',async()=>assert.rejects(()=>extractTranscriptRules({plan:{...prepare()},provider:'groq',model:'TEST_MODEL',invoker:async()=>{}}),/PLAN_REQUIRED/));
test('call budget checked before invocation',async()=>assert.rejects(()=>extractTranscriptRules({plan:prepare(),provider:'groq',model:'TEST_MODEL',maxCalls:0,invoker:async()=>{}}),/CALL_BUDGET/));
test('actual mock response preserves exact quote not invented paraphrase',async()=>{const r=await run();assert.equal(r.status,'EXTRACTED_REVIEW_REQUIRED');assert.equal(r.claims[0].quote,'Enter above the range.');assert.equal(r.claims[1].begin,23);assert.deepEqual(r.missingRuleKinds,['EXIT','POSITION_SIZING','EXECUTION_ASSUMPTION']);});
for(const [name,a] of [
 ['malformed','```json {} ```'],['extra authority',JSON.stringify({claims:[],executionAuthority:'LIVE'})],
 ['invented number',JSON.stringify({claims:[{kind:'ENTRY',quote:'Enter above 150.'}]})],
 ['performance category',JSON.stringify({claims:[{kind:'PERFORMANCE',quote:'Enter above the range.'}]})],
 ['duplicate',JSON.stringify({claims:[{kind:'ENTRY',quote:'Enter above the range.'},{kind:'ENTRY',quote:'Enter above the range.'}]})],
])test(`${name} yields incomplete record, not success`,async()=>{const r=await run(prepare(),a);assert.equal(r.status,'INCOMPLETE');assert.equal(r.callsAttempted,1);assert.ok(r.blockers.includes('EXTRACTION_INCOMPLETE'));});
test('empty AI output is no rules rather than fabricated defaults',async()=>{const p=prepare(),r=await run(p,'{"claims":[]}');assert.equal(r.claims.length,0);await assert.rejects(()=>draft(p,r),/NO_SOURCE_RULES/);});
test('wrong model identity blocks result',async()=>{const r=await extractTranscriptRules({plan:prepare(),provider:'groq',model:'TEST_MODEL',maxCalls:1,clock:()=>later,invoker:async()=>({answer,model:'other',generatedAt:later})});assert.equal(r.status,'INCOMPLETE');});
test('late provider response cannot succeed after cancel',async()=>{const c=new AbortController();const r=await extractTranscriptRules({plan:prepare(),provider:'groq',model:'TEST_MODEL',maxCalls:1,clock:()=>later,signal:c.signal,invoker:async()=>{c.abort();return {answer,model:'TEST_MODEL',generatedAt:later};}});assert.equal(r.status,'INCOMPLETE');});
test('already cancelled skips provider entirely',async()=>{const c=new AbortController();c.abort();let n=0;const r=await extractTranscriptRules({plan:prepare(),provider:'groq',model:'TEST_MODEL',maxCalls:1,clock:()=>later,signal:c.signal,invoker:async()=>n++});assert.equal(n,0);assert.equal(r.status,'INCOMPLETE');});
test('provider secrets in exception never appear in result',async()=>{const r=await extractTranscriptRules({plan:prepare(),provider:'groq',model:'TEST_MODEL',maxCalls:1,clock:()=>later,invoker:async()=>{throw new Error('api_key=secret-value');}});assert.equal(r.status,'INCOMPLETE');assert.ok(!JSON.stringify(r).includes('secret-value'));});
test('producer bridges to existing validator and missing rules remain missing',async()=>{const d=await draft();assert.equal(d.available,true);assert.equal(d.view.strategies[0].state,'RULES_INCOMPLETE');assert.equal(d.view.strategies[0].run,null);assert.equal(d.view.strategies[0].actions.scannerApply,false);assert.equal(d.backtestInvoked,false);});
test('untimed evidence never converted to a timed receipt',async()=>{const f=fixture();f.document.format='UNTIMED_TRANSCRIPT';f.selections[0].startSec=null;f.selections[0].endSec=null;const p=prepare(f);const d=await draft(p);assert.equal(d.available,false);assert.equal(d.reason,'VIDEO_TIMESTAMP_ALIGNMENT_MISSING');});
test('semantic review must match exact actual extraction',async()=>{const p=prepare(),e=await run(p);assert.throws(()=>prepareExtractedWorkspaceDraft({plan:p,extraction:e,review:{reviewId:'other',traceDigest:'f'.repeat(64),sourceSemanticsAccepted:true}}),/SEMANTIC_REVIEW/);});
test('extraction from different plan rejected',async()=>{const a=prepare(),b=prepare(),e=await run(a);await assert.rejects(()=>draft(b,e),/RECEIPT_REQUIRED/);});
test('real producer envelope works with existing Phase4 preparation and frontend parser',async()=>{
 const d=await draft(),m=new Map(d.artifacts.map(a=>[a.digest,a]));
 const p=await prepareWorkspacePublication({videoEvidence:source,registry:d.registry,policy,loadArtifact:async q=>m.get(q.digest)});
 assert.equal(p.dataClass,'SYNTHETIC');assert.equal(p.runCount,0);assert.equal(parseResearchWorkspaceResponse({available:true,workspace:d.view}).strategies.length,1);
 assert.equal(d.publicationPerformed,false);assert.equal(d.view.workerState,'UNVERIFIED');
});
test('receipt trace binds actual normalized model response',async()=>{const d=await draft(),trace=JSON.parse(d.trace.bytes);assert.equal(digest(d.trace.bytes),d.trace.digest);assert.equal(trace.calls[0].answer,answer);assert.equal(trace.originalProviderHttpBodyRetained,false);assert.equal(trace.authority.videoFramesAnalyzed,false);});
