import assert from 'node:assert/strict';
import {
  classifyPsqlFailure,
  parseStagingDatabaseTarget,
  projectRefFromSupabaseUrl,
} from './verify-staging-postgres-auth.mjs';

const projectRef = 'abcdefghijklmnopqrst';
assert.equal(projectRefFromSupabaseUrl(`https://${projectRef}.supabase.co`), projectRef);
assert.throws(
  () => projectRefFromSupabaseUrl('https://bawcbkoyovbeajkrnduq.supabase.co'),
  /production_project_rejected/,
);

const pooler = parseStagingDatabaseTarget(
  `postgresql://postgres.${projectRef}:safe-placeholder@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`,
  projectRef,
);
assert.equal(pooler.endpointType, 'session_pooler');
assert.equal(pooler.projectMatch, true);
assert.equal(pooler.port, '5432');

const direct = parseStagingDatabaseTarget(
  `postgresql://postgres:safe-placeholder@db.${projectRef}.supabase.co:5432/postgres`,
  projectRef,
);
assert.equal(direct.endpointType, 'direct');
assert.equal(direct.projectMatch, true);

assert.throws(
  () => parseStagingDatabaseTarget(
    `postgresql://postgres.wrongproject:safe-placeholder@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`,
    projectRef,
  ),
  /project_mismatch|username_format/,
);

assert.equal(classifyPsqlFailure('FATAL: password authentication failed for user "postgres"'), 'password_rejected');
assert.equal(classifyPsqlFailure('FATAL: Tenant or user not found'), 'username_format');
assert.equal(classifyPsqlFailure('could not translate host name'), 'pooler_dns');
assert.equal(classifyPsqlFailure('connection timed out'), 'pooler_timeout');
assert.equal(classifyPsqlFailure('connection refused'), 'pooler_connection');
assert.equal(classifyPsqlFailure('SSL certificate verify failed'), 'pooler_tls');
assert.equal(classifyPsqlFailure('database "missing" does not exist'), 'database_name');
assert.equal(classifyPsqlFailure('unrecognized failure'), 'postgres_auth_unknown');

console.log('[staging-postgres-auth-test] parsing, production rejection, read-only endpoint selection, and non-sensitive failure classification verified');
