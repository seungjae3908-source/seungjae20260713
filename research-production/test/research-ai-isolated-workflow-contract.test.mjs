import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../../.github/workflows/research-ai-isolated-validation.yml', import.meta.url);
const activationWorkflowUrl = new URL('../../.github/workflows/research-ai-production-activation.yml', import.meta.url);

test('isolated natural-cycle workflow requires an exact owner command and protected approval', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(workflow, /comment\.user\.login == github\.repository_owner/u);
  assert.match(workflow, /author_association == 'OWNER'/u);
  assert.match(workflow, /\/validate-research-ai-isolated /u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /bash -s -- validate-isolated/u);
  assert.match(workflow, /REPOSITORY_URL/u);
  assert.doesNotMatch(workflow, /AI_RESEARCH_ISOLATED_EXACT_RELEASE_RECEIPT_REQUIRED/u);
  assert.match(workflow, /PRODUCTION_STATE_MUTATED=false/u);
  assert.match(workflow, /systemd_changed: false/u);
  assert.match(workflow, /provider_secret_values_exposed: false/u);
  assert.doesNotMatch(workflow, /bash -s -- activate\b/u);
  assert.doesNotMatch(workflow, /systemctl\s+(?:enable|disable|start|stop|restart)/u);
});

test('production activation requires the exact-SHA isolated success receipt', async () => {
  const workflow = await readFile(activationWorkflowUrl, 'utf8');
  assert.match(workflow, /AI_RESEARCH_EXACT_ISOLATED_VALIDATION_RECEIPT_REQUIRED/u);
  assert.match(workflow, /\[RESEARCH_AI_ISOLATED_VALIDATION\]/u);
  assert.match(workflow, /production_state_mutated: false/u);
  assert.match(workflow, /natural_cycle_proven: true/u);
});
