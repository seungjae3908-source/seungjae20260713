import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

for (const name of ['research-production-activation', 'research-ai-production-activation', 'research-market-watch-activation', 'research-dashboard-activation']) {
  test(`${name} requires protected Production approval before SSH activation`, async () => {
    const source = (await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
    const activate = source.split('\n  activate:\n')[1]?.split(/\n  [a-zA-Z][a-zA-Z0-9_-]*:\n/u)[0] ?? '';
    assert.ok(activate, 'Research activation job must exist');
    assert.match(activate, /^    needs: authorize$/mu, 'Exact owner/main/CI authorization must precede activation');
    assert.match(activate, /^    environment: production$/mu, 'SSH secrets and mutation must stay behind protected Production approval');
    assert.match(activate, /secrets\.PROD_SSH_PRIVATE_KEY/u);
  });
}

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
