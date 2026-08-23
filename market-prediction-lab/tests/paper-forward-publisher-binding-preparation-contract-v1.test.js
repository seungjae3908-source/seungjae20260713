import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../../.github/workflows/paper-forward-publisher-binding-preparation.yml', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../../ops/prepare-paper-forward-publisher-binding.sh', import.meta.url), 'utf8');

test('publisher binding preparation requires exact owner Issue #23 command and protected Production approval', () => {
  assert.match(workflow, /\/prepare-paper-forward-publisher-binding \([0-9a-f]\{40\}\)/);
  assert.match(workflow, /github\.event\.issue\.number == 23/);
  assert.match(workflow, /COMMENT_AUTHOR.*seungjae3908-source/s);
  assert.match(workflow, /AUTHOR_ASSOCIATION.*OWNER/s);
  assert.match(workflow, /environment: production/);
});

test('publisher binding preparation requires exact-main CI Auth and release-ready Staging evidence', () => {
  for (const context of [
    'application-ci/verified',
    'browser-ui/verified',
    'database-rls/verified',
    'security-integration/verified',
    'ai-privacy/verified',
    'futures-public-network-smoke/verified',
  ]) assert.ok(workflow.includes(context), context);
  assert.match(workflow, /Staging PostgreSQL Auth Gate/);
  assert.match(workflow, /staging-verdict-/);
  assert.match(workflow, /verify-staging-verdict\.mjs/);
});

test('binding preparer is canonical-path atomic and cannot switch publisher account identity silently', () => {
  assert.match(script, /\/opt\/stock-app-data\/paper-forward-v1/);
  assert.match(script, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(script, /existing publisher account binding differs; separate identity migration approval required/);
  assert.match(script, /writeFileSync\(temporary/);
  assert.match(script, /renameSync\(temporary, path\)/);
  assert.match(script, /accountBindingVerified: true/);
  assert.doesNotMatch(script, /publisherAccountIdSha256.*process\.stdout/s);
});

test('binding preparation has no schedule deploy private API or trading authority', () => {
  assert.match(script, /executionAuthority: 'NONE'/);
  assert.match(script, /privateApiAllowed: false/);
  assert.match(script, /liveTrading: false/);
  assert.match(script, /financialMutationAllowed: false/);
  assert.match(script, /orderAuthority: false/);
  assert.match(script, /scheduleMutationPerformed: false/);
  assert.doesNotMatch(script, /\bcrontab\s+-|\bpm2\s+(?:start|restart|reload|delete|stop)|\bsystemctl\b|deploy-production\.sh|LIVE_TRADING=true|REAL_ORDER_ENABLED=true|PRIVATE_TRADING_API_ALLOWED=true/);
  assert.doesNotMatch(workflow, /deploy-production\.sh/);
});
