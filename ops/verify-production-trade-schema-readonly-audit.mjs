#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const workflowPath = path.join(root, '.github/workflows/production-deploy.yml');
const auditPath = path.join(root, 'ops/production-trade-schema-readonly-audit.sh');

const REQUIRED_KEYS = new Set([
  'schemaVersion',
  'status',
  'code',
  'missingTables',
  'missingFunctions',
  'rlsReady',
  'adminPolicyTablesReady',
  'globalControlBrowserPolicyFree',
  'tossConstraintReady',
  'readOnlyEnforced',
  'rawUserDataExposed',
  'arbitrarySqlAllowed',
]);

const FORBIDDEN_ARTIFACT_PATTERNS = [
  /postgres(?:ql)?:\/\//i,
  /(?:^|[^0-9])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?:$|[^0-9])/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:DATABASE_URL|SUPABASE_DB_URL|SUPABASE_DATABASE_URL|POSTGRES_URL|POSTGRESQL_URL)\s*=/i,
  /\b(?:password|passwd|secret|service[_-]?role[_-]?key|authorization)\s*[=:]/i,
];

function fail(message) {
  throw new Error(message);
}
function assert(condition, message) {
  if (!condition) fail(message);
}
function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function validateArtifact(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'artifact must be an object');
  for (const key of Object.keys(value)) {
    assert(REQUIRED_KEYS.has(key), 'unexpected artifact key: ' + key);
  }
  for (const key of REQUIRED_KEYS) {
    assert(Object.hasOwn(value, key), 'missing artifact key: ' + key);
  }
  assert(value.schemaVersion === 'production-trade-schema-readonly-audit-v1', 'schema version mismatch');
  assert(value.status === 'READY' || value.status === 'BLOCKED', 'invalid status');
  assert(Array.isArray(value.missingTables), 'missingTables must be an array');
  assert(Array.isArray(value.missingFunctions), 'missingFunctions must be an array');
  assert(value.readOnlyEnforced === true, 'readOnlyEnforced must be true');
  assert(value.rawUserDataExposed === false, 'rawUserDataExposed must be false');
  assert(value.arbitrarySqlAllowed === false, 'arbitrarySqlAllowed must be false');
  const serialized = JSON.stringify(value);
  for (const pattern of FORBIDDEN_ARTIFACT_PATTERNS) {
    assert(!pattern.test(serialized), 'artifact contains forbidden sensitive pattern: ' + String(pattern));
  }
}

function verifyStaticContract() {
  const workflow = read(workflowPath);
  const audit = read(auditPath);

  assert(workflow.includes('ops/production-trade-schema-readonly-audit.sh'), 'workflow does not invoke trade schema audit');
  assert(workflow.includes('ops/verify-production-trade-schema-readonly-audit.mjs --static'), 'static audit verification missing');
  assert(workflow.includes('Require canonical Production trade schema and journal privileges before application mutation'), 'pre-deploy schema gate step missing');
  assert(
    workflow.indexOf('Require canonical Production trade schema and journal privileges before application mutation')
      < workflow.indexOf('Deploy exact approved revision'),
    'trade schema gate must execute before application deployment',
  );
  assert(workflow.includes('bash -n ops/production-trade-schema-readonly-audit.sh'), 'audit shell syntax validation missing');
  assert(workflow.includes('ref: ${{ env.TARGET_SHA }}'), 'exact approved checkout missing from deploy job');
  assert((workflow.match(/secrets\.PROD_DATABASE_URL/g) ?? []).length === 1, 'Production database credential must be scoped exactly once');
  assert(workflow.includes("printf '%s\\n' \"$PROD_DATABASE_URL\" | ssh"), 'database credential must enter the remote audit over stdin');
  assert(workflow.includes('IFS= read -r PROD_DATABASE_URL; export PROD_DATABASE_URL'), 'remote stdin credential bridge missing');
  assert(!workflow.includes('PROD_DATABASE_URL=%q'), 'database credential must not be embedded in remote command argv');

  assert(audit.startsWith('#!/usr/bin/env bash'), 'audit shebang missing');
  assert(audit.includes('set -Eeuo pipefail'), 'strict shell mode missing');
  assert(!audit.includes('set -x'), 'shell tracing is forbidden');
  assert(!audit.includes('printenv'), 'environment dumping is forbidden');
  assert(!/\/proc\/[^ \n]*environ/u.test(audit), 'raw process environment reads are forbidden');
  assert(!audit.includes('SUPABASE_SERVICE_ROLE_KEY'), 'service role key use is forbidden');
  assert(!audit.includes('SUPABASE_SECRET_KEY'), 'Supabase secret key use is forbidden');
  assert(audit.includes('process.env.PROD_DATABASE_URL'), 'transient protected database credential input missing');
  assert(audit.includes('transientProductionDatabaseUrl'), 'transient database credential candidate missing');
  assert(audit.includes('delete baseEnv.PROD_DATABASE_URL'), 'database credential must be removed before spawning psql');
  assert(
    audit.includes("PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000'"),
    'read-only PGOPTIONS missing',
  );
  assert(audit.includes('"BEGIN READ ONLY;"'), 'read-only transaction missing');
  assert(audit.includes("'trade_automation_profiles'"), 'base trade profile table missing from contract');
  assert(audit.includes("'trade_protection_orders'"), 'protection table missing from contract');
  assert(audit.includes("'cancel_trade_split_children_atomic'"), 'risk/split function missing from contract');
  assert(audit.includes("ILIKE '%toss%'"), 'Toss schema extension check missing');

  const forbiddenSqlWords = [
    'INSERT ', 'UPDATE ', 'DELETE ', 'UPSERT ', 'MERGE ', 'ALTER ', 'CREATE ',
    'DROP ', 'TRUNCATE ', 'GRANT ', 'REVOKE ', 'CALL ', 'VACUUM ', 'REINDEX ', 'CLUSTER ', 'COPY ',
  ];
  const sqlStart = audit.indexOf('const SCHEMA_SQL = [');
  const sqlEnd = audit.indexOf("].join('\\n');", sqlStart);
  assert(sqlStart >= 0 && sqlEnd > sqlStart, 'hardcoded schema SQL block missing');
  const sql = audit.slice(sqlStart, sqlEnd);
  for (const word of forbiddenSqlWords) {
    assert(!sql.toUpperCase().includes(word), 'mutating SQL is forbidden in schema audit: ' + word.trim());
  }
  assert(sql.includes('BEGIN READ ONLY'), 'schema SQL is not explicitly read-only');
  assert(sql.includes('COMMIT'), 'schema SQL transaction termination missing');

  const good = {
    schemaVersion: 'production-trade-schema-readonly-audit-v1',
    status: 'READY',
    code: null,
    missingTables: [],
    missingFunctions: [],
    rlsReady: true,
    adminPolicyTablesReady: true,
    globalControlBrowserPolicyFree: true,
    tossConstraintReady: true,
    readOnlyEnforced: true,
    rawUserDataExposed: false,
    arbitrarySqlAllowed: false,
  };
  validateArtifact(good);

  const badArtifacts = [
    { ...good, code: 'postgresql://user:password@db.example/db' },
    { ...good, code: 'server=10.20.30.40' },
    { ...good, code: 'DATABASE_URL=postgresql://hidden' },
  ];
  for (const bad of badArtifacts) {
    let rejected = false;
    try {
      validateArtifact(bad);
    } catch {
      rejected = true;
    }
    assert(rejected, 'sensitive artifact negative test unexpectedly passed');
  }
  process.stdout.write('production trade schema readonly audit static safety verification passed\n');
}

const [mode, file] = process.argv.slice(2);
try {
  if (mode === '--static') {
    verifyStaticContract();
  } else if (mode === '--artifact' && file) {
    validateArtifact(JSON.parse(read(path.resolve(file))));
    process.stdout.write('production trade schema readonly audit artifact verification passed\n');
  } else {
    fail('usage: verify-production-trade-schema-readonly-audit.mjs --static | --artifact <file>');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
