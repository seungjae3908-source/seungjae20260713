#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP="${APP:-/opt/stock-app}"
PM2_APP="${PM2_APP:-stock-app}"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:8080}"
PUBLIC_URL="${PUBLIC_URL:-https://lsj119.duckdns.org}"
TMP_DIR="$(mktemp -d)"
LOCK_FILE="/var/lock/stockdeploy-account-repair.lock"

cleanup() {
  APP_LOGIN_ID=''
  APP_PASSWORD=''
  APP_PASSWORD_CONFIRM=''
  unset APP_LOGIN_ID APP_PASSWORD APP_PASSWORD_CONFIRM || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  printf 'ACCOUNT_REPAIR=FAILED\nREASON=%s\n' "$1" >&2
  exit 1
}

for command_name in node pm2 curl flock; do
  command -v "$command_name" >/dev/null 2>&1 || fail "${command_name}_missing"
done

exec 9>"$LOCK_FILE"
flock -n 9 || fail 'another_account_repair_is_running'

PM2_STATE="$(pm2 jlist)"
printf '%s' "$PM2_STATE" > "$TMP_DIR/pm2.json"
node - "$TMP_DIR/pm2.json" "$PM2_APP" <<'NODE' || fail 'stock_app_not_single_online'
const fs = require('fs');
const list = JSON.parse(fs.readFileSync(process.argv[2], 'utf8') || '[]');
const name = process.argv[3];
const matches = list.filter((item) => String(item?.name || '') === name);
if (matches.length !== 1 || matches[0]?.pm2_env?.status !== 'online') process.exit(1);
NODE

count_workers() {
  pm2 jlist | node -e '
let text = "";
process.stdin.on("data", (chunk) => { text += chunk; });
process.stdin.on("end", () => {
  const list = JSON.parse(text || "[]");
  const count = list.filter((item) =>
    /signal-worker|alert-worker|auto.?trade|order-worker/i.test(String(item?.name || "")) &&
    item?.pm2_env?.status === "online"
  ).length;
  process.stdout.write(String(count));
});'
}

WORKERS_BEFORE="$(count_workers)"
printf 'WORKER_ONLINE_COUNT_BEFORE=%s\n' "$WORKERS_BEFORE"
[[ "$WORKERS_BEFORE" == '0' ]] || fail 'worker_online_before'

curl -fsS --connect-timeout 5 --max-time 20 \
  -H 'Cache-Control: no-cache' \
  "$LOCAL_URL/api/health?account_repair=pre" >/dev/null || fail 'pre_local_health_failed'
curl -fsS --connect-timeout 5 --max-time 20 \
  -H 'Cache-Control: no-cache' \
  "$PUBLIC_URL/api/health?account_repair=pre" >/dev/null || fail 'pre_public_health_failed'
printf 'PRE_HEALTH=OK\n'

printf '앱 아이디를 입력하세요: '
IFS= read -r APP_LOGIN_ID
[[ -n "$APP_LOGIN_ID" ]] || fail 'app_login_id_empty'

printf '새 앱 비밀번호를 입력하세요(화면에 표시되지 않음): '
IFS= read -r -s APP_PASSWORD
printf '\n'
printf '새 앱 비밀번호를 한 번 더 입력하세요: '
IFS= read -r -s APP_PASSWORD_CONFIRM
printf '\n'

[[ "$APP_PASSWORD" == "$APP_PASSWORD_CONFIRM" ]] || fail 'password_confirmation_mismatch'
[[ ${#APP_PASSWORD} -ge 8 && ${#APP_PASSWORD} -le 72 ]] || fail 'password_length_invalid'

cat > "$TMP_DIR/repair-account.mjs" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function stop(reason) {
  console.error('ACCOUNT_REPAIR=FAILED');
  console.error(`REASON=${reason}`);
  process.exit(1);
}

function normalizeName(value) {
  return value.trim().normalize('NFKC').toLowerCase();
}

function parseDotEnv(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    result[match[1]] = value;
  }
  return result;
}

function collectEnvFiles(root, maxDepth = 4) {
  const files = [];
  function walk(current, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && /^\.env(?:\.|$)/.test(entry.name)) files.push(full);
    }
  }
  walk(root, 0);
  return files;
}

function mergeConfig(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const [key, value] of Object.entries(source)) {
    if (target[key] === undefined && typeof value === 'string' && value.length > 0) {
      target[key] = value;
    }
  }
}

async function fetchJson(url, options, failureName) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    stop(`${failureName}_network_error`);
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!response.ok) stop(`${failureName}_http_${response.status}`);
  return data;
}

const input = fs.readFileSync(0);
const values = input.toString('utf8').split('\0');
let loginName = values[0] ?? '';
let password = values[1] ?? '';

if (loginName.length < 2 || loginName.length > 20) stop('app_login_id_length_invalid');
if (!/^[가-힣a-zA-Z0-9 _.-]+$/.test(loginName)) stop('app_login_id_characters_invalid');
if (password.length < 8 || password.length > 72) stop('password_length_invalid');

const normalized = normalizeName(loginName);
const emailToken = createHash('sha256')
  .update(`seungjae-stock-account:${normalized}`)
  .digest('hex')
  .slice(0, 40);
const internalEmail = `${emailToken}@accounts.seungjae-stock.com`;

let pm2List;
try {
  pm2List = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }));
} catch {
  stop('pm2_state_read_failed');
}
const processName = process.env.PM2_APP || 'stock-app';
const matches = pm2List.filter((item) => String(item?.name || '') === processName);
if (matches.length !== 1) stop('stock_app_process_count_not_one');
const appProcess = matches[0];

const config = {};
mergeConfig(config, appProcess?.pm2_env);
mergeConfig(config, appProcess?.pm2_env?.env);

const pid = Number(appProcess?.pid || 0);
if (pid > 0) {
  try {
    const procEnv = fs.readFileSync(`/proc/${pid}/environ`);
    const parsed = {};
    for (const item of procEnv.toString('utf8').split('\0')) {
      const index = item.indexOf('=');
      if (index > 0) parsed[item.slice(0, index)] = item.slice(index + 1);
    }
    mergeConfig(config, parsed);
  } catch {}
}

const appRoot = process.env.APP || '/opt/stock-app';
for (const envFile of collectEnvFiles(appRoot)) {
  try {
    mergeConfig(config, parseDotEnv(fs.readFileSync(envFile, 'utf8')));
  } catch {}
}

const supabaseUrl = String(config.SUPABASE_URL || '').replace(/\/+$/, '');
const serviceKey = String(config.SUPABASE_SECRET_KEY || config.SUPABASE_SERVICE_ROLE_KEY || '');
const tokenKey = String(config.SUPABASE_ANON_KEY || serviceKey);

if (!supabaseUrl) stop('supabase_url_missing');
if (!serviceKey) stop('supabase_service_key_missing');
if (!tokenKey) stop('supabase_token_key_missing');

console.log('SUPABASE_ADMIN_CONFIG=OK');

function elevatedHeaders(key, extra = {}) {
  const headers = { apikey: key, ...extra };
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

const adminHeaders = elevatedHeaders(serviceKey, {
  'Content-Type': 'application/json',
});

const users = [];
for (let page = 1; page <= 100; page += 1) {
  const pageData = await fetchJson(
    `${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=1000`,
    { method: 'GET', headers: adminHeaders },
    'admin_list_users',
  );
  const pageUsers = Array.isArray(pageData) ? pageData : (pageData?.users ?? []);
  users.push(...pageUsers);
  if (pageUsers.length < 1000) break;
}

let profileRows = [];
try {
  const profileUrl =
    `${supabaseUrl}/rest/v1/profiles` +
    `?select=id,login_name,display_name,role,status` +
    `&login_name=eq.${encodeURIComponent(normalized)}&limit=2`;
  const profileResponse = await fetch(profileUrl, {
    method: 'GET',
    headers: elevatedHeaders(serviceKey, {
      Accept: 'application/json',
    }),
  });
  if (profileResponse.ok) {
    const parsed = await profileResponse.json();
    if (Array.isArray(parsed)) profileRows = parsed;
  }
} catch {}

const candidateIds = new Set();
for (const user of users) {
  if (String(user?.email || '').toLowerCase() === internalEmail.toLowerCase()) {
    candidateIds.add(String(user.id));
  }
  const metadataName = user?.user_metadata?.login_name;
  if (typeof metadataName === 'string' && normalizeName(metadataName) === normalized) {
    candidateIds.add(String(user.id));
  }
}
for (const row of profileRows) {
  if (row?.id && users.some((user) => String(user.id) === String(row.id))) {
    candidateIds.add(String(row.id));
  }
}

if (candidateIds.size > 1) stop('ambiguous_existing_accounts');

let targetUser = null;
if (candidateIds.size === 1) {
  const [targetId] = [...candidateIds];
  targetUser = users.find((user) => String(user.id) === targetId) ?? null;
}

const existingDisplayName =
  profileRows[0]?.display_name ||
  targetUser?.user_metadata?.display_name ||
  loginName;

const userMetadata = {
  ...(targetUser?.user_metadata || {}),
  login_name: normalized,
  display_name: existingDisplayName,
};
const appMetadata = {
  ...(targetUser?.app_metadata || {}),
  role: 'admin',
  status: 'approved',
};

let accountAction;
if (targetUser) {
  const updated = await fetchJson(
    `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(targetUser.id)}`,
    {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        email: internalEmail,
        password,
        email_confirm: true,
        user_metadata: userMetadata,
        app_metadata: appMetadata,
      }),
    },
    'admin_update_user',
  );
  targetUser = updated?.user ?? updated;
  accountAction = 'UPDATED';
} else {
  const created = await fetchJson(
    `${supabaseUrl}/auth/v1/admin/users`,
    {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        email: internalEmail,
        password,
        email_confirm: true,
        user_metadata: userMetadata,
        app_metadata: appMetadata,
      }),
    },
    'admin_create_user',
  );
  targetUser = created?.user ?? created;
  accountAction = 'CREATED';
}

if (!targetUser?.id) stop('admin_user_result_missing');

let profileResult = 'SKIPPED';
try {
  const profileResponse = await fetch(
    `${supabaseUrl}/rest/v1/profiles?on_conflict=id`,
    {
      method: 'POST',
      headers: elevatedHeaders(serviceKey, {
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      }),
      body: JSON.stringify([{
        id: targetUser.id,
        login_name: normalized,
        display_name: existingDisplayName,
        role: 'admin',
        status: 'approved',
      }]),
    },
  );
  profileResult = profileResponse.ok ? 'UPSERTED' : `SKIPPED_HTTP_${profileResponse.status}`;
} catch {
  profileResult = 'SKIPPED_NETWORK_ERROR';
}

const tokenData = await fetchJson(
  `${supabaseUrl}/auth/v1/token?grant_type=password`,
  {
    method: 'POST',
    headers: {
      apikey: tokenKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: internalEmail, password }),
  },
  'supabase_direct_login',
);
if (!tokenData?.access_token || !tokenData?.refresh_token) stop('supabase_direct_session_missing');

async function verifyAppApi(base, label) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    },
    body: JSON.stringify({ identifier: loginName, password }),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  console.log(`${label}_API_LOGIN_HTTP=${response.status}`);
  if (!response.ok) stop(`${label.toLowerCase()}_api_login_http_${response.status}`);
  const session = data?.session ?? data?.data?.session ?? data;
  if (!session?.access_token || !session?.refresh_token) {
    stop(`${label.toLowerCase()}_api_session_missing`);
  }
}

await verifyAppApi(process.env.LOCAL_URL || 'http://127.0.0.1:8080', 'LOCAL');
await verifyAppApi(process.env.PUBLIC_URL || 'https://lsj119.duckdns.org', 'PUBLIC');

console.log(`SUPABASE_ACCOUNT_ACTION=${accountAction}`);
console.log(`PROFILE_SYNC=${profileResult}`);
console.log('SUPABASE_DIRECT_LOGIN=OK');
console.log('ACCOUNT_ROLE=admin');
console.log('ACCOUNT_STATUS=approved');
console.log('CREDENTIALS_PRINTED=NO');
console.log('CREDENTIALS_WRITTEN_TO_FILE=NO');

loginName = '';
password = '';
NODE

export APP PM2_APP LOCAL_URL PUBLIC_URL

set +e
printf '%s\0%s\0' "$APP_LOGIN_ID" "$APP_PASSWORD" | node "$TMP_DIR/repair-account.mjs"
RC=$?
set -e

APP_LOGIN_ID=''
APP_PASSWORD=''
APP_PASSWORD_CONFIRM=''
unset APP_LOGIN_ID APP_PASSWORD APP_PASSWORD_CONFIRM || true

[[ "$RC" == '0' ]] || exit "$RC"

curl -fsS --connect-timeout 5 --max-time 20 \
  -H 'Cache-Control: no-cache' \
  "$LOCAL_URL/api/health?account_repair=post" >/dev/null || fail 'post_local_health_failed'
curl -fsS --connect-timeout 5 --max-time 20 \
  -H 'Cache-Control: no-cache' \
  "$PUBLIC_URL/api/health?account_repair=post" >/dev/null || fail 'post_public_health_failed'

WORKERS_AFTER="$(count_workers)"
[[ "$WORKERS_AFTER" == '0' ]] || fail 'worker_online_after'

printf 'POST_HEALTH=OK\n'
printf 'WORKER_ONLINE_COUNT_AFTER=%s\n' "$WORKERS_AFTER"
printf 'SOURCE_CHANGED=NO\n'
printf 'BUILD_RUN=NO\n'
printf 'PM2_RESTARTED=NO\n'
printf 'PM2_SAVE=NOT_RUN\n'
printf 'CADDY_CHANGED=NO\n'
printf 'APP_ENV_CHANGED=NO\n'
printf 'AUTH_ACCOUNT_DATA_CHANGED=YES\n'
printf 'BROWSER_LOGIN_RETEST_REQUIRED=YES\n'
printf 'ACCOUNT_REPAIR=PASSED\n'
