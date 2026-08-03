import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bootstrapDir = path.join(root, 'api-server/supabase/bootstrap');
const manifestPath = path.join(bootstrapDir, 'staging-bootstrap.sql');
const knownProductionRef = 'bawcbkoyovbeajkrnduq';
const expectedIncludes = [
  'staging-empty-project-guard.sql',
  'staging-bootstrap-helpers.sql',
  'staging-allowlist-base.sql',
  '../migrations/2026080201_journal_sync_analytics_phase7.sql',
  '../migrations/2026080202_release_candidate_permissions_phase8.sql',
  '../migrations/2026080203_phase8_paper_capability_rls.sql',
  '../migrations/2026080301_trade_automation_integration.sql',
  'staging-bootstrap-assert.sql',
];
const transactionalIncludes = new Set(expectedIncludes.slice(3, 7));
const fail = (message) => {
  throw new Error(`[staging-supabase-bootstrap] ${message}`);
};

function redact(raw, secrets) {
  let output = String(raw ?? '');
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join('[REDACTED]');
  }
  return output.slice(0, 4000);
}

function parseProjectRef(projectUrl) {
  const match = /^https:\/\/([a-z0-9]{10,40})\.supabase\.co\/?$/i.exec(projectUrl);
  if (!match) fail('STAGING_SUPABASE_URL must use the standard isolated <project-ref>.supabase.co host');
  const projectRef = match[1].toLowerCase();
  if (projectRef === knownProductionRef) fail('refusing to bootstrap the known production Supabase project');
  return projectRef;
}

function parseManifest(manifest) {
  const includes = manifest.split(/\r?\n/)
    .map((line) => /^\s*\\ir\s+(.+?)\s*$/.exec(line)?.[1])
    .filter(Boolean);
  if (includes.length !== expectedIncludes.length
    || includes.some((item, index) => item !== expectedIncludes[index])) {
    fail('staging bootstrap manifest contains an unexpected or reordered include');
  }
  if (!manifest.includes('\\set ON_ERROR_STOP on')) {
    fail('staging bootstrap manifest must stop on the first SQL error');
  }
  return includes;
}

function stripOuterTransaction(sql, relativePath) {
  const lines = sql.split(/\r?\n/);
  const codeIndexes = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line && !line.startsWith('--'));
  const first = codeIndexes.at(0);
  const last = codeIndexes.at(-1);
  if (!first || !/^begin\s*;$/i.test(first.line) || !last || !/^commit\s*;$/i.test(last.line)) {
    fail(`${relativePath} must have one removable outer BEGIN/COMMIT envelope`);
  }
  lines[first.index] = `-- outer BEGIN removed by staging bootstrap runner: ${relativePath}`;
  lines[last.index] = `-- outer COMMIT removed by staging bootstrap runner: ${relativePath}`;
  return lines.join('\n');
}

function quoteSqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function connection(projectRef) {
  const databaseUrl = String(process.env.STAGING_DATABASE_URL ?? '').trim();
  const ciMode = process.env.STAGING_BOOTSTRAP_CI === 'true';
  if (databaseUrl) {
    if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) fail('STAGING_DATABASE_URL must be a PostgreSQL connection URL');
    const normalized = databaseUrl.toLowerCase();
    if (normalized.includes(knownProductionRef)) fail('refusing a database URL for the known production Supabase project');
    if (!normalized.includes(projectRef)) fail('STAGING_DATABASE_URL does not match STAGING_SUPABASE_URL project ref');

    let parsed;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      fail('STAGING_DATABASE_URL is not a valid PostgreSQL connection URL');
    }
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    if (!parsed.hostname || !parsed.username || !database) fail('STAGING_DATABASE_URL is missing host, user, or database');
    return {
      args: [
        '--host', parsed.hostname,
        '--port', parsed.port || '5432',
        '--username', decodeURIComponent(parsed.username),
        '--dbname', database,
      ],
      env: {
        PGPASSWORD: decodeURIComponent(parsed.password),
        PGSSLMODE: parsed.searchParams.get('sslmode') || 'require',
      },
      secrets: [databaseUrl, parsed.password, decodeURIComponent(parsed.password)],
    };
  }

  if (!ciMode) fail('STAGING_DATABASE_URL is required for one-time remote staging bootstrap');
  for (const name of ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD']) {
    if (!String(process.env[name] ?? '').trim()) fail(`${name} is required in bootstrap CI mode`);
  }
  return {
    args: [
      '--host', process.env.PGHOST,
      '--port', process.env.PGPORT,
      '--username', process.env.PGUSER,
      '--dbname', process.env.PGDATABASE,
    ],
    env: {},
    secrets: [process.env.PGPASSWORD],
  };
}

async function buildTransactionalScript(projectRef) {
  const manifest = await readFile(manifestPath, 'utf8');
  const includes = parseManifest(manifest);
  const parts = new Map();
  for (const relativePath of includes) {
    const resolved = path.resolve(bootstrapDir, relativePath);
    const allowedRoot = path.resolve(root, 'api-server/supabase');
    if (!(resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${path.sep}`))) {
      fail(`bootstrap include escapes the allowlisted Supabase directory: ${relativePath}`);
    }
    let sql = await readFile(resolved, 'utf8');
    if (transactionalIncludes.has(relativePath)) sql = stripOuterTransaction(sql, relativePath);
    parts.set(relativePath, sql);
  }

  const assertionPath = expectedIncludes.at(-1);
  const repeatedPaths = expectedIncludes.slice(0, -1);
  const output = [
    '\\set ON_ERROR_STOP on',
    'begin;',
    `set local app.staging_project_ref = ${quoteSqlLiteral(projectRef)};`,
    "set local app.staging_bootstrap = 'true';",
  ];
  for (let pass = 1; pass <= 2; pass += 1) {
    output.push(`-- staging bootstrap idempotency pass ${pass}`);
    for (const relativePath of repeatedPaths) {
      output.push(`-- begin allowlisted file: ${relativePath}`, parts.get(relativePath), `-- end allowlisted file: ${relativePath}`);
    }
  }
  output.push(
    '-- final staging bootstrap contract assertion',
    parts.get(assertionPath),
    'commit;',
    '',
  );
  return output.join('\n');
}

async function main() {
  const projectUrl = String(process.env.STAGING_SUPABASE_URL ?? '').trim();
  const projectRef = parseProjectRef(projectUrl);
  const target = connection(projectRef);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'seungjae-staging-bootstrap-'));
  const scriptPath = path.join(tempDir, 'bootstrap.sql');
  try {
    await writeFile(scriptPath, await buildTransactionalScript(projectRef), { encoding: 'utf8', mode: 0o600 });
    await chmod(scriptPath, 0o600);
    const result = spawnSync('psql', [
      ...target.args,
      '--no-psqlrc',
      '--set=ON_ERROR_STOP=1',
      '--file', scriptPath,
    ], {
      cwd: root,
      env: {
        ...process.env,
        ...target.env,
        PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT ?? '15',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) fail(result.error.code === 'ENOENT' ? 'psql is required for staging schema bootstrap' : result.error.message);
    if (result.status !== 0) {
      fail(`schema bootstrap failed: ${redact(result.stderr || result.stdout || 'bootstrap failed', [projectUrl, ...target.secrets])}`);
    }
    console.log('[staging-supabase-bootstrap] isolated staging schema applied twice and committed after final verification');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : '[staging-supabase-bootstrap] unknown failure');
  process.exit(1);
});
