import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = resolve(ROOT, '.github/workflows/research-production-forward-one-shot.yml');

test('forward one-shot is owner-only, canonical-Hub-only, exact-main-only and CI-gated', async () => {
  const source = await readFile(WORKFLOW, 'utf8');

  for (const token of [
    "github.event.comment.user.login == github.repository_owner",
    "github.event.comment.author_association == 'OWNER'",
    "startsWith(github.event.comment.body, '/run-research-production-forward-once ')",
    "agent_hub_rollover_v2.py resolve",
    "Target is not exact current main",
    "[RESEARCH_PRODUCTION_ACTIVATION]",
    "Required CI 6/6 SUCCESS",
    "application-ci/verified",
    "browser-ui/verified",
    "database-rls/verified",
    "security-integration/verified",
    "ai-privacy/verified",
    "futures-public-network-smoke/verified",
  ]) {
    assert.ok(source.includes(token), `missing authorization contract: ${token}`);
  }
});

test('forward one-shot mutates only the isolated forward oneshot service and not timers/deploy/db', async () => {
  const source = await readFile(WORKFLOW, 'utf8');

  assert.ok(source.includes('systemctl start research-production@forward.service'));
  assert.ok(source.includes('systemctl is-enabled --quiet research-production-forward.timer'));
  assert.ok(source.includes('systemctl is-active --quiet research-production-forward.timer'));
  assert.ok(source.includes('FORWARD_ONE_SHOT_BLOCKED_ACTIVE_SERVICE=true'));

  for (const forbidden of [
    'systemctl enable ',
    'systemctl disable ',
    'systemctl restart ',
    'systemctl stop ',
    'systemctl daemon-reload',
    'activate-server.sh',
    'kubectl ',
    'psql ',
    'npm run deploy',
    'vercel ',
    'pm2 ',
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden mutation present: ${forbidden}`);
  }

  assert.ok(source.includes('server_deploy_mutation: 0'));
  assert.ok(source.includes('production_db_mutation: 0'));
  assert.ok(source.includes('timer_schedule_mutation: 0'));
});

test('forward one-shot preserves Paper-only safety and captures fail-closed evidence', async () => {
  const source = await readFile(WORKFLOW, 'utf8');

  for (const token of [
    "grep -Fx 'live_trading=false'",
    "grep -Fx 'private_api=false'",
    "grep -Fx 'order_authority=false'",
    "grep -Fx 'real_order_count=0'",
    'TASK_FAILURE_SIGNATURE',
    'ERR_MODULE_NOT_FOUND',
    'MODULE_NOT_FOUND',
    "paper_module_failure",
    "['success', 'blocked_data'].includes",
    "status === 'FAIL_CLOSED'",
    '[RESEARCH_PRODUCTION_FORWARD_ONE_SHOT]',
  ]) {
    assert.ok(source.includes(token), `missing fail-closed evidence contract: ${token}`);
  }

  assert.equal(source.includes('LIVE_TRADING=true'), false);
  assert.equal(source.includes('AUTO_TRADING=true'), false);
  assert.equal(source.includes('REAL_ORDER_ENABLED=true'), false);
  assert.equal(source.includes('PRIVATE_TRADING_API_ALLOWED=true'), false);
});

test('forward one-shot readback is exact-release-bound and uses existing read-only evidence owner', async () => {
  const source = await readFile(WORKFLOW, 'utf8');

  assert.ok(source.includes('current_release_match=true'));
  assert.ok(source.includes('TARGET_RESEARCH_SHA'));
  assert.ok(source.includes('ops/research-production-readonly-evidence.sh'));
  assert.ok(source.includes('cycle.research_sha === process.env.TARGET_SHA'));
  assert.ok(source.includes('server_files_written=0'));
  assert.ok(source.includes('server_processes_restarted=0'));
  assert.ok(source.includes('deployment_executed=0'));
  assert.ok(source.includes('database_changes=0'));
});


test('forward one-shot resolves temporary files at step runtime instead of job-level runner context', async () => {
  const source = await readFile(WORKFLOW, 'utf8');

  assert.equal(source.includes('${{ runner.temp }}'), false);
  assert.ok(source.includes('SERVICE_FILE="$RUNNER_TEMP/research-production-forward-one-shot-service.txt"'));
  assert.ok(source.includes('EVIDENCE_FILE="$RUNNER_TEMP/research-production-forward-one-shot-evidence.txt"'));
  assert.ok(source.includes('service_file=$SERVICE_FILE'));
  assert.ok(source.includes('evidence_file=$EVIDENCE_FILE'));
  assert.ok(source.includes('steps.service.outputs.service_file'));
  assert.ok(source.includes('steps.evidence.outputs.evidence_file'));
});
