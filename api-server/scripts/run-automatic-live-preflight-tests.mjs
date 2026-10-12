import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectOfflinePreflightStages } from './automatic-live-preflight-stages.mjs';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(apiRoot, '..');
// All provider/execution dependencies in these tests are fake transports.
// This runner neither loads Production credentials nor calls Production APIs.
const entries = [
  'member-auto-trading-background-worker.service.test.ts',
  'trade-recovery-worker.test.ts',
  'trade-automation-repository-compatibility.test.ts',
  'trade-rule-pack-pilot-capital.service.test.ts',
  'trade-automation-integration.test.ts',
  'trade-kiwoom-readonly-contract.test.ts',
  'kiwoom-readonly-order-recovery.service.test.ts',
  'trade-order-recovery.test.ts',
  'trade-execution-pre-submission.test.ts',
  'automatic-live-budget.service.test.ts',
  'public-live-plan-origin.service.test.ts',
  'trading-provider-response.service.test.ts',
  'bitget-native-protection-readonly.service.test.ts',
  'member-auto-trading-ai-review-evidence.service.test.ts',
];
const contracts = [
  'api-server/scripts/automatic-live-preflight-stages.test.mjs',
  '.github/scripts/automatic-live-preactivation-audit.test.cjs',
  '.github/scripts/production-manual-live-receipts.test.cjs',
  '.github/scripts/production-postdeploy-qa-evidence.test.cjs',
  '.github/tests/production-auto-live-only-release-contract.test.mjs',
  '.github/tests/production-auto-live-budget-contract.test.mjs',
  '.github/tests/kiwoom-readonly-recovery-security-contract.test.mjs',
];
function run(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`AUTO_LIVE_PREFLIGHT_TEST_FAILED:${result.status ?? 'SIGNAL'}`);
}

const output = await mkdtemp(path.join(tmpdir(), 'auto-live-preflight-tests-'));
try {
  const files = [];
  const result = await collectOfflinePreflightStages([
    ...entries.map((entry, index) => ({ id: `compile:${entry}`, async run() {
      const outfile = path.join(output, `${index}.test.cjs`);
      await build({ entryPoints: [path.join(apiRoot, 'src/services', entry)], outfile,
        bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'warning' });
      files.push(outfile);
    } })),
    { id: 'component-tests', run() {
      if (!files.length) throw new Error('AUTO_LIVE_PREFLIGHT_COMPONENTS_UNAVAILABLE');
      run(['--test', '--test-concurrency=1', ...files], repositoryRoot);
    } },
    { id: 'release-contracts', run() { run(['--test', '--test-concurrency=1', ...contracts], repositoryRoot); } },
  ]);
  console.log(JSON.stringify(result));
  if (!result.ready) throw new Error('AUTO_LIVE_PREFLIGHT_ALL_DEFECTS_COLLECTED');
  console.log('AUTO_LIVE_OFFLINE_PREFLIGHT_COMPONENTS_PASS; PRODUCTION_ACTIVATION_NOT_ATTESTED; FINANCIAL_API_CALLS=0');
} finally {
  // Only the unique directory returned by mkdtemp is removed, never a workspace.
  await rm(output, { recursive: true, force: true });
}
