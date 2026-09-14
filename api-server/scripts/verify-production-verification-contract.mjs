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
