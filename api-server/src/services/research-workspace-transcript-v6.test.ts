import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createCanonicalTranscriptInvoker } from './research-workspace-transcript-v6';
const keys=['AI_CHAT_PROVIDER','AI_CHAT_API_KEY','AI_CHAT_MODEL','OPENAI_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','GEMINI_MODEL','GROQ_API_KEY','GROQ_MODEL'];
const message='Classify this historical source excerpt only. Return exactly {"claims":[]}. TEXT_JSON="Waiting for a confirmed range."';
function env(t:test.TestContext,provider:'groq'|'gemini') {
 const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));keys.forEach(k=>delete process.env[k]);
 process.env.AI_CHAT_PROVIDER=provider;process.env[provider==='groq'?'GROQ_API_KEY':'GEMINI_API_KEY']='SYNTHETIC_TEST_KEY';
 process.env[provider==='groq'?'GROQ_MODEL':'GEMINI_MODEL']='test-source-model';
 t.after(()=>{for(const k of keys){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}});
}
function opts(text=message){return {signal:new AbortController().signal,expectedPromptSha256:createHash('sha256').update(text).digest('hex')};}
function harness(provider:'groq'|'gemini',overrides:Record<string,unknown>={}){
 let calls=0;let url='';let body='';
 const fetchImpl:typeof fetch=async(input,init)=>{calls++;url=String(input);body=String(init?.body);return new Response(JSON.stringify(provider==='groq'?{choices:[{message:{content:'{"claims":[]}'}}]}:{candidates:[{content:{parts:[{text:'{"claims":[]}' }]}}]}),{status:200,headers:{'content-type':'application/json'}});};
 const invoke=createCanonicalTranscriptInvoker({provider,model:'test-source-model',freeTierReviewed:true,approve:async()=>true,fetchImpl,...overrides});
 return {invoke,read:()=>({calls,url,body})};
}
for(const provider of ['groq','gemini'] as const)test(`uses actual canonical ${provider} transport with synthetic HTTP response`,async t=>{
 env(t,provider);const h=harness(provider),before=JSON.stringify(Object.fromEntries(keys.map(k=>[k,process.env[k]])));
 const r=await h.invoke(message,opts());assert.equal(r.answer,'{"claims":[]}');assert.equal(r.model,'test-source-model');assert.equal(h.read().calls,1);
 assert.equal(before,JSON.stringify(Object.fromEntries(keys.map(k=>[k,process.env[k]]))));assert.ok(h.read().body.includes('publicContext'));
});
test('unreviewed free tier is not assumed',()=>assert.throws(()=>createCanonicalTranscriptInvoker({provider:'groq',model:'test',freeTierReviewed:false,approve:async()=>true}),/REVIEW_REQUIRED/));
test('provider fallback credentials block before network',async t=>{env(t,'gemini');process.env.GROQ_API_KEY='TEST_OTHER';const h=harness('gemini');await assert.rejects(()=>h.invoke(message,opts()),/ISOLATION/);assert.equal(h.read().calls,0);});
test('generic paid override blocks before network',async t=>{env(t,'groq');process.env.AI_CHAT_API_KEY='TEST';const h=harness('groq');await assert.rejects(()=>h.invoke(message,opts()),/ISOLATION/);assert.equal(h.read().calls,0);});
test('missing exact model configuration blocks',async t=>{env(t,'groq');delete process.env.GROQ_MODEL;const h=harness('groq');await assert.rejects(()=>h.invoke(message,opts()),/ISOLATION/);});
test('approval denial sends nothing',async t=>{env(t,'groq');const h=harness('groq',{approve:async()=>false});await assert.rejects(()=>h.invoke(message,opts()),/NOT_APPROVED/);assert.equal(h.read().calls,0);});
test('hash mismatch sends nothing',async t=>{env(t,'groq');const h=harness('groq');await assert.rejects(()=>h.invoke(message,{...opts(),expectedPromptSha256:'0'.repeat(64)}),/WOULD_CHANGE/);assert.equal(h.read().calls,0);});
test('oversize cannot silently truncate',async t=>{env(t,'groq');const h=harness('groq'),m='X'.repeat(2001);await assert.rejects(()=>h.invoke(m,opts(m)),/WOULD_CHANGE/);assert.equal(h.read().calls,0);});
test('canonical normalization cannot silently modify evidence',async t=>{env(t,'groq');const h=harness('groq'),m='a <b>word</b>';await assert.rejects(()=>h.invoke(m,opts(m)),/WOULD_CHANGE/);assert.equal(h.read().calls,0);});
test('cancelled request sends nothing',async t=>{env(t,'groq');const h=harness('groq'),o=opts(),c=new AbortController();c.abort();await assert.rejects(()=>h.invoke(message,{...o,signal:c.signal}),/CANCELLED/);assert.equal(h.read().calls,0);});
test('current-data source text is not disguised to bypass canonical refusal',async t=>{env(t,'groq');const h=harness('groq'),m='오늘 거래량을 설명한 원문';await assert.rejects(()=>h.invoke(m,opts(m)),/UNVERIFIED/);assert.equal(h.read().calls,0);});
test('provider limit is not retried or redirected to paid provider',async t=>{env(t,'groq');let calls=0;const h=harness('groq',{fetchImpl:async()=>{calls++;return new Response('{}',{status:429});}});await assert.rejects(()=>h.invoke(message,opts()));assert.equal(calls,1);});
