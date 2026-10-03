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
  assert(text.includes('const HUB_ISSUE = 1102;'), file + ' must resolve activation from the canonical Hub receipt');
  assert(text.includes('const MAX_HUB_COMMENTS = 2500;'), file + ' must preserve the bounded Hub hard limit');
  assert(text.includes("const RECEIPT_MARKER = '[FAST_PROFITABILITY_V1_ACTIVATED]';"), file + ' must require the canonical activation receipt marker');
  assert(text.includes("fields.get('activation_run_id')"), file + ' must bind the receipt to an exact activation run');
  assert(text.includes('github.rest.issues.get'), file + ' must read bounded Hub comment count');
  assert(text.includes('github.rest.issues.listComments'), file + ' must read canonical Hub receipt history');
  assert(text.includes('page >= 1; page -= 1'), file + ' must scan Hub receipt pages newest-first within the hard bound');
  assert(text.includes('github.rest.actions.getWorkflowRun'), file + ' must verify exact activation-run provenance');
  assert(text.includes('listWorkflowRunArtifacts'), file + ' must bind artifacts to the exact activation run');
  assert(text.includes("run.path !== '.github/workflows/fast-profitability-v1-activation.yml'"), file + ' must verify activation workflow identity');
  assert(!text.includes('FAST_ACTIVATION_DISCOVERY_WINDOW_EXHAUSTED'), file + ' must not fail because unrelated issue_comment runs pushed the activation outside a run-page window');
  assert(!/workflow_id: 'fast-profitability-v1-activation\.yml'[\s\S]{0,240}event: 'issue_comment'[\s\S]{0,240}status: 'success'/.test(text),
    file + ' must not rediscover activation by scanning noisy successful issue_comment workflow history');
}
const activation = await read('.github/workflows/fast-profitability-v1-activation.yml');
assert(activation.includes("'activation_run_id=' + context.runId"), 'activation receipt must publish exact workflow run id');
const collector = await read('.github/workflows/fast-profitability-v1-collector.yml');
assert(collector.includes('run_id: Number(process.env.ACTIVATION_RUN_ID)'), 'OOS key lookup must remain scoped to the bound activation run');
assert(collector.includes('prediction-lab-canonical-shadow-cycle.yml'), 'Shadow lookup must remain scoped to the canonical Shadow workflow');
console.log('[fast-artifact-discovery-contract] canonical Hub receipt + exact run-scoped artifact discovery passed');
