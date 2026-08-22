import { createClient } from '@supabase/supabase-js';

const APPROVAL_TOKEN = 'STAGING_ADMIN_AUTH_REPAIR_V1';
const PUBLISHER_MARKER = 'staging_publisher_admin_v1';

function fail(message) {
  throw new Error(`[staging-admin-auth-repair] ${message}`);
}

function required(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function safeStatus(error) {
  const code = String(error?.code ?? 'unknown').replace(/[^a-z0-9_-]/gi, '').slice(0, 64) || 'unknown';
  const status = Number.isFinite(Number(error?.status)) ? Number(error.status) : 0;
  return { code, status };
}

function projectRefFromUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail('SUPABASE_URL must be a valid URL');
  }
  if (parsed.protocol !== 'https:') fail('SUPABASE_URL must use HTTPS');
  const match = /^([a-z0-9]+)\.supabase\.co$/iu.exec(parsed.hostname);
  if (!match) fail('SUPABASE_URL must use a standard Supabase project host');
  return match[1].toLowerCase();
}

function client(url, key) {
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

async function verifyPasswordLogin(publicClient, email, password) {
  const { data, error } = await publicClient.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, error };
  if (!data?.user?.id) fail('password login returned no authenticated user identity');
  return { ok: true, userId: data.user.id };
}

async function findExactUser(adminClient, targetEmail) {
  const normalized = targetEmail.toLowerCase();
  let found = null;
  const perPage = 200;

  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage });
    if (error) {
      const { code, status } = safeStatus(error);
      fail(`admin user lookup failed (${code}; HTTP ${status || 'unknown'})`);
    }

    const users = Array.isArray(data?.users) ? data.users : [];
    for (const user of users) {
      if (String(user?.email ?? '').trim().toLowerCase() !== normalized) continue;
      if (found && found.id !== user.id) fail('multiple Auth users matched the configured admin identity');
      found = user;
    }

    if (users.length < perPage) break;
    if (page === 50) fail('admin user lookup exceeded bounded pagination');
  }

  return found;
}

async function main() {
  if (required('REPAIR_APPROVED') !== APPROVAL_TOKEN) fail('explicit repair approval token is missing');

  const supabaseUrl = required('SUPABASE_URL');
  const anonKey = required('SUPABASE_ANON_KEY');
  const secretKey = required('SUPABASE_SECRET_KEY');
  const email = required('ADMIN_EMAIL');
  const password = required('ADMIN_PASSWORD');
  const expectedStagingRef = required('EXPECTED_STAGING_PROJECT_REF').toLowerCase();
  const knownProductionRef = required('KNOWN_PRODUCTION_PROJECT_REF').toLowerCase();

  const actualRef = projectRefFromUrl(supabaseUrl);
  if (actualRef === knownProductionRef) fail('refusing to touch the known Production Supabase project');
  if (actualRef !== expectedStagingRef) fail('configured Supabase project is not the approved isolated Staging project');
  if (anonKey === secretKey) fail('publishable and server keys must be distinct');
  if (!email.includes('@') || /\s/u.test(email)) fail('configured admin email is invalid');
  if (password.length < 8) fail('configured admin password is too short for bounded repair');

  const publicClient = client(supabaseUrl, anonKey);
  const initialLogin = await verifyPasswordLogin(publicClient, email, password);
  if (initialLogin.ok) {
    console.log('[staging-admin-auth-repair] already_authenticated; auth_user_mutation=false');
    return;
  }

  const initialFailure = safeStatus(initialLogin.error);
  if (initialFailure.code !== 'invalid_credentials' || initialFailure.status !== 400) {
    fail(`refusing mutation after unexpected auth classification (${initialFailure.code}; HTTP ${initialFailure.status || 'unknown'})`);
  }

  const adminClient = client(supabaseUrl, secretKey);
  const existingUser = await findExactUser(adminClient, email);
  let repairedUserId;
  let action;

  if (!existingUser) {
    const { data, error } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: {
        staging_publisher_identity: PUBLISHER_MARKER,
      },
    });
    if (error || !data?.user?.id) {
      const { code, status } = safeStatus(error);
      fail(`Auth user creation failed (${code}; HTTP ${status || 'unknown'})`);
    }
    repairedUserId = data.user.id;
    action = 'created';
  } else {
    const marker = String(existingUser?.app_metadata?.staging_publisher_identity ?? '');
    if (marker !== PUBLISHER_MARKER) {
      fail('configured admin email already belongs to an unmarked Auth user; refusing password reset');
    }
    const { data, error } = await adminClient.auth.admin.updateUserById(existingUser.id, {
      password,
      email_confirm: true,
      app_metadata: {
        ...(existingUser.app_metadata ?? {}),
        staging_publisher_identity: PUBLISHER_MARKER,
      },
    });
    if (error || !data?.user?.id) {
      const { code, status } = safeStatus(error);
      fail(`Auth user update failed (${code}; HTTP ${status || 'unknown'})`);
    }
    repairedUserId = data.user.id;
    action = 'updated';
  }

  const verified = await verifyPasswordLogin(publicClient, email, password);
  if (!verified.ok) {
    const { code, status } = safeStatus(verified.error);
    fail(`post-repair password authentication failed (${code}; HTTP ${status || 'unknown'})`);
  }
  if (verified.userId !== repairedUserId) fail('post-repair identity mismatch');

  console.log(`[staging-admin-auth-repair] ${action}; password_authentication=verified; production_touched=false; direct_profile_or_db_mutation=false`);
}

main().catch((error) => {
  const message = String(error?.message ?? 'unknown failure')
    .replace(String(process.env.ADMIN_EMAIL ?? ''), '[REDACTED_EMAIL]')
    .replace(String(process.env.ADMIN_PASSWORD ?? ''), '[REDACTED_PASSWORD]')
    .replace(String(process.env.SUPABASE_ANON_KEY ?? ''), '[REDACTED_ANON_KEY]')
    .replace(String(process.env.SUPABASE_SECRET_KEY ?? ''), '[REDACTED_SECRET_KEY]');
  console.error(message);
  process.exit(1);
});
