import process from 'node:process';

const knownProductionRef = 'bawcbkoyovbeajkrnduq';
const fail = (message) => {
  console.error(`[staging-supabase-schema] ${message}`);
  process.exit(1);
};
const value = (name) => String(process.env[name] ?? '').trim();
const projectUrl = value('STAGING_SUPABASE_URL');
const secretKey = value('STAGING_SUPABASE_SECRET_KEY');
const anonKey = value('STAGING_SUPABASE_ANON_KEY');

const match = /^https:\/\/([a-z0-9]{10,40})\.supabase\.co\/?$/i.exec(projectUrl);
if (!match) fail('STAGING_SUPABASE_URL must use the standard isolated <project-ref>.supabase.co host');
if (match[1].toLowerCase() === knownProductionRef) fail('refusing to inspect the known production Supabase project');
if (secretKey.length < 20) fail('STAGING_SUPABASE_SECRET_KEY is missing or implausible');
if (anonKey.length < 20) fail('STAGING_SUPABASE_ANON_KEY is missing or implausible');
if (secretKey === anonKey) fail('staging publishable and secret keys must be different');

const headers = {
  apikey: secretKey,
  Authorization: `Bearer ${secretKey}`,
  Accept: 'application/json',
  'User-Agent': 'seungjae-staging-schema-verifier',
};

async function request(path) {
  let response;
  try {
    response = await fetch(`${projectUrl.replace(/\/$/, '')}${path}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    fail(`Supabase schema request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  if (!response.ok) {
    let code = '';
    try {
      const payload = await response.json();
      code = typeof payload?.code === 'string' ? ` (${payload.code})` : '';
    } catch {
      // Keep the error credential-free and bounded.
    }
    fail(`Supabase schema contract returned HTTP ${response.status}${code}`);
  }
  return response.json();
}

await request('/rest/v1/profiles?select=id,login_name,display_name,role,status,membership_level,is_active,permissions_updated_at,updated_at&limit=0');
await request('/rest/v1/paper_journal_entries?select=user_id,id,version&limit=0');
await request('/rest/v1/trade_order_plans?select=user_id,id,idempotency_key,state&limit=0');
const controls = await request('/rest/v1/trade_system_controls?select=control_key,emergency_stopped&control_key=eq.global&limit=1');
if (!Array.isArray(controls) || controls.length !== 1 || controls[0]?.emergency_stopped !== false) {
  fail('safe global trade control row is missing or invalid');
}

console.log('[staging-supabase-schema] isolated staging schema contract verified');
