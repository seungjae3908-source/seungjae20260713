import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';

export type StagingMemberTier = 'pending' | 'associate' | 'regular' | 'admin';

export type StagingAccountCredential = {
  loginName: string;
  password: string;
};

export type StagingAccountCredentials = Record<StagingMemberTier, StagingAccountCredential>;

export type StagingAccountLifecycle = {
  accounts: StagingAccountCredentials;
  cleanup(): Promise<void>;
};

type ProvisionOptions = {
  supabaseUrl: string;
  supabaseSecretKey: string;
  artifactDir: string;
};

type CreatedAccount = {
  id: string;
  tier: StagingMemberTier;
  loginName: string;
  email: string;
  password: string;
};

const REPOSITORY = 'seungjae3908-source/seungjae20260713';
const VALIDATION_MARKER = 'seungjae-staging-release-validation';
const KNOWN_PRODUCTION_PROJECT_REFS = new Set([
  // Production project shown by the owner. Staging validation must fail closed
  // before creating any Auth or profile row when this project is configured.
  'bawcbkoyovbeajkrnduq',
]);
const TIERS: readonly StagingMemberTier[] = ['pending', 'associate', 'regular', 'admin'];
const PROFILE_FIELDS = [
  'id',
  'login_name',
  'display_name',
  'membership_level',
  'is_active',
  'status',
  'role',
].join(',');

function normalizeLoginName(value: string) {
  return value.trim().normalize('NFKC').toLowerCase();
}

function internalEmail(loginName: string) {
  const digest = createHash('sha256')
    .update(`seungjae-stock-account:${normalizeLoginName(loginName)}`, 'utf8')
    .digest('hex')
    .slice(0, 40);
  return `${digest}@accounts.seungjae-stock.com`;
}

function safeDetail(cause: unknown, redactions: string[]) {
  let detail = cause instanceof Error ? cause.message : String(cause ?? 'unknown error');
  for (const redaction of redactions) {
    if (redaction) detail = detail.split(redaction).join('[REDACTED]');
  }
  detail = detail.replace(/[^\s@]+@[^\s@]+/g, '[REDACTED_EMAIL]');
  return detail.slice(0, 1_000);
}

function projectRefFromUrl(raw: string) {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('STAGING_SUPABASE_URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('STAGING_SUPABASE_URL must use HTTPS');
  }
  const match = /^([a-z0-9]+)\.supabase\.co$/i.exec(parsed.hostname);
  if (!match) {
    throw new Error('STAGING_SUPABASE_URL must use the standard isolated <project-ref>.supabase.co host');
  }
  const projectRef = match[1].toLowerCase();
  if (KNOWN_PRODUCTION_PROJECT_REFS.has(projectRef)) {
    throw new Error('STAGING_SUPABASE_URL resolves to the known production Supabase project; ephemeral validation accounts were not created');
  }
  return projectRef;
}

async function writeArtifact(artifactDir: string, name: string, value: Record<string, unknown>) {
  await mkdir(artifactDir, { recursive: true });
  const destination = path.join(artifactDir, name);
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, destination);
}

function validationMetadata(user: User) {
  const metadata = user.user_metadata;
  return metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {};
}

function isValidationUser(user: User) {
  const metadata = validationMetadata(user);
  const loginName = typeof metadata.login_name === 'string' ? metadata.login_name : '';
  return metadata.staging_validation_marker === VALIDATION_MARKER
    && metadata.staging_validation_repository === REPOSITORY
    && /^sv-[pard]-[a-f0-9]{10}$/.test(loginName)
    && user.email === internalEmail(loginName);
}

async function listAllUsers(client: SupabaseClient) {
  const all: User[] = [];
  const perPage = 1_000;
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Supabase Admin listUsers failed: ${error.message}`);
    const users = data.users ?? [];
    all.push(...users);
    if (users.length < perPage) return all;
  }
  throw new Error('Supabase Admin listUsers exceeded the safety pagination limit');
}

async function deleteUsers(client: SupabaseClient, users: Array<Pick<User, 'id'>>) {
  const failures: string[] = [];
  for (const user of [...users].reverse()) {
    const { error } = await client.auth.admin.deleteUser(user.id, false);
    if (error) failures.push(user.id);
  }
  if (failures.length > 0) {
    throw new Error(`Supabase Admin deleteUser failed for ${failures.length} temporary account(s)`);
  }
}

async function removeStaleValidationUsers(client: SupabaseClient) {
  const users = (await listAllUsers(client)).filter(isValidationUser);
  await deleteUsers(client, users);
  return users.length;
}

async function waitForProfile(client: SupabaseClient, userId: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { data, error } = await client
      .from('profiles')
      .select(PROFILE_FIELDS)
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      throw new Error(`public.profiles lookup failed: ${error.message}`);
    }
    if (data) return data as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('public.profiles row was not created by the Auth user trigger within 15 seconds');
}

async function assignTier(
  client: SupabaseClient,
  account: CreatedAccount,
) {
  await waitForProfile(client, account.id);
  const approved = account.tier !== 'pending';
  const now = new Date().toISOString();
  const changes = {
    login_name: account.loginName,
    display_name: `Staging validation ${account.tier}`,
    membership_level: account.tier,
    is_active: true,
    role: account.tier === 'admin' ? 'admin' : 'user',
    status: approved ? 'approved' : 'pending',
    approved_at: approved ? now : null,
    approved_by: null,
    permissions_updated_at: now,
    updated_at: now,
  };
  const { data, error } = await client
    .from('profiles')
    .update(changes)
    .eq('id', account.id)
    .select(PROFILE_FIELDS)
    .single();
  if (error || !data) {
    throw new Error(`public.profiles tier assignment failed for ${account.tier}: ${error?.message ?? 'no row returned'}`);
  }
  const profile = data as Record<string, unknown>;
  const expectedRole = account.tier === 'admin' ? 'admin' : 'user';
  const expectedStatus = approved ? 'approved' : 'pending';
  if (
    profile.login_name !== account.loginName
    || profile.membership_level !== account.tier
    || profile.is_active !== true
    || profile.role !== expectedRole
    || profile.status !== expectedStatus
  ) {
    throw new Error(`public.profiles tier read-back mismatch for ${account.tier}`);
  }
}

function createRunToken() {
  const runId = process.env.GITHUB_RUN_ID?.trim() || `local-${Date.now()}`;
  const attempt = process.env.GITHUB_RUN_ATTEMPT?.trim() || '1';
  return createHash('sha256')
    .update(`${runId}:${attempt}:${randomBytes(16).toString('hex')}`, 'utf8')
    .digest('hex')
    .slice(0, 10);
}

function loginNameFor(tier: StagingMemberTier, token: string) {
  const code: Record<StagingMemberTier, string> = {
    pending: 'p',
    associate: 'a',
    regular: 'r',
    admin: 'd',
  };
  const loginName = `sv-${code[tier]}-${token}`;
  if (!/^[a-z0-9_.-]{2,20}$/.test(loginName)) {
    throw new Error(`generated staging login name is invalid for ${tier}`);
  }
  return loginName;
}

function passwordForRun() {
  return `Stg!${randomBytes(24).toString('base64url')}Aa1`;
}

async function verifyDeletedProfiles(client: SupabaseClient, ids: string[]) {
  if (ids.length === 0) return;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data, error } = await client.from('profiles').select('id').in('id', ids);
    if (error) throw new Error(`temporary profile cleanup verification failed: ${error.message}`);
    if ((data ?? []).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('temporary public.profiles rows remained after Auth user cleanup');
}

export async function provisionEphemeralStagingAccounts(
  options: ProvisionOptions,
): Promise<StagingAccountLifecycle> {
  const projectRef = projectRefFromUrl(options.supabaseUrl);
  const redactions = [options.supabaseUrl, options.supabaseSecretKey];
  const client = createClient(options.supabaseUrl, options.supabaseSecretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  const created: CreatedAccount[] = [];
  let cleaned = false;
  let staleRemoved = 0;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const ids = created.map((account) => account.id);
    try {
      await deleteUsers(client, created);
      await verifyDeletedProfiles(client, ids);
      await writeArtifact(options.artifactDir, 'staging-account-cleanup.json', {
        status: 'passed',
        requested: created.length,
        deleted: created.length,
        profiles_remaining: 0,
      });
    } catch (cause) {
      await writeArtifact(options.artifactDir, 'staging-account-cleanup.json', {
        status: 'failed',
        requested: created.length,
        deleted: 0,
        detail: safeDetail(cause, [...redactions, ...created.flatMap((account) => [
          account.loginName,
          account.email,
          account.password,
        ])]),
      });
      throw cause;
    }
  };

  try {
    staleRemoved = await removeStaleValidationUsers(client);
    const token = createRunToken();
    for (const tier of TIERS) {
      const loginName = loginNameFor(tier, token);
      const password = passwordForRun();
      const email = internalEmail(loginName);
      const { data, error } = await client.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          display_name: loginName,
          login_name: loginName,
          staging_validation_marker: VALIDATION_MARKER,
          staging_validation_repository: REPOSITORY,
          staging_validation_tier: tier,
          staging_validation_created_at: new Date().toISOString(),
        },
      });
      if (error || !data.user) {
        throw new Error(`Supabase Admin createUser failed for ${tier}: ${error?.message ?? 'no user returned'}`);
      }
      const account: CreatedAccount = {
        id: data.user.id,
        tier,
        loginName,
        email,
        password,
      };
      created.push(account);
      await assignTier(client, account);
    }

    const accounts = Object.fromEntries(created.map((account) => [
      account.tier,
      { loginName: account.loginName, password: account.password },
    ])) as StagingAccountCredentials;

    await writeArtifact(options.artifactDir, 'staging-account-provisioning.json', {
      status: 'passed',
      project_ref: projectRef,
      stale_accounts_removed: staleRemoved,
      created: created.length,
      tiers: TIERS,
      credentials_recorded: false,
    });

    return { accounts, cleanup };
  } catch (cause) {
    const provisioningDetail = safeDetail(cause, [...redactions, ...created.flatMap((account) => [
      account.loginName,
      account.email,
      account.password,
    ])]);
    await writeArtifact(options.artifactDir, 'staging-account-provisioning.json', {
      status: 'failed',
      project_ref: projectRef,
      stale_accounts_removed: staleRemoved,
      created_before_failure: created.length,
      credentials_recorded: false,
      detail: provisioningDetail,
    });
    try {
      await cleanup();
    } catch (cleanupCause) {
      throw new Error(`${provisioningDetail}; cleanup also failed: ${safeDetail(cleanupCause, redactions)}`);
    }
    throw new Error(provisioningDetail);
  }
}
