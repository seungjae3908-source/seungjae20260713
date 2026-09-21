import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('ready dispatcher treats an advanced unique PR head as a safe superseded no-op', async () => {
  const document = await readFile('.github/workflows/application-full-ci-ready-dispatch.yml', 'utf8');
  assert.match(document, /const openCandidates = \[\]/u);
  assert.match(document, /openCandidates\.push\(pr\)/u);
  assert.match(document, /openMatches\.length === 0 && openCandidates\.length === 1/u);
  assert.match(document, /currentHeadSha !== targetSha/u);
  assert.match(document, /\[SUPERSEDED_FAST_HEAD\]/u);
  assert.match(document, /core\.setOutput\('dispatch', 'false'\)/u);
  assert.match(document, /openMatches\.length !== 1/u);
  assert.match(document, /READY_FAST_CI_PR_RESOLUTION_FAILED/u);
});
