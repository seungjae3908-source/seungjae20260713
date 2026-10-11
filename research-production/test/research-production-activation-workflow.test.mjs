import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = new URL('../../.github/workflows/research-production-activation.yml', import.meta.url);

test('current-main Application CI lookup is scoped to the Application CI workflow', async () => {
  const source = await readFile(workflow, 'utf8');
  const targetLookup = source.match(
    /const targetRuns = await github\.paginate\(([\s\S]*?)\n\s*const targetApplicationRuns =/u,
  );

  assert.ok(targetLookup, 'target Application CI lookup block must exist');
  assert.match(targetLookup[1], /github\.rest\.actions\.listWorkflowRuns/u);
  assert.match(targetLookup[1], /workflow_id: 'futures-public-network-smoke\.yml'/u);
  assert.match(targetLookup[1], /branch: 'main'/u);
  assert.doesNotMatch(targetLookup[1], /listWorkflowRunsForRepo/u);
});
