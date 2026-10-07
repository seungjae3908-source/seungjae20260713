import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scriptUrl = new URL('../deploy/activate-ai-research.sh', import.meta.url);
const workflowUrl = new URL('../../.github/workflows/research-ai-production-activation.yml', import.meta.url);
const aiCliUrl = new URL('../bin/research-ai-review.mjs', import.meta.url);
const aiServiceUrl = new URL('../deploy/research-production-ai-review.service', import.meta.url);

test('AI Research activation is fail-closed and exact-SHA bound', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  assert.match(script, /TARGET_SHA must be an exact lowercase 40-character SHA/);
  assert.match(script, /AI_RESEARCH_CURRENT_SHA_MISMATCH/);
  assert.match(script, /\/opt\/investment-research\/releases\/[^\n]*\$TARGET_SHA/);
  assert.match(script, /AI_RESEARCH_ACTIVATION_FAILED_SAFE_DISABLED=\$safe_disabled/);
  assert.match(script, /AI_RESEARCH_TIMER_STILL_ACTIVE/);
  assert.match(script, /AI_RESEARCH_DAEMON_STILL_ACTIVE/);
  assert.match(script, /systemctl disable --now/);
});

test('provider readiness is proven before timer activation and secrets are not printed', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  const preflight = script.indexOf('provider_preflight');
  const materialize = script.indexOf('research-provider-bootstrap.mjs" materialize');
  const enable = script.indexOf('systemctl enable --now');
  assert.ok(preflight >= 0 && materialize > preflight && enable > materialize);
  assert.match(script, /fullStackReady !== true/);
  assert.match(script, /providers\.youtube !== 'PRESENT'/);
  assert.match(script, /providers\.gemini !== 'PRESENT'/);
  assert.match(script, /providers\.groq !== 'PRESENT'/);
  assert.doesNotMatch(script, /echo .*API_KEY|printf .*API_KEY/);
});


test('existing isolated Research provider env is reused before app or PM2 bootstrap', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  const ready = script.indexOf('provider_env_ready()');
  const fallback = script.indexOf('research-provider-bootstrap.mjs" preflight');
  const materialize = script.indexOf('materialize_or_reuse_provider_env');
  assert.ok(ready >= 0 && fallback > ready && materialize > ready);
  assert.match(script, /EXISTING_RESEARCH_PROVIDER_ENV/);
  assert.match(script, /credentialValuesExposed: false/);
  assert.match(script, /executionAuthority: 'NONE'/);
  assert.doesNotMatch(script, /source\s+"\$PROVIDER_ENV"|\.\s+"\$PROVIDER_ENV"/);
});

test('runtime policy files require explicit YouTube approval and free AI provider selection', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  assert.match(script, /AI_RESEARCH_POLICY_ENV_MISSING/);
  assert.match(script, /VIDEO_RESEARCH_POLICY_ENV_MISSING/);
  assert.match(script, /RESEARCH_AI_FREE_TIER_CONFIRMED/);
  assert.match(script, /AI_CHAT_PROVIDER/);
  assert.match(script, /RESEARCH_VIDEO_DISCOVERY_APPROVED/);
  assert.match(script, /AI_RESEARCH_FREE_TIER_CONFIRMATION_REQUIRED/);
  assert.match(script, /VIDEO_RESEARCH_DISCOVERY_APPROVAL_REQUIRED/);
  assert.doesNotMatch(script, /source\s+"\$AI_POLICY_ENV"|source\s+"\$VIDEO_POLICY_ENV"/);
});

test('provider materialization fallback is non-recursive and preserves existing isolated env first', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  const start = script.indexOf('materialize_or_reuse_provider_env()');
  const end = script.indexOf('require_runtime_policy_env()', start);
  assert.ok(start >= 0 && end > start);
  const helper = script.slice(start, end);
  assert.match(helper, /research-provider-bootstrap\.mjs" materialize/);
  assert.equal((helper.match(/materialize_or_reuse_provider_env/g) ?? []).length, 1);
});
test('provider env is readable by the isolated Research service user', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  assert.match(script, /chown root:investment-research/);
  assert.match(script, /chmod 0640/);
  assert.match(script, /runuser -u investment-research -- test -r/);
});

test('one-shot workers must succeed before recurring timers are enabled', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  const ai = script.indexOf('systemctl start research-production-ai-review.service');
  const video = script.indexOf('systemctl start research-production-video-discovery.service');
  const enable = script.indexOf('systemctl enable --now');
  assert.ok(ai >= 0 && video > ai && enable > video);
  assert.match(script, /AI_RESEARCH_ONE_SHOT_FAILED/);
  assert.match(script, /AI_REVIEW_ONE_SHOT=success/);
  assert.match(script, /VIDEO_DISCOVERY_ONE_SHOT=success/);
});

test('fresh one-shot provider evidence is required before recurring timers enable', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  const ai = script.indexOf('systemctl start research-production-ai-review.service');
  const video = script.indexOf('systemctl start research-production-video-discovery.service');
  const proof = script.indexOf('verify_one_shot_evidence "$one_shot_started_ms"');
  const enable = script.indexOf('systemctl enable --now');
  assert.ok(ai >= 0 && video > ai && proof > video && enable > proof);
  assert.match(script, /AI_RESEARCH_ONE_SHOT_NOT_READY/);
  assert.match(script, /AI_RESEARCH_ONE_SHOT_PROVIDER_OR_CACHE_PROOF_MISSING/);
  assert.match(script, /AI_RESEARCH_ONE_SHOT_STALE/);
  assert.match(script, /VIDEO_DISCOVERY_ONE_SHOT_NOT_COMPLETE/);
  assert.match(script, /VIDEO_DISCOVERY_ONE_SHOT_NETWORK_PROOF_MISSING/);
  assert.match(script, /VIDEO_DISCOVERY_ONE_SHOT_SOURCE_COUNT_INVALID/);
  assert.match(script, /VIDEO_DISCOVERY_ONE_SHOT_STALE/);
});
test('AI activation preserves no-trading authority contract', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  for (const token of [
    'LIVE_TRADING=false',
    'PRIVATE_TRADING_API_ALLOWED=false',
    'REAL_ORDER_ENABLED=false',
    'executionAuthority=NONE',
    'REAL_ORDER_SUBMITTED=false',
  ]) assert.match(script, new RegExp(token));
  assert.doesNotMatch(script, /LIVE_TRADING=true|REAL_ORDER_ENABLED=true|PRIVATE_TRADING_API_ALLOWED=true|executionAuthority=LIVE/);
});


test('existing provider credentials are normalized with fixed Research models without secret logging', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  assert.match(script, /provider_credentials_present\(\)/);
  assert.match(script, /normalize_existing_provider_env\(\)/);
  assert.match(script, /GEMINI_MODEL=gemini-3\.1-flash-lite/);
  assert.match(script, /GROQ_MODEL=openai\/gpt-oss-20b/);
  assert.match(script, /EXISTING_RESEARCH_PROVIDER_ENV_MODELS_NORMALIZED/);
  assert.match(script, /install -o root -g investment-research -m 0640/);
  assert.doesNotMatch(script, /console\.log\([^\n]*API_KEY|echo [^\n]*API_KEY|printf [^\n]*API_KEY/);
});


test('activation requires current-sha forward evidence before provider one-shot', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  const readiness = script.indexOf('require_current_sha_ai_evidence_ready');
  const aiStart = script.indexOf('systemctl start research-production-ai-review.service');
  assert.ok(readiness >= 0 && aiStart > readiness);
  assert.match(script, /AI_RESEARCH_CURRENT_SHA_FORWARD_EVIDENCE_MISSING/);
  assert.match(script, /research-ai-current-sha-readiness-v1/);
});


test('activation rejects current-sha forward cycles whose tasks are blocked_data', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  assert.match(script, /AI_RESEARCH_CURRENT_SHA_FORWARD_RUNTIME_BLOCKED/);
  assert.match(script, /forward\?\.successCount !== forward\.taskCount/);
  assert.match(script, /forward\?\.blockedDataCount !== 0/);
  assert.match(script, /forward\?\.failedCount !== 0/);
  assert.match(script, /task\?\.status !== 'success'/);
  assert.match(script, /task\?\.exitCode !== 0/);
});

test('forward Paper Shadow runtime diagnostic runs before provider preflight', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  const runtimeGate = script.indexOf('require_forward_runtime_ready');
  const providerGate = script.indexOf('provider_preflight', script.indexOf('preflight()'));
  assert.ok(runtimeGate >= 0);
  assert.ok(providerGate > runtimeGate);
  assert.match(script, /research-forward-runtime-diagnostic\.mjs/);
  assert.match(script, /AI_RESEARCH_FORWARD_RUNTIME_NOT_READY/);
});

test('activation exposes leaf diagnostics and accepts current cache proof', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  assert.match(script, /research-ai-diagnostic\.mjs/);
  assert.match(script, /PARTIAL_COVERAGE_COMPLETE/);
  assert.match(script, /cacheHits/);
  assert.match(script, /AI_RESEARCH_ONE_SHOT_PROVIDER_OR_CACHE_PROOF_MISSING/);
  assert.match(script, /blockedProfiles/);
  assert.match(script, /deferredProfiles/);
});

test('approved-job intake and workspace heartbeat are proven before activation completes', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  const intake = script.indexOf('systemctl start research-production-approved-job-intake.service');
  const enable = script.indexOf('systemctl enable --now');
  const heartbeat = script.indexOf('verify_workspace_worker_health', enable);
  assert.ok(intake >= 0 && intake < enable && heartbeat > enable);
  assert.match(script, /research-worker-status-v9/);
  assert.match(script, /workerState !== 'ACTIVE'/);
  assert.match(script, /AI_RESEARCH_WORKSPACE_WORKER_HEARTBEAT_NOT_ACTIVE/);
});



test('AI review business failures are visible to systemd instead of exiting success', async () => {
  const [cli, service] = await Promise.all([
    readFile(aiCliUrl, 'utf8'),
    readFile(aiServiceUrl, 'utf8'),
  ]);
  assert.match(cli, /PARTIAL_AI_UNAVAILABLE/);
  assert.match(cli, /WAITING_FOR_FREE_AI/);
  assert.match(cli, /DEFERRED_RETRY/);
  assert.match(cli, /process\.exitCode = 75/);
  assert.match(service, /ExecStart=.*research-ai-review\.mjs run/);
  assert.doesNotMatch(service, /SuccessExitStatus=.*75/);
});

test('activation workflow preserves sanitized diagnostics and failed-closed Hub receipt', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(workflow, /id: activate_ai/);
  assert.match(workflow, /2>&1 \| tee "\$RUNNER_TEMP\/ai-research-activation\.txt"/);
  assert.match(workflow, /AI_RESEARCH_ACTIVATION_PROOF_INVALID/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /research-ai-activation-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /status: failed_closed/);
  assert.match(workflow, /failure_reason: ' \+ process\.env\.FAILURE_REASON/);
  assert.match(workflow, /provider_secret_values_exposed: false/);
  assert.match(workflow, /executionAuthority: NONE/);
});
