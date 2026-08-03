import { readFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const cwd = process.cwd();
const root = path.basename(cwd) === 'api-server' ? path.resolve(cwd, '..') : path.resolve(cwd);
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[phase10-deployment-safety] ${message}`);
};

const production = await read('.github/workflows/production-deploy.yml');
const approval = await read('.github/workflows/production-one-time-approval.yml');
const staging = await read('.github/workflows/staging-readiness.yml');
const dispatchBridge = await read('.github/workflows/staging-dispatch-bridge.yml');
const productionScript = await read('ops/deploy-production.sh');
const stagingScript = await read('ops/deploy-staging.sh');
const stagingVerifier = await read('api-server/scripts/verify-phase10-staging-readiness.mjs');
const verdictBuilder = await read('api-server/scripts/build-staging-verdict.mjs');
const verdictVerifier = await read('api-server/scripts/verify-staging-verdict.mjs');
const stagingSpec = await read('stock-analyzer/e2e/phase10-staging-readiness.spec.ts');
const stagingAccountLifecycle = await read('stock-analyzer/e2e/support/staging-account-lifecycle.ts');

for (const workflow of [production, approval]) {
  for (const status of [
    'application-ci/verified',
    'browser-ui/verified',
    'database-rls/verified',
    'security-integration/verified',
    'ai-privacy/verified',
    'futures-public-network-smoke/verified',
  ]) {
    assert(workflow.includes(status), `production gate is missing required status ${status}`);
  }
}

assert(/workflow_dispatch:/.test(production), 'production workflow must support explicit workflow dispatch');
assert(!/\n\s*push:\s*\n\s*branches:/.test(production), 'production workflow must not deploy on main push');
assert(/\^\[0-9a-fA-F\]\{40\}\$/.test(production), 'production workflow must require an exact SHA');
assert(production.includes('actions.listWorkflowRunsForRepo'), 'production gate must verify Application CI run provenance');
assert(production.includes('actions.listArtifactsForRepo'), 'production gate must locate staging verdict artifacts');
assert(production.includes('actions.getWorkflowRun'), 'production gate must directly verify the artifact source run');
assert(production.includes('actions/download-artifact@v4'), 'production gate must download the exact verdict artifact');
assert(production.includes('verify-staging-verdict.mjs'), 'production gate must validate verdict contents');
assert(production.includes('staging-verdict-${{ steps.target.outputs.sha }}'), 'production gate must use an exact-SHA artifact name');
assert(production.includes("run.path === '.github/workflows/staging-readiness.yml'"), 'production gate must require the official staging workflow');
assert(production.includes("run.conclusion === 'success'"), 'production gate must require successful staging workflow conclusion');
assert(/environment:\s*production/.test(production), 'production deploy job must use the protected production environment');
assert(!/STAGING_(?:SSH|SUPABASE|DATABASE|PENDING|ASSOCIATE|REGULAR|ADMIN)/.test(production), 'production workflow must not consume staging secrets');

assert(!/PROD_/.test(staging), 'staging workflow must not consume production secrets');
assert(!staging.includes('/opt/stock-app'), 'staging workflow must not use the production path');
assert(!staging.includes('PM2_NAME=stock-app'), 'staging workflow must not use the production PM2 process');
assert(!staging.includes('https://lsj119.duckdns.org'), 'staging workflow must not use the production URL');
assert(staging.includes('/srv/seungjae-staging'), 'staging workflow must use the isolated staging path');
assert(staging.includes('STAGING_RUN_FULL_VALIDATION=true is mandatory'), 'deploy candidates must require full validation');
assert(staging.includes('Run complete anonymous and four-account browser validation'), 'staging must execute the complete browser suite');
assert(staging.includes('playwright install --with-deps chromium'), 'staging must install the real browser runtime');
assert(staging.includes('Collect staging runtime, health, SHA, and PM2 stability evidence'), 'staging must collect runtime evidence');
assert(staging.includes('staging-runtime-verification.json'), 'staging must persist runtime verification');
assert(staging.includes('staging-database-verification.json'), 'staging must persist DB migration assessment');
assert(staging.includes('build-staging-verdict.mjs'), 'staging must build a final verdict');
assert(staging.includes('actions/upload-artifact@v4'), 'staging must upload immutable evidence');
assert(staging.includes('staging-verdict-${{ env.TARGET_SHA }}'), 'staging artifact must be tied to the exact target SHA');
assert(staging.includes('RELEASE_READY'), 'staging summary must expose release readiness');
assert(staging.includes('Failed:') && staging.includes('Skipped:'), 'staging summary must report failed and skipped counts');
assert(verdictBuilder.includes('정의된 검증 범위 내 미발견 오류 0개 — 운영 배포 가능'), 'verdict builder must use the exact success verdict');
assert(verdictBuilder.includes('오류 발견 — 운영 배포 불가'), 'verdict builder must use the exact failure verdict');
assert(verdictBuilder.includes('배포 성공, 전체 검증 미완료 — 운영 배포 불가'), 'verdict builder must use the exact incomplete verdict');

assert(approval.includes('actions.listArtifactsForRepo'), 'one-time approval must wait for an exact verdict artifact');
assert(approval.includes('actions/download-artifact@v4'), 'one-time approval must download the verdict');
assert(approval.includes('verify-staging-verdict.mjs'), 'one-time approval must independently validate the verdict');
assert(approval.includes('failed=0, skipped=0'), 'one-time approval audit must require zero failed and skipped checks');
assert(approval.includes('actions.createWorkflowDispatch'), 'one-time approval must dispatch only the official production workflow');
assert(!approval.includes('secrets.'), 'one-time approval gate must not read deployment secrets');
assert(!approval.includes('/opt/stock-app'), 'one-time approval gate must not touch the production path');

assert(dispatchBridge.includes("flags.includes('--full-validation')"), 'staging bridge must parse full validation');
assert(dispatchBridge.includes("workflowId = 'staging-readiness.yml'"), 'staging bridge must target only staging readiness');
assert(!dispatchBridge.includes('production-deploy.yml'), 'staging bridge must never dispatch production');

for (const marker of [
  'target_sha', 'deployed_sha', 'total', 'passed', 'failed', 'skipped',
  'console_errors', 'unexpected_http_errors', 'pm2_status', 'restart_count',
  'ephemeral_accounts_created', 'ephemeral_accounts_deleted', 'ephemeral_profiles_remaining',
  'release_ready', 'verdict',
]) {
  assert(verdictBuilder.includes(marker), `verdict builder is missing ${marker}`);
}
assert(verdictBuilder.includes('failed === 0 && skipped === 0'), 'release_ready must require failed=0 and skipped=0');
assert(verdictBuilder.includes('staging-account-provisioning.json'), 'verdict must require ephemeral account provisioning evidence');
assert(verdictBuilder.includes('staging-account-cleanup.json'), 'verdict must require ephemeral account cleanup evidence');
assert(verdictVerifier.includes('verdict.release_ready !== true'), 'production verdict verifier must require release_ready=true');
assert(verdictVerifier.includes('verdict.skipped !== 0'), 'production verdict verifier must reject skipped checks');
assert(verdictVerifier.includes('verdict.deployed_sha !== targetSha'), 'production verdict verifier must reject SHA mismatch');

for (const requirement of [
  'anonymous: health, login boundary, and protected API denial',
  'pending: approval-waiting account',
  'associate: basic stock and spot access allowed',
  'regular: futures, scanner, paper trading',
  'admin: member management is allowed',
  'bottom navigation and popup menus',
  'console_errors',
  'page_errors',
  'unhandled_rejections',
  'unexpected_http_errors',
]) {
  assert(stagingSpec.includes(requirement), `staging browser suite is missing ${requirement}`);
}

assert(stagingSpec.includes('provisionEphemeralStagingAccounts'), 'staging browser suite must provision temporary accounts at runtime');
assert(stagingSpec.includes('accountLifecycle?.cleanup()'), 'staging browser suite must clean temporary accounts in afterAll');
assert(!stagingSpec.includes('STAGING_PENDING_EMAIL'), 'staging browser suite must not require manually configured account credentials');
for (const marker of [
  'auth.admin.createUser',
  'email_confirm: true',
  ".from('profiles')",
  'membership_level',
  'auth.admin.deleteUser',
  'removeStaleValidationUsers',
  'staging-account-provisioning.json',
  'staging-account-cleanup.json',
  'credentials_recorded: false',
  'bawcbkoyovbeajkrnduq',
]) {
  assert(stagingAccountLifecycle.includes(marker), `ephemeral staging account lifecycle is missing ${marker}`);
}
assert(stagingAccountLifecycle.includes('finally') || stagingAccountLifecycle.includes('catch'), 'ephemeral account lifecycle must clean up on provisioning failure');

assert(productionScript.includes('restore_backup'), 'production deploy script must retain rollback');
assert(stagingScript.includes('checksums.sha256'), 'staging deploy script must create backup checksums');
assert(stagingScript.includes('probe_health_url'), 'staging deploy script must retry health checks');
assert(stagingScript.includes('APP_ENV=staging'), 'staging runtime must identify itself');
assert(stagingScript.includes('DEPLOY_SHA='), 'staging runtime must expose the deployed SHA');
assert(stagingVerifier.includes('staging setting name(s) need attention'), 'staging preflight must aggregate missing settings');
assert(stagingVerifier.includes('fullValidationRequired'), 'staging preflight must require isolated Supabase admin configuration for full validation');
assert(!stagingVerifier.includes('STAGING_PENDING_EMAIL'), 'staging preflight must not require manual validation account credentials');
assert(stagingVerifier.includes('knownProductionSupabaseProjectRefs'), 'staging preflight must reject the known production Supabase project');

const verifierPath = path.join(root, 'api-server/scripts/verify-phase10-staging-readiness.mjs');
const runPreflight = (extraEnv = {}) => spawnSync(process.execPath, [verifierPath, '--preflight'], {
  cwd: root,
  encoding: 'utf8',
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    STAGING_ACTION: 'preflight',
    STAGING_RUN_FULL_VALIDATION: 'false',
    STAGING_RUN_DESTRUCTIVE_RECOVERY_DRILL: 'false',
    ...extraEnv,
  },
});
const emptyPreflight = runPreflight();
assert(emptyPreflight.status !== 0, 'empty staging preflight must fail');
for (const name of ['STAGING_SSH_HOST', 'STAGING_SSH_USER', 'STAGING_SSH_PRIVATE_KEY', 'STAGING_BASE_URL']) {
  assert(emptyPreflight.stderr.includes(`- ${name}:`), `aggregate preflight did not report ${name}`);
}
const minimal = {
  STAGING_SSH_HOST: 'staging.example.invalid',
  STAGING_SSH_USER: 'staging',
  STAGING_SSH_PRIVATE_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\nstatic-ci-test-only\n-----END OPENSSH PRIVATE KEY-----',
  STAGING_BASE_URL: 'https://staging.example.invalid',
};
const minimalPreflight = runPreflight(minimal);
assert(minimalPreflight.status === 0, `minimal preflight should pass: ${minimalPreflight.stderr}`);

const missingSupabasePreflight = runPreflight({
  ...minimal,
  STAGING_ACTION: 'deploy',
  STAGING_RUN_FULL_VALIDATION: 'true',
});
assert(missingSupabasePreflight.status !== 0, 'full validation without isolated Supabase settings must fail');
for (const name of ['STAGING_SUPABASE_URL', 'STAGING_SUPABASE_ANON_KEY', 'STAGING_SUPABASE_SECRET_KEY']) {
  assert(missingSupabasePreflight.stderr.includes(`- ${name}:`), `full validation did not report ${name}`);
}

const isolatedSupabase = {
  STAGING_SUPABASE_URL: 'https://stageproject123.supabase.co',
  STAGING_SUPABASE_ANON_KEY: 'sb_publishable_static_ci_test_only_1234567890',
  STAGING_SUPABASE_SECRET_KEY: 'sb_secret_static_ci_test_only_1234567890',
};
const fullPreflight = runPreflight({
  ...minimal,
  ...isolatedSupabase,
  STAGING_ACTION: 'deploy',
  STAGING_RUN_FULL_VALIDATION: 'true',
});
assert(fullPreflight.status === 0, `full validation with three isolated Supabase settings should pass: ${fullPreflight.stderr}`);

const productionSupabasePreflight = runPreflight({
  ...minimal,
  ...isolatedSupabase,
  STAGING_SUPABASE_URL: 'https://bawcbkoyovbeajkrnduq.supabase.co',
  STAGING_ACTION: 'deploy',
  STAGING_RUN_FULL_VALIDATION: 'true',
});
assert(productionSupabasePreflight.status !== 0, 'known production Supabase project must be rejected');
assert(productionSupabasePreflight.stderr.includes('known production Supabase project'), 'production Supabase rejection reason must be explicit');

const temp = await mkdtemp(path.join(os.tmpdir(), 'staging-verdict-contract-'));
try {
  await mkdir(temp, { recursive: true });
  const sha = 'a'.repeat(40);
  await writeFile(path.join(temp, 'playwright-report.json'), JSON.stringify({
    suites: [{ specs: [{ title: 'sample', tests: [{ projectName: 'chromium', status: 'expected', results: [{ status: 'passed' }] }] }] }],
  }));
  await writeFile(path.join(temp, 'staging-browser-results.json'), JSON.stringify({
    console_errors: [], page_errors: [], unhandled_rejections: [], unexpected_http_errors: [],
  }));
  await writeFile(path.join(temp, 'staging-account-provisioning.json'), JSON.stringify({
    status: 'passed', created: 4, credentials_recorded: false,
  }));
  await writeFile(path.join(temp, 'staging-account-cleanup.json'), JSON.stringify({
    status: 'passed', deleted: 4, profiles_remaining: 0,
  }));
  await writeFile(path.join(temp, 'staging-runtime-verification.json'), JSON.stringify({
    deployed_sha: sha,
    pm2_status: 'online',
    restart_count: 3,
    restart_count_delta: 0,
    checks: [{ name: 'health', status: 'passed' }],
  }));
  await writeFile(path.join(temp, 'staging-database-verification.json'), JSON.stringify({
    status: 'passed', detail: 'not required',
  }));
  const built = spawnSync(process.execPath, [path.join(root, 'api-server/scripts/build-staging-verdict.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      TARGET_SHA: sha,
      STAGING_RUN_FULL_VALIDATION: 'true',
      STAGING_ARTIFACT_DIR: temp,
    },
  });
  assert(built.status === 0, `release-ready fixture should pass: ${built.stderr}`);
  const verified = spawnSync(process.execPath, [path.join(root, 'api-server/scripts/verify-staging-verdict.mjs'), path.join(temp, 'staging-verdict.json')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TARGET_SHA: sha },
  });
  assert(verified.status === 0, `release-ready verdict should verify: ${verified.stderr}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log('[phase10-deployment-safety] ephemeral four-tier staging accounts, cleanup, production-project rejection, full staging validation, zero-skip verdict artifact, exact-SHA production revalidation, manual protected production deployment, and rollback contract verified');
