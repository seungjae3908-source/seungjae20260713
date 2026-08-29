import { readFileSync } from 'node:fs';
const workflow = readFileSync('.github/workflows/production-telegram-storage-release-diagnostic.yml', 'utf8');
const diagnostic = readFileSync('ops/production-telegram-storage-release-diagnostic.mjs', 'utf8');
const requireText = (source, text) => { if (!source.includes(text)) throw new Error(`missing contract: ${text}`); };
const forbid = (source, pattern) => { if (pattern.test(source)) throw new Error(`read-only contract violation: ${pattern}`); };
if ((workflow.match(/secrets\.PROD_DATABASE_URL/g) ?? []).length !== 1) throw new Error('PROD_DATABASE_URL must be scoped exactly once');
if ((workflow.match(/continue-on-error: true/g) ?? []).length < 3) throw new Error('provenance, diagnostic, and artifact verification must fail safely before terminal enforcement');
for (const text of [
  'environment: production',
  'PROD_DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}',
  "printf '%s\\n' \"$PROD_DATABASE_URL\" | ssh",
  '/run-telegram-storage-release-diagnostic ',
  '--verify-artifact "$DIAGNOSTIC_ARTIFACT"',
  '- name: Prepare sanitized diagnostic path',
  '- name: Resolve and require active Production SHA provenance',
  'id: provenance',
  "core.setOutput('latest_sha'",
  "core.setOutput('latest_run_id'",
  "if: steps.provenance.outcome == 'success'",
  "if: steps.provenance.outcome == 'success' && steps.diagnostic.outcome == 'success'",
  "if: steps.provenance.outcome == 'success' && steps.diagnostic.outcome == 'success' && steps.verify.outcome == 'success'",
  'Latest successful Production SHA:',
  'Latest Production Deploy Run ID:',
  'PROVENANCE_OUTCOME: ${{ steps.provenance.outcome }}',
  '- name: Enforce diagnostic execution status',
]) requireText(workflow, text);
const artifactPathIndex = workflow.indexOf('- name: Prepare sanitized diagnostic path');
const provenanceIndex = workflow.indexOf('- name: Resolve and require active Production SHA provenance');
if (artifactPathIndex < 0 || provenanceIndex < 0 || artifactPathIndex > provenanceIndex) throw new Error('diagnostic artifact path must be defined before provenance can fail');
forbid(workflow, /\bscp\b|mktemp\s+-d|createWorkflowDispatch|dispatchWorkflow|gh\s+workflow\s+run/);
forbid(workflow, /core\.setFailed\(['"]Sanitized diagnostic evidence missing\./);
forbid(workflow, /if: always\(\) && steps\.command\.outcome == 'success'\s*\n\s*run: \|\s*\n\s*set -Eeuo pipefail\s*\n\s*\[\[ -s "\$DIAGNOSTIC_ARTIFACT"/);
for (const text of [
  "const PRODUCTION_SESSION_POOLER_HOST = 'aws-1-ap-south-1.pooler.supabase.com';",
  "const transientDatabaseUrl = String(process.env.PROD_DATABASE_URL ?? '').trim();",
  'begin read only;',
  'rollback;',
  'delete childEnv.PROD_DATABASE_URL;',
  'function psqlExistsOutsidePath() {',
  "const candidates = ['/usr/bin/psql', '/usr/local/bin/psql'];",
  "readdirSync('/usr/lib/postgresql'",
  'accessSync(path, fsConstants.X_OK);',
  "blocked('psql_installed_outside_path', connected)",
  "blocked('psql_not_installed', connected)",
  'function classifyPsqlFailure(stderrText) {',
  "return 'production_database_supavisor_circuit_breaker'",
  "return 'production_database_supavisor_tenant_unresolved'",
  "return 'production_database_supavisor_auth_connection_closed'",
  "return 'production_database_auth_failed'",
  "return 'production_database_dns_failed'",
  "return 'production_database_network_unreachable'",
  "return 'production_database_connection_timed_out'",
  "return 'production_database_connection_refused'",
  "return 'production_database_server_closed_connection'",
  "return 'production_database_connection_failed'",
  "blocked('production_database_pooler_host_mismatch'",
  'hostname !== PRODUCTION_SESSION_POOLER_HOST',
  'const pooler = hostname === PRODUCTION_SESSION_POOLER_HOST && poolerUser;',
  'blocked(classifyPsqlFailure(result.stderr), connected);',
  'database_changed: false',
  'server_files_written: 0',
  'server_processes_restarted: 0',
  'production_deployment_executed: false',
  'order_submitted: false',
  'private_trading_api_count: 0',
  'live_trading_authority: false',
]) requireText(diagnostic, text);
if (diagnostic.includes("blocked('psql_unavailable'")) throw new Error('legacy undifferentiated psql_unavailable classification is forbidden');
forbid(diagnostic, /else if \(\/could not translate host name\|could not connect\|connection refused\|connection timed out\|server closed the connection\|network is unreachable\/\.test\(stderr\)\) classification = 'production_database_connection_failed'/);
if (diagnostic.indexOf("return 'production_database_supavisor_circuit_breaker'") > diagnostic.indexOf("return 'production_database_auth_failed'")) throw new Error('Supavisor circuit breaker classification must precede generic authentication failure');
const sql = /const SQL = String\.raw`([\s\S]*?)`;/.exec(diagnostic)?.[1];
if (!sql) throw new Error('diagnostic SQL missing');
forbid(sql, /^\s*(insert|update|delete|create|alter|drop|grant|revoke|truncate|comment|copy|merge|vacuum|reindex|cluster|refresh|do)\b/im);
forbid(diagnostic, /\b(writeFileSync|appendFileSync|unlinkSync|rmSync|renameSync|mkdirSync)\b|\b(fetch|https?\.request|net\.connect|tls\.connect)\b/);
forbid(diagnostic, /\b(?:apt|apt-get|yum|dnf|apk|brew)\b/);
forbid(diagnostic, /console\.(?:log|error)\([^\n]*transientDatabaseUrl|process\.(?:stdout|stderr)\.write\([^\n]*transientDatabaseUrl/);
process.stdout.write('production Telegram storage release diagnostic static contract: PASS\n');
