import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PAPER_FORWARD_REVIEWED_PATHS, AUTOMATIC_LIVE_SAFETY_REVIEWED_PATHS,
  AUTOMATIC_SIGNAL_PIPELINE_REVIEWED_PATHS,
  PAPER_FORWARD_AUTO_SAFETY_SUPPLEMENTAL_PATHS } from '../scripts/paper-forward-reviewed-paths.mjs';
import { PAPER_INTEGRATION_SHA, PAPER_INTEGRATION_SOURCE_SHAS, RESEARCH_CENTER_BATCH_PATHS, isPreservedPaperIntegrationPath, isResearchCenterBatchUi, isResearchOnlyNavigationDiff } from '../scripts/research-center-batch-scope.mjs';

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

test('activation lifecycle additions are exactly reviewed validators and tests, not execution exemptions', () => {
  for (const file of ['.github/scripts/research-ai-activation-result.cjs',
    '.github/workflows/research-production-validation.yml',
    'research-production/test/research-ai-activation-lifecycle.test.mjs',
    'research-production/test/research-ai-activation-result.test.mjs']) {
    assert.ok(RESEARCH_CENTER_BATCH_PATHS.includes(file));
    assert.equal(isPreservedPaperIntegrationPath(file, () => blob), false);
  }
  for (const file of ['.github/scripts/research-unreviewed-helper.cjs',
    'research-production/test/unreviewed.test.mjs', 'ops/install-paper-forward-schedule.sh.new',
    'api-server/src/services/unreviewed-trade-execution.service.ts']) {
    assert.equal(RESEARCH_CENTER_BATCH_PATHS.includes(file), false);
    assert.equal(isPreservedPaperIntegrationPath(file, () => blob), false);
  }
  assert.ok(read('.github/scripts/research-ai-activation-result.cjs').includes('grantsExecutionAuthority: false'));
  const batch = read('.github/workflows/research-production-validation.yml');
  assert.match(batch, /^  contents: read$/mu);
  assert.doesNotMatch(batch, /^\s+environment:\s*(?:production|staging)\s*$/mu);
  assert.equal(batch.includes('${{ secrets.'), false);
});

test('a one-byte equivalent blob identity change restores the automatic-trading gate', () => {
  assert.equal(isPreservedPaperIntegrationPath(sharedPath, (ref) => ref === 'HEAD' ? 'b'.repeat(40) : blob), false);
});

test('repinned merge requires both original Paper and current-main safety ancestry', () => {
  assert.deepEqual(PAPER_INTEGRATION_SOURCE_SHAS, [
    '09854c1895b1a41f0dfedc9cf1240734c88ac5e3',
    'af24fe44e286073de29cf31aa1f17fc13a309b28',
  ]);
  const source = read('.github/scripts/verify-research-workspace-sync-v3.mjs');
  assert.ok(source.includes("for(const sourceSha of PAPER_INTEGRATION_SOURCE_SHAS)git('merge-base','--is-ancestor',sourceSha,PAPER_INTEGRATION_SHA)"));
});

test('research navigation substitutions never exempt another Trading edit', () => {
  const before = "      { id: 'research-center', href: APP_ROUTES.researchCenter, label: '연구센터', icon: 'chart', capability: 'canManageMembers' },";
  const after = before.replace('canManageMembers', 'canAccessBasicInfo');
  const diff = '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-' + before + '\n+' + after;
  const file = 'stock-analyzer/src/lib/app-navigation.ts';
  assert.equal(isResearchOnlyNavigationDiff(file, diff), true);
  assert.equal(isResearchOnlyNavigationDiff(file, diff + '\n+  liveTrading: true,'), false);
  assert.equal(isResearchOnlyNavigationDiff(file, diff.replace('canAccessBasicInfo', 'canPlaceOrders')), false);
  assert.equal(isResearchOnlyNavigationDiff(file, ''), false);
  assert.equal(isResearchOnlyNavigationDiff('stock-analyzer/src/pages/auto-trading.tsx', diff), false);
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

test('extracted Paper allowlist preserves the exact legacy set plus its own data file', () => {
  assert.equal(PAPER_FORWARD_REVIEWED_PATHS.length, 268);
  assert.equal(new Set(PAPER_FORWARD_REVIEWED_PATHS).size, 268);
  const digest = createHash('sha256').update([...PAPER_FORWARD_REVIEWED_PATHS].sort().join('\n')).digest('hex');
  assert.equal(digest, '7b991a3b55c36ce644a7fdeedb037a7cc80fbfb7732fb1c811e51cf0ddcacd14');
  for (const path of PAPER_FORWARD_REVIEWED_PATHS) assert.ok(!path.includes('*') && !path.includes('..'));
});

test('Paper run expressions stay below the GitHub 21000 character limit', () => {
  const workflow = read('.github/workflows/paper-forward-schedule-validation.yml');
  for (const block of workflow.split(/\r?\n        run: \|\r?\n/u).slice(1)) {
    const run = block.split(/\r?\n      (?:- name:|- uses:|[a-z][a-z_-]*:)/u)[0];
    assert.ok(run.length < 21000, 'oversized run expression: ' + run.length);
  }
  assert.ok(workflow.includes('mapfile -t allowed < <(node .github/scripts/paper-forward-reviewed-paths.mjs)'));
});

test('owner-approved AUTO safety registration is exactly the 50 approved paths, separate from legacy Paper', () => {
  const paths = AUTOMATIC_LIVE_SAFETY_REVIEWED_PATHS;
  assert.equal(paths.length, 50);
  assert.equal(new Set(paths).size, 50);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(createHash('sha256').update(paths.join('\n')).digest('hex'),
    'be1a41afdcd5832ea63db727b7f10f1b92538a7eb860883db72d6004e85220a3');
  assert.equal(Object.isFrozen(paths), true);
  for (const path of paths) {
    assert.ok(!path.includes('*') && !path.includes('..') && !path.startsWith('/'));
    assert.ok(!PAPER_FORWARD_REVIEWED_PATHS.includes(path));
    assert.ok(!/^(?:market-prediction-lab|research-production|packages\/external-research)\//u.test(path));
  }
  for (const path of ['ops/deploy-production.sh', '.github/scripts/verify-production-preactivation-evidence.cjs',
    '.github/workflows/production-automatic-trading-gate.yml', 'api-server/src/routes/trade-automation.ts',
    'api-server/src/middleware/auth.ts', 'stock-analyzer/src/pages/account.tsx', 'pnpm-lock.yaml',
    paths[0] + '.new', '../' + paths[0]]) assert.equal(paths.includes(path), false, path);
});

test('automatic signal pipeline scope is exact and receives full Trading review instead of Scanner repair status', () => {
  const paths = AUTOMATIC_SIGNAL_PIPELINE_REVIEWED_PATHS;
  assert.equal(paths.length, 39);
  assert.equal(new Set(paths).size, 39);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(createHash('sha256').update(paths.join('\n')).digest('hex'),
    '413c463c6c11d762643d558d778bd3d1ba635a213ef83fa44448898ee3f8cbdc');
  assert.equal(Object.isFrozen(paths), true);
  const generatedRuntimeOutputs = new Set([
    'market-prediction-lab/runtime/authoritative-paper-runtime-v1/authoritative-paper-runtime-v1.manifest.json',
    'market-prediction-lab/runtime/authoritative-paper-runtime-v1/authoritative-paper-runtime-v1.mjs',
  ]);
  for (const path of paths) {
    assert.ok(!path.includes('*') && !path.includes('..') && !path.startsWith('/'));
    if (path.startsWith('market-prediction-lab/')) assert.ok(generatedRuntimeOutputs.has(path), path);
    else assert.ok(!/^(?:research-production|packages\/external-research|ops\/deploy)/u.test(path));
  }
  for (const path of ['ops/deploy-production.sh', 'api-server/src/middleware/auth.ts',
    'market-prediction-lab/runtime/authoritative-paper-runtime-v1/unreviewed.mjs',
    'stock-analyzer/src/pages/account.tsx', 'pnpm-lock.yaml', paths[0] + '.new', '../' + paths[0]]) {
    assert.equal(paths.includes(path), false, path);
  }
});

test('registered AUTO paths retain Trading, protected-main and Paper assertions with exact trigger coverage', () => {
  const source = read('.github/scripts/verify-research-workspace-sync-v3.mjs');
  const block = source.split('const automaticTradingDriftReviewed=[')[1].split('];')[0];
  assert.ok(block.includes('...AUTOMATIC_LIVE_SAFETY_REVIEWED_PATHS'));
  assert.ok(block.includes('...AUTOMATIC_SIGNAL_PIPELINE_REVIEWED_PATHS'));
  assert.ok(source.includes("from './paper-forward-reviewed-paths.mjs'"));
  assert.ok(source.includes("if(!allowed.has(p))throw new Error('UNREVIEWED_PATH:'+p)"));
  assert.ok(source.includes('automaticSignalGeneratedRuntimeOutputs=new Set(['));
  assert.ok(source.includes('&&!automaticSignalGeneratedRuntimeOutputs.has(p)'));
  assert.ok(source.includes('if(automaticTradingChanged.includes(path))exceptions.add(path)'));
  for (const guard of ['.github/workflows/production-automatic-trading-gate.yml',
    'api-server/scripts/verify-production-automatic-trading-gate.mjs']) assert.ok(source.includes(guard));
  const workflow = read('.github/workflows/paper-forward-schedule-validation.yml').replaceAll('\r\n', '\n');
  const pull = workflow.split('  pull_request:\n')[1].split('  push:\n')[0];
  const trigger = pull.split('\n').filter((line) => line.startsWith('      - ')).map((line) => line.slice(8));
  assert.equal(trigger.length, new Set(trigger).size);
  for (const path of [...AUTOMATIC_LIVE_SAFETY_REVIEWED_PATHS, ...AUTOMATIC_SIGNAL_PIPELINE_REVIEWED_PATHS]) {
    assert.ok(trigger.includes(path), path);
  }
  const research = read('.github/workflows/research-workspace-integration-v1.yml').replaceAll('\r\n', '\n');
  const researchPull = research.split('  pull_request:\n')[1].split('permissions:\n')[0];
  const researchTrigger = researchPull.split('\n').filter((line) => line.startsWith('      - ')).map((line) => line.slice(8));
  assert.equal(researchTrigger.length, new Set(researchTrigger).size);
  for (const path of [...AUTOMATIC_LIVE_SAFETY_REVIEWED_PATHS,
    ...AUTOMATIC_SIGNAL_PIPELINE_REVIEWED_PATHS, '.github/scripts/paper-forward-reviewed-paths.mjs']) {
    assert.ok(researchTrigger.includes(path), path);
  }
  for (const token of ["'--list-auto-live-safety'", 'test "${#auto_safety[@]}" -eq 50',
    "'--list-auto-signal-pipeline'", 'test "${#auto_signal[@]}" -eq 39',
    'allowed+=("${auto_safety[@]}")', 'allowed+=("${auto_signal[@]}")',
    'echo "unexpected path: $path"', 'echo "Unexpected Paper-facing UI change: $path"']) {
    assert.ok(workflow.includes(token), token);
  }
  // Scope registration is not an AUTO activation certificate.
  assert.ok(read('.github/scripts/verify-production-preactivation-evidence.cjs')
    .includes("throw new Error('PREACTIVATION_AUTOMATIC_LIVE_COMPLETE_CONTROL_AUDIT_REQUIRED')"));
});

test('bounded AI provider recovery tests are scoped exactly without adding execution or secret paths',()=>{
  assert.equal(RESEARCH_CENTER_BATCH_PATHS.includes('research-production/test/research-ai-review-worker.test.mjs'),true);
  for(const path of ['research-production/test/research-ai-review-worker.test.mjs.new',
    'api-server/src/services/trade-execution.service.ts.new','ops/restart-production.sh']){
    assert.equal(RESEARCH_CENTER_BATCH_PATHS.includes(path),false,path);
  }
});

test('autonomous research loop scope is exact and grants no deployment or order path', () => {
  for (const path of [
    'research-production/bin/autonomous-research-closed-loop.mjs',
    'research-production/deploy/research-production-ai-review.service',
    'research-production/src/autonomous-research-closed-loop-v1.mjs',
    'research-production/test/autonomous-research-closed-loop-v1.test.mjs',
  ]) assert.equal(RESEARCH_CENTER_BATCH_PATHS.includes(path), true, path);
  for (const path of [
    'ops/deploy-production.sh',
    'research-production/deploy/activate-autonomous-live.sh',
    'api-server/src/services/trade-execution.service.ts.new',
  ]) assert.equal(RESEARCH_CENTER_BATCH_PATHS.includes(path), false, path);
});

test('separately approved Paper supplement is exactly 19 immutable paths without broadening either original set', () => {
  const paths = PAPER_FORWARD_AUTO_SAFETY_SUPPLEMENTAL_PATHS;
  assert.equal(paths.length, 19);
  assert.equal(new Set(paths).size, 19);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(Object.isFrozen(paths), true);
  assert.equal(createHash('sha256').update(paths.join('\n')).digest('hex'),
    '886c1f364d091d9d2226dd74bc41a290ee9694d0ebf71c3321700cb32c5ef654');
  for (const path of paths) {
    assert.ok(!path.includes('*') && !path.includes('..') && !path.startsWith('/'));
    assert.ok(!PAPER_FORWARD_REVIEWED_PATHS.includes(path));
    assert.ok(!AUTOMATIC_LIVE_SAFETY_REVIEWED_PATHS.includes(path));
    assert.ok(!/^(?:market-prediction-lab|research-production|packages\/external-research)\//u.test(path));
  }
  for (const path of ['ops/deploy-production.sh', 'ops/restart-production.sh', 'pnpm-lock.yaml',
    'api-server/src/middleware/auth.ts', 'stock-analyzer/src/pages/account.tsx', paths[0] + '.new', '../' + paths[0]]) {
    assert.equal(paths.includes(path), false, path);
  }
});

test('Paper supplement has exact unique trigger coverage and cannot bypass the bounded diff or activation fence', () => {
  for (const [file, end] of [
    ['.github/workflows/paper-forward-schedule-validation.yml', '  push:\n'],
    ['.github/workflows/research-workspace-integration-v1.yml', 'permissions:\n'],
  ]) {
    const pull = read(file).replaceAll('\r\n', '\n').split('  pull_request:\n')[1].split(end)[0];
    const trigger = pull.split('\n').filter((line) => line.startsWith('      - ')).map((line) => line.slice(8));
    assert.equal(trigger.length, new Set(trigger).size);
    for (const path of PAPER_FORWARD_AUTO_SAFETY_SUPPLEMENTAL_PATHS) assert.ok(trigger.includes(path), path);
  }
  const workflow = read('.github/workflows/paper-forward-schedule-validation.yml');
  for (const token of ["'--list-auto-live-supplement'", 'test "${#auto_supplement[@]}" -eq 19',
    'allowed+=("${auto_supplement[@]}")', 'AUTO_LIVE_SUPPLEMENT_MUST_BE_EXACTLY_19',
    'echo "unexpected path: $path"', 'echo "Unexpected Paper-facing UI change: $path"']) {
    assert.ok(workflow.includes(token), token);
  }
  assert.ok(read('.github/scripts/verify-production-preactivation-evidence.cjs')
    .includes("throw new Error('PREACTIVATION_AUTOMATIC_LIVE_COMPLETE_CONTROL_AUDIT_REQUIRED')"));
});
