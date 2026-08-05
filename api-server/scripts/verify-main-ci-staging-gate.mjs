import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.cwd(), path.basename(process.cwd()) === 'api-server' ? '..' : '.');
const workflowPath = path.join(root, '.github/workflows/application-ci-main-coverage.yml');
const workflow = await readFile(workflowPath, 'utf8');

const assert = (condition, message) => {
  if (!condition) throw new Error(`[main-ci-staging-gate] ${message}`);
};

const pushBlock = /\n\s*push:\s*\n([\s\S]*?)(?=\n\s{2}[a-zA-Z_][\w-]*:\s*\n)/.exec(workflow)?.[1] ?? '';

assert(/^name: Application CI$/m.test(workflow), 'coverage workflow must produce an Application CI push run');
assert(/branches:\s*\n\s*- main/.test(pushBlock), 'coverage workflow must run on every main push');
assert(!/\n\s*paths(?:-ignore)?:/.test(`\n${pushBlock}`), 'main push coverage must not use path filtering');
assert(workflow.includes("workflowId = 'futures-public-network-smoke.yml'"), 'coverage workflow must dispatch only the official Application CI workflow');
assert(workflow.includes('target_sha: targetSha'), 'dispatch must attach statuses to the exact main SHA');
assert(workflow.includes('checkout_ref: targetSha'), 'dispatch must checkout the exact immutable SHA');
assert(workflow.includes("main.data.commit.sha !== targetSha"), 'coverage workflow must reject stale main SHAs');
assert(workflow.includes("run.path === '.github/workflows/futures-public-network-smoke.yml'"), 'coverage workflow must verify official workflow provenance');
assert(workflow.includes("['push', 'workflow_dispatch'].includes(run.event)"), 'coverage workflow must accept only official push or explicit dispatch provenance');
assert(workflow.includes('Existing Application CI already owns'), 'coverage workflow must avoid duplicate dispatch when normal CI already started');

for (const status of [
  'application-ci/verified',
  'browser-ui/verified',
  'database-rls/verified',
  'security-integration/verified',
  'ai-privacy/verified',
  'futures-public-network-smoke/verified',
]) {
  assert(workflow.includes(status), `coverage workflow is missing required status ${status}`);
}

assert(!workflow.includes('production-deploy.yml'), 'coverage workflow must never dispatch production');
assert(!workflow.includes('staging-readiness.yml'), 'coverage workflow must not dispatch staging by itself');
assert(!workflow.includes('secrets.'), 'coverage workflow must not read repository or environment secrets');
assert(!workflow.includes('force'), 'coverage workflow must not modify branch refs');

console.log('main CI staging gate coverage contract verified');
