import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bootstrapFile = path.join(root, 'api-server/supabase/bootstrap/staging-bootstrap.sql');
const knownProductionRef = 'bawcbkoyovbeajkrnduq';
const fail = (message) => {
  console.error(`[staging-supabase-bootstrap] ${message}`);
  process.exit(1);
};

const projectUrl = String(process.env.STAGING_SUPABASE_URL ?? '').trim();
const match = /^https:\/\/([a-z0-9]{10,40})\.supabase\.co\/?$/i.exec(projectUrl);
if (!match) fail('STAGING_SUPABASE_URL must use the standard isolated <project-ref>.supabase.co host');
const projectRef = match[1].toLowerCase();
if (projectRef === knownProductionRef) fail('refusing to bootstrap the known production Supabase project');

const databaseUrl = String(process.env.STAGING_DATABASE_URL ?? '').trim();
const ciMode = process.env.STAGING_BOOTSTRAP_CI === 'true';
let args;
if (databaseUrl) {
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) fail('STAGING_DATABASE_URL must be a PostgreSQL connection URL');
  const normalized = databaseUrl.toLowerCase();
  if (normalized.includes(knownProductionRef)) fail('refusing a database URL for the known production Supabase project');
  if (!normalized.includes(projectRef)) fail('STAGING_DATABASE_URL does not match STAGING_SUPABASE_URL project ref');
  args = [databaseUrl, '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--file', bootstrapFile];
} else {
  if (!ciMode) fail('STAGING_DATABASE_URL is required for one-time remote staging bootstrap');
  for (const name of ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD']) {
    if (!String(process.env[name] ?? '').trim()) fail(`${name} is required in bootstrap CI mode`);
  }
  args = [
    '--host', process.env.PGHOST,
    '--port', process.env.PGPORT,
    '--username', process.env.PGUSER,
    '--dbname', process.env.PGDATABASE,
    '--no-psqlrc',
    '--set=ON_ERROR_STOP=1',
    '--file', bootstrapFile,
  ];
}

const result = spawnSync('psql', args, {
  cwd: root,
  env: { ...process.env, PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT ?? '15' },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  maxBuffer: 16 * 1024 * 1024,
});
if (result.error) fail(result.error.code === 'ENOENT' ? 'psql is required for staging schema bootstrap' : result.error.message);
if (result.status !== 0) {
  const detail = String(result.stderr || result.stdout || 'bootstrap failed')
    .replaceAll(databaseUrl, '[REDACTED]')
    .slice(0, 4000);
  fail(`schema bootstrap failed: ${detail}`);
}
console.log('[staging-supabase-bootstrap] isolated empty staging schema bootstrap verified');
