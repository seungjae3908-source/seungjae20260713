import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.cwd());
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[phase10-deployment-safety] ${message}`);
};

const production = await read('.github/workflows/production-deploy.yml');
const staging = await read('.github/workflows/staging-readiness.yml');
const productionScript = await read('ops/deploy-production.sh');
const stagingScript = await read('ops/deploy-staging.sh');

assert(/workflow_dispatch:/.test(production), 'production workflow must support explicit workflow dispatch');
assert(!/\n\s*push:\s*\n\s*branches:\s*\n\s*-\s*main\b/.test(production), 'production workflow must not deploy on main push');
assert(/\^\[0-9a-fA-F\]\{40\}\$/.test(production), 'production workflow must require an exact 40-character SHA');
assert(/merge-base --is-ancestor/.test(production), 'production workflow must require the target SHA to be contained in main');
for (const status of [
  'application-ci/verified',
  'browser-ui/verified',
  'database-rls/verified',
  'security-integration/verified',
  'ai-privacy/verified',
  'futures-public-network-smoke/verified',
]) {
  assert(production.includes(status), `production workflow is missing required status ${status}`);
}
assert(/environment:\s*production/.test(production), 'production job must use the GitHub production environment');
assert(!/STAGING_/.test(production), 'production workflow must not consume staging secrets');
assert(!/PROD_/.test(staging), 'staging workflow must not consume production secrets');
assert(!staging.includes('/opt/stock-app'), 'staging workflow must not use the production install path');
assert(!staging.includes('PM2_NAME=stock-app'), 'staging workflow must not use the production PM2 process');
assert(!staging.includes('https://lsj119.duckdns.org'), 'staging workflow must not use the production URL');
assert(staging.includes('/srv/seungjae-staging'), 'staging workflow must use the isolated staging path');
assert(staging.includes('STAGING_DATABASE_URL'), 'staging workflow must require a staging database');
assert(staging.includes('STAGING_AI_API_KEY'), 'staging workflow must require a server-side staging AI key');
assert(staging.includes('run_destructive_recovery_drill'), 'staging workflow must require an explicit recovery drill');
assert(productionScript.includes('restore_backup'), 'production deploy script must retain automatic rollback');
assert(stagingScript.includes('checksums.sha256'), 'staging deploy script must create backup checksums');
assert(stagingScript.includes('APP_ENV=staging'), 'staging deploy script must identify the environment');
assert(stagingScript.includes('DEPLOY_SHA='), 'staging deploy script must expose the deployed revision to the server');
assert(!/TRADING_REVIEW_API_KEY[^\n]*(?:echo|printf|summary)/i.test(stagingScript), 'staging AI secret must not be printed');

console.log('[phase10-deployment-safety] production is manual-only; immutable main SHA and six statuses are required; staging remains isolated');
