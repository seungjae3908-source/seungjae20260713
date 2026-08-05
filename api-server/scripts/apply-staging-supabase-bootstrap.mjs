import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = path.basename(process.cwd()) === 'api-server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());
const env = process.env;
const KNOWN_PRODUCTION_PROJECT_REFS = new Set(['bawcbkoyovbeajkrnduq']);
const SCHEMA_VERSION = '20260805.1';

const required = (name) => {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required for automated staging Supabase bootstrap`);
  return value;
};

function projectRefFromUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('STAGING_SUPABASE_URL is invalid'); }
  if (parsed.protocol !== 'https:') throw new Error('STAGING_SUPABASE_URL must use HTTPS');
  const match = /^([a-z0-9]+)\.supabase\.co$/i.exec(parsed.hostname);
  if (!match) throw new Error('STAGING_SUPABASE_URL must use <project-ref>.supabase.co');
  const projectRef = match[1].toLowerCase();
  if (KNOWN_PRODUCTION_PROJECT_REFS.has(projectRef)) {
    throw new Error('staging bootstrap refuses the known production Supabase project');
  }
  return projectRef;
}

function parseDatabaseUrl(raw, projectRef) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('STAGING_DATABASE_URL is invalid'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('STAGING_DATABASE_URL must be a PostgreSQL connection URL');
  }
  const hostname = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username).toLowerCase();
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'postgres';
  const disposableCi = env.CI === 'true'
    && env.STAGING_BOOTSTRAP_ALLOW_DISPOSABLE_CI === 'true'
    && ['127.0.0.1', 'localhost'].includes(hostname);
  const directMatch = hostname === `db.${projectRef}.supabase.co`;
  const poolerMatch = username === `postgres.${projectRef}`;
  if (!disposableCi && !directMatch && !poolerMatch) {
    throw new Error('STAGING_DATABASE_URL does not resolve to the same Supabase project ref');
  }
  for (const productionRef of KNOWN_PRODUCTION_PROJECT_REFS) {
    if (hostname.includes(productionRef) || username.includes(productionRef)) {
      throw new Error('STAGING_DATABASE_URL resolves to the known production Supabase project');
    }
  }
  if (!parsed.password) throw new Error('STAGING_DATABASE_URL must include the staging database password');
  return {
    hostname,
    port: parsed.port || (disposableCi ? '5432' : '5432'),
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    disposableCi,
  };
}

function stripOuterTransaction(source, relativePath) {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const beginIndexes = [];
  const commitIndexes = [];
  lines.forEach((line, index) => {
    if (/^\s*begin;\s*$/i.test(line)) beginIndexes.push(index);
    if (/^\s*commit;\s*$/i.test(line)) commitIndexes.push(index);
  });
  if (beginIndexes.length !== 1 || commitIndexes.length !== 1 || beginIndexes[0] >= commitIndexes[0]) {
    throw new Error(`${relativePath} must have exactly one outer BEGIN/COMMIT envelope`);
  }
  lines.splice(commitIndexes[0], 1);
  lines.splice(beginIndexes[0], 1);
  const remaining = lines.join('\n');
  if (/^\s*(?:begin|commit|rollback);\s*$/im.test(remaining)) {
    throw new Error(`${relativePath} contains an unexpected transaction control statement`);
  }
  return remaining;
}

async function read(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function buildAtomicSql(projectRef) {
  const plainFiles = [
    'api-server/supabase/bootstrap/staging-empty-project-guard.sql',
    'api-server/supabase/bootstrap/staging-bootstrap-helpers.sql',
    'api-server/supabase/bootstrap/staging-allowlist-base.sql',
  ];
  const envelopedFiles = [
    'api-server/supabase/migrations/2026080201_journal_sync_analytics_phase7.sql',
    'api-server/supabase/migrations/2026080202_release_candidate_permissions_phase8.sql',
    'api-server/supabase/migrations/2026080203_phase8_paper_capability_rls.sql',
    'api-server/supabase/migrations/2026080301_trade_automation_integration.sql',
    'api-server/supabase/migrations/2026080501_paper_journal_authenticated_privileges.sql',
    'api-server/supabase/migrations/2026080502_member_permission_audit_authenticated_privileges.sql',
  ];
  const assertionPaths = [
    'api-server/supabase/bootstrap/staging-bootstrap-assert.sql',
    'api-server/supabase/bootstrap/staging-audit-privilege-assert.sql',
  ];
  const plain = await Promise.all(plainFiles.map(async (file) => `\n-- ${file}\n${await read(file)}`));
  const enveloped = await Promise.all(envelopedFiles.map(async (file) => (
    `\n-- ${file}\n${stripOuterTransaction(await read(file), file)}`
  )));
  const assertions = await Promise.all(assertionPaths.map(async (file) => `\n-- ${file}\n${await read(file)}`));
  const pass = [...plain, ...enveloped, ...assertions].join('\n');
  return [
    '\\set ON_ERROR_STOP on',
    'begin;',
    "select set_config('app.staging_bootstrap', 'true', true);",
    `select set_config('app.staging_project_ref', '${projectRef}', true);`,
    '-- First application and structural verification.',
    pass,
    '-- Second application proves idempotency before the single atomic commit.',
    pass,
    'commit;',
    '',
  ].join('\n');
}

async function writeArtifact(artifactDir, value) {
  await mkdir(artifactDir, { recursive: true });
  const destination = path.join(artifactDir, 'staging-bootstrap-verification.json');
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, destination);
}

function safeDetail(cause, redactions) {
  let output = cause instanceof Error ? cause.message : String(cause ?? 'unknown failure');
  for (const redaction of redactions) {
    if (redaction) output = output.split(redaction).join('[REDACTED]');
  }
  return output.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]').slice(0, 2_000);
}

const artifactDir = path.resolve(env.STAGING_ARTIFACT_DIR ?? path.join(root, 'staging-artifacts'));
let projectRef = '';
let database;
try {
  const supabaseUrl = required('STAGING_SUPABASE_URL');
  const databaseUrl = required('STAGING_DATABASE_URL');
  projectRef = projectRefFromUrl(supabaseUrl);
  database = parseDatabaseUrl(databaseUrl, projectRef);
  const sql = await buildAtomicSql(projectRef);
  const result = spawnSync('psql', [
    '--no-psqlrc',
    '--set=ON_ERROR_STOP=1',
    '--host', database.hostname,
    '--port', database.port,
    '--username', database.username,
    '--dbname', database.database,
  ], {
    cwd: root,
    input: sql,
    encoding: 'utf8',
    env: {
      ...env,
      PGPASSWORD: database.password,
      PGCONNECT_TIMEOUT: '20',
      PGSSLMODE: database.disposableCi ? 'disable' : 'require',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `psql exited with status ${result.status}`);
  }
  await writeArtifact(artifactDir, {
    status: 'passed',
    project_ref: projectRef,
    schema_version: SCHEMA_VERSION,
    atomic_transaction: true,
    idempotency_passes: 2,
    production_export_used: false,
    auth_users_copied: 0,
    profile_rows_copied: 0,
    storage_objects_copied: 0,
    credentials_recorded: false,
  });
  console.log('[staging-bootstrap] allowlisted schema applied and verified atomically');
} catch (cause) {
  const redactions = [
    env.STAGING_SUPABASE_URL,
    env.STAGING_DATABASE_URL,
    database?.username,
    database?.password,
  ];
  const detail = safeDetail(cause, redactions);
  await writeArtifact(artifactDir, {
    status: 'failed',
    project_ref: projectRef || 'unresolved',
    schema_version: SCHEMA_VERSION,
    atomic_transaction: true,
    credentials_recorded: false,
    detail,
  });
  console.error(`[staging-bootstrap] ${detail}`);
  process.exitCode = 1;
}
