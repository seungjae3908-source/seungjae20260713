import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAPER_INTEGRATION_SHA, RESEARCH_CENTER_BATCH_PATHS, isPreservedPaperIntegrationPath, isResearchCenterBatchUi } from '../scripts/research-center-batch-scope.mjs';

const sharedPath = 'api-server/src/services/trade-execution.service.ts';
const blob = 'a'.repeat(40);
const read = (file) => readFileSync(new URL('../../' + file, import.meta.url), 'utf8');

test('batch uses exact unique paths, without directory or traversal exemptions', () => {
  assert.equal(RESEARCH_CENTER_BATCH_PATHS.length, new Set(RESEARCH_CENTER_BATCH_PATHS).size);
  for (const path of RESEARCH_CENTER_BATCH_PATHS) assert.ok(!path.includes('*') && !path.includes('..'));
  for (const path of ['ops/deploy-production.sh', 'api-server/src/middleware/auth.ts', 'packages/member-access/src/index.js', 'pnpm-lock.yaml', 'stock-analyzer/src/pages/auto-trading.tsx']) {
    assert.ok(!RESEARCH_CENTER_BATCH_PATHS.includes(path), path);
  }
});

test('shared Paper repair is accepted only from the pinned immutable snapshot', () => {
  assert.match(PAPER_INTEGRATION_SHA, /^[0-9a-f]{40}$/u);
  const refs = [];
  assert.equal(isPreservedPaperIntegrationPath(sharedPath, (ref, path) => {
    refs.push(ref); assert.equal(path, sharedPath); return blob;
  }), true);
  assert.deepEqual(refs, [PAPER_INTEGRATION_SHA, 'HEAD']);
});

test('a one-byte equivalent blob identity change restores the automatic-trading gate', () => {
  assert.equal(isPreservedPaperIntegrationPath(sharedPath, (ref) => ref === 'HEAD' ? 'b'.repeat(40) : blob), false);
});

test('missing, empty or unreadable pinned blobs fail closed', () => {
  assert.equal(isPreservedPaperIntegrationPath(sharedPath, () => ''), false);
  assert.equal(isPreservedPaperIntegrationPath(sharedPath, () => null), false);
  assert.equal(isPreservedPaperIntegrationPath(sharedPath, () => { throw new Error('missing'); }), false);
});

test('matching blobs do not exempt arbitrary execution paths', () => {
  for (const path of ['ops/deploy-production.sh', 'api-server/src/index.ts', '../' + sharedPath, sharedPath + '.new']) {
    assert.equal(isPreservedPaperIntegrationPath(path, () => blob), false, path);
  }
});

test('UI scope excludes all Live, credential and unrelated Paper pages', () => {
  assert.equal(isResearchCenterBatchUi('stock-analyzer/src/pages/research-center.tsx'), true);
  assert.equal(isResearchCenterBatchUi('stock-analyzer/src/pages/auto-trading.tsx'), false);
  assert.equal(isResearchCenterBatchUi('stock-analyzer/src/pages/account.tsx'), false);
  assert.equal(isResearchCenterBatchUi('stock-analyzer/src/components/trade-automation-settings.tsx'), false);
  assert.equal(isResearchCenterBatchUi('stock-analyzer/src/components/research-not-reviewed.tsx'), false);
});

test('workspace preserves full automatic trading gates for unpinned edits', () => {
  const source = read('.github/scripts/verify-research-workspace-sync-v3.mjs');
  for (const token of ['AUTOMATIC_TRADING_SCOPE_GUARD_MISSING:', 'AUTOMATIC_TRADING_RESEARCH_SCOPE_FORBIDDEN:', 'AUTOMATIC_TRADING_PAPER_ONLY_DEPLOY_ACTIVATION_FORBIDDEN', 'MAIN_ROUTE_CHANGE_NOT_PRESERVED', 'PROTECTED_PATH_CHANGED:', "git('merge-base','--is-ancestor',PAPER_INTEGRATION_SHA,'HEAD')", '!preservedPaperIntegration.includes(p)']) assert.ok(source.includes(token), token);
});

test('member overview remains authenticated GET-only while administration is guarded', () => {
  const route = read('api-server/src/routes/index.ts');
  const overview = read('api-server/src/routes/research-overview.ts');
  assert.ok(route.indexOf('router.use(requireAuthenticated);') < route.indexOf("router.use('/research',"));
  assert.ok(route.includes("requireCapability('canAccessBasicInfo'), researchOverviewRouter"));
  assert.ok(overview.includes('sanitizeResearchCenterOverview'));
  assert.ok(!/router\.(?:post|put|patch|delete)\(/u.test(overview));
  assert.ok(read('api-server/src/routes/admin.ts').includes('router.use(requireAuthenticated, requireAdmin);'));
  assert.ok(read('api-server/src/routes/research-workspace.ts').includes("requireCapability('canManageMembers')"));
});

test('predeploy shell steps retain valid run indentation and no extra authority', () => {
  const source = read('.github/workflows/research-center-predeploy-validation.yml');
  assert.match(source, /- name: Research Center overview[^\n]*\r?\n        run: \|\r?\n          set -Eeuo pipefail/u);
  assert.ok(!/^\s*environment:\s*(?:production|staging)\s*$/mu.test(source));
  assert.ok(!source.includes('${{ secrets.'));
  assert.ok(source.includes('DEPLOY_AUTHORITY=false'));
});

test('production membership denial uses the actual basic-info capability and safe artifacts', () => {
  const workflow = read('.github/workflows/production-comprehensive-readonly-qa.yml');
  const spec = read('stock-analyzer/e2e/production-research-center-readonly-qa.spec.ts');
  const marker = 'RESEARCH_CENTER_NOT_EVALUATED: Production QA credential lacks canAccessBasicInfo';
  assert.ok(workflow.includes(marker) && spec.includes(marker));
  assert.ok(spec.includes("getByTestId('capability-denied')"));
  const config = read('stock-analyzer/playwright.production-comprehensive.config.ts');
  assert.ok(config.includes("trace: 'off'"));
  assert.ok(config.includes("screenshot: 'off'"));
});
