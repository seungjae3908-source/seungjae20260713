import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ProductionDatabaseResolutionError,
  PRODUCTION_ENV_ALLOWLIST,
  collectProductionPostgresUris,
  resolveProductionPostgresConnection,
} from './production-postgres-connection-resolver.mjs';

const projectRef = 'bawcbkoyovbeajkrnduq';
const runtime = {
  SUPABASE_URL: `https://${projectRef}.supabase.co`,
};
const direct = `postgresql://postgres:example-password@db.${projectRef}.supabase.co:5432/postgres`;
const pooler = `postgresql://postgres.${projectRef}:example-password@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres`;

function expectClassification(fn, classification) {
  let error;
  try {
    fn();
  } catch (candidate) {
    error = candidate;
  }
  assert(error instanceof ProductionDatabaseResolutionError, `expected resolver error: ${classification}`);
  assert.equal(error.classification, classification);
  assert(!String(error.stack ?? error.message).includes('example-password'), 'resolver errors must not expose credentials');
}

assert.deepEqual(PRODUCTION_ENV_ALLOWLIST, [
  '/opt/stock-app/.env',
  '/opt/stock-app/.env.production',
  '/opt/stock-app/api-server/.env',
  '/opt/stock-app/api-server/.env.production',
]);

expectClassification(
  () => resolveProductionPostgresConnection(runtime, { envFiles: [], allowTestPaths: true }),
  'production_database_connection_missing',
);

const root = mkdtempSync(path.join(os.tmpdir(), 'production-postgres-resolver-'));
try {
  const envA = path.join(root, '.env');
  const envB = path.join(root, '.env.production');
  writeFileSync(envA, `# production\nDATABASE_URL="${direct}"\n`, { mode: 0o600 });

  const resolved = resolveProductionPostgresConnection(runtime, {
    envFiles: [envA],
    allowTestPaths: true,
  });
  assert.equal(resolved.connectionCount, 1);
  assert.equal(resolved.database.endpointType, 'direct');
  assert.equal(resolved.database.port, '5432');
  assert.equal(resolved.database.database, 'postgres');

  const duplicate = collectProductionPostgresUris({ ...runtime, DATABASE_URL: direct }, {
    envFiles: [envA],
    allowTestPaths: true,
  });
  assert.equal(duplicate.length, 1, 'identical runtime/env URLs must dedupe');

  writeFileSync(envB, `POSTGRES_URL='${pooler}'\n`, { mode: 0o600 });
  expectClassification(
    () => resolveProductionPostgresConnection(runtime, {
      envFiles: [envA, envB],
      allowTestPaths: true,
    }),
    'production_database_connection_ambiguous',
  );

  const insecure = path.join(root, 'insecure.env');
  writeFileSync(insecure, `DATABASE_URL=${direct}\n`, { mode: 0o600 });
  chmodSync(insecure, 0o666);
  expectClassification(
    () => resolveProductionPostgresConnection(runtime, {
      envFiles: [insecure],
      allowTestPaths: true,
    }),
    'production_database_env_file_unsafe',
  );

  const target = path.join(root, 'target.env');
  const link = path.join(root, 'link.env');
  writeFileSync(target, `DATABASE_URL=${direct}\n`, { mode: 0o600 });
  symlinkSync(target, link);
  expectClassification(
    () => resolveProductionPostgresConnection(runtime, {
      envFiles: [link],
      allowTestPaths: true,
    }),
    'production_database_env_file_unsafe',
  );

  const badPort = `postgresql://postgres:example-password@db.${projectRef}.supabase.co:6543/postgres`;
  expectClassification(
    () => resolveProductionPostgresConnection({ ...runtime, DATABASE_URL: badPort }, {
      envFiles: [],
      allowTestPaths: true,
    }),
    'production_database_project_mismatch',
  );

  expectClassification(
    () => resolveProductionPostgresConnection({
      SUPABASE_URL: 'https://wrongproject.supabase.co',
      DATABASE_URL: direct,
    }, { envFiles: [], allowTestPaths: true }),
    'production_project_mismatch',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write('Production PostgreSQL connection resolver contract: PASS\n');
