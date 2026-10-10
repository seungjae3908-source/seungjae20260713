import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/staging-admin-profile-repair.yml', 'utf8');
const repair = readFileSync('api-server/scripts/repair-staging-admin-profile.mjs', 'utf8');
const requireText = (source, marker) => {
  if (!source.includes(marker)) throw new Error('STAGING_ADMIN_PROFILE_REPAIR_CONTRACT_MISSING:' + marker);
};
const forbid = (source, marker) => {
  if (source.includes(marker)) throw new Error('STAGING_ADMIN_PROFILE_REPAIR_CONTRACT_FORBIDDEN:' + marker);
};

for (const marker of [
  'issue_comment:', "github.event.issue.number == 1555",
  "github.event.issue.title == 'Staging Readiness Control — Rollover 2026-10-02'",
  "github.event.comment.user.login == github.repository_owner",
  "github.event.comment.author_association == 'OWNER'",
  '/repair-staging-admin-profile ', 'environment: staging',
  'REPAIR_APPROVED: STAGING_ADMIN_PROFILE_REPAIR_V1',
  'EXPECTED_STAGING_PROJECT_REF: petlfbztqguuzkasfpug',
  'KNOWN_PRODUCTION_PROJECT_REF: bawcbkoyovbeajkrnduq',
  'application-ci/verified', 'browser-ui/verified', 'database-rls/verified',
  'security-integration/verified', 'ai-privacy/verified', 'futures-public-network-smoke/verified',
  'Required statuses do not share one exact Application CI provenance run.',
  'node api-server/scripts/repair-staging-admin-profile.mjs',
  'node api-server/scripts/staging-trading-core-admin-profile.mjs',
]) requireText(workflow, marker);

for (const marker of [
  "const APPROVAL_TOKEN = 'STAGING_ADMIN_PROFILE_REPAIR_V1'",
  "const EXPECTED_STAGING_REF = 'petlfbztqguuzkasfpug'",
  "const KNOWN_PRODUCTION_REF = 'bawcbkoyovbeajkrnduq'",
  'signInWithPassword', ".from('profiles')", ".eq('id', userId)",
  ".eq('status', 'pending')", ".eq('is_active', false)",
  ".eq('membership_level', 'pending')", ".eq('role', 'user')",
  "status: 'approved'", 'is_active: true', "membership_level: 'admin'", "role: 'admin'",
  'STAGING_ADMIN_PROFILE_REPAIR_UNSAFE_CURRENT_STATE',
  'STAGING_ADMIN_PROFILE_REPAIR_PRODUCTION_FORBIDDEN',
  'STAGING_ADMIN_PROFILE_REPAIR_READBACK_MISMATCH',
]) requireText(repair, marker);

for (const marker of [
  'environment: production', 'secrets.PROD_', 'secrets.PRODUCTION_', 'STAGING_DATABASE_URL',
  'ssh ', 'pm2 ', '/srv/', 'production-deploy',
]) forbid(workflow.toLowerCase(), marker.toLowerCase());
for (const marker of [
  'auth.admin.createuser', 'auth.admin.updateuserbyid', 'auth.admin.deleteuser',
  '.insert(', '.upsert(', '.delete(', '.rpc(', 'execute_sql', 'postgresql://',
]) forbid(repair.toLowerCase(), marker.toLowerCase());

console.log('STAGING_ADMIN_PROFILE_REPAIR_CONTRACT_PASS');
