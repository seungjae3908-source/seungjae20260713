import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyChangedFiles, commandsForImpact } from '../scripts/ci-impact-plan.mjs';

test('impact plan selects only relevant expensive lanes while preserving shared safety', () => {
  const scanner = classifyChangedFiles(['api-server/src/services/stock-signal-scanner.service.ts']);
  assert.equal(scanner.backend, true);
  assert.equal(scanner.phase2, true);
  assert.equal(scanner.phase6, true);
  assert.equal(scanner.frontend, false);

  const commands = commandsForImpact(scanner);
  assert.ok(commands.includes('pnpm --dir api-server run test:phase2'));
  assert.ok(commands.includes('pnpm --dir api-server run test:phase6'));
  assert.ok(commands.includes('pnpm --dir api-server run test:unit'));
  assert.ok(commands.includes('pnpm --dir api-server run test:smoke'));
  assert.ok(!commands.includes('pnpm --dir api-server run test:phase5'));
});

test('shared changes expand to frontend and backend checks', () => {
  const impact = classifyChangedFiles(['packages/member-access/src/index.js']);
  assert.equal(impact.shared, true);
  assert.equal(impact.frontend, true);
  assert.equal(impact.backend, true);
});

test('pre-ci virtual merge and ready gate fail closed with command-scoped merge identity', async () => {
  const document = await readFile('.github/scripts/pre-ci-v3.mjs', 'utf8');
  assert.match(document, /VIRTUAL_MERGE_CONFLICT/u);
  assert.match(document, /READY_BASE_STALE/u);
  assert.match(document, /READY_PRODUCT_INTEGRITY_BLOCKED/u);
  assert.match(document, /git worktree add --detach/u);
  assert.match(document, /git -c user\.name=pre-ci-v3 -c user\.email=pre-ci-v3@invalid\.local merge --no-commit --no-ff/u);
  assert.doesNotMatch(document, /git config --global|--force-with-lease|push --force|git push/u);
});

test('fast CI covers commit changes for Draft and Ready PRs without rerunning on Ready transition', async () => {
  const document = await readFile('.github/workflows/application-fast-ci.yml', 'utf8');
  assert.match(document, /ci-impact-plan\.mjs/u);
  assert.match(document, /pre-ci-v3\.mjs/u);
  assert.match(document, /--virtual-merge --gate-only/u);
  assert.match(document, /- opened/u);
  assert.match(document, /- synchronize/u);
  assert.match(document, /- reopened/u);
  assert.match(document, /- converted_to_draft/u);
  assert.doesNotMatch(document, /- ready_for_review/u);
  assert.doesNotMatch(document, /if:\s*github\.event\.pull_request\.draft\s*==\s*true/u);
  assert.match(document, /Application Fast CI is a development accelerator only/u);
});

test('ready dispatcher sequences commit-change full CI strictly after successful exact-head Fast CI', async () => {
  const document = await readFile('.github/workflows/application-full-ci-ready-dispatch.yml', 'utf8');
  assert.match(document, /workflow_run:/u);
  assert.match(document, /Application Fast CI/u);
  assert.match(document, /github\.event\.workflow_run\.conclusion == 'success'/u);
  assert.match(document, /run\.head_sha/u);
  assert.match(document, /pr\.draft/u);
  assert.match(document, /target_sha: targetSha/u);
  assert.match(document, /createWorkflowDispatch/u);
  assert.match(document, /Failed, skipped, cancelled, missing, stale, or Draft Fast CI cannot dispatch/u);
});

test('canonical full CI keeps direct Ready transition and independently requires green Fast CI', async () => {
  const document = await readFile('.github/workflows/futures-public-network-smoke.yml', 'utf8');
  const triggerSection = document.slice(0, document.indexOf('\npermissions:'));
  assert.match(triggerSection, /pull_request:/u);
  assert.match(triggerSection, /ready_for_review/u);
  assert.match(document, /READY_FAST_CI_NOT_GREEN/u);
  assert.match(document, /latestFast\.conclusion !== 'success'/u);
  assert.match(document, /^  ready-gate:/mu);
  assert.match(document, /^  application-tests:/mu);
  assert.match(document, /matrix:/u);
  assert.match(document, /phase2, risk, phase4, phase5, phase6, phase7, phase8, phase9, phase12, smoke/u);
  assert.match(document, /application-build-\$\{\{ env\.APPLICATION_STATUS_SHA \}\}/u);
  assert.match(document, /actions\/upload-artifact@v4/u);
  assert.match(document, /actions\/download-artifact@v4/u);
  assert.match(document, /application-ci\/verified/u);
  assert.match(document, /browser-ui\/verified/u);
  assert.match(document, /database-rls\/verified/u);
  assert.match(document, /security-integration\/verified/u);
  assert.match(document, /ai-privacy\/verified/u);
  assert.match(document, /futures-public-network-smoke\/verified/u);

  const security = document.slice(document.indexOf('  security-integration:'), document.indexOf('  ai-privacy:'));
  const ai = document.slice(document.indexOf('  ai-privacy:'), document.indexOf('  network-smoke:'));
  assert.doesNotMatch(security, /Build frontend for bundle inspection/u);
  assert.doesNotMatch(ai, /Build frontend for secret inspection/u);
  assert.match(security, /Verify immutable build artifact identity/u);
  assert.match(ai, /Verify immutable build artifact identity/u);
});

test('V3 does not grant deployment or trading authority', async () => {
  for (const file of [
    '.github/workflows/application-fast-ci.yml',
    '.github/workflows/application-full-ci-ready-dispatch.yml',
    '.github/workflows/futures-public-network-smoke.yml',
  ]) {
    const document = await readFile(file, 'utf8');
    assert.doesNotMatch(document, /REAL_ORDER_ENABLED\s*:\s*true/u);
    assert.doesNotMatch(document, /AUTO_TRADING\s*:\s*true/u);
    assert.doesNotMatch(document, /^\s+environment:\s*production\s*$/mu);
  }
});
