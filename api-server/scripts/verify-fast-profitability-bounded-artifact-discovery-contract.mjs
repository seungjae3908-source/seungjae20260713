import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.cwd(), path.basename(process.cwd()) === 'api-server' ? '..' : '.');
const read = (file) => readFile(path.join(root, file), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error('[fast-artifact-discovery-contract] ' + message);
};

const files = [
  '.github/workflows/fast-profitability-v1-preactivation-watch.yml',
  '.github/workflows/fast-profitability-v1-collector.yml',
  '.github/workflows/fast-profitability-v1-activation.yml',
];

for (const file of files) {
  const text = await read(file);
  assert(!text.includes('github.paginate(github.rest.actions.listWorkflowRuns'), file + ' must not use unbounded workflow-run pagination');
  assert(text.includes("status: 'success'") || text.includes("run.conclusion !== 'success'"), file + ' must reject non-success workflow provenance');
  assert(!text.includes("status: 'completed'"), file + ' must not let failed/skipped/cancelled runs consume discovery');
  const artifactCalls = [...text.matchAll(/listArtifactsForRepo\(\{([\s\S]*?)\}\)/gu)];
  for (const [, args] of artifactCalls) {
    assert(/\bname\s*:/u.test(args) || /\bname\s*,/u.test(args), file + ' repository artifact lookup must use an exact name filter');
    assert(/per_page\s*:\s*100/u.test(args), file + ' exact-name artifact lookup must remain bounded to one page');
  }
}

const collector = await read('.github/workflows/fast-profitability-v1-collector.yml');
assert(collector.includes('[FAST_PROFITABILITY_V1_ACTIVATED]'), 'collector must resolve the durable activation receipt first');
assert(collector.includes("issue_number: 1102"), 'collector activation receipt must remain bound to canonical Hub #1102');
assert(collector.includes("name: artifactName"), 'collector activation artifact lookup must use the exact receipt-derived artifact name');
assert(collector.includes('b.activationDigest !== process.env.EXPECTED_ACTIVATION_DIGEST'), 'downloaded binding must match the receipt activation digest');
assert(collector.includes('run_id: Number(process.env.ACTIVATION_RUN_ID)'), 'OOS key lookup must be scoped to the bound activation run');
assert(collector.includes("workflow_id: 'prediction-lab-canonical-shadow-cycle.yml'"), 'Shadow lookup must remain scoped to canonical Shadow workflow');
assert(collector.includes("event: 'schedule'"), 'Shadow lookup must ignore issue-comment no-op runs and inspect genuine scheduled cycles');

const activation = await read('.github/workflows/fast-profitability-v1-activation.yml');
assert(activation.includes('[FAST_PROFITABILITY_V1_ACTIVATED]'), 'activation must retain the durable activation receipt');
assert(activation.includes("'activation_run_id=' + context.runId"), 'future activation receipts must expose exact activation run provenance');
assert(activation.includes("name: artifactName"), 'duplicate binding lookup must use exact receipt-derived artifact name');

const watch = await read('.github/workflows/fast-profitability-v1-preactivation-watch.yml');
assert(watch.includes('[FAST_PROFITABILITY_V1_ACTIVATED]'), 'preactivation watch must resolve durable activation receipt before deciding no binding exists');
assert(watch.includes("name: artifactName"), 'preactivation active-binding lookup must use exact artifact name');

console.log('[fast-artifact-discovery-contract] receipt-bound exact-name discovery passed');
