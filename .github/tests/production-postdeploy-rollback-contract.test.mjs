import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const workflow = readFileSync('.github/workflows/production-deploy.yml', 'utf8');
const contract = readFileSync('.github/scripts/verify-production-postdeploy-qa-contract.mjs', 'utf8');
const rollback = workflow.split('- name: Roll back application SHA after failed post-deploy QA when schema is compatible')[1] ?? '';
const preserve = workflow.split('- name: Preserve fail-closed release if previous schema cannot safely be restored')[1] ?? '';
const before = workflow.split('- name: Capture exact predeploy rollback target and schema compatibility')[1]?.split('- name: Deploy exact approved revision')[0] ?? '';
test('release job keeps exact approved deploy and only invokes recovery after a successful remote switch and failing post-QA', () => {
  assert.match(workflow, /if: github.event_name == 'workflow_dispatch'/);
  assert.ok(rollback.includes("failure() && steps.deploy_app.outcome == 'success'"));
  assert.ok(rollback.includes("steps.rollback_target.outputs.schema_compatible == 'true'"));
  assert.ok(preserve.includes("steps.rollback_target.outputs.schema_compatible != 'true'"));
  assert.ok(workflow.indexOf('- name: Destroy deployment authority before read-only QA')
    < workflow.indexOf('- name: Roll back application SHA after failed post-deploy QA when schema is compatible'));
  assert.ok(rollback.includes('POSTDEPLOY_ROLLBACK_NEWER_RELEASE_CONFLICT'));
  assert.ok(rollback.includes('POSTDEPLOY_ROLLBACK_TRADING_AUTHORITY_PRESENT'));
  assert.ok(rollback.includes('POSTDEPLOY_ROLLBACK_IDENTITY_MISMATCH'));
});
test('rollbacks are prevented across changed migrations, invalid original identity or old membership RPC contracts', () => {
  assert.ok(before.includes('PREDEPLOY_ROLLBACK_IDENTITY_NOT_VERIFIED'));
  assert.ok(before.includes('git diff --quiet "$previous_sha" "$TARGET_SHA"'));
  assert.ok(before.includes('api-server/supabase/migrations supabase/migrations database/migrations'));
  assert.ok(before.includes('p_expected_permissions_updated_at'));
  assert.ok(before.includes('schema_compatible=false'));
  assert.ok(rollback.includes('ROLLBACK_SHA'));
  assert.ok(rollback.includes("actual") && rollback.includes('POSTDEPLOY_ROLLBACK_RESOLUTION_MISMATCH'));
});
test('incompatible rollback preserves latest target only when all live trading authority is off', () => {
  assert.ok(preserve.includes('POSTDEPLOY_FAILCLOSED_TRADING_AUTHORITY_PRESENT'));
  assert.ok(preserve.includes('POSTDEPLOY_FAILCLOSED_TARGET_SHA_MISMATCH'));
  assert.ok(preserve.includes('POSTDEPLOY_FAILCLOSED_HEALTH_IDENTITY_INVALID'));
  assert.ok(preserve.includes("manual incident review".replace('manual', 'Manual')));
  for(const forbidden of ['PROD_DATABASE_URL','production-readonly-qa']) {
    assert.ok(!rollback.includes(forbidden));
    assert.ok(!preserve.includes(forbidden));
  }
  assert.ok(contract.includes('const qaTailRaw'));
  assert.ok(contract.includes('const recoveryTail'));
});

function exactRunScript(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start !== -1, `missing workflow step: ${name}`);
  const runLine = '        run: |\n';
  const codeStart = workflow.indexOf(runLine, start);
  const nextStep = workflow.indexOf('\n      - name: ', start + marker.length);
  assert.ok(codeStart > start && (nextStep === -1 || codeStart < nextStep), `missing run block: ${name}`);
  const code = workflow.slice(codeStart + runLine.length, nextStep === -1 ? undefined : nextStep);
  return code.split('\n').map((line) => {
    if (line.trim() && !line.startsWith('          ')) {
      throw new Error(`invalid YAML script indentation for ${name}`);
    }
    return line.startsWith('          ') ? line.slice(10) : line;
  }).join('\n');
}

test('all protected post-deploy recovery shell blocks pass bash syntax inspection before approval', () => {
  for (const name of [
    'Capture exact predeploy rollback target and schema compatibility',
    'Roll back application SHA after failed post-deploy QA when schema is compatible',
    'Preserve fail-closed release if previous schema cannot safely be restored',
  ]) {
    const code = exactRunScript(name);
    const syntax = spawnSync('bash', ['-n'], { input: code, encoding: 'utf8', timeout: 5000 });
    assert.equal(syntax.status, 0, `${name}: ${syntax.stderr || syntax.error?.message || 'syntax error'}`);
  }
});
