import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.basename(process.cwd()) === 'api-server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[server-readonly-diagnostics-contract] ${message}`);
};

const script = await read('ops/server-readonly-diagnostics.sh');
const workflow = await read('.github/workflows/server-readonly-diagnostics.yml');
const legacyProductionSha = '85be5c7cae0c5da7b8d9c4147b0198da9eba8452';
const stagingSha = 'aab202273498af5d2db13f4328a9ebe9287f9a1c';

for (const required of [
  "section 'diagnostic_identity'",
  'verification_phase=',
  'hostnamectl --static',
  'lsblk -o NAME,SIZE,FSTYPE,TYPE,MOUNTPOINTS',
  'df -hP',
  'df -iP',
  'df -B1 -P /',
  'findmnt / -o TARGET,SOURCE,FSTYPE,OPTIONS',
  'swapon --show --bytes --noheadings --output TYPE,SIZE,USED,PRIO',
  'vmstat 1 10',
  'mpstat 1 10',
  'pm2 jlist 2>/dev/null | node -e',
  'pm2_required_checks()',
  'PM2_CHECK',
  'systemctl is-active caddy',
  'caddy validate --config /etc/caddy/Caddyfile',
  'caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile',
  'pm2_pid_for_name()',
  'listening_dial_for_pid()',
  'caddy_route_has_dial()',
  'ss -H -ltnp',
  "health_probe 'production-internal'",
  "health_probe 'production-external'",
  "health_probe 'staging-internal'",
  "health_probe 'staging-external'",
  'https://lsj119.duckdns.org/api/health',
  'https://lsj119-staging.duckdns.org/api/health',
  'sha_present=',
  'sha_match=',
  'evaluate_production_identity()',
  "section 'production_identity_verification'",
  `readonly LEGACY_PRODUCTION_SHA='${legacyProductionSha}'`,
  '"$VERIFICATION_PHASE" == pre-production-upgrade',
  '"$EXPECTED_PRODUCTION_SHA" == "$LEGACY_PRODUCTION_SHA"',
  '"$production_sha" == "$LEGACY_PRODUCTION_SHA"',
  '"$production_marker_match" -eq 1',
  '"$caddy_active" == active',
  '"$caddy_validation_valid" -eq 1',
  '"$stock_app_status" == online',
  '"$stock_app_cwd" == /opt/stock-app',
  '"$public_ip_match" -eq 1',
  'production_health_status=healthy',
  'production_identity_verified=true',
  'production_identity_source=deploy-marker',
  'production_legacy_health_contract=true',
  'production_health_sha_present=false',
  'production_health_sha_match=not_applicable',
  'server_files_written=0',
  'server_files_deleted=0',
  'server_processes_restarted=0',
  'server_processes_stopped=0',
  'deployment_executed=0',
  'database_changes=0',
  'secret_values_collected=0',
  'service_verification_status=passed',
  'READ_ONLY_DIAGNOSTICS_COMPLETE',
]) {
  assert(script.includes(required), `missing required read-only or legacy bridge evidence: ${required}`);
}

for (const forbidden of [
  /(^|\n)\s*(sudo\s+)?rm\s/m,
  /(^|\n)\s*(sudo\s+)?mv\s/m,
  /(^|\n)\s*(sudo\s+)?cp\s/m,
  /(^|\n)\s*(sudo\s+)?truncate\s/m,
  /(^|\n)\s*(sudo\s+)?unlink\s/m,
  /(^|\n)\s*(sudo\s+)?kill(all)?\s/m,
  /(^|\n)\s*(sudo\s+)?pkill\s/m,
  /(^|\n)\s*(sudo\s+)?reboot\b/m,
  /(^|\n)\s*(sudo\s+)?shutdown\b/m,
  /systemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask)\b/,
  /pm2\s+(start|stop|restart|reload|delete|flush|save|kill|resurrect)\b/,
  /\b(growpart|resize2fs|fdisk|parted|sfdisk|cryptsetup|mdadm)\b/,
  /find[^\n]*\s-delete\b/,
  /(^|\n)\s*(apt|apt-get|yum|dnf|apk)\s/m,
  /(^|\n)\s*(npm|pnpm|yarn)\s+(install|add|remove|update)\b/m,
  /(^|\n)\s*(docker|podman)\s+(system\s+)?prune\b/m,
  /journalctl\s+--vacuum/,
  /(^|\n)\s*(sudo\s+)?(printenv|env)(\s|$)/m,
  /\/proc\/[^\n]*\/environ/,
  /(^|[^2])>\s*\/(?!dev\/null)/m,
  /curl[^\n]*(--request|-X|--data|-d|--form|-F|--upload-file|-T)\b/,
  /curl[^\n]*(authorization|proxy-authorization|cookie|x-api-key|apikey|token)/i,
  /https?:\/\/[^/\s]+@/,
]) {
  assert(!forbidden.test(script), `server script contains forbidden mutation, method, or secret pattern: ${forbidden}`);
}

const curlLines = script.split('\n').filter((line) => /\bcurl\b/.test(line));
assert(curlLines.length === 1, `expected exactly one generic curl command in health_probe, found ${curlLines.length}`);
assert(curlLines[0].includes('curl --get'), 'curl must explicitly use safe GET mode');
assert(script.includes('health_probe()'), 'curl must be encapsulated by the health-only probe');
assert(!script.includes('curl -4'), 'public IP discovery must not add a non-health curl request');
assert(!script.includes('route_dial_for_host()'), 'internal Health ports must come from PM2 PID and listening socket');

const pm2Lines = script.split('\n').filter((line) => /pm2 jlist/.test(line));
assert(pm2Lines.length > 0, 'safe PM2 parsing must remain present');
assert(pm2Lines.every((line) => line.includes('| node -e')), 'raw pm2 jlist output must always be piped directly to a field filter');
for (const forbiddenPm2Field of ['process.env', 'pm2_env?.env', 'exec_interpreter', 'node_args', 'username']) {
  assert(!script.includes(forbiddenPm2Field), `PM2 output must not enumerate sensitive field: ${forbiddenPm2Field}`);
}

const bridgeStart = script.indexOf('evaluate_production_identity()');
const bridgeEnd = script.indexOf("section 'diagnostic_identity'");
assert(bridgeStart >= 0 && bridgeEnd > bridgeStart, 'legacy production bridge function must be present before diagnostics execute');
const bridge = script.slice(bridgeStart, bridgeEnd);
assert(!bridge.includes('|| true'), 'legacy production bridge must not ignore a failed condition');
assert(!bridge.includes('production_health_sha_match=1'), 'legacy bridge must not forge sha_match=1');
assert(bridge.includes('both_sha_absent'), 'legacy bridge must require SHA absence on both production Health responses');
assert(bridge.includes('both_sha_present'), 'strict production identity must require SHA presence on both Health responses');
assert(bridge.includes('service_consistent'), 'legacy bridge must compare safe internal and external service identity');
assert(bridge.includes('infrastructure_identity_ready'), 'legacy bridge must require deploy marker, Caddy, PM2, cwd, and public IP identity');

for (const required of [
  "startsWith(github.event.comment.body, '/run-server-diagnostics ')",
  '(pre-production-upgrade|post-production-deploy)',
  'environment: staging',
  'Require diagnostics SHA contained in current main',
  '< ops/server-readonly-diagnostics.sh > "$artifact"',
  'Enforce diagnostic redaction contract',
  'Check service verification verdict',
  "grep -Fx 'service_verification_status=passed'",
  "grep -Fx 'server_files_written=0'",
  "grep -Fx 'server_files_deleted=0'",
  "grep -Fx 'server_processes_restarted=0'",
  "grep -Fx 'server_processes_stopped=0'",
  "grep -Fx 'deployment_executed=0'",
  "grep -Fx 'database_changes=0'",
  "grep -Fx 'secret_values_collected=0'",
  "grep -Fx 'production_health_status=healthy'",
  "grep -Fx 'production_identity_verified=true'",
  'case "$identity_source" in',
  'deploy-marker)',
  'health-response)',
  "target=staging-.*sha_present=1.*sha_match=1",
  'Server files written or deleted: `0`',
  'Server processes restarted or stopped: `0`',
  'Staging deployment executed: `false`',
  'Production deployment executed: `false`',
  'Production database changed: `false`',
  'Secret values recorded: `false`',
  'EXPECTED_PRODUCTION_SHA',
  'EXPECTED_STAGING_SHA',
  'EXPECTED_PUBLIC_IP',
  'VERIFICATION_PHASE',
  legacyProductionSha,
]) {
  assert(workflow.includes(required), `workflow is missing safety or legacy bridge contract: ${required}`);
}

assert(!workflow.includes("if [[ \"$VERIFICATION_PHASE\" == 'pre-production-upgrade' && \"$EXPECTED_PRODUCTION_SHA\" == \"$legacy_sha\" ]]"),
  'workflow must branch on verified artifact identity source, not assume legacy from command inputs');
assert(workflow.includes('issue_comment:'), 'approved Issue command trigger is required');
assert(!workflow.includes('workflow_dispatch:'), 'no new manual deployment-style dispatch path may be added');
assert((workflow.match(/environment:\s*staging/g) ?? []).length === 1, 'workflow must use exactly one staging environment declaration');
assert(!/environment:\s*production/.test(workflow), 'production environment reference is forbidden');
assert(!/secrets\.(PRODUCTION|PROD)_[A-Z0-9_]+/.test(workflow), 'production secret reference is forbidden');

for (const forbidden of [
  'createWorkflowDispatch',
  'staging-readiness.yml',
  'production-deploy.yml',
  'STAGING_SUPABASE_URL',
  'STAGING_SUPABASE_SECRET_KEY',
  'STAGING_DATABASE_URL',
  'DEPLOY_SHA=',
  'pm2 restart',
  'pm2 reload',
  'pm2 start',
  'pm2 stop',
  'systemctl restart',
  'systemctl reload',
  'systemctl start',
  'systemctl stop',
  'growpart',
  'resize2fs',
]) {
  assert(!workflow.includes(forbidden), `workflow must not contain deployment, database, or server mutation path: ${forbidden}`);
}

assert(workflow.includes('STAGING_SSH_PRIVATE_KEY'), 'workflow must use the isolated staging SSH credential');
assert(workflow.includes('Exact command required: /run-server-diagnostics'), 'owner command must be exact and auditable');
assert(workflow.includes('Diagnostics SHA is not contained in current main.'), 'diagnostics SHA ancestry check is required');
assert(workflow.includes('Diagnostic artifact contains a prohibited sensitive pattern.'), 'artifact redaction must fail closed');
assert(workflow.includes('https?://'), 'artifact redaction must reject leaked URLs');
assert(workflow.includes('(authorization|apikey|api_key|password|token|secret)'), 'artifact redaction must reject authentication material');

const productionGate = (fixture) => {
  const internal = fixture.productionInternal;
  const external = fixture.productionExternal;
  const transportHealthy =
    internal.status === 200 && external.status === 200 &&
    internal.timeout === 0 && external.timeout === 0 &&
    internal.serverError === 0 && external.serverError === 0 &&
    internal.ok === true && external.ok === true;
  const serviceConsistent =
    typeof internal.service === 'string' && internal.service.length > 0 &&
    internal.service === external.service;
  const infrastructureIdentityReady =
    fixture.markerSha === fixture.expectedProductionSha &&
    fixture.caddyActive === true && fixture.caddyValid === true &&
    fixture.stockAppStatus === 'online' && fixture.stockAppCwd === '/opt/stock-app' &&
    fixture.publicIpMatch === true;
  const internalShaPresent = typeof internal.sha === 'string' && internal.sha.length > 0;
  const externalShaPresent = typeof external.sha === 'string' && external.sha.length > 0;

  if (internalShaPresent && externalShaPresent) {
    return {
      passed: transportHealthy && serviceConsistent && infrastructureIdentityReady &&
        internal.sha === fixture.expectedProductionSha && external.sha === fixture.expectedProductionSha,
      source: 'health-response',
      legacy: false,
    };
  }
  if (!internalShaPresent && !externalShaPresent) {
    return {
      passed: transportHealthy && serviceConsistent && infrastructureIdentityReady &&
        fixture.phase === 'pre-production-upgrade' &&
        fixture.expectedProductionSha === legacyProductionSha &&
        fixture.markerSha === legacyProductionSha,
      source: 'deploy-marker',
      legacy: true,
    };
  }
  return { passed: false, source: 'unverified', legacy: false };
};

const stagingGate = (fixture) => [fixture.stagingInternal, fixture.stagingExternal].every((health) =>
  health.status === 200 && health.timeout === 0 && health.serverError === 0 &&
  typeof health.sha === 'string' && health.sha.length > 0 && health.sha === fixture.expectedStagingSha,
);

const baseFixture = {
  phase: 'pre-production-upgrade',
  expectedProductionSha: legacyProductionSha,
  markerSha: legacyProductionSha,
  caddyActive: true,
  caddyValid: true,
  stockAppStatus: 'online',
  stockAppCwd: '/opt/stock-app',
  publicIpMatch: true,
  productionInternal: { status: 200, timeout: 0, serverError: 0, ok: true, service: 'api-server', sha: null },
  productionExternal: { status: 200, timeout: 0, serverError: 0, ok: true, service: 'api-server', sha: null },
  expectedStagingSha: stagingSha,
  stagingInternal: { status: 200, timeout: 0, serverError: 0, sha: stagingSha },
  stagingExternal: { status: 200, timeout: 0, serverError: 0, sha: stagingSha },
};
const cloneFixture = () => structuredClone(baseFixture);

const passingLegacy = productionGate(baseFixture);
assert(passingLegacy.passed && passingLegacy.source === 'deploy-marker' && passingLegacy.legacy,
  'exact legacy production bridge fixture must pass');
assert(stagingGate(baseFixture), 'strict staging SHA fixture must pass');

const failureCases = [
  ['production expected SHA differs by one character', (f) => { f.expectedProductionSha = `${legacyProductionSha.slice(0, -1)}3`; }],
  ['production deploy marker mismatches', (f) => { f.markerSha = `${legacyProductionSha.slice(0, -1)}3`; }],
  ['production internal Health is not 200', (f) => { f.productionInternal.status = 503; f.productionInternal.serverError = 1; }],
  ['production external Health is not 200', (f) => { f.productionExternal.status = 503; f.productionExternal.serverError = 1; }],
  ['production safe service fields mismatch', (f) => { f.productionExternal.service = 'different-service'; }],
  ['production Health reports 5xx', (f) => { f.productionInternal.status = 502; f.productionInternal.serverError = 1; }],
  ['production Health times out', (f) => { f.productionExternal.timeout = 1; }],
  ['Caddy is inactive', (f) => { f.caddyActive = false; }],
  ['Caddy config is invalid', (f) => { f.caddyValid = false; }],
  ['stock-app is offline', (f) => { f.stockAppStatus = 'stopped'; }],
  ['stock-app cwd mismatches', (f) => { f.stockAppCwd = '/opt/other-app'; }],
  ['phase is post-production-deploy', (f) => { f.phase = 'post-production-deploy'; }],
  ['production Health contains a mismatched SHA', (f) => { f.productionInternal.sha = '1'.repeat(40); f.productionExternal.sha = '1'.repeat(40); }],
  ['only one production Health response contains SHA', (f) => { f.productionInternal.sha = legacyProductionSha; }],
  ['public IP does not match', (f) => { f.publicIpMatch = false; }],
];
for (const [name, mutate] of failureCases) {
  const fixture = cloneFixture();
  mutate(fixture);
  assert(!productionGate(fixture).passed, `legacy bridge must fail when ${name}`);
}

const missingStagingSha = cloneFixture();
missingStagingSha.stagingInternal.sha = null;
assert(!stagingGate(missingStagingSha), 'staging Health SHA absence must fail');
const mismatchedStagingSha = cloneFixture();
mismatchedStagingSha.stagingExternal.sha = '2'.repeat(40);
assert(!stagingGate(mismatchedStagingSha), 'staging Health SHA mismatch must fail');

const strictPreDeploy = cloneFixture();
strictPreDeploy.productionInternal.sha = legacyProductionSha;
strictPreDeploy.productionExternal.sha = legacyProductionSha;
const strictPreDeployResult = productionGate(strictPreDeploy);
assert(strictPreDeployResult.passed && strictPreDeployResult.source === 'health-response' && !strictPreDeployResult.legacy,
  'a matching Health SHA must use the strict identity path even during pre-production-upgrade');

const strictPostDeploy = cloneFixture();
strictPostDeploy.phase = 'post-production-deploy';
strictPostDeploy.expectedProductionSha = '3'.repeat(40);
strictPostDeploy.markerSha = '3'.repeat(40);
strictPostDeploy.productionInternal.sha = '3'.repeat(40);
strictPostDeploy.productionExternal.sha = '3'.repeat(40);
const strictPostDeployResult = productionGate(strictPostDeploy);
assert(strictPostDeployResult.passed && strictPostDeployResult.source === 'health-response' && !strictPostDeployResult.legacy,
  'post-production verification must pass only with matching Health SHA responses');

console.log('[server-readonly-diagnostics-contract] exact legacy SHA pre-upgrade bridge, artifact-source routing, strict post-deploy and staging SHA verification, zero-change evidence, Caddy/PM2/IP/deploy-marker identity, redaction, owner gate, staging-only environment, and no-mutation contracts verified');
