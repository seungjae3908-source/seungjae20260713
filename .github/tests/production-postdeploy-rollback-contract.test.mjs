import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
