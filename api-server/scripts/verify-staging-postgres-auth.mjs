import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const KNOWN_PRODUCTION_PROJECT_REFS = new Set(['bawcbkoyovbeajkrnduq']);

function required(name, env = process.env) {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function projectRefFromSupabaseUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('supabase_url_invalid');
  }
  if (parsed.protocol !== 'https:') throw new Error('supabase_url_invalid');
  const match = /^([a-z0-9]+)\.supabase\.co$/i.exec(parsed.hostname);
  if (!match) throw new Error('supabase_url_invalid');
  const projectRef = match[1].toLowerCase();
  if (KNOWN_PRODUCTION_PROJECT_REFS.has(projectRef)) throw new Error('production_project_rejected');
  return projectRef;
}

export function parseStagingDatabaseTarget(raw, projectRef) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('database_url_invalid');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('database_url_invalid');

  const hostname = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username);
  const usernameLower = username.toLowerCase();
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'postgres';
  const port = parsed.port || '5432';
  const directHost = hostname === `db.${projectRef}.supabase.co`;
  const poolerHost = /(^|\.)pooler\.supabase\.com$/i.test(hostname);
  const poolerUserMatches = usernameLower === `postgres.${projectRef}`;

  if (KNOWN_PRODUCTION_PROJECT_REFS.has(projectRef)
    || [...KNOWN_PRODUCTION_PROJECT_REFS].some((ref) => hostname.includes(ref) || usernameLower.includes(ref))) {
    throw new Error('production_project_rejected');
  }
  if (!directHost && !(poolerHost && poolerUserMatches)) throw new Error('project_mismatch');
  if (poolerHost && !poolerUserMatches) throw new Error('username_format');
  if (!parsed.password) throw new Error('password_missing');

  return {
    hostname,
    port,
    username,
    password: decodeURIComponent(parsed.password),
    database,
    endpointType: poolerHost ? 'session_pooler' : 'direct',
    projectMatch: true,
  };
}

export function classifyPsqlFailure(raw) {
  const value = String(raw ?? '');
  if (/password authentication failed/i.test(value)) return 'password_rejected';
  if (/tenant or user not found|role .* does not exist|user .* does not exist|invalid user/i.test(value)) return 'username_format';
  if (/could not translate host name|name or service not known|getaddrinfo|temporary failure in name resolution/i.test(value)) return 'pooler_dns';
  if (/connection timed out|timeout expired|operation timed out/i.test(value)) return 'pooler_timeout';
  if (/connection refused|no route to host|network is unreachable|server closed the connection unexpectedly/i.test(value)) return 'pooler_connection';
  if (/ssl|tls|certificate/i.test(value)) return 'pooler_tls';
  if (/database .* does not exist/i.test(value)) return 'database_name';
  return 'postgres_auth_unknown';
}

function safeMessage(classification) {
  const messages = {
    username_format: 'Session Pooler username format or database role was rejected.',
    password_rejected: 'PostgreSQL rejected the supplied database password.',
    pooler_dns: 'Session Pooler hostname could not be resolved.',
    pooler_timeout: 'Session Pooler connection timed out.',
    pooler_connection: 'Session Pooler network connection could not be established.',
    pooler_tls: 'Session Pooler TLS negotiation failed.',
    database_name: 'The requested PostgreSQL database name was rejected.',
    project_mismatch: 'Database URL does not match the staging Supabase project.',
    production_project_rejected: 'Known production Supabase project was rejected.',
    database_url_invalid: 'STAGING_DATABASE_URL is not a valid PostgreSQL URL.',
    supabase_url_invalid: 'STAGING_SUPABASE_URL is not a valid Supabase project URL.',
    password_missing: 'STAGING_DATABASE_URL does not contain a database password.',
    postgres_auth_unknown: 'PostgreSQL authentication failed for an unclassified non-sensitive reason.',
  };
  return messages[classification] ?? messages.postgres_auth_unknown;
}

async function writeArtifact(artifactDir, value) {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    path.join(artifactDir, 'staging-postgres-auth-verification.json'),
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

export async function runAuthProbe(env = process.env) {
  const artifactDir = path.resolve(env.STAGING_ARTIFACT_DIR ?? path.join(process.cwd(), 'staging-auth-artifacts'));
  let endpointType = 'unresolved';
  let port = 'unresolved';
  let projectMatch = false;

  try {
    const projectRef = projectRefFromSupabaseUrl(required('STAGING_SUPABASE_URL', env));
    const target = parseStagingDatabaseTarget(required('STAGING_DATABASE_URL', env), projectRef);
    endpointType = target.endpointType;
    port = target.port;
    projectMatch = target.projectMatch;

    const sql = [
      '\\set ON_ERROR_STOP on',
      'begin read only;',
      "set local statement_timeout = '10s';",
      'select 1;',
      'rollback;',
      '',
    ].join('\n');

    const result = spawnSync('psql', [
      '--no-psqlrc',
      '--quiet',
      '--tuples-only',
      '--no-align',
      '--set=ON_ERROR_STOP=1',
      '--host', target.hostname,
      '--port', target.port,
      '--username', target.username,
      '--dbname', target.database,
    ], {
      input: sql,
      encoding: 'utf8',
      env: {
        ...env,
        PGPASSWORD: target.password,
        PGCONNECT_TIMEOUT: '15',
        PGSSLMODE: 'require',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });

    if (result.error) throw result.error;
    if (result.status !== 0) {
      const classification = classifyPsqlFailure(result.stderr || result.stdout);
      await writeArtifact(artifactDir, {
        status: 'failed',
        classification,
        detail: safeMessage(classification),
        project_match: projectMatch,
        endpoint_type: endpointType,
        port,
        read_only_probe: true,
        database_changed: false,
        credentials_recorded: false,
      });
      console.error(`[staging-postgres-auth] ${classification}: ${safeMessage(classification)}`);
      return 1;
    }

    await writeArtifact(artifactDir, {
      status: 'passed',
      classification: 'authenticated',
      detail: 'PostgreSQL authentication succeeded with a rolled-back read-only transaction.',
      project_match: projectMatch,
      endpoint_type: endpointType,
      port,
      read_only_probe: true,
      database_changed: false,
      credentials_recorded: false,
    });
    console.log('[staging-postgres-auth] authentication succeeded; read-only transaction rolled back');
    return 0;
  } catch (cause) {
    const classification = cause instanceof Error && [
      'username_format',
      'project_mismatch',
      'production_project_rejected',
      'database_url_invalid',
      'supabase_url_invalid',
      'password_missing',
    ].includes(cause.message)
      ? cause.message
      : classifyPsqlFailure(cause instanceof Error ? cause.message : String(cause));

    await writeArtifact(artifactDir, {
      status: 'failed',
      classification,
      detail: safeMessage(classification),
      project_match: projectMatch,
      endpoint_type: endpointType,
      port,
      read_only_probe: true,
      database_changed: false,
      credentials_recorded: false,
    });
    console.error(`[staging-postgres-auth] ${classification}: ${safeMessage(classification)}`);
    return 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  process.exitCode = await runAuthProbe();
}
