import test from 'node:test';
import assert from 'node:assert/strict';
import contract from '../../.github/scripts/research-ai-activation-result.cjs';
const { evaluateAiActivationResult, REQUIRED_MARKERS } = contract;
const SHA = 'a'.repeat(40);
const proof = () => ({schemaVersion:'research-ai-one-shot-proof-v1',targetSha:SHA,
  ai:{status:'PARTIAL_COVERAGE_COMPLETE',provider:'gemini',providerNetworkCalls:1,cacheHits:0,reviewCount:1},
  video:{status:'COMPLETE',providerNetworkCalls:1,sourceCount:0},
  credentialValuesExposed:false,executionAuthority:'NONE'});
const operationalProof = () => ({schemaVersion:'research-ai-operational-transition-v2',status:'PASS',targetSha:SHA,
  actualNaturalCycle:{status:'NATURAL_CYCLE_PROVEN',directiveConsumed:true,discoveryStatus:'DOSSIER_STAGED',
    discoveryEvidenceStatus:'DOSSIER_STAGED',discoveryExecution:'FRESH_THIS_INVOCATION',
    providerCalls:{attempted:2,succeeded:2,failed:0},sourceFetches:{attempted:3,succeeded:3,failed:0},
    formulaGeneratedCount:1,actualBacktestCount:1,paperActivated:false,executionAuthority:'NONE'},
  longHistory:{state:'STALE_RELEASE_EVIDENCE_PRESERVED',treatedAsFailure:false},
  youtube:{state:'PROVIDER_SUCCESS_ZERO_RESULTS'},liveTrading:false,privateTradingApiAllowed:false,
  realOrderEnabled:false,executionAuthority:'NONE'});
const log = () => [JSON.stringify(proof()),JSON.stringify(operationalProof()), ...REQUIRED_MARKERS, 'TARGET_SHA=' + SHA].join('\n');
const evaluate = (extra={}) => evaluateAiActivationResult({diagnostics:log(),targetSha:SHA,
  remoteExitCode:0,captureExitCode:0,...extra});

test('only zero remote and capture exits with exact safe one-shot proof can succeed', () => {
  const r = evaluate();
  assert.equal(r.activationSucceeded,true);
  assert.equal(r.failureReason,null);
  assert.equal(r.completionEvidenceObserved,true);
  assert.equal(r.naturalCycleProven,true);
  assert.equal(r.longHistoryState,'STALE_RELEASE_EVIDENCE_PRESERVED');
  assert.equal(r.youtubeState,'PROVIDER_SUCCESS_ZERO_RESULTS');
  assert.equal(r.rollbackState,'NOT_REQUIRED');
  assert.equal(r.existingServicePreserved,true);
  assert.equal(r.runtimeRecheckRequired,false);
  assert.equal(r.grantsExecutionAuthority,false);
});

test('the production cleanup error after success markers stays failed, with the actual reason', () => {
  const r = evaluate({remoteExitCode:1,diagnostics:log()+'\nmain: line 587: evidence: unbound variable\n'});
  assert.equal(r.activationSucceeded,false);
  assert.equal(r.failureReason,'AI_RESEARCH_ACTIVATION_CLEANUP_SCOPE_FAILED');
  assert.equal(r.completionEvidenceObserved,true);
  assert.equal(r.runtimeRecheckRequired,true);
  assert.notEqual(r.failureReason,'AI_RESEARCH_ACTIVATED=true');
});

test('tee failure cannot be hidden by successful remote execution or complete markers', () => {
  for (const remoteExitCode of [0,1,141]) {
    const r = evaluate({remoteExitCode,captureExitCode:1});
    assert.equal(r.activationSucceeded,false);
    assert.equal(r.failureReason,'AI_RESEARCH_ACTIVATION_DIAGNOSTIC_CAPTURE_FAILED');
    assert.equal(r.runtimeRecheckRequired,true);
  }
});

test('generic remote errors never become success or leak log payloads as failure reasons', () => {
  const r = evaluate({remoteExitCode:255,diagnostics:log()+'\nsecret=TEST_ONLY_NOT_A_CREDENTIAL\n'});
  assert.equal(r.activationSucceeded,false);
  assert.equal(r.failureReason,'AI_RESEARCH_ACTIVATION_REMOTE_FAILED');
  assert.equal(JSON.stringify(r).includes('TEST_ONLY_NOT_A_CREDENTIAL'),false);
});

test('real leaf failures are retained without stdout or provider payload disclosure', () => {
  const r = evaluate({remoteExitCode:70,diagnostics:'AI_RESEARCH_ONE_SHOT_FAILED:TEST_ONLY\n'});
  assert.equal(r.failureReason,'AI_RESEARCH_ONE_SHOT_FAILED');
  assert.equal(r.completionEvidenceObserved,false);
  assert.equal(r.runtimeRecheckRequired,true);
});

test('missing, mismatched, stale-last or unsafe completion proof blocks success', () => {
  for (const marker of REQUIRED_MARKERS) {
    assert.equal(evaluate({diagnostics:log().replace(marker,'')}).activationSucceeded,false,marker);
  }
  const other = {...proof(),targetSha:'b'.repeat(40)};
  const unsafe = {...proof(),executionAuthority:'TEST_ONLY_FORBIDDEN'};
  for (const diagnostics of [
    log().replace('TARGET_SHA='+SHA,'TARGET_SHA='+'b'.repeat(40)),
    log().replace(JSON.stringify(proof()),JSON.stringify(other)),
    log()+'\n'+JSON.stringify(other), log()+'\n'+JSON.stringify(unsafe),
    log()+'\nAI_REVIEW_TIMER_ENABLED=false',
    log()+'\n'+REQUIRED_MARKERS.find(x=>x.startsWith('LIVE_TRADING=')).replace('false','true'),
  ]) assert.equal(evaluate({diagnostics}).activationSucceeded,false);
  for (const invalid of [
    null,
    {...operationalProof(),targetSha:'b'.repeat(40)},
    {...operationalProof(),actualNaturalCycle:{...operationalProof().actualNaturalCycle,discoveryStatus:'ALREADY_DISCOVERED'}},
    {...operationalProof(),actualNaturalCycle:{...operationalProof().actualNaturalCycle,actualBacktestCount:0}},
  ]) {
    const diagnostics = invalid == null
      ? log().replace(JSON.stringify(operationalProof()), '')
      : log().replace(JSON.stringify(operationalProof()), JSON.stringify(invalid));
    assert.equal(evaluate({diagnostics}).activationSucceeded,false);
  }
});

test('cached AI is distinguished from a new call and video still requires a real network call', () => {
  const cached = proof(); cached.ai.providerNetworkCalls=0; cached.ai.cacheHits=1;
  assert.equal(evaluate({diagnostics:log().replace(JSON.stringify(proof()),JSON.stringify(cached))}).activationSucceeded,true);
  cached.video.providerNetworkCalls=0;
  assert.equal(evaluate({diagnostics:log().replace(JSON.stringify(proof()),JSON.stringify(cached))}).activationSucceeded,false);
});

test('invalid exit statuses, identities and unbounded input fail closed', () => {
  for (const extra of [{remoteExitCode:-1},{remoteExitCode:256},{captureExitCode:NaN},
    {remoteExitCode:'0'},{targetSha:'main'},{diagnostics:'x'.repeat(1024*1024+1)}]) {
    const r = evaluate(extra);
    assert.equal(r.activationSucceeded,false);
    assert.equal(r.failureReason,'AI_RESEARCH_ACTIVATION_RESULT_INPUT_INVALID');
  }
});

test('the production timeout diagnostic preserves provider cause separately from failed component',()=>{
  const diagnostic={schemaVersion:'research-production-ai-diagnostic-v1',researchSha:SHA,
    status:'PARTIAL_AI_UNAVAILABLE',provider:'gemini',credentialValuesExposed:false,executionAuthority:'NONE',
    blockedProfiles:[{profile:'forward',reason:'FREE_AI_TIMEOUT'}],deferredProfiles:[{profile:'long-history',reason:'STALE_RELEASE_EVIDENCE'}]};
  const diagnostics=JSON.stringify(diagnostic,null,2)+'\nAI_RESEARCH_ONE_SHOT_FAILED:research-production-ai-review.service:result=exit-code:status=75\nAI_RESEARCH_ROLLBACK=RESTORED\nAI_RESEARCH_PREVIOUS_SERVICE_PRESERVED=true\nAI_RESEARCH_ACTIVATION_FAILED_ROLLED_BACK=true';
  const r=evaluate({diagnostics,remoteExitCode:70});
  assert.equal(r.activationSucceeded,false);assert.equal(r.failureReason,'AI_RESEARCH_ONE_SHOT_FAILED');
  assert.equal(r.providerFailureReason,'FREE_AI_TIMEOUT');assert.equal(r.runtimeRecheckRequired,true);
  assert.equal(r.rollbackState,'RESTORED');assert.equal(r.existingServicePreserved,true);
  for(const other of [{...diagnostic,researchSha:'b'.repeat(40)},
    {...diagnostic,credentialValuesExposed:true},
    {...diagnostic,blockedProfiles:[{reason:'TEST_ONLY_SECRET_VALUE'}]}]){
    const result=evaluate({diagnostics:JSON.stringify(other,null,2),remoteExitCode:70});
    assert.equal(result.providerFailureReason,null);assert.doesNotMatch(JSON.stringify(result),/TEST_ONLY_SECRET/);
  }
  assert.equal(evaluate({diagnostics:log()+'\n'+JSON.stringify(diagnostic),remoteExitCode:0}).providerFailureReason,null);
});

test('a pre-cutover refusal records the existing runtime as unchanged',()=>{
  const diagnostics='AI_RESEARCH_CUTOVER_BUSY:research-production-ai-review.service:active\n'
    +'AI_RESEARCH_EXISTING_RUNTIME_UNCHANGED=true';
  const r=evaluate({diagnostics,remoteExitCode:1});
  assert.equal(r.activationSucceeded,false);
  assert.equal(r.failureReason,'AI_RESEARCH_CUTOVER_BUSY');
  assert.equal(r.rollbackState,'UNCHANGED');
  assert.equal(r.existingServicePreserved,true);
});

test('pretty proof handles quoted braces, but malformed or truncated trailing JSON cannot finalize success',()=>{
  const p=proof();p.testOnly='quoted { braces } and \\" escaping';
  const diagnostics=[JSON.stringify(p,null,2),JSON.stringify(operationalProof(),null,2),...REQUIRED_MARKERS,'TARGET_SHA='+SHA].join('\n');
  assert.equal(evaluate({diagnostics}).activationSucceeded,true);
  for(const tail of ['\n{"incomplete":','\n{bad}\n']){
    assert.equal(evaluate({diagnostics:diagnostics+tail}).activationSucceeded,false);
  }
});
