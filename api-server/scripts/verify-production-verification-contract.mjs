import { readFile } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const root = path.basename(cwd) === 'api-server' ? path.resolve(cwd, '..') : path.resolve(cwd);
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[production-verification-contract] ${message}`);
};

const productionDeploy = await read('.github/workflows/production-deploy.yml');
const productionBrowser = await read('.github/workflows/production-browser-smoke.yml');
const productionComprehensive = await read('.github/workflows/production-comprehensive-readonly-qa.yml');
const productionObserver = await read('.github/workflows/production-health-observer.yml');
const deployScript = await read('ops/deploy-production.sh');

const officialProductionBaseUrl = 'https://lsj119.com';

assert(
  productionDeploy.includes(`PUBLIC_BASE_URL: ${officialProductionBaseUrl}`),
  'Production Deploy must verify the official Production hostname',
);
assert(
  !productionDeploy.includes('https://lsj119.duckdns.org'),
  'legacy DuckDNS Production verification target must not remain in Production Deploy',
);
for (const [name, workflow] of [
  ['Production Browser Smoke', productionBrowser],
  ['Production Comprehensive Read-Only QA', productionComprehensive],
  ['Production Health Observer', productionObserver],
]) {
  assert(
    workflow.includes(officialProductionBaseUrl),
    `${name} must use the same official Production hostname`,
  );
}

assert(deployScript.includes('verify_gate()'), 'deploy script must expose a named post-switch verification gate helper');
for (const gate of ['LOCAL_HEALTH', 'DATA_PLANE', 'PM2_RUNTIME', 'PUBLIC_HEALTH']) {
  assert(
    deployScript.includes(`verify_gate ${gate}`),
    `deploy script must log the ${gate} post-switch verification gate`,
  );
}
assert(
  deployScript.includes('[deploy][verify] ${gate_name}=PASS'),
  'deploy script must emit sanitized PASS markers for named verification gates',
);
assert(
  deployScript.includes('[deploy][verify] ${gate_name}=FAIL'),
  'deploy script must emit sanitized FAIL markers for named verification gates',
);
assert(deployScript.includes('restore_backup'), 'automatic rollback must remain enabled');
assert(
  deployScript.includes('[deploy] production verification failed; starting automatic rollback'),
  'post-switch verification failure must still trigger automatic rollback',
);
assert(deployScript.includes('exit 13'), 'post-switch verification failure must remain fail-closed');

console.log('[production-verification-contract] verified');
