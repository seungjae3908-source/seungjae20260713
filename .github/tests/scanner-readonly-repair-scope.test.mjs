import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SCANNER_REPAIR_PATHS, SCANNER_REPAIR_PINNED_PATHS, SCANNER_REPAIR_SOURCE_SHA, SCANNER_REPAIR_WORKFLOW_BASE_SHA,
  SCANNER_PROTECTED_AUTHORITY_PATHS, SCANNER_REPAIR_INTEGRATION_BASE_SHA, SCANNER_REPAIR_INTEGRATION_BLOBS, verifyPinnedScannerScope } from '../scripts/scanner-readonly-repair-scope.mjs';
import { AUTOMATIC_SIGNAL_PIPELINE_REVIEWED_PATHS } from '../scripts/paper-forward-reviewed-paths.mjs';

const base = 'b'.repeat(40), blob = 'a'.repeat(40), drift = 'c'.repeat(40);
const stock = 'api-server/src/providers/krx.ts';
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

test('scanner classification is exact, unique and cannot include execution/deploy/auth paths', () => {
  assert.equal(new Set(SCANNER_REPAIR_PATHS).size, SCANNER_REPAIR_PATHS.length);
  for (const path of SCANNER_REPAIR_PATHS) assert.ok(!path.includes('*') && !path.includes('..'));
  for (const path of ['ops/deploy-production.sh', 'api-server/src/services/trade-execution.service.ts',
    'api-server/src/middleware/auth.ts', '.github/workflows/production-automatic-trading-gate.yml',
    'api-server/src/services/member-auto-trading-background-worker.service.ts', 'pnpm-lock.yaml']) {
    assert.ok(!SCANNER_REPAIR_PINNED_PATHS.includes(path), path);
  }
  assert.match(SCANNER_REPAIR_SOURCE_SHA, /^[a-f0-9]{40}$/u);
});

test('only byte-identical scanner source is classified, not mutable files with the same name', () => {
  assert.deepEqual(verifyPinnedScannerScope([stock], base, () => blob), [stock]);
  assert.throws(() => verifyPinnedScannerScope([stock], base,
    (ref, path) => ref === 'HEAD' && path === stock ? drift : blob), /SCANNER_SCOPE_BLOB_DRIFT/);
  assert.throws(() => verifyPinnedScannerScope([stock], base, () => 'invalid'), /SCANNER_SCOPE_BLOB_DRIFT/);
  assert.throws(() => verifyPinnedScannerScope([stock], '', () => blob), /SCANNER_SCOPE_BASE_REQUIRED/);
  assert.throws(() => verifyPinnedScannerScope([stock], base, () => { throw new Error('MISSING_BLOB'); }), /MISSING_BLOB/);
});

test('every protected authority tree/file must remain byte-identical to exact PR base', () => {
  for (const protectedPath of SCANNER_PROTECTED_AUTHORITY_PATHS) {
    assert.throws(() => verifyPinnedScannerScope([stock], base,
      (ref, path) => ref === 'HEAD' && path === protectedPath ? drift : blob), /SCANNER_AUTHORITY_PATH_CHANGED/);
  }
});

test('mixed execution changes and renamed/unlisted files never acquire a scanner exemption', () => {
  const execution = 'api-server/src/services/trade-execution.service.ts';
  assert.deepEqual(verifyPinnedScannerScope([stock, execution], base, () => blob), [stock]);
  for (const path of [execution, stock + '.renamed', '.github/workflows/production-deploy.yml']) {
    assert.deepEqual(verifyPinnedScannerScope([path], base, () => { throw new Error('SHOULD_NOT_READ'); }), []);
  }
  const verifier = read('.github/scripts/verify-research-workspace-sync-v3.mjs');
  assert.ok(verifier.includes('&&!pinnedScannerRepair.includes(p)'));
  assert.ok(verifier.includes('AUTOMATIC_TRADING_SCOPE_GUARD_MISSING'));
  assert.ok(verifier.includes('UNREVIEWED_PATH:'));
});

test('automatic signal pipeline overlap is routed to full Trading guards, never the immutable Scanner exemption', () => {
  const overlap = AUTOMATIC_SIGNAL_PIPELINE_REVIEWED_PATHS.filter((path) =>
    SCANNER_REPAIR_PINNED_PATHS.includes(path));
  assert.deepEqual(overlap.sort(), [
    'api-server/src/services/scanner-indicator-library.service.ts',
    'api-server/src/services/scanner-quant-strategy.service.test.ts',
    'api-server/src/services/scanner-quant-strategy.service.ts',
    'api-server/src/services/stock-signal-scanner.service.ts',
    'market-prediction-lab/runtime/authoritative-paper-runtime-v1/authoritative-paper-runtime-v1.manifest.json',
    'market-prediction-lab/runtime/authoritative-paper-runtime-v1/authoritative-paper-runtime-v1.mjs',
    'signal-intelligence-v3/README.md',
    'signal-intelligence-v3/scripts/run-public-scanner-cycle.ts',
    'signal-intelligence-v3/src/public-cycle-progress-v2.mjs',
    'signal-intelligence-v3/tests/public-cycle-progress-v2.test.mjs',
  ]);
  assert.deepEqual(verifyPinnedScannerScope(overlap, base, () => {
    throw new Error('FULL_TRADING_REVIEW_MUST_NOT_READ_PINNED_BLOB');
  }), []);
});

test('all exact scanner paths are PR-trigger covered without dropping any Paper safety step', () => {
  const path = '.github/workflows/paper-forward-schedule-validation.yml';
  const workflow = read(path);
  const pull = workflow.split('  pull_request:\n')[1].split('  push:\n')[0];
  const triggers = pull.split('\n').filter(line => line.startsWith('      - ')).map(line => line.slice(8).trim());
  assert.equal(new Set(triggers).size, triggers.length);
  for (const path of SCANNER_REPAIR_PATHS) assert.ok(triggers.includes(path), path);
  assert.ok(workflow.includes('node .github/scripts/scanner-readonly-repair-scope.mjs --verify "$base"'));
  assert.ok(workflow.includes('permissions:\n  contents: read'));
  const steps = text => [...text.matchAll(/^      - name: (.+)$/gmu)].map(match => match[1]);
  for (const workflowPath of [path, '.github/workflows/research-workspace-integration-v1.yml']) {
    const original = git('show', SCANNER_REPAIR_WORKFLOW_BASE_SHA + ':' + workflowPath).replace(/\r\n/gu, '\n');
    assert.deepEqual(steps(read(workflowPath)), steps(original), workflowPath);
  }
});


test('only exact audited merger and S-only scanner blobs are accepted on the pinned current main', () => {
  assert.equal(SCANNER_REPAIR_INTEGRATION_BASE_SHA, '964d3a619b931589e0f31cd9a2b8dce4ebcf3314');
  assert.deepEqual(Object.keys(SCANNER_REPAIR_INTEGRATION_BLOBS).sort(),
    ['api-server/package.json', 'api-server/test.mjs', 'stock-analyzer/src/lib/signal-scanner.ts', 'stock-analyzer/src/lib/scanner-request.test.ts'].sort());
  assert.equal(Object.isFrozen(SCANNER_REPAIR_INTEGRATION_BLOBS), true);
  for (const [path, expected] of Object.entries(SCANNER_REPAIR_INTEGRATION_BLOBS)) {
    const legitimate = (ref, name) => ref === 'HEAD' && name === path ? expected : blob;
    assert.deepEqual(verifyPinnedScannerScope([path], SCANNER_REPAIR_INTEGRATION_BASE_SHA, legitimate), [path]);
    const wrongBase = 'e'.repeat(40);
    assert.throws(() => verifyPinnedScannerScope([path], wrongBase, legitimate), /SCANNER_SCOPE_BLOB_DRIFT/);
    const changed = (ref, name) => ref === 'HEAD' && name === path ? drift : blob;
    assert.throws(() => verifyPinnedScannerScope([path], SCANNER_REPAIR_INTEGRATION_BASE_SHA, changed), /SCANNER_SCOPE_BLOB_DRIFT/);
    assert.throws(() => verifyPinnedScannerScope([path], SCANNER_REPAIR_INTEGRATION_BASE_SHA,
      (ref, name) => ref === 'HEAD' && name === path ? expected : 'invalid'), /SCANNER_SCOPE_BLOB_DRIFT/);
  }
});
