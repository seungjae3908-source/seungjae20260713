import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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
const productionWatchNormalize = await read('.github/workflows/production-pm2-watch-normalize.yml');
const deployScript = await read('ops/deploy-production.sh');
const watchNormalizer = await read('ops/normalize-production-pm2-watch.sh');
const diagnostics = await read('ops/production-verification-diagnostics.sh');
const apiPackage = JSON.parse(await read('api-server/package.json'));

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
assert(
  deployScript.includes('for ((attempt = 1; attempt <= 10; attempt += 1)); do'),
  'Production health must retain the bounded 10-attempt readiness budget',
);
assert(
  deployScript.includes('health identity not ready (attempt $attempt/10)'),
  'Production health must identify exact-SHA readiness waits without disclosing payloads',
);
assert(
  !deployScript.includes('probe_json "$base_url/api/health" "$output_file" 10 3'),
  'Production health must not accept transport-valid JSON before exact identity is ready',
);
assert(
  apiPackage.scripts?.start === 'NODE_ENV=production node --enable-source-maps ./dist/index.mjs',
  'Production PM2 start must execute the prebuilt server directly',
);
assert(
  !/\bbuild\b/u.test(apiPackage.scripts.start),
  'Production PM2 start must not rebuild watched dist files and create a restart loop',
);
assert(
  deployScript.includes('NODE_ENV=production pnpm --filter @workspace/api-server run build'),
  'The immutable release must remain fully built before canary and live promotion',
);
assert(
  deployScript.includes('pm2 stop "$PM2_NAME" --watch'),
  'Production Deploy must explicitly disable inherited PM2 watch before restart',
);
assert(
  deployScript.includes('pm2_runtime_snapshot'),
  'Production Deploy must inspect the live PM2 definition instead of trusting online status alone',
);
assert(
  deployScript.includes('listener_pids'),
  'Production Deploy must verify real live-port ownership',
);
assert(
  deployScript.includes('PM2 entrypoint differs from canonical prebuilt Production API'),
  'Production Deploy must reject a non-canonical PM2 entrypoint before restart',
);
assert(
  deployScript.includes('[[ "$watched" == false ]] || return 1'),
  'Production Deploy success must require PM2 watch=false',
);
assert(
  deployScript.includes('"${#current_listeners[@]}" -eq 1 && "${current_listeners[0]}" == "$pid"'),
  'Production Deploy success must require the PM2 PID to own the sole live-port listener',
);
assert(
  deployScript.includes('"$live" == false && "$auto" == false && "$real" == false && "$private_api" == false'),
  'Production Deploy runtime acceptance must keep all trading/private authority flags off',
);
assert(
  deployScript.includes('[[ "$authority" == NONE ]] || return 1'),
  'Production Deploy runtime acceptance must keep executionAuthority=NONE',
);

assert(
  watchNormalizer.includes('active Production marker differs from approved normalization target'),
  'one-time watch normalization must pin the exact active Production SHA',
);
assert(
  watchNormalizer.includes('PM2 stock-app PID is not the sole Production live-port listener before normalization'),
  'one-time watch normalization must require exact PM2 live-port ownership before mutation',
);
assert(
  watchNormalizer.includes('PM2 stock-app entrypoint differs from canonical prebuilt Production API'),
  'one-time watch normalization must require the canonical direct Node entrypoint',
);
assert(
  watchNormalizer.includes('pm2 stop "$PM2_NAME" --watch'),
  'one-time watch normalization must use the PM2-supported watch-disable transition',
);
assert(
  watchNormalizer.includes('final PM2 watch mode must be disabled'),
  'one-time watch normalization must verify watch=false afterward',
);
assert(
  watchNormalizer.includes('PM2 did not reacquire the Production live port with exact active SHA'),
  'one-time watch normalization must prove exact PM2 ownership and SHA after restart',
);
assert(
  watchNormalizer.includes('trading authority flags are not fail-closed before normalization'),
  'one-time watch normalization must reject non-fail-closed trading authority before mutation',
);
assert(
  watchNormalizer.includes('trading authority changed during watch normalization'),
  'one-time watch normalization must prove trading authority remains fail-closed',
);
assert(
  watchNormalizer.includes('pm2 reset "$PM2_NAME"'),
  'one-time watch normalization must reset historical restart count only after success',
);
assert(
  watchNormalizer.includes('pm2 save'),
  'one-time watch normalization must persist the corrected PM2 definition',
);
assert(!watchNormalizer.includes('rsync '), 'watch normalization must not sync Production source');
assert(!watchNormalizer.includes('pnpm '), 'watch normalization must not rebuild or install Production code');
assert(!watchNormalizer.includes('psql '), 'watch normalization must not access the Production database');

assert(
  productionWatchNormalize.includes("startsWith(github.event.comment.body, '/normalize-production-pm2-watch ')"),
  'watch normalization workflow must require the exact owner command prefix',
);
assert(
  productionWatchNormalize.includes("github.event.issue.number == 23"),
  'watch normalization workflow must stay bound to Release Control #23',
);
assert(
  productionWatchNormalize.includes('environment: production'),
  'watch normalization runtime must remain behind the protected production environment',
);
assert(
  productionWatchNormalize.includes('production-ci-provenance.cjs'),
  'watch normalization must require exact current-main Required CI provenance',
);
assert(
  productionWatchNormalize.includes('ops/normalize-production-pm2-watch.sh'),
  'watch normalization workflow must stream the merged normalizer implementation',
);
assert(
  productionWatchNormalize.includes('https://lsj119.com'),
  'watch normalization must verify the official Production endpoint',
);
assert(
  productionWatchNormalize.includes('Production application deploy executed:'),
  'watch normalization result must explicitly record no Production application deploy',
);
assert(
  productionWatchNormalize.includes('Production database changed:'),
  'watch normalization result must explicitly record no Production DB mutation',
);

assert(deployScript.includes('restore_backup'), 'automatic rollback must remain enabled');
assert(
  deployScript.includes('[deploy] production verification failed; starting automatic rollback'),
  'post-switch verification failure must still trigger automatic rollback',
);
assert(deployScript.includes('exit 13'), 'post-switch verification failure must remain fail-closed');

const normalizedDeployScript = deployScript.replaceAll('\r\n', '\n');
const healthStart = normalizedDeployScript.indexOf('probe_health() {');
const healthEnd = normalizedDeployScript.indexOf('\n}\n\nprobe_data()', healthStart);
assert(healthStart >= 0 && healthEnd > healthStart, 'Production health helper boundary is missing');
const healthHelper = normalizedDeployScript.slice(healthStart, healthEnd + 3);
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const targetSha = 'a'.repeat(40);
const previousSha = 'b'.repeat(40);
const healthPayload = (sha) => JSON.stringify({
  ok: true,
  deploySha: sha,
  processDeploySha: sha,
  deployMarkerSha: sha,
  identityMatch: true,
  identityStatus: 'match',
});
const exerciseHealth = (mode) => spawnSync(bash, ['--noprofile', '--norc', '-s'], {
  cwd: root,
  encoding: 'utf8',
  timeout: 15_000,
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PROBE_MODE: mode,
    TARGET_SHA: targetSha,
    STALE_PAYLOAD: healthPayload(previousSha),
    TARGET_PAYLOAD: healthPayload(targetSha),
  },
  input: `set -Eeuo pipefail
HEALTH_CALLS=0
curl() {
  HEALTH_CALLS=$((HEALTH_CALLS + 1))
  local output=''
  while (( $# > 0 )); do
    if [[ "$1" == '-o' ]]; then output="$2"; shift 2; else shift; fi
  done
  [[ -n "$output" ]]
  if [[ "$PROBE_MODE" == 'converge' && "$HEALTH_CALLS" -gt 1 ]]; then
    printf '%s' "$TARGET_PAYLOAD" > "$output"
  else
    printf '%s' "$STALE_PAYLOAD" > "$output"
  fi
}
sleep() { :; }
${healthHelper}
set +e
probe_health 'http://127.0.0.1:8080' "$TARGET_SHA"
status=$?
set -e
printf 'status=%s calls=%s\\n' "$status" "$HEALTH_CALLS"
`,
});

const convergedHealth = exerciseHealth('converge');
assert(!convergedHealth.error, `health convergence probe failed to execute: ${convergedHealth.error?.message}`);
assert(convergedHealth.status === 0, `health convergence fixture failed: ${convergedHealth.stderr}`);
assert(convergedHealth.stdout.trim() === 'status=0 calls=2', 'stale identity must be retried and then accepted');

const staleHealth = exerciseHealth('stale');
assert(!staleHealth.error, `stale health probe failed to execute: ${staleHealth.error?.message}`);
assert(staleHealth.status === 0, `stale health fixture failed: ${staleHealth.stderr}`);
assert(staleHealth.stdout.trim() === 'status=1 calls=10', 'permanently stale identity must fail after exactly 10 attempts');

console.log('[production-verification-contract] verified');
