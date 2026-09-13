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
const diagnostics = await read('ops/production-verification-diagnostics.sh');

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

assert(
  productionDeploy.includes('ops/production-verification-diagnostics.sh'),
  'Production Deploy path contract must include the diagnostics hook',
);
assert(
  productionDeploy.includes('BASH_ENV="$SOURCE_DIR/ops/production-verification-diagnostics.sh"'),
  'Production Deploy must inject the read-only diagnostics hook into the deploy shell only',
);
assert(diagnostics.includes('unset BASH_ENV'), 'diagnostics hook must not propagate into child shells');
assert(diagnostics.includes('trap production_verify_debug DEBUG'), 'diagnostics hook must observe the active post-switch gate');
assert(diagnostics.includes('trap production_verify_error ERR'), 'diagnostics hook must report the failing gate');
for (const gate of ['LOCAL_HEALTH', 'DATA_PLANE', 'PM2_RUNTIME', 'PUBLIC_HEALTH']) {
  assert(
    diagnostics.includes(`PROD_VERIFY_CURRENT_GATE="${gate}"`),
    `diagnostics hook must classify ${gate}`,
  );
}
assert(
  diagnostics.includes('[deploy][verify] ${PROD_VERIFY_CURRENT_GATE}=FAIL'),
  'diagnostics hook must emit a sanitized named failure marker',
);
assert(deployScript.includes('restore_backup'), 'automatic rollback must remain enabled');
assert(
  deployScript.includes('[deploy] production verification failed; starting automatic rollback'),
  'post-switch verification failure must still trigger automatic rollback',
);
assert(deployScript.includes('exit 13'), 'post-switch verification failure must remain fail-closed');

console.log('[production-verification-contract] verified');
