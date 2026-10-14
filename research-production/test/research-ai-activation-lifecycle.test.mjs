import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import contract from '../../.github/scripts/research-ai-activation-result.cjs';

const source = readFileSync(new URL('../deploy/activate-ai-research.sh',import.meta.url),'utf8').replaceAll('\r\n','\n');
const bash = process.platform==='win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const shellPath = p => process.platform==='win32'
  ? p.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,d)=>'/'+d.toLowerCase()) : p;
const SHA='a'.repeat(40);
const operationalCli=fileURLToPath(new URL('../bin/research-ai-operational-transition-v2.mjs',import.meta.url));
const workflow=readFileSync(new URL('../../.github/workflows/research-ai-production-activation.yml',import.meta.url),'utf8').replaceAll('\r\n','\n');
function sandbox(run) {
  const root=mkdtempSync(join(tmpdir(),'TEST-ONLY-ai-lifecycle-'));
  try { return run(root,shellPath(root)); }
  finally {
    assert.equal(dirname(resolve(root)),resolve(tmpdir()));
    assert.match(basename(root),/^TEST-ONLY-ai-lifecycle-/u);
    rmSync(root,{recursive:true,force:true});
  }
}
function invoke(code,root,extra={}) {
  const result=spawnSync(bash,['-s'],{input:code,cwd:root,encoding:'utf8',timeout:30_000,
    env:{...process.env,TARGET_SHA:SHA,HARNESS_ROOT:shellPath(root),REAL_NODE:shellPath(process.execPath),
      TMPDIR:shellPath(root),MSYS2_ENV_CONV_EXCL:'*',...extra}});
  assert.ifError(result.error);
  return result;
}
const helper = (start,end) => source.slice(source.indexOf(start+'()'),source.indexOf(end+'()'));

test('provider bootstrap cleanup cannot escape to caller or replace caller traps', () => sandbox(root => {
  const code=String.raw`
set -Eeuo pipefail
SUDO=(); RESEARCH_ROOT="$HARNESS_ROOT/release"; APP_ROOT="$HARNESS_ROOT/app"
provider_env_ready() { return 1; }
provider_credentials_present() { return 1; }
node() {
  if [[ "$1" == *research-provider-bootstrap.mjs ]]; then
    printf '%s\n' '{"schemaVersion":"research-provider-bootstrap-v1","fullStackReady":true,"providers":{"youtube":"PRESENT","gemini":"PRESENT","groq":"PRESENT"},"conflicts":[],"credentialValuesExposed":false,"executionAuthority":"NONE","liveTrading":false,"privateTradingApiAllowed":false}'
  else "$REAL_NODE" "$@"; fi
}
`+helper('provider_preflight','normalize_existing_provider_env')+String.raw`
trap 'printf "PARENT_EXIT\n"' EXIT
trap 'printf "PARENT_RETURN\n"' RETURN
before_return="$(trap -p RETURN)"; before_exit="$(trap -p EXIT)"
outer() { provider_preflight; printf 'AFTER_PROVIDER\n'; }
outer
[[ "$(trap -p RETURN)" == "$before_return" && "$(trap -p EXIT)" == "$before_exit" ]]
printf 'FINALIZED\n'
`;
  const r=invoke(code,root);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/AFTER_PROVIDER[\s\S]*FINALIZED[\s\S]*PARENT_EXIT/u);
  assert.doesNotMatch(r.stderr,/unbound variable/u);
  assert.equal(readdirSync(root).filter(x=>x.startsWith('tmp.')).length,0);
}));

function activation({workerReady=true,unsafeEvidence=false,oldCleanup=false,oneShotFailures=false}={}) {
  return sandbox(root=>{
    const state=join(root,'state');
    writeFileSync(join(root,'events'),'');
    for(const folder of ['latest','ai-review','video-research'])mkdirSync(join(state,folder),{recursive:true});
    writeFileSync(join(state,'latest','forward.json'),JSON.stringify({schemaVersion:'research-production-cycle-v1',
      profile:'forward',researchSha:SHA,status:'blocked_data'}));
    writeFileSync(join(state,'latest','autonomous-research-cycle-v2.json'),JSON.stringify({
      schemaVersion:2,contract:'autonomous-research-cycle/v2',status:'COMPLETE',
      observedAt:new Date(0).toISOString(),researchCodeSha:SHA,directiveConsumed:true,discoveryStatus:'DOSSIER_STAGED',
      actualProviderCalls:{attempted:2,succeeded:2,failed:0},actualSourceFetches:{attempted:3,succeeded:3,failed:0},
      selectedNextStrategy:{repository:'https://github.com/example/public-strategy',sourcePath:'strategy.py',
        sourceRevision:'c'.repeat(40),family:'PARTICIPATION_BREAKOUT',templateId:'RVOL_BREAKOUT_V1'},
      stagedDossierDigest:'d'.repeat(64),
      formulaGeneratedCount:1,actualBacktestCount:1,
      safety:{executionAuthority:'NONE',liveTrading:false,privateTradingApi:false,realOrder:false}}));
    writeFileSync(join(state,'latest','autonomous-research-discovery-v2.json'),JSON.stringify({
      schemaVersion:2,contract:'autonomous-research-discovery/v2',status:'DOSSIER_STAGED',researchCodeSha:SHA,
      directiveConsumed:true,actualProviderCalls:{attempted:2,succeeded:2,failed:0},
      actualSourceFetches:{attempted:3,succeeded:3,failed:0},stagedDossierDigest:'d'.repeat(64)}));
    writeFileSync(join(state,'ai-review','latest.json'),JSON.stringify({schemaVersion:'research-production-ai-scan-v1',
      researchSha:SHA,status:'PARTIAL_COVERAGE_COMPLETE',provider:'gemini',providerNetworkCalls:1,cacheHits:0,
      reviews:[{fixtureOnly:true}],blockedProfiles:[],observedAt:0,
      safety:{executionAuthority:unsafeEvidence?'TEST_ONLY_FORBIDDEN':'NONE',liveTrading:false,privateTradingApiAllowed:false,orderAllowed:false},
      evidenceCredit:0,profitabilityProven:false}));
    writeFileSync(join(state,'video-research','latest.json'),JSON.stringify({schemaVersion:'research-video-discovery-scan-v1',
      researchSha:SHA,status:'COMPLETE',provider:'YOUTUBE_DATA_API_V3',providerNetworkCalls:1,sourceCount:0,
      observedAt:new Date(0).toISOString(),safety:{executionAuthority:'NONE',liveTrading:false,
        privateTradingApiAllowed:false,realOrderEnabled:false,profitabilityCredit:0,economicEvidenceCredit:0}}));
    let script=source.slice(0,source.lastIndexOf('\ncase "$MODE" in'));
    if(oldCleanup)script=script.replace('verify_workspace_worker_health() (','verify_workspace_worker_health() {')
      .replace(/(verify_workspace_worker_health\(\) \{[\s\S]*?)trap 'rm -f -- "\$evidence"' EXIT/u,"$1trap 'rm -f -- \"$evidence\"' RETURN")
      .replace(/(verify_workspace_worker_health\(\) \{[\s\S]*?\n)\)\n\nverify_one_shot_evidence/u,'$1}\n\nverify_one_shot_evidence');
    const mocks=String.raw`
RESEARCH_ROOT="$HARNESS_ROOT/release"; STATE_ROOT="$HARNESS_ROOT/state"
ENV_ROOT="$HARNESS_ROOT/env"; PROVIDER_ENV="$ENV_ROOT/providers.env"
AI_POLICY_ENV="$ENV_ROOT/ai.env"; VIDEO_POLICY_ENV="$ENV_ROOT/video.env"
TRANSITION_ROOT="$HARNESS_ROOT/transition"
require_exact_research_release() { :; }
require_research_safety_env() { :; }
require_runtime_policy_env() { :; }
provider_env_ready() { :; }
require_existing_provider_env() { :; }
verify_unit_sources() { :; }
verify_installed_unit_ownership() { :; }
require_isolated_validation() { ISOLATED_BASELINE_SNAPSHOT_ROOT="$HARNESS_ROOT/baseline"; }
capture_runtime_snapshot() { :; }
restore_runtime_snapshot() { printf 'AI_RESEARCH_ROLLBACK=RESTORED\n' >&2; }
print_forward_runtime_diagnostic() { :; }
verify_v2_operational_transition() {
  "$REAL_NODE" "$TEST_OPERATIONAL_CLI" --state-root "$STATE_ROOT" --research-sha "$TARGET_SHA" --started-at-ms "$1"
}
chown() { :; }; chmod() { :; }; sleep() { :; }
systemd-analyze() { :; }
node() { "$REAL_NODE" "$@"; }
bash() { [[ "$1" == "$RESEARCH_ROOT/research-production/deploy/install-ai-research-units.sh" ]]; }
enabled=0
systemctl() {
  printf '%s\n' "$*" >> "$HARNESS_ROOT/events"
  case "$1" in
    disable) enabled=0 ;;
    enable) enabled=1 ;;
    is-active|is-enabled) (( enabled == 1 )) ;;
    show) case "$4" in LoadState) printf 'loaded\n';; ActiveState) printf 'inactive\n';;
      Result) if [[ "$TEST_ONESHOT_FAILURES" == true && "$2" != research-production@forward.service ]]; then printf 'exit-code\n'; else printf 'success\n'; fi;;
      ExecMainStatus) if [[ "$TEST_ONESHOT_FAILURES" == true && "$2" != research-production@forward.service ]]; then printf '75\n'; else printf '0\n'; fi;; *) return 90;; esac ;;
    start) if [[ "$2" == research-production-ai-review.service || "$2" == research-production-video-discovery.service ]]; then
      "$REAL_NODE" -e 'const fs=require("node:fs");const p=process.argv[1];const v=JSON.parse(fs.readFileSync(p));v.observedAt=v.schemaVersion==="research-production-ai-scan-v1"?Date.now():new Date().toISOString();fs.writeFileSync(p,JSON.stringify(v));' "$STATE_ROOT/$( [[ "$2" == research-production-ai-review.service ]] && printf ai-review || printf video-research )/latest.json"
      if [[ "$2" == research-production-ai-review.service ]]; then
        "$REAL_NODE" -e 'const fs=require("node:fs");const p=process.argv[1];const v=JSON.parse(fs.readFileSync(p));v.observedAt=new Date().toISOString();fs.writeFileSync(p,JSON.stringify(v));' "$STATE_ROOT/latest/autonomous-research-cycle-v2.json"
      fi
      fi ;;
    stop|daemon-reload) : ;;
    *) return 91 ;;
  esac
}
runuser() {
  if [[ "$*" == *--status* ]]; then
    if [[ "$TEST_WORKER_READY" == true ]]; then
      printf '%s\n' '{"schemaVersion":"research-worker-status-v9","available":true,"workerState":"ACTIVE","lastHeartbeatAt":"TEST_ONLY_HEARTBEAT","authority":{"executionAuthority":"NONE","providerCallsFromStatus":0}}'
    else printf '%s\n' '{"schemaVersion":"research-worker-status-v9","available":false,"workerState":"UNKNOWN"}'; fi
  else [[ "$*" == *test*-r* ]]; fi
}
activate
printf 'SCRIPT_FINALIZED=true\n'
`;
    const r=invoke('id() { printf "0\\n"; }\n'+script+'\n'+mocks,root,{TEST_WORKER_READY:String(workerReady),
      TEST_ONESHOT_FAILURES:String(oneShotFailures),TEST_OPERATIONAL_CLI:shellPath(operationalCli)});
    return {...r,temporaryFiles:readdirSync(root).filter(x=>x.startsWith('tmp.')),
      events:readFileSync(join(root,'events'),'utf8')};
  });
}

test('actual activation body finalizes with exit zero after fresh proof and worker cleanup', () => {
  const r=activation();
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/AI_RESEARCH_ACTIVATED=true[\s\S]*SCRIPT_FINALIZED=true/u);
  assert.match(r.stdout,/"schemaVersion":"research-ai-one-shot-proof-v1"/u);
  assert.equal(r.temporaryFiles.length,0);
});

test('the full harness detects the exact old late RETURN cleanup false failure', () => {
  const r=activation({oldCleanup:true});
  assert.notEqual(r.status,0);
  assert.match(r.stdout,/AI_RESEARCH_ACTIVATED=true/u);
  assert.match(r.stderr,/evidence: unbound variable/u);
  assert.doesNotMatch(r.stdout,/SCRIPT_FINALIZED=true/u);
});

test('workspace failure preserves the parent fail-safe rather than replacing it with cleanup', () => {
  const r=activation({workerReady:false});
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/AI_RESEARCH_WORKSPACE_WORKER_HEARTBEAT_NOT_ACTIVE/u);
  assert.match(r.stderr,/AI_RESEARCH_ACTIVATION_FAILED_ROLLED_BACK=true/u);
  assert.doesNotMatch(r.stdout,/AI_RESEARCH_ACTIVATED=true/u);
  assert.equal(r.temporaryFiles.length,0);
});

test('unsafe one-shot fixture cannot reach timer enable or success finalization', () => {
  const r=activation({unsafeEvidence:true});
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/AI_RESEARCH_ONE_SHOT_SAFETY_INVALID/u);
  assert.match(r.stderr,/AI_RESEARCH_ACTIVATION_FAILED_ROLLED_BACK=true/u);
  assert.doesNotMatch(r.events,/^enable /mu);
});

test('all already-started one-shot results are reported, then failures keep every timer and worker off',()=>{
  const r=activation({oneShotFailures:true});assert.notEqual(r.status,0);
  for(const unit of ['ai-review','video-discovery','approved-job-intake']){
    assert.match(r.stdout,new RegExp('AI_RESEARCH_ONE_SHOT_RESULT:research-production-'+unit+'[.]service:result=exit-code:status=75'));
  }
  assert.match(r.stderr,/AI_RESEARCH_ACTIVATION_FAILED_ROLLED_BACK=true/);
  assert.doesNotMatch(r.events,/^enable /mu);assert.doesNotMatch(r.stdout,/AI_RESEARCH_ACTIVATED=true/);
});

for(const [remote,capture,reason] of [[0,0,null],
  [1,0,'AI_RESEARCH_ACTIVATION_CLEANUP_SCOPE_FAILED'],
  [0,1,'AI_RESEARCH_ACTIVATION_DIAGNOSTIC_CAPTURE_FAILED'],
  [255,0,'AI_RESEARCH_ACTIVATION_REMOTE_FAILED']]) {
  test(`actual workflow step respects remote=${remote}, capture=${capture} through Node and final exit`,()=>sandbox(root=>{
    const body=workflow.split('      - name: Activate AI Review and Video Discovery timers with one-shot proof\n')[1]
      ?.split('\n      - name:')[0]?.split('        run: |\n')[1];
    assert.ok(body);
    const step=body.split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
    const proof={schemaVersion:'research-ai-one-shot-proof-v1',targetSha:SHA,
      ai:{status:'COMPLETE',provider:'gemini',providerNetworkCalls:1,cacheHits:0,reviewCount:1},
      video:{status:'COMPLETE',providerNetworkCalls:1,sourceCount:0},
      credentialValuesExposed:false,executionAuthority:'NONE'};
    const operationalProof={schemaVersion:'research-ai-operational-transition-v2',status:'PASS',targetSha:SHA,
      actualNaturalCycle:{status:'NATURAL_CYCLE_PROVEN',directiveConsumed:true,discoveryStatus:'DOSSIER_STAGED',
        discoveryEvidenceStatus:'DOSSIER_STAGED',discoveryExecution:'FRESH_THIS_INVOCATION',
        providerCalls:{attempted:2,succeeded:2,failed:0},sourceFetches:{attempted:3,succeeded:3,failed:0},
        formulaGeneratedCount:1,actualBacktestCount:1,paperActivated:false,executionAuthority:'NONE'},
      longHistory:{state:'STALE_RELEASE_EVIDENCE_PRESERVED',treatedAsFailure:false},
      youtube:{state:'PROVIDER_SUCCESS_ZERO_RESULTS'},liveTrading:false,privateTradingApiAllowed:false,
      realOrderEnabled:false,executionAuthority:'NONE'};
    const diagnostics=[JSON.stringify(proof),JSON.stringify(operationalProof),...contract.REQUIRED_MARKERS,'TARGET_SHA='+SHA,
      ...(remote===1?['main: line 587: evidence: unbound variable']:[])].join('\n')+'\n';
    writeFileSync(join(root,'diagnostics'),diagnostics);
    const repoRoot=fileURLToPath(new URL('../..',import.meta.url));
    const prefix=String.raw`
node() { "$REAL_NODE" "$@"; }
ssh() { command cat "$HARNESS_ROOT/diagnostics"; return "$TEST_REMOTE_EXIT"; }
tee() { command tee "$@"; return "$TEST_CAPTURE_EXIT"; }
`;
    const result=spawnSync(bash,['-s'],{input:prefix+step,cwd:repoRoot,
      encoding:'utf8',timeout:30_000,env:{...process.env,TARGET_SHA:SHA,HARNESS_ROOT:shellPath(root),
        REAL_NODE:shellPath(process.execPath),RUNNER_TEMP:shellPath(root),GITHUB_OUTPUT:join(root,'outputs'),
        SSH_PORT:'TEST_ONLY',SSH_HOST:'TEST_ONLY',SSH_USER:'TEST_ONLY',
        TEST_REMOTE_EXIT:String(remote),TEST_CAPTURE_EXIT:String(capture),MSYS2_ENV_CONV_EXCL:'*'}});
    assert.ifError(result.error);
    assert.equal(result.status,reason===null?0:1,result.stderr);
    const outputs=readFileSync(join(root,'outputs'),'utf8');
    assert.ok(outputs.includes('failure_reason='+(reason??'')+'\n'));
    assert.ok(outputs.includes('completion_evidence_observed=true\n'));
    assert.ok(outputs.includes('runtime_recheck_required='+(reason!==null)+'\n'));
  }));
}
