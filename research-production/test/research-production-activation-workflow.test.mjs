import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

for (const name of ['research-production-activation', 'research-market-watch-activation']) {
  test(`${name} looks up exact main CI in the correct workflow without bypassing six checks`, async () => {
    const source = await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    assert.match(source, /github\.rest\.actions\.listWorkflowRuns[,\s]/);
    assert.match(source, /workflow_id:\s*'futures-public-network-smoke\.yml'/);
    assert.match(source, /branch:\s*'main'/);
    assert.match(source, /run\.head_sha\.toLowerCase\(\)\s*===/);
    for (const context of ['application-ci/verified', 'browser-ui/verified', 'database-rls/verified', 'security-integration/verified', 'ai-privacy/verified', 'futures-public-network-smoke/verified']) assert.ok(source.includes(context));
  });
}
