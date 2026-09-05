#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const workflowPath = path.join(root, '.github/workflows/production-postgres-readonly-audit.yml');
const auditPath = path.join(root, 'ops/production-postgres-readonly-audit.sh');

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const REQUIRED_ARTIFACT_KEYS = new Set([
  'STATUS',
  'DB_CATALOG_AUDIT',
  'PRODUCTION_SHA',
  'EXISTING_SAFE_DB_CONNECTION_AVAILABLE',
  'TABLE_EXISTS',
  'ACTUAL_COLUMNS',
  'ACTUAL_PRIMARY_KEY',
  'ACTUAL_UNIQUE_CONSTRAINTS',
  'ACTUAL_UNIQUE_INDEXES',
  'ACTUAL_EXCLUSION_CONSTRAINTS',
  'ARBITER_TYPE',
  'ARBITER_INDEX_NAME',
  'ARBITER_COLUMNS',
  'ARBITER_PARTIAL',
  'ARBITER_DEFERRABLE',
  'ARBITER_VALID',
  'ARBITER_READY',
  'DUPLICATE_GROUP_COUNT',
  'DUPLICATE_EXTRA_ROW_COUNT',
  'TOTAL_ROW_COUNT',
  'RLS_ENABLED',
  'RLS_FORCE',
  'WATCHLIST_POLICY_COUNT',
  'CURRENT_ROLE_HAS_SELECT',
  'READ_ONLY_ENFORCED',
  'ARBITRARY_SQL_ALLOWED',
  'RAW_USER_DATA_EXPOSED',
]);

const COLUMN_KEYS = new Set(['column_name', 'data_type', 'is_nullable', 'column_default']);
const CONSTRAINT_KEYS = new Set([
  'conname',
  'contype',
  'condeferrable',
  'condeferred',
  'convalidated',
  'definition',
]);
const INDEX_KEYS = new Set([
  'index_name',
  'indisunique',
  'indisprimary',
  'indisvalid',
  'indisready',
  'indimmediate',
  'key_columns',
  'predicate',
  'definition',
]);

const FORBIDDEN_ARTIFACT_PATTERNS = [
  /postgres(?:ql)?:\/\//i,
  /(?:^|[^0-9])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?:$|[^0-9])/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:DATABASE_URL|SUPABASE_DB_URL|SUPABASE_DATABASE_URL|POSTGRES_URL|POSTGRESQL_URL)\s*=/i,
  /\b(?:password|passwd|secret|service[_-]?role[_-]?key|authorization)\s*[=:]/i,
];

function assertOnlyKeys(value, allowed, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`);
  for (const key of Object.keys(value)) {
    assert(allowed.has(key), `${label} contains unexpected key: ${key}`);
  }
}

function assertArrayShape(rows, allowed, label) {
  assert(Array.isArray(rows), `${label} must be an array.`);
  for (const row of rows) assertOnlyKeys(row, allowed, `${label} row`);
}

function validateArtifact(value) {
  assertOnlyKeys(value, REQUIRED_ARTIFACT_KEYS, 'artifact');
  for (const key of REQUIRED_ARTIFACT_KEYS) {
    assert(Object.hasOwn(value, key), `artifact missing required key: ${key}`);
  }

  assertArrayShape(value.ACTUAL_COLUMNS, COLUMN_KEYS, 'ACTUAL_COLUMNS');
  assertArrayShape(value.ACTUAL_PRIMARY_KEY, CONSTRAINT_KEYS, 'ACTUAL_PRIMARY_KEY');
  assertArrayShape(value.ACTUAL_UNIQUE_CONSTRAINTS, CONSTRAINT_KEYS, 'ACTUAL_UNIQUE_CONSTRAINTS');
  assertArrayShape(value.ACTUAL_EXCLUSION_CONSTRAINTS, CONSTRAINT_KEYS, 'ACTUAL_EXCLUSION_CONSTRAINTS');
  assertArrayShape(value.ACTUAL_UNIQUE_INDEXES, INDEX_KEYS, 'ACTUAL_UNIQUE_INDEXES');

  assert(Array.isArray(value.ARBITER_COLUMNS), 'ARBITER_COLUMNS must be an array.');
  assert(value.READ_ONLY_ENFORCED === true, 'READ_ONLY_ENFORCED must be true.');
  assert(value.ARBITRARY_SQL_ALLOWED === false, 'ARBITRARY_SQL_ALLOWED must be false.');
  assert(value.RAW_USER_DATA_EXPOSED === false, 'RAW_USER_DATA_EXPOSED must be false.');

  const serialized = JSON.stringify(value);
  for (const pattern of FORBIDDEN_ARTIFACT_PATTERNS) {
    assert(!pattern.test(serialized), `artifact contains forbidden sensitive pattern: ${pattern}`);
  }
}

function extractSqlConstants(source) {
  return [...source.matchAll(/const\s+[A-Z0-9_]+_SQL\s*=\s*String\.raw`([\s\S]*?)`;/g)]
    .map((match) => match[1]);
}

function verifyStaticContract() {
  const workflow = read(workflowPath);
  const audit = read(auditPath);

  assert(/^name:\s+Production PostgreSQL Read-only Watchlist Audit/m.test(workflow), 'workflow name missing.');
  assert(/\non:\n\s+workflow_dispatch:/m.test(workflow), 'workflow_dispatch trigger missing.');
  for (const forbiddenTrigger of ['pull_request:', 'push:', 'schedule:', 'workflow_run:', 'issue_comment:']) {
    assert(!workflow.includes(forbiddenTrigger), `forbidden workflow trigger present: ${forbiddenTrigger}`);
  }
  const inputNames = [...workflow.matchAll(/^\s{6}([A-Za-z_][A-Za-z0-9_]*):\s*$/gm)].map((match) => match[1]);
  assert(inputNames.length === 1 && inputNames[0] === 'production_sha', 'production_sha must be the only workflow input.');

  assert(workflow.includes('seungjae3908-source/seungjae20260713'), 'repository gate missing.');
  assert(workflow.includes('GITHUB_ACTOR') && workflow.includes('seungjae3908-source'), 'owner actor gate missing.');
  assert(workflow.includes('^[0-9a-fA-F]{40}$'), 'exact SHA validation missing.');
  assert(workflow.includes("workflow_id: 'production-deploy.yml'"), 'latest Production Deploy provenance check missing.');

  const secretRefs = [...workflow.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)[^}]*\}\}/g)].map((match) => match[1]);
  const allowedSecrets = new Set([
    'PROD_SSH_HOST',
    'PROD_SSH_USER',
    'PROD_SSH_PORT',
    'PROD_SSH_PRIVATE_KEY',
    'PROD_SSH_KNOWN_HOSTS',
  ]);
  for (const name of secretRefs) {
    assert(allowedSecrets.has(name), `unexpected secret reference: ${name}`);
  }
  assert(secretRefs.includes('PROD_SSH_HOST'), 'PROD_SSH_HOST reference missing.');
  assert(secretRefs.includes('PROD_SSH_USER'), 'PROD_SSH_USER reference missing.');
  assert(secretRefs.includes('PROD_SSH_PRIVATE_KEY'), 'PROD_SSH_PRIVATE_KEY reference missing.');

  const auditJobEnv = workflow.match(/\n  audit:\n[\s\S]*?\n    env:\n([\s\S]*?)\n    steps:/);
  assert(auditJobEnv, 'audit job env block missing.');
  assert(!auditJobEnv[1].includes('${{ runner.'), 'runner context is forbidden in jobs.audit.env.');
  assert(workflow.includes('Initialize runner-local audit paths'), 'runner-local audit path initialization missing.');
  assert(workflow.includes('$RUNNER_TEMP/production-postgres-watchlist-audit.json'), 'RUNNER_TEMP artifact path missing.');
  assert(workflow.includes('$RUNNER_TEMP/production-postgres-watchlist-audit.stderr'), 'RUNNER_TEMP stderr path missing.');
  assert(workflow.includes('>> "$GITHUB_ENV"'), 'runner-local paths must be exported through GITHUB_ENV.');

  assert(!/\b(?:DATABASE_URL|SUPABASE_DB_URL|SUPABASE_DATABASE_URL|POSTGRES_URL|POSTGRESQL_URL)\b/.test(workflow), 'workflow must not consume a DB secret.');
  assert(!workflow.includes('set -x'), 'workflow must not enable shell tracing.');
  assert(workflow.includes('remote stderr is intentionally not printed'), 'SSH stderr suppression contract missing.');
  assert(workflow.includes('--artifact "$AUDIT_ARTIFACT"'), 'artifact redaction verification step missing.');

  assert(audit.startsWith('#!/usr/bin/env bash'), 'audit script shebang missing.');
  assert(audit.includes('set -Eeuo pipefail'), 'strict shell mode missing.');
  assert(!audit.includes('set -x'), 'audit script must not enable shell tracing.');
  assert(audit.includes("PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000'"), 'hard read-only PGOPTIONS missing.');
  assert((audit.match(/BEGIN READ ONLY;/g) ?? []).length >= 2, 'every PostgreSQL probe must begin read-only.');
  assert(audit.includes('public.watchlist_items'), 'watchlist table identity missing.');
  assert(audit.includes('POSTGRES_URI_PATTERN = /^postgres(?:ql)?:\\/\\//i'), 'runtime PostgreSQL URI discovery contract missing.');
  assert(audit.includes('BLOCKED_NO_EXISTING_SAFE_POSTGRES_CONNECTION'), 'safe no-connection blocking contract missing.');
  assert(!audit.includes('printenv'), 'printenv is forbidden.');
  assert(!/\benv\s*\|/.test(audit), 'environment dumping is forbidden.');
  assert(!/\/proc\/[^ \n]*environ/.test(audit), 'raw process environment reads are forbidden.');
  assert(!audit.includes('SUPABASE_SERVICE_ROLE_KEY'), 'service-role key use is forbidden.');
  assert(!audit.includes('SUPABASE_SECRET_KEY'), 'Supabase secret key use is forbidden.');

  const sqlBlocks = extractSqlConstants(audit);
  assert(sqlBlocks.length === 2, 'expected exactly two hardcoded SQL blocks.');
  const forbiddenSql = /\b(?:INSERT|UPDATE|DELETE|UPSERT|MERGE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|CALL|DO|VACUUM|REINDEX|CLUSTER)\b/i;
  const copyFrom = /\bCOPY\b[\s\S]{0,100}\bFROM\b/i;
  for (const sql of sqlBlocks) {
    assert(!forbiddenSql.test(sql), `mutating SQL is forbidden: ${forbiddenSql}`);
    assert(!copyFrom.test(sql), 'COPY FROM is forbidden.');
    assert(/\bBEGIN READ ONLY;/i.test(sql), 'SQL block is not explicitly read-only.');
    assert(/\bCOMMIT;/i.test(sql), 'read-only transaction termination missing.');
  }

  const good = {};
  for (const key of REQUIRED_ARTIFACT_KEYS) good[key] = null;
  Object.assign(good, {
    STATUS: 'passed',
    DB_CATALOG_AUDIT: 'PASSED',
    PRODUCTION_SHA: '0'.repeat(40),
    EXISTING_SAFE_DB_CONNECTION_AVAILABLE: true,
    TABLE_EXISTS: true,
    ACTUAL_COLUMNS: [
      { column_name: 'device_id', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'ticker', data_type: 'text', is_nullable: 'NO', column_default: null },
    ],
    ACTUAL_PRIMARY_KEY: [],
    ACTUAL_UNIQUE_CONSTRAINTS: [],
    ACTUAL_UNIQUE_INDEXES: [],
    ACTUAL_EXCLUSION_CONSTRAINTS: [],
    ARBITER_TYPE: 'ARBITER_MISSING',
    ARBITER_INDEX_NAME: null,
    ARBITER_COLUMNS: [],
    ARBITER_PARTIAL: false,
    ARBITER_DEFERRABLE: false,
    ARBITER_VALID: false,
    ARBITER_READY: false,
    DUPLICATE_GROUP_COUNT: 0,
    DUPLICATE_EXTRA_ROW_COUNT: 0,
    TOTAL_ROW_COUNT: 0,
    RLS_ENABLED: true,
    RLS_FORCE: false,
    WATCHLIST_POLICY_COUNT: 0,
    CURRENT_ROLE_HAS_SELECT: true,
    READ_ONLY_ENFORCED: true,
    ARBITRARY_SQL_ALLOWED: false,
    RAW_USER_DATA_EXPOSED: false,
  });
  validateArtifact(good);

  const badArtifacts = [
    { ...good, PRODUCTION_SHA: 'postgresql://user:password@db.example/db' },
    { ...good, PRODUCTION_SHA: 'server=10.20.30.40' },
    { ...good, PRODUCTION_SHA: 'eyJabcdefgh.abcdefgh.abcdefgh' },
    { ...good, DB_CATALOG_AUDIT: 'DATABASE_URL=postgresql://hidden' },
    { ...good, device_id: 'private-device', ticker: '005930' },
  ];
  for (const bad of badArtifacts) {
    let rejected = false;
    try {
      validateArtifact(bad);
    } catch {
      rejected = true;
    }
    assert(rejected, 'artifact redaction negative test unexpectedly passed.');
  }

  process.stdout.write('production postgres readonly audit static safety verification passed\n');
}

function verifyArtifactFile(file) {
  const value = JSON.parse(read(file));
  validateArtifact(value);
  process.stdout.write('production postgres readonly audit artifact sanitization verification passed\n');
}

const [mode, file] = process.argv.slice(2);
try {
  if (mode === '--static') {
    verifyStaticContract();
  } else if (mode === '--artifact' && file) {
    verifyArtifactFile(path.resolve(file));
  } else {
    fail('usage: verify-production-postgres-readonly-audit.mjs --static | --artifact <file>');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
