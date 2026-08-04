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

for (const required of [
  "section 'diagnostic_identity'",
  'hostnamectl --static',
  "section 'block_devices'",
  'lsblk -o NAME,SIZE,FSTYPE,TYPE,MOUNTPOINTS',
  "section 'df_h'",
  'df -hP',
  "section 'df_i'",
  'df -iP',
  "section 'root_filesystem_bytes'",
  'df -B1 -P /',
  "section 'root_mount'",
  'findmnt / -o TARGET,SOURCE,FSTYPE,OPTIONS',
  "section 'memory_and_swap'",
  'swapon --show --bytes --noheadings --output TYPE,SIZE,USED,PRIO',
  'vmstat 1 10',
  'mpstat 1 10',
  "section 'pm2_safe_inventory'",
  'pm2 jlist 2>/dev/null | node -e',
  'pm_id:',
  'restart_count:',
  'pm2_required_checks()',
  'PM2_CHECK',
  "section 'caddy_service_and_config'",
  'systemctl is-active caddy',
  'caddy validate --config /etc/caddy/Caddyfile',
  'caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile',
  'pm2_pid_for_name()',
  'listening_dial_for_pid()',
  'caddy_route_has_dial()',
  'INTERNAL_ROUTE',
  "section 'listening_sockets'",
  'ss -H -ltnp',
  "section 'health_verification'",
  "health_probe 'production-internal'",
  "health_probe 'production-external'",
  "health_probe 'staging-internal'",
  "health_probe 'staging-external'",
  'https://lsj119.duckdns.org/api/health',
  'https://lsj119-staging.duckdns.org/api/health',
  'expected_sha=',
  'sha_match=',
  'service_verification_status=passed',
  'READ_ONLY_DIAGNOSTICS_COMPLETE',
  'ionice -c3 nice -n 19 du',
  'journalctl --since "$INCIDENT_START" --until "$INCIDENT_END"',
]) {
  assert(script.includes(required), `missing required read-only evidence: ${required}`);
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
assert(!script.includes('route_dial_for_host()'), 'internal Health ports must come from the PM2 PID and listening socket, not the first Caddy upstream');

const pm2Lines = script.split('\n').filter((line) => /pm2 jlist/.test(line));
assert(pm2Lines.length > 0, 'safe PM2 parsing must remain present');
assert(pm2Lines.every((line) => line.includes('| node -e')), 'raw pm2 jlist output must always be piped directly to a field filter');
for (const forbiddenPm2Field of [
  'process.env',
  'pm2_env?.env',
  'exec_interpreter',
  'node_args',
  'username',
]) {
  assert(!script.includes(forbiddenPm2Field), `PM2 output must not enumerate sensitive field: ${forbiddenPm2Field}`);
}

for (const required of [
  "startsWith(github.event.comment.body, '/run-server-diagnostics ')",
  'environment: staging',
  'Require diagnostics SHA contained in current main',
  '< ops/server-readonly-diagnostics.sh > "$artifact"',
  'Enforce diagnostic redaction contract',
  'Check service verification verdict',
  "grep -Fx 'service_verification_status=passed'",
  'Server files deleted: `0`',
  'Server processes restarted or stopped: `0`',
  'Staging deployment executed: `false`',
  'Production deployment executed: `false`',
  'Production database changed: `false`',
  'Secret values recorded: `false`',
  'EXPECTED_PRODUCTION_SHA',
  'EXPECTED_STAGING_SHA',
  'EXPECTED_PUBLIC_IP',
]) {
  assert(workflow.includes(required), `workflow is missing safety contract: ${required}`);
}

assert(workflow.includes('issue_comment:'), 'approved Issue command trigger is required');
assert(!workflow.includes('workflow_dispatch:'), 'no new manual deployment-style dispatch path may be added');
assert((workflow.match(/environment:\s*staging/g) ?? []).length === 1, 'workflow must use exactly one staging environment declaration');
assert(!/environment:\s*production/.test(workflow), 'production environment reference is forbidden');
assert(!/secrets\.(PRODUCTION|PROD)_[A-Z0-9_]+/.test(workflow), 'production secret reference is forbidden');

for (const forbidden of [
  'createWorkflowDispatch',
  'staging-readiness.yml',
  'production-deploy',
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

console.log('[server-readonly-diagnostics-contract] hostname, storage, Caddy, safe PM2, four GET health checks, redaction, owner gate, staging-only environment, and no-mutation contracts verified');
