import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SAFE_ERROR_CODES = new Set([
  'bad_jwt',
  'email_not_confirmed',
  'invalid_credentials',
  'invalid_grant',
  'over_request_rate_limit',
  'request_timeout',
  'user_banned',
]);

const normalizedCode = (payload) => {
  if (!payload || typeof payload !== 'object') return '';
  for (const field of ['error_code', 'code', 'error']) {
    const code = String(payload[field] ?? '').trim().toLowerCase();
    if (SAFE_ERROR_CODES.has(code)) return code;
  }
  return '';
};

export function classifyStagingAdminAuthFailure(status, payload = null) {
  const code = normalizedCode(payload);
  const message = String(payload?.message ?? payload?.error_description ?? '').trim().toLowerCase();

  if (code === 'email_not_confirmed' || message === 'email not confirmed') {
    return 'email_confirmation_required';
  }
  if (
    code === 'invalid_credentials'
    || code === 'invalid_grant'
    || message === 'invalid login credentials'
  ) {
    // Supabase deliberately does not distinguish a wrong email, wrong password,
    // missing password credential, or a non-password identity in this response.
    return 'invalid_credentials';
  }
  if (code === 'user_banned') return 'user_banned';
  if (status === 429 || code === 'over_request_rate_limit') return 'rate_limited';
  if (code === 'request_timeout') return 'auth_service_timeout';
  if (status === 401 || status === 403 || code === 'bad_jwt') return 'anon_key_or_auth_policy_rejected';
  if (status === 400) return 'password_auth_contract_rejected';
  return 'unexpected_auth_rejection';
}

const required = (name, env) => {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required for staging admin authentication preflight`);
  return value;
};

const readFailurePayload = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

export async function resolveStagingAdminPublisherBinding({
  supabaseUrl,
  anonKey,
  email,
  password,
  fetchImpl = fetch,
}) {
  const endpoint = `${String(supabaseUrl).replace(/\/+$/u, '')}/auth/v1/token?grant_type=password`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const classification = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? 'auth_service_timeout'
      : 'auth_network_failure';
    throw new Error(`Staging admin authentication preflight failed: ${classification}; snapshot binding not configured`);
  }

  if (!response.ok) {
    const payload = await readFailurePayload(response);
    const classification = classifyStagingAdminAuthFailure(response.status, payload);
    throw new Error(
      `Staging admin authentication preflight failed: ${classification} (HTTP ${response.status}); snapshot binding not configured`,
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('Staging admin authentication preflight failed: invalid_success_payload; snapshot binding not configured');
  }
  const userId = String(body?.user?.id ?? '').trim();
  const accessToken = String(body?.access_token ?? '').trim();
  if (!userId || !accessToken) {
    throw new Error('Staging admin authentication preflight failed: incomplete_session; snapshot binding not configured');
  }
  return {
    accessToken,
    publisherDigest: createHash('sha256').update(userId, 'utf8').digest('hex'),
    userId,
  };
}

export async function runStagingAdminAuthPreflight({
  env = process.env,
  fetchImpl = fetch,
  writePublisherDigest = false,
} = {}) {
  const result = await resolveStagingAdminPublisherBinding({
    supabaseUrl: required('SUPABASE_URL', env),
    anonKey: required('SUPABASE_ANON_KEY', env),
    email: required('ADMIN_EMAIL', env),
    password: required('ADMIN_PASSWORD', env),
    fetchImpl,
  });

  process.stdout.write(`::add-mask::${result.userId}\n`);
  process.stdout.write(`::add-mask::${result.accessToken}\n`);
  process.stdout.write(`::add-mask::${result.publisherDigest}\n`);
  if (writePublisherDigest) {
    const outputPath = required('GITHUB_OUTPUT', env);
    appendFileSync(outputPath, `publisher_sha256=${result.publisherDigest}\n`);
  }
  process.stdout.write('staging admin password authentication verified without recording account identity\n');
  return result;
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const writePublisherDigest = process.argv.includes('--write-publisher-digest');
  runStagingAdminAuthPreflight({ writePublisherDigest }).catch((error) => {
    console.error(error instanceof Error ? error.message : 'staging admin authentication preflight failed');
    process.exit(1);
  });
}
