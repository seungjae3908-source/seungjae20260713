#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const scriptPath = path.join(root, 'ops', 'server-resilience-readonly-diagnostics.sh');
const source = fs.readFileSync(scriptPath, 'utf8');

const required = [
  'RESOURCE_HEALTH',
  'PM2_STABLE',
  'PM2_RELEASE_PROCESS',
  'release_scoped_processes_are_dynamic=true',
  'release_scoped_processes_required_for_service_verdict=false',
  'LOCAL_BACKUP',
  'DB_BACKUP',
  'OFFSITE_BACKUP',
  'RESTORE_DRILL',
  'unknown_is_never_pass=true',
  'server_files_written=0',
  'server_files_deleted=0',
  'server_processes_restarted=0',
  'deployment_executed=0',
  'database_changes=0',
  'secret_values_collected=0',
  'SERVER_RESILIENCE_READ_ONLY_DIAGNOSTICS_COMPLETE',
];

const forbiddenLiterals = [
  'stock-app-f6b2bea-canary',
  'stock-signal-worker-f6b2bea-canary',
  'stock-app-f6b2bea-production',
  '/opt/stock-app-releases/f6b2bea',
];

const forbiddenMutations = [
  /\bpm2\s+(?:start|restart|reload|stop|delete|save)\b/i,
  /\bsystemctl\s+(?:start|restart|reload|stop|enable|disable)\b/i,
  /\b(?:reboot|shutdown|poweroff)\b/i,
  /\bfind\b[^\n]*\s-delete(?:\s|$)/i,
  /\brm\s+-[^\n]*r[^\n]*f\b/i,
  /\btruncate\s+-s\b/i,
  /\b(?:psql|pg_restore|pg_dump)\b[^\n]*\s(?:-c|--command)\b/i,
];

const failures = [];

for (const token of required) {
  if (!source.includes(token)) failures.push(`missing required contract token: ${token}`);
}

for (const token of forbiddenLiterals) {
  if (source.includes(token)) failures.push(`stale deploy-specific PM2 literal present: ${token}`);
}

for (const pattern of forbiddenMutations) {
  if (pattern.test(source)) failures.push(`mutation-like command present: ${pattern}`);
}

if (!source.includes('["kiwoom-proxy","online","/opt/kiwoom-proxy"]') ||
    !source.includes('["stock-app","online","/opt/stock-app"]') ||
    !source.includes('["seungjae-staging","online","/srv/seungjae-staging/api-server"]')) {
  failures.push('stable PM2 service contract is incomplete');
}

if (!source.includes('/^(stock-app|stock-signal-worker)-([0-9a-f]{7,40})-(canary|production)$/i')) {
  failures.push('release-scoped PM2 process discovery is not dynamic');
}

if (!source.includes('credentialed_db_probe=false') ||
    !source.includes('restore_verified=false')) {
  failures.push('database backup evidence must remain non-credentialed and restore-unverified');
}

if (!source.includes('OFFSITE_BACKUP\\tstatus=UNVERIFIED')) {
  failures.push('off-site backup must remain explicitly unverified without an external probe');
}

if (failures.length) {
  console.error('Server resilience read-only contract FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Server resilience read-only contract PASS');
console.log(`required_tokens=${required.length}`);
console.log(`forbidden_stale_literals=${forbiddenLiterals.length}`);
console.log(`forbidden_mutation_patterns=${forbiddenMutations.length}`);
