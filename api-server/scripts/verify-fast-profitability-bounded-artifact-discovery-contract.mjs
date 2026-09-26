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
  assert(!text.includes('listArtifactsForRepo'), file + ' must not scan the repository-wide artifact collection');
  assert(!text.includes('github.paginate(github.rest.actions.listWorkflowRuns'), file + ' must not use unbounded workflow-run pagination');
  assert(text.includes('listWorkflowRunArtifacts'), file + ' must bind artifact reads to an exact workflow run');
  assert(text.includes('const maxPages = 5;'), file + ' must use a bounded workflow-run discovery window');
  assert(text.includes('DISCOVERY_WINDOW_EXHAUSTED'), file + ' must fail closed when bounded discovery is exhausted');
}
const collector = await read('.github/workflows/fast-profitability-v1-collector.yml');
assert(collector.includes('run_id: Number(process.env.ACTIVATION_RUN_ID)'), 'OOS key lookup must be scoped to the bound activation run');
assert(collector.includes('prediction-lab-canonical-shadow-cycle.yml'), 'Shadow lookup must be scoped to the canonical Shadow workflow');
console.log('[fast-artifact-discovery-contract] bounded run-scoped discovery passed');
