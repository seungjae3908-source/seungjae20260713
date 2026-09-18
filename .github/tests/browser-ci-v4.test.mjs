import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Browser CI V4 keeps the full canonical suite and disables retry-to-pass', async () => {
  const config = await readFile('stock-analyzer/playwright.config.ts', 'utf8');
  const pkg = JSON.parse(await readFile('stock-analyzer/package.json', 'utf8'));

  assert.match(config, /testDir:\s*'\.\/e2e'/u);
  assert.match(config, /testIgnore:\s*\/production-readonly-smoke\\\.spec\\\.ts\//u);
  assert.match(config, /retries:\s*0/u);
  assert.match(config, /workers:\s*process\.env\.CI \? 1 : undefined/u);
  assert.equal(pkg.scripts['test:e2e'], 'playwright test -c playwright.config.ts');
  assert.equal(pkg.scripts['test:e2e:critical'], 'playwright test -c playwright.critical.config.ts');
});

test('critical browser suite covers the primary product journeys without replacing the full suite', async () => {
  const critical = await readFile('stock-analyzer/playwright.critical.config.ts', 'utf8');
  for (const name of [
    'full-product-browser-flow',
    'app-navigation',
    'ai-chart-v2',
    'signal-scanner',
    'paper-trading-risk-copy-truth',
    'portfolio-professional-ui',
    'account-professional-ui',
    'phase12-trade-automation',
    'research-copilot',
  ]) {
    assert.match(critical, new RegExp(name, 'u'), `missing critical browser journey: ${name}`);
  }
  assert.match(critical, /retries:\s*0/u);
  assert.doesNotMatch(critical, /testIgnore/u);
});

test('Fast CI requires critical browser journeys for frontend or CI changes', async () => {
  const workflow = await readFile('.github/workflows/application-fast-ci.yml', 'utf8');
  assert.match(workflow, /^  browser-critical:/mu);
  assert.match(workflow, /Critical browser journeys before Ready/u);
  assert.match(workflow, /test:e2e:critical/u);
  assert.match(workflow, /steps\.impact\.outputs\.frontend == 'true' \|\| steps\.impact\.outputs\.ci == 'true'/u);
  assert.match(workflow, /playwright-\$\{\{ runner\.os \}\}-chromium-1\.61\.1/u);
  assert.doesNotMatch(workflow, /browser-ui\/verified/u);
});

test('Full Browser Required context is four-way sharded and aggregated once', async () => {
  const workflow = await readFile('.github/workflows/futures-public-network-smoke.yml', 'utf8');

  assert.match(workflow, /^  browser-ui-start:/mu);
  assert.match(workflow, /^  browser-ui-shard:/mu);
  assert.match(workflow, /^  browser-ui-result:/mu);
  assert.doesNotMatch(workflow, /^  browser-ui:$/mu);
  assert.match(workflow, /shard:\s*\[1, 2, 3, 4\]/u);
  assert.match(workflow, /fail-fast:\s*false/u);
  assert.match(workflow, /pnpm --dir stock-analyzer exec playwright test -c playwright\.config\.ts --shard=\$\{\{ matrix\.shard \}\}\/4 --retries=0/u);
  assert.doesNotMatch(workflow, /run test:e2e -- --shard=/u);
  assert.match(workflow, /needs:\s*\[browser-ui-start, browser-ui-shard\]/u);
  assert.match(workflow, /Aggregate Browser UI Required context/u);
  assert.match(workflow, /browser-ui\/verified/u);
  assert.match(workflow, /phase9-playwright-\$\{\{ github\.run_id \}\}-shard-\$\{\{ matrix\.shard \}\}/u);

  const browserShard = workflow.slice(
    workflow.indexOf('  browser-ui-shard:'),
    workflow.indexOf('  browser-ui-result:'),
  );
  assert.doesNotMatch(browserShard, /continue-on-error:\s*true[\s\S]*Run full Playwright shard/u);
});

test('Browser CI V4 adds no deployment or trading authority', async () => {
  for (const file of [
    '.github/workflows/application-fast-ci.yml',
    '.github/workflows/futures-public-network-smoke.yml',
    'stock-analyzer/playwright.config.ts',
    'stock-analyzer/playwright.critical.config.ts',
  ]) {
    const document = await readFile(file, 'utf8');
    assert.doesNotMatch(document, /REAL_ORDER_ENABLED\s*:\s*true/u);
    assert.doesNotMatch(document, /AUTO_TRADING\s*:\s*true/u);
    assert.doesNotMatch(document, /PRIVATE_TRADING_API_ALLOWED\s*:\s*true/u);
    assert.doesNotMatch(document, /pull_request_target/u);
  }
});
