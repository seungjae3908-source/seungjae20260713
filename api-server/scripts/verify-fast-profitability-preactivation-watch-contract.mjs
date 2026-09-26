import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.cwd(), path.basename(process.cwd()) === 'api-server' ? '..' : '.');
const read = (file) => readFile(path.join(root, file), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error('[fast-preactivation-watch-contract] ' + message);
};

const workflow = await read('.github/workflows/fast-profitability-v1-preactivation-watch.yml');
const watcher = await read('api-server/src/scripts/run-fast-profitability-preactivation-watch.ts');
const activation = await read('api-server/src/services/fast-profitability-activation.service.ts');
const tests = await read('api-server/src/services/fast-profitability-activation.service.test.ts');

assert(workflow.includes("cron: '7,22,37,52 * * * *'"), '15-minute staggered schedule is required');
assert(!workflow.includes('issue_comment:'), 'scheduled watch must not subscribe to issue_comment');
assert(workflow.includes("if: github.event_name == 'schedule'"), 'watch job must be schedule-only');
assert(!workflow.includes("startsWith(github.event.comment.body, '/run-fast-profitability-preactivation-watch ')"), 'manual comment watch command must be absent');
assert(!workflow.includes('author_association'), 'scheduled watch must not depend on comment author metadata');
assert(
  workflow.includes("group: fast-profitability-v1-preactivation-forward-watch-${{ github.event_name == 'pull_request' && github.event.pull_request.number || 'schedule' }}"),
  'schedule and pull-request validation concurrency must be isolated',
);
assert(workflow.includes("run.data.event !== 'schedule'"), 'prior watch state must come from a natural schedule run');
assert(workflow.includes('getBranch') && workflow.includes('mainSha'), 'current-main resolution required');
for (const status of [
  'application-ci/verified',
  'browser-ui/verified',
  'database-rls/verified',
  'security-integration/verified',
  'ai-privacy/verified',
  'futures-public-network-smoke/verified',
]) {
  assert(workflow.includes(status), 'Required CI gate missing: ' + status);
}
assert(workflow.includes('CURRENT_MAIN_REQUIRED_CI_NOT_READY'), 'unverified main must clean no-op');
assert(workflow.includes('ACTIVE_BINDING_PRESENT'), 'watch must stop after activation exists');
assert(
  workflow.includes('fast-profitability-v1-preactivation-watch-state-${{ steps.gate.outputs.target_sha }}'),
  'watch state must be exact-SHA scoped',
);
assert(workflow.includes('steps.previous.outputs.found') && workflow.includes('--state-input'), 'prior exact-SHA observer state continuity is required');
assert(
  (workflow.match(/node api-server\/\.fast-profitability-runtime\/forward-observer\.mjs/gu) ?? []).length === 1,
  'scheduled watch must execute exactly one Forward observer cycle',
);
assert(!/for\s*\(\(\s*cycle|while\s+/u.test(workflow), 'multi-cycle retry loops are forbidden in scheduled watch');
assert(workflow.includes('Report newly observed canonical candidate'), 'candidate-only notification step required');
assert(workflow.includes('action=HUMAN_REVIEW_ONLY'), 'candidate notification must remain human-review-only');
assert(workflow.includes('auto_activation=false'), 'auto activation must be explicitly false');
assert(workflow.includes('activation_command_created=false'), 'activation command creation must be explicitly false');
assert(workflow.includes('activation_binding_created=false'), 'activation binding creation must be explicitly false');

assert(workflow.includes('actions: read'), 'actions permission must be read-only');
assert(workflow.includes('contents: read'), 'contents permission must be read-only');
assert(workflow.includes('issues: write'), 'issue notification permission is required');
assert(!/secrets\./u.test(workflow), 'watch must not consume repository/environment secrets');
assert(!/environment:\s*(?:production|staging)/iu.test(workflow), 'Production/Staging environments are forbidden');
assert(!/\bssh\b|\bpm2\b|deploy-production|run-staging|supabase\s+db/iu.test(workflow), 'deploy/SSH/DB mutation tooling is forbidden');

assert(activation.includes('inspectFastProfitabilityPreActivationCandidatesV1'), 'watch must reuse the activation candidate selector');
assert(
  activation.includes('activationCandidateRows(input.observerState, targetSha, inspectedAtMs)'),
  'read-only inspector must delegate to activationCandidateRows',
);
assert(tests.includes('preactivation inspector reuses the exact activation candidate ordering'), 'candidate ordering regression test required');
assert(tests.includes('preactivation inspector returns zero candidates for expired observations'), 'expired candidate regression test required');

for (const marker of [
  'inspectFastProfitabilityPreActivationCandidatesV1',
  'autoActivationAllowed: false',
  'activationCommandCreated: false',
  'activationBindingCreated: false',
  'economicCreditCreated: 0',
  'validationCredit: 0',
  'oosCredit: 0',
  'profitabilityCredit: 0',
  'replayCredit: 0',
  'backfillCredit: 0',
  'syntheticCredit: 0',
  'manualCredit: 0',
  "executionAuthority: 'NONE'",
  'liveTrading: false',
  'autoTrading: false',
  'realOrderEnabled: false',
  'privateTradingApiAllowed: false',
]) {
  assert(watcher.includes(marker), 'watch safety marker missing: ' + marker);
}
assert(!watcher.includes('buildFastProfitabilityActivationBundleV1'), 'watch must not build an activation bundle');
assert(!watcher.includes('randomBytes'), 'watch must not create activation/sealing key material');
assert(!watcher.includes('/activate-fast-profitability-v1'), 'watch must not create or invoke activation commands');

console.log('[fast-preactivation-watch-contract] static contract passed');
