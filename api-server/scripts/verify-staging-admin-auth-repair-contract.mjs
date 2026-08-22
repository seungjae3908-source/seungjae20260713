import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const workflowPath = path.join(root, '.github/workflows/staging-admin-auth-repair.yml');
const repairPath = path.join(root, 'api-server/scripts/repair-staging-admin-auth.mjs');

const workflow = fs.readFileSync(workflowPath, 'utf8');
const repair = fs.readFileSync(repairPath, 'utf8');

function requireText(source, text, label) {
  if (!source.includes(text)) {
    throw new Error(`[staging-admin-auth-repair-contract] missing ${label}: ${text}`);
  }
}

function forbidText(source, text, label) {
  if (source.includes(text)) {
    throw new Error(`[staging-admin-auth-repair-contract] forbidden ${label}: ${text}`);
  }
}

const workflowRequirements = [
  ['issue_comment:', 'issue-comment command trigger'],
  ["github.event.issue.number == 23", 'Release Control issue gate'],
  ["github.event.comment.user.login == github.repository_owner", 'repository-owner gate'],
  ['/repair-staging-admin-auth ', 'explicit repair command'],
  ['environment: staging', 'isolated staging Environment'],
  ['EXPECTED_STAGING_PROJECT_REF: petlfbztqguuzkasfpug', 'exact isolated Staging project ref'],
  ['KNOWN_PRODUCTION_PROJECT_REF: bawcbkoyovbeajkrnduq', 'known Production deny ref'],
  ['REPAIR_APPROVED: STAGING_ADMIN_AUTH_REPAIR_V1', 'bounded approval token'],
  ['application-ci/verified', 'Application CI gate'],
  ['browser-ui/verified', 'Browser CI gate'],
  ['database-rls/verified', 'DB/RLS CI gate'],
  ['security-integration/verified', 'Security CI gate'],
  ['ai-privacy/verified', 'AI privacy CI gate'],
  ['futures-public-network-smoke/verified', 'public network CI gate'],
  ['persist-credentials: false', 'credential persistence disabled'],
];

for (const [text, label] of workflowRequirements) requireText(workflow, text, label);

const scriptRequirements = [
  ["const APPROVAL_TOKEN = 'STAGING_ADMIN_AUTH_REPAIR_V1'", 'approval token'],
  ["const PUBLISHER_MARKER = 'staging_publisher_admin_v1'", 'persistent publisher marker'],
  ['signInWithPassword', 'password verification'],
  ['auth.admin.listUsers', 'bounded exact-user lookup'],
  ['auth.admin.createUser', 'missing-user repair'],
  ['auth.admin.updateUserById', 'marked-user password repair'],
  ['email_confirm: true', 'confirmed password identity'],
  ['refusing to touch the known Production Supabase project', 'Production hard stop'],
  ['configured Supabase project is not the approved isolated Staging project', 'Staging project identity gate'],
  ['configured admin email already belongs to an unmarked Auth user', 'unmarked-user reset stop'],
  ['post-repair identity mismatch', 'post-repair identity verification'],
];

for (const [text, label] of scriptRequirements) requireText(repair, text, label);

for (const forbidden of [
  'STAGING_DATABASE_URL',
  'DATABASE_URL',
  'ssh ',
  'pm2 ',
  '/srv/',
  'production-deploy',
  'schedule activation',
]) {
  forbidText(workflow.toLowerCase(), forbidden.toLowerCase(), 'runtime mutation surface');
}

for (const forbidden of [
  ".from('profiles')",
  '.from("profiles")',
  '.rpc(',
  'execute_sql',
  'postgresql://',
  'ssh ',
  'pm2 ',
  '/srv/',
]) {
  forbidText(repair.toLowerCase(), forbidden.toLowerCase(), 'DB/server mutation surface');
}

if (/console\.(?:log|error)\([^)]*(?:ADMIN_EMAIL|ADMIN_PASSWORD|SUPABASE_SECRET_KEY|SUPABASE_ANON_KEY)/u.test(repair)) {
  throw new Error('[staging-admin-auth-repair-contract] secret-bearing environment names must not be logged');
}

console.log('[staging-admin-auth-repair-contract] PASS');
