const test=require('node:test');
const assert=require('node:assert/strict');
const {evaluatePreflightV13}=require('./research-workspace-one-shot-preflight-v13.cjs');

const now='2026-09-26T07:00:00.000Z';
const sha='a'.repeat(40);
function processRow(overrides={}){
  return {name:'stock-app',pid:123,pm2_env:{
    status:'online',DEPLOY_SHA:sha,
    LIVE_TRADING:'false',AUTO_TRADING:'false',REAL_ORDER_ENABLED:'false',PRIVATE_TRADING_API_ALLOWED:'false',ORDER_EXECUTION_ENABLED:'false',
    executionAuthority:'NONE',GEMINI_API_KEY:'abcdefghijk',GROQ_API_KEY:'abcdefghijk',GROQ_MODEL:'groq-test',
    ...overrides,
  }};
}
function files(){
  const manifest={schemaVersion:'research-one-shot-manifest-v12',manifestDigest:'b'.repeat(64),sourceId:'source-1',
    videoPlanDigest:'c'.repeat(64),orchestratorPlanDigest:'d'.repeat(64)};
  return {
    source:{exists:true,safe:true,value:{sourceId:'source-1',canonicalUrl:'https://www.youtube.com/watch?v=abcdefghijk',videoId:'abcdefghijk'}},
    spec:{exists:true,safe:true,value:{schemaVersion:'research-video-spec-v7',videoUrl:'https://www.youtube.com/watch?v=abcdefghijk'}},
    manifest:{exists:true,safe:true,value:manifest},
    videoApproval:{exists:true,safe:true,value:{schemaVersion:'research-video-call-approval-v7',planDigest:manifest.videoPlanDigest,
      notBefore:'2026-09-26T06:59:00.000Z',expiresAt:'2026-09-26T07:20:00.000Z',maxCalls:1,sourceUseApproved:true,freeTierReviewed:true,paidFallback:false,executionAuthority:'NONE'}},
    groqApproval:{exists:true,safe:true,value:{schemaVersion:'research-groq-call-approval-v12',orchestratorPlanDigest:manifest.orchestratorPlanDigest,
      notBefore:'2026-09-26T06:59:00.000Z',expiresAt:'2026-09-26T07:20:00.000Z',maxCalls:1,sourceUseApproved:true,freeTierReviewed:true,paidFallback:false,executionAuthority:'NONE'}},
  };
}
test('preflight reports ready only for exact safe production and reviewed files',()=>{
  const result=evaluatePreflightV13({processes:[processRow()],targetSha:sha,now,rootFacts:{configured:true,safe:true},files:files()});
  assert.equal(result.status,'READY_FOR_REVIEWED_ONE_SHOT');
  assert.equal(result.providerCalls,0);
  assert.equal(result.serverFilesWritten,0);
  assert.equal(result.secretValuesCollected,0);
  assert.equal(result.executionAuthority,'NONE');
  assert.deepEqual(result.reasonCodes,[]);
  assert.equal(JSON.stringify(result).includes('abcdefghijk'),false);
});
test('missing private root fails closed without exposing credentials',()=>{
  const result=evaluatePreflightV13({processes:[processRow()],targetSha:sha,now,rootFacts:{configured:false,safe:false},files:null});
  assert.equal(result.status,'BLOCKED');
  assert.ok(result.reasonCodes.includes('ONE_SHOT_ROOT_NOT_CONFIGURED'));
  assert.equal(JSON.stringify(result).includes('abcdefghijk'),false);
});
test('provider conflict, model absence, enabled trading flag and stale deployment all block',()=>{
  const env={GEMINI_API_KEY:'abcdefghijk',GOOGLE_API_KEY:'differentkey',GROQ_API_KEY:'abcdefghijk',GROQ_MODEL:'',LIVE_TRADING:'true'};
  const result=evaluatePreflightV13({processes:[processRow(env)],targetSha:'f'.repeat(40),now,rootFacts:{configured:true,safe:true},files:files()});
  assert.equal(result.status,'BLOCKED');
  for(const code of ['PRODUCTION_SHA_MISMATCH','TRADING_AUTHORITY_NOT_SAFE','GEMINI_CREDENTIAL_NOT_READY','GROQ_MODEL_NOT_READY'])
    assert.ok(result.reasonCodes.includes(code),code);
});
test('expired or misbound approvals block before any provider call',()=>{
  const f=files();f.groqApproval.value={...f.groqApproval.value,orchestratorPlanDigest:'e'.repeat(64),expiresAt:now};
  const result=evaluatePreflightV13({processes:[processRow()],targetSha:sha,now,rootFacts:{configured:true,safe:true},files:f});
  assert.equal(result.status,'BLOCKED');
  assert.ok(result.reasonCodes.includes('GROQ_APPROVAL_BINDING_INVALID'));
  assert.ok(result.reasonCodes.includes('GROQ_APPROVAL_EXPIRED_OR_INVALID'));
  assert.equal(result.providerCalls,0);
});
