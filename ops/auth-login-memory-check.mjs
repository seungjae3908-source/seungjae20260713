#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://lsj119.duckdns.org';
const LOGIN_PATH = '/api/auth/login';

function stop(reason, extra = {}) {
  console.log('REAL_LOGIN_TEST=FAILED');
  for (const [key, value] of Object.entries(extra)) console.log(`${key}=${value}`);
  console.log(`REASON=${reason}`);
  process.exit(1);
}

function readPm2() {
  try {
    return JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '[]');
  } catch {
    stop('pm2_read_failed');
  }
}

function workerCount(list) {
  return list.filter((p) => /signal-worker|alert-worker|auto.?trade|order-worker/i.test(String(p?.name || '')) && p?.pm2_env?.status === 'online').length;
}

function anonKey(list) {
  for (const p of list) {
    const env = p?.pm2_env || {};
    for (const key of ['SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY']) {
      const value = env[key] ?? env?.env?.[key];
      if (typeof value === 'string' && value.length > 20) return value;
    }
  }
  return '';
}

async function jsonRequest(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    stop('endpoint_unreachable');
  }
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  return { response, text, body };
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks);
const split = input.indexOf(0);
if (split < 1) stop('credential_input_invalid');

const identifier = input.subarray(0, split).toString('utf8').trim();
const password = input.subarray(split + 1).toString('utf8');
if (identifier.length < 2 || identifier.length > 20) stop('identifier_length_invalid');
if (password.length < 8 || password.length > 72) stop('password_length_invalid');

const before = readPm2();
const workersBefore = workerCount(before);
console.log(`WORKER_ONLINE_COUNT_BEFORE=${workersBefore}`);
if (workersBefore !== 0) stop('worker_online_before_test');

const login = await jsonRequest(`${PUBLIC_URL}${LOGIN_PATH}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
  body: JSON.stringify({ identifier, password }),
});

const errorName = String(login.body?.error || '');
console.log(`REAL_LOGIN_HTTP=${login.response.status}`);
if (errorName) console.log(`REAL_LOGIN_ERROR=${errorName}`);
if (errorName === 'LOGIN_REQUIRED') stop('LOGIN_REQUIRED', { REAL_LOGIN_HTTP: login.response.status });
if (errorName === 'INVALID_CREDENTIALS') stop('INVALID_CREDENTIALS', { REAL_LOGIN_HTTP: login.response.status });
if (!login.response.ok) stop(errorName || 'login_request_failed', { REAL_LOGIN_HTTP: login.response.status });

const session = login.body?.session || login.body?.data?.session || {};
const accessToken = session?.access_token;
const refreshToken = session?.refresh_token;
if (!accessToken || !refreshToken) stop('session_tokens_missing');

const key = anonKey(before);
if (!key) stop('supabase_anon_key_missing');

const user = await jsonRequest(`${PUBLIC_URL}/auth/v1/user`, {
  headers: { apikey: key, Authorization: `Bearer ${accessToken}`, 'Cache-Control': 'no-cache' },
});
if (user.response.status !== 200) stop('initial_session_invalid', { SESSION_USER_HTTP: user.response.status });

const refresh = await jsonRequest(`${PUBLIC_URL}/auth/v1/token?grant_type=refresh_token`, {
  method: 'POST',
  headers: { apikey: key, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
  body: JSON.stringify({ refresh_token: refreshToken }),
});
const refreshedAccessToken = refresh.body?.access_token;
if (refresh.response.status !== 200 || !refreshedAccessToken) stop('session_refresh_failed', { SESSION_REFRESH_HTTP: refresh.response.status });

const reload = await jsonRequest(`${PUBLIC_URL}/auth/v1/user`, {
  headers: { apikey: key, Authorization: `Bearer ${refreshedAccessToken}`, 'Cache-Control': 'no-cache' },
});
if (reload.response.status !== 200) stop('session_reload_failed', { SESSION_RELOAD_HTTP: reload.response.status });

const after = readPm2();
const workersAfter = workerCount(after);
console.log('REAL_LOGIN=OK');
console.log('SESSION_REFRESH=OK');
console.log('SESSION_RELOAD=OK');
console.log(`WORKER_ONLINE_COUNT_AFTER=${workersAfter}`);
console.log('CREDENTIAL_STORAGE=MEMORY_ONLY');
console.log('TOKEN_FILE_STORAGE=NONE');
if (workersAfter !== 0) stop('worker_online_after_test');
console.log('REAL_LOGIN_TEST=PASSED');
