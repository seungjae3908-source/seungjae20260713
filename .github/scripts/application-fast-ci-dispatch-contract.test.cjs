'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowPath = path.resolve(__dirname, '..', 'workflows', 'application-fast-ci.yml');

test('pre-merge Full CI reuse lookup stays bounded to the current PR branch', () => {
  const source = fs.readFileSync(workflowPath, 'utf8');
  const start = source.indexOf("const workflowId = 'futures-public-network-smoke.yml';");
  const end = source.indexOf('await github.rest.actions.createWorkflowDispatch({', start);
  const lookup = source.slice(start, end);

  assert.ok(start >= 0, 'Full CI workflow lookup must exist');
  assert.ok(end > start, 'Full CI dispatch must follow its reuse lookup');
  assert.match(lookup, /github\.rest\.actions\.listWorkflowRuns\(\{/u);
  assert.match(lookup, /branch: headRef,/u);
  assert.match(lookup, /per_page: 100,/u);
  assert.match(lookup, /existingPage\.workflow_runs \?\? \[\]/u);
  assert.doesNotMatch(lookup, /github\.paginate/u);
});
