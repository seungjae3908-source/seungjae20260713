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
  "section 'df_h'",
  'df -hP',
  "section 'df_i'",
  'df -iP',
  "section 'root_filesystem_bytes'",
  "section 'srv_top_directories_bytes'",
  "section 'release_and_backup_inventory'",
  "section 'deployment_state_files'",
  "section 'package_and_browser_cache_sizes'",
  "section 'pm2_log_sizes'",
  "section 'system_log_sizes'",
  "section 'tmp_and_temporary_build_directories'",
  "section 'memory_and_swap'",
  "section 'incident_system_and_proxy_logs'",
  "section 'incident_pm2_application_logs'",
  "section 'kernel_resource_pressure_signals'",
  'READ_ONLY_DIAGNOSTICS_COMPLETE',
  'ionice -c3 nice -n 19 du',
  'pm2 jlist',
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
  /pm2\s+(start|stop|restart|reload|delete|flush|save|kill)\b/,
  /find[^\n]*\s-delete\b/,
  /(^|\n)\s*(apt|apt-get|yum|dnf|apk)\s/m,
  /(^|\n)\s*(npm|pnpm|yarn)\s+(install|add|remove|update)\b/m,
  /\/proc\/[^\n]*\/environ/,
  /\b(printenv|env)\b/,
  /(^|[^2])>\s*\/(?!dev\/null)/m,
]) {
  assert(!forbidden.test(script), `server script contains forbidden mutation or secret-enumeration pattern: ${forbidden}`);
}

for (const required of [
  "startsWith(github.event.comment.body, '/run-server-diagnostics ')",
  "environment: staging",
  'Require incident SHA contained in current main',
  '< ops/server-readonly-diagnostics.sh > "$artifact"',
  'Enforce diagnostic redaction contract',
  'Server files deleted: `0`',
  'Server processes restarted or stopped: `0`',
  'Staging deployment executed: `false`',
  'Production deployment executed: `false`',
  'Secret values recorded: `false`',
]) {
  assert(workflow.includes(required), `workflow is missing safety contract: ${required}`);
}

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
  'systemctl restart',
]) {
  assert(!workflow.includes(forbidden), `workflow must not contain deployment/database mutation path: ${forbidden}`);
}

assert(workflow.includes('STAGING_SSH_PRIVATE_KEY'), 'workflow must use the isolated staging SSH credential');
assert(workflow.includes('Exact command required: /run-server-diagnostics'), 'owner command must be exact and auditable');
assert(workflow.includes('Incident SHA is not contained in current main.'), 'incident SHA ancestry check is required');
assert(workflow.includes('Diagnostic artifact contains a prohibited sensitive pattern.'), 'artifact redaction must fail closed');

console.log('[server-readonly-diagnostics-contract] read-only commands, redaction, owner gate, and no-deploy contracts verified');
