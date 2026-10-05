#!/usr/bin/env node
import { createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const targetSha = String(process.env.TARGET_SHA ?? '').trim().toLowerCase();
const qaUserScopeHash = String(process.env.QA_USER_SCOPE_HASH ?? '').trim().toLowerCase();
const productionDatabaseUrl = String(process.env.PROD_DATABASE_URL ?? '').trim();
const pm2Name = String(process.env.PM2_NAME ?? 'stock-app').trim() || 'stock-app';
const markerPath = '/opt/stock-app/.deploy/current-sha';
const origin = 'https://openapi.tossinvest.com';
const timeoutMs = 8_000;

const common = {
  schemaVersion: 'production-toss-fresh-readonly-probe-v1',
  targetSha,
  readOnlyEnforced: true,
  rawSecretValuesExposed: false,
  rawAccountValuesExposed: false,
  mutationRequests: { orders: 0, cancels: 0, amends: 0, transfers: 0, withdrawals: 0 },
  realOrderSubmitted: false,
  liveTradingAuthorityGranted: false,
  autoTradingAuthorityGranted: false,
};

function finish(status, extra = {}, exitCode = status === 'PASS' ? 0 : 1) {
  process.stdout.write(JSON.stringify({ ...common, status, ...extra }) + '\n');
  process.exit(exitCode);
}

function fail(status, extra = {}) {
  finish(status, extra, 1);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function records(value, preferredKey) {
  const root = record(value);
  const result = record(root?.result);
  const preferred = preferredKey ? root?.[preferredKey] ?? result?.[preferredKey] : undefined;
  const candidate = preferred ?? root?.result ?? root?.data ?? value;
  if (Array.isArray(candidate)) return candidate.map(record).filter(Boolean);
  const single = record(candidate);
  return single ? [single] : [];
}

function runPsql(sql, parsed) {
  const baseEnv = { ...process.env };
  for (const key of Object.keys(baseEnv)) if (key.startsWith('PG')) delete baseEnv[key];
  delete baseEnv.PROD_DATABASE_URL;
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  const pgEnv = {
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username || ''),
    PGPASSWORD: decodeURIComponent(parsed.password || ''),
    PGDATABASE: database,
  };
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode) pgEnv.PGSSLMODE = sslmode;
  return spawnSync(
    'psql',
    ['-X', '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--quiet', '--tuples-only', '--no-align'],
    {
      env: {
        ...baseEnv,
        ...pgEnv,
        PGCONNECT_TIMEOUT: '5',
        PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000',
      },
      input: sql,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  );
}

function decryptCredential(value, encodedKey) {
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    fail('BLOCKED_PROVIDER_READONLY_AUDIT_INCOMPLETE:toss', { diagnosticClassification: 'CREDENTIAL_PAYLOAD_INVALID' });
  }
  const key = Buffer.from(String(encodedKey ?? '').trim(), 'base64');
  if (key.length !== 32) {
    fail('BLOCKED_PROVIDER_READONLY_AUDIT_INCOMPLETE:toss', { diagnosticClassification: 'MASTER_KEY_INVALID' });
  }
  if (envelope?.version !== 1 || envelope?.algorithm !== 'aes-256-gcm') {
    fail('BLOCKED_PROVIDER_READONLY_AUDIT_INCOMPLETE:toss', { diagnosticClassification: 'CREDENTIAL_PAYLOAD_INVALID' });
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(plaintext);
    if (!record(parsed)) throw new Error('shape');
    return parsed;
  } catch {
    fail('BLOCKED_PROVIDER_READONLY_AUDIT_INCOMPLETE:toss', { diagnosticClassification: 'CREDENTIAL_DECRYPT_FAILED' });
  }
}

async function boundedFetch(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'error', cache: 'no-store' });
  } catch (error) {
    const classification = error instanceof Error && error.name === 'AbortError'
      ? 'PROVIDER_TIMEOUT'
      : 'NETWORK_FAILURE';
    fail('BLOCKED_PROVIDER_READONLY_AUDIT_INCOMPLETE:toss', { diagnosticClassification: classification });
  } finally {
    clearTimeout(timer);
  }
}

async function jsonBody(response, classification) {
  try {
    return await response.json();
  } catch {
    fail('BLOCKED_PROVIDER_READONLY_AUDIT_INCOMPLETE:toss', { diagnosticClassification: classification });
  }
}

function classifyHttp(stage, response) {
  if (response.status === 401) {
    fail(
      stage === 'TOKEN'
        ? 'BLOCKED_EXTERNAL_CREDENTIAL:TOSS_TOKEN_AUTH_FAILED'
        : 'BLOCKED_EXTERNAL_CREDENTIAL:TOSS_ACCOUNT_API_AUTH_FAILED',
      { diagnosticClassification: stage === 'TOKEN' ? 'TOSS_TOKEN_AUTH_FAILED' : 'TOSS_ACCOUNT_API_AUTH_FAILED' },
    );
  }
  if (response.status === 403) {
    fail('BLOCKED_EXTERNAL_CREDENTIAL:TOSS_IP_NOT_ALLOWED', { diagnosticClassification: 'TOSS_IP_NOT_ALLOWED' });
  }
  if (response.status === 429) {
    fail('BLOCKED_PROVIDER_READONLY_AUDIT_INCOMPLETE:toss', { diagnosticClassification: 'RATE_LIMITED' });
  }
  if (response.status >= 500) {
    fail('BLOCKED_PROVIDER_READONLY_AUDIT_INCOMPLETE:toss', { diagnosticClassification: 'PROVIDER_UNAVAILABLE' });
  }
  if (response.status >= 400) {
    fail('BLOCKED_PROVIDER_READONLY_AUDIT_INCOMPLETE:toss', { diagnosticClassification: `TOSS_HTTP_${response.status}` });
  }
}

if (!/^[0-9a-f]{40}$/u.test(targetSha)) fail('LIVE_DISABLE_TOSS_FRESH_PROBE_TARGET_INVALID');
if (!/^[0-9a-f]{32}$/u.test(qaUserScopeHash)) fail('LIVE_DISABLE_TOSS_FRESH_PROBE_USER_SCOPE_INVALID');
if (!existsSync(markerPath) || readFileSync(markerPath, 'utf8').trim() !== targetSha) {
  fail('LIVE_DISABLE_TOSS_FRESH_PROBE_DEPLOYED_SHA_MISMATCH');
}

const pm2 = spawnSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
if (pm2.status !== 0) fail('LIVE_DISABLE_TOSS_FRESH_PROBE_PM2_UNAVAILABLE');
let pm2Rows;
try { pm2Rows = JSON.parse(pm2.stdout); } catch { fail('LIVE_DISABLE_TOSS_FRESH_PROBE_PM2_INVALID'); }
const matches = Array.isArray(pm2Rows) ? pm2Rows.filter((row) => row?.name === pm2Name) : [];
if (matches.length !== 1) fail('LIVE_DISABLE_TOSS_FRESH_PROBE_PM2_INVALID');
const runtime = matches[0]?.pm2_env;
if (!runtime || runtime.status !== 'online' || String(runtime.DEPLOY_SHA ?? '') !== targetSha) {
  fail('LIVE_DISABLE_TOSS_FRESH_PROBE_RUNTIME_IDENTITY_INVALID');
}
const masterKey = String(runtime.TRADING_CREDENTIAL_MASTER_KEY ?? '').trim();
if (Buffer.from(masterKey, 'base64').length !== 32) {
  fail('LIVE_DISABLE_TOSS_FRESH_PROBE_MASTER_KEY_INVALID');
}

let parsedDatabaseUrl;
try { parsedDatabaseUrl = new URL(productionDatabaseUrl); } catch { fail('LIVE_DISABLE_TOSS_FRESH_PROBE_DATABASE_URL_INVALID'); }
if (!/^postgres(?:ql)?:$/iu.test(parsedDatabaseUrl.protocol)
  || !parsedDatabaseUrl.hostname
  || !parsedDatabaseUrl.pathname.replace(/^\/+/, '')) {
  fail('LIVE_DISABLE_TOSS_FRESH_PROBE_DATABASE_URL_INVALID');
}

const sql = [
  'BEGIN READ ONLY;',
  'SELECT json_build_object(',
  "  'rowCount', count(*),",
  "  'encryptedCredentials', CASE WHEN count(*) = 1 THEN min(encrypted_credentials) ELSE NULL END",
  ')::text',
  'FROM public.account_readonly_credentials',
  "WHERE provider = 'toss'",
  '  AND configured = true',
  '  AND encrypted_credentials IS NOT NULL',
  `  AND md5(user_id::text) = '${qaUserScopeHash}';`,
  'COMMIT;',
].join('\n');
const dbResult = runPsql(sql, parsedDatabaseUrl);
if (dbResult.status !== 0) {
  fail('BLOCKED_PROVIDER_READONLY_AUDIT_INCOMPLETE:toss', { diagnosticClassification: 'READONLY_DATABASE_QUERY_FAILED' });
}
const dbLine = String(dbResult.stdout ?? '').split(/\r?\n/u)
  .map((value) => value.trim())
  .find((value) => value.startsWith('{') && value.endsWith('}'));
let row;
try { row = JSON.parse(dbLine || ''); } catch {
  fail('BLOCKED_PROVIDER_READONLY_AUDIT_INCOMPLETE:toss', { diagnosticClassification: 'READONLY_DATABASE_RESULT_INVALID' });
}
if (row?.rowCount !== 1 || typeof row?.encryptedCredentials !== 'string' || !row.encryptedCredentials) {
  fail('BLOCKED_PROVIDER_READONLY_AUDIT_INCOMPLETE:toss', {
    diagnosticClassification: row?.rowCount === 0 ? 'TOSS_CREDENTIAL_ROW_NOT_FOUND' : 'TOSS_CREDENTIAL_ROW_AMBIGUOUS',
  });
}

const credentials = decryptCredential(row.encryptedCredentials, masterKey);
const clientId = String(credentials.clientId ?? '').trim();
const clientSecret = String(credentials.clientSecret ?? '').trim();
const configuredAccountSeq = String(credentials.accountSeq ?? '').trim();
if (!clientId || !clientSecret) {
  fail('BLOCKED_EXTERNAL_CREDENTIAL:TOSS_TOKEN_AUTH_FAILED', { diagnosticClassification: 'TOSS_CREDENTIAL_FIELDS_MISSING' });
}

const tokenBody = new URLSearchParams({
  grant_type: 'client_credentials',
  client_id: clientId,
  client_secret: clientSecret,
}).toString();
const tokenResponse = await boundedFetch(new URL('/oauth2/token', origin), {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  body: tokenBody,
});
classifyHttp('TOKEN', tokenResponse);
const tokenPayload = record(await jsonBody(tokenResponse, 'TOSS_TOKEN_RESPONSE_INVALID'));
const accessToken = String(tokenPayload?.access_token ?? '').trim();
const expiresIn = Number(tokenPayload?.expires_in ?? 0);
if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
  fail('BLOCKED_PROVIDER_READONLY_AUDIT_INCOMPLETE:toss', { diagnosticClassification: 'TOSS_TOKEN_RESPONSE_INVALID' });
}

const authHeaders = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
const accountsResponse = await boundedFetch(new URL('/api/v1/accounts', origin), {
  method: 'GET',
  headers: authHeaders,
});
classifyHttp('ACCOUNT', accountsResponse);
const accountsPayload = await jsonBody(accountsResponse, 'TOSS_ACCOUNTS_RESPONSE_INVALID');
const accountRows = records(accountsPayload, 'accounts')
  .flatMap((account) => {
    const accountSeq = String(account?.accountSeq ?? '').trim();
    return accountSeq ? [{ accountSeq, account }] : [];
  });

let accountSeq = configuredAccountSeq;
if (accountSeq) {
  if (!accountRows.some((entry) => entry.accountSeq === accountSeq)) {
    fail('BLOCKED_PROVIDER_READONLY_AUDIT_INCOMPLETE:toss', { diagnosticClassification: 'TOSS_ACCOUNT_NOT_FOUND' });
  }
} else {
  const brokerage = accountRows.filter(({ account }) => String(account?.accountType ?? '').trim().toLowerCase() === 'brokerage');
  if (brokerage.length === 1) accountSeq = brokerage[0].accountSeq;
  else if (accountRows.length === 1) accountSeq = accountRows[0].accountSeq;
  else {
    fail('BLOCKED_PROVIDER_READONLY_AUDIT_INCOMPLETE:toss', {
      diagnosticClassification: accountRows.length === 0 ? 'TOSS_ACCOUNT_NOT_FOUND' : 'TOSS_ACCOUNT_SELECTION_REQUIRED',
    });
  }
}

const ordersUrl = new URL('/api/v1/orders', origin);
ordersUrl.searchParams.set('status', 'OPEN');
const ordersResponse = await boundedFetch(ordersUrl, {
  method: 'GET',
  headers: { ...authHeaders, 'X-Tossinvest-Account': accountSeq },
});
classifyHttp('ACCOUNT', ordersResponse);
const ordersPayload = record(await jsonBody(ordersResponse, 'TOSS_OPEN_ORDERS_RESPONSE_INVALID'));
const ordersResult = record(ordersPayload?.result);
if (!Array.isArray(ordersResult?.orders)) {
  fail('BLOCKED_PROVIDER_READONLY_AUDIT_INCOMPLETE:toss', { diagnosticClassification: 'TOSS_OPEN_ORDERS_RESPONSE_INVALID' });
}
const openOrderCount = ordersResult.orders.length;
if (openOrderCount > 0) {
  fail('BLOCKED_LIVE_STATE_NOT_TERMINAL', {
    diagnosticClassification: 'TOSS_OPEN_ORDERS_PRESENT',
    openOrdersKnown: true,
    openOrderCount,
  });
}

finish('PASS', {
  diagnosticClassification: 'PASS_FRESH_PROCESS',
  openOrdersKnown: true,
  openOrderCount: 0,
  freshOAuthTokenIssued: true,
});
