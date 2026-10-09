/**
 * Production Telegram six-room READ-ONLY preflight.
 * Reads encrypted Supabase Vault owner/room binding, PM2 revision, and the
 * Telegram Bot API getMe/getChat/getChatMember endpoints. Never sends or writes.
 * Prints safe codes, booleans and Git SHAs only, not Telegram IDs or secrets.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const ROOM_NAMES = Object.freeze({
  TELEGRAM_KR_STOCK_CHAT_ID: 'KR_STOCK',
  TELEGRAM_US_STOCK_CHAT_ID: 'US_STOCK',
  TELEGRAM_CRYPTO_SPOT_CHAT_ID: 'CRYPTO_SPOT',
  TELEGRAM_CRYPTO_FUTURES_CHAT_ID: 'CRYPTO_FUTURES',
  TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID: 'HOLDINGS',
  TELEGRAM_AUTO_TRADING_CHAT_ID: 'AUTO_TRADING',
});

export function sanitizedSha(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return /^[a-f0-9]{40}$/u.test(text) ? text : null;
}

export function checkSixRoomConfig(rooms, owner, ownerVerified = false) {
  if (!rooms || typeof rooms !== 'object' || Array.isArray(rooms)) {
    return { valid: false, reason: 'VAULT_ROOMS_ABSENT' };
  }
  const keys = Object.keys(ROOM_NAMES);
  if (Object.keys(rooms).length !== 6 || keys.some(key => !Object.hasOwn(rooms, key))) {
    return { valid: false, reason: 'VAULT_ROOMS_KEYS_INVALID' };
  }
  const ids = keys.map(key => rooms[key]);
  if (ids.some(id => typeof id !== 'string' || !/^-100[0-9]{8,15}$/u.test(id))) {
    return { valid: false, reason: 'VAULT_ROOM_ID_FORMAT_INVALID' };
  }
  if (new Set(ids).size !== 6) return { valid: false, reason: 'VAULT_ROOM_IDS_DUPLICATED' };
  if (typeof owner !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(owner)
    || ownerVerified !== true) {
    return { valid: false, reason: 'OWNER_DB_PROOF_INVALID' };
  }
  return { valid: true, reason: null };
}

export function botPermissionVerdict(chat, member) {
  const type = String(chat?.type ?? '');
  if (!['group', 'supergroup', 'channel'].includes(type)) return 'INVALID_ROOM_TYPE';
  const status = String(member?.status ?? '');
  if (!['creator', 'administrator', 'member', 'restricted'].includes(status)) return 'BOT_NOT_A_ROOM_MEMBER';
  if ((type === 'group' || type === 'supergroup') && status === 'member'\n    && chat?.permissions?.can_send_messages === false) return 'BOT_ROOM_SEND_FORBIDDEN';\n  if (type === 'channel' && status !== 'creator'
    && !(status === 'administrator' && member?.can_post_messages === true)) {
    return 'BOT_CHANNEL_POST_FORBIDDEN';
  }
  if (status === 'restricted' && member?.can_send_messages !== true) return 'BOT_ROOM_SEND_FORBIDDEN';
  return 'PASS';
}

export function classifyPreflight(snapshot) {
  if (!snapshot.pm2Online) return 'PRODUCTION_PM2_OFFLINE';
  if (!snapshot.pm2Sha || !snapshot.markerSha || snapshot.pm2Sha !== snapshot.markerSha) {
    return 'PRODUCTION_RUNTIME_SHA_MISMATCH';
  }
  if (snapshot.pm2Sha !== snapshot.mainSha) return 'PRODUCTION_NOT_AT_CURRENT_MAIN';
  if (!snapshot.vaultValid) return snapshot.vaultReason || 'VAULT_CONFIG_INVALID';
  if (!snapshot.botIdentityVerified) return 'BOT_IDENTITY_NOT_VERIFIED';
  if (snapshot.autoRoomMismatch) return 'AUTO_ROOM_CONFIG_MISMATCH';
  if (Object.values(snapshot.roomResults || {}).some(result => result !== 'PASS')) {
    return 'BOT_SIXROOM_PERMISSION_BLOCKED';
  }
  return 'READY_FOR_PROTECTED_BINDING_REVIEW';
}

export function parseDatabaseTarget(connectionString, runtimeSupabaseUrl) {
  const provider = new URL(String(runtimeSupabaseUrl ?? ''));
  const match = /^([a-z0-9]{10,})\.supabase\.co$/iu.exec(provider.hostname);
  if (provider.protocol !== 'https:' || !match) throw new Error('SUPABASE_PROJECT_UNVERIFIED');
  const project = match[1];
  const db = new URL(String(connectionString ?? ''));
  if (!['postgres:', 'postgresql:'].includes(db.protocol)) throw new Error('PRODUCTION_DATABASE_URL_INVALID');
  const username = decodeURIComponent(db.username);
  const direct = db.hostname === 'db.' + project + '.supabase.co' && username === 'postgres';
  const pooler = /(^|\.)pooler\.supabase\.com$/iu.test(db.hostname)
    && username === 'postgres.' + project;
  if ((!direct && !pooler) || decodeURIComponent(db.pathname) !== '/postgres'
    || !['5432', '6543'].includes(db.port || '5432') || !db.password) {
    throw new Error('PRODUCTION_DATABASE_PROJECT_MISMATCH');
  }
  return {
    host: db.hostname, port: db.port || '5432', user: username,
    password: decodeURIComponent(db.password), database: 'postgres',
  };
}

const VAULT_READ_SQL = [
  'WITH rooms AS (SELECT decrypted_secret::jsonb AS value FROM vault.decrypted_secrets',
  "WHERE name='telegram_sixroom_prod_config_v1'),",
  'owner AS (SELECT decrypted_secret AS value FROM vault.decrypted_secrets',
  "WHERE name='telegram_sixroom_owner_member_id_v1'),",
  'valid_owner AS (SELECT p.id FROM public.profiles p',
  'JOIN public.telegram_connections t ON t.user_id=p.id',
  'WHERE p.id::text=(SELECT value FROM owner)',
  "AND lower(p.role) IN ('admin','owner','super_admin')",
  "AND p.is_active IS TRUE AND lower(p.status::text)='approved'",
  'AND (p.membership_expires_at IS NULL OR p.membership_expires_at>now())',
  "AND t.status='ACTIVE' AND t.revoked_at IS NULL",
  'AND (SELECT count(DISTINCT lower(c.provider)) FROM public.account_readonly_credentials c',
  'WHERE c.user_id=p.id)>=4',
  'AND EXISTS(SELECT 1 FROM public.trade_automation_profiles ap WHERE ap.user_id=p.id))',
  "SELECT jsonb_build_object('rooms',(SELECT value FROM rooms),",
  "'owner',(SELECT value FROM owner),",
  "'roomsUnique',(SELECT count(*)=1 FROM rooms),",
  "'ownerUnique',(SELECT count(*)=1 FROM owner),",
  "'ownerVerified',(SELECT count(*)=1 FROM valid_owner))::text;",
].join('\n');

function readVault(databaseUrl, runtime) {
  const target = parseDatabaseTarget(databaseUrl, runtime.SUPABASE_URL || runtime.VITE_SUPABASE_URL);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PG') || key === 'PROD_DATABASE_URL') delete env[key];
  Object.assign(env, {
    PGHOST: target.host, PGPORT: target.port, PGUSER: target.user,
    PGPASSWORD: target.password, PGDATABASE: target.database,
    PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '10',
  });
  // SQL has no secret literal. psql credentials stay in child-process env.
  const result = spawnSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
    input: VAULT_READ_SQL, encoding: 'utf8', env,
    timeout: 20000, maxBuffer: 100000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    throw new Error('VAULT_READ_UNAVAILABLE');
  }
  const proof = JSON.parse(result.stdout.trim());
  if (proof.roomsUnique !== true || proof.ownerUnique !== true) throw new Error('VAULT_RECORD_NOT_UNIQUE');
  return proof;
}

async function readTelegram(token, method, params = {}) {
  const url = new URL('https://api.telegram.org/bot' + token + '/' + method);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method: 'GET', headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json().catch(() => null);
  return response.ok && body?.ok === true ? body.result ?? null : null;
}

export async function runPreflight() {
  const result = {
    schemaVersion: 'telegram-sixroom-vault-readonly-v1',
    readOnly: true,
    mainSha: sanitizedSha(process.env.EXPECTED_MAIN_SHA),
    pm2Sha: null, markerSha: null, pm2Online: false,
    vaultValid: false, vaultReason: null, botIdentityVerified: false,
    autoRoomMismatch: false, telegramActivationEnabled: false,
    roomResults: Object.fromEntries(Object.values(ROOM_NAMES).map(label => [label, 'NOT_CHECKED'])),
    classification: 'PREFLIGHT_INTERNAL_FAILED',
    secretValuesRecorded: false, serverMutations: 0, telegramSends: 0, financialMutations: 0,
  };
  try {
    if (!result.mainSha) throw new Error('INVALID_EXPECTED_MAIN');
    const processes = JSON.parse(execFileSync('pm2', ['jlist'], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 20000000,
    }));
    const matches = Array.isArray(processes) ? processes.filter(p => p?.name === 'stock-app') : [];
    if (matches.length !== 1) throw new Error('PM2_PROCESS_AMBIGUOUS');
    const runtime = matches[0].pm2_env ?? {};
    result.pm2Online = runtime.status === 'online';
    result.pm2Sha = sanitizedSha(runtime.DEPLOY_SHA);
    try {
      result.markerSha = sanitizedSha(readFileSync('/opt/stock-app/.deploy/current-sha', 'utf8'));
    } catch {
      result.markerSha = null;
    }
    result.telegramActivationEnabled = String(runtime.LIVE_TELEGRAM_ACTIVATION_APPROVED) === 'true';
    if (!result.pm2Online) throw new Error('PRODUCTION_PM2_OFFLINE');

    const proof = readVault(process.env.PROD_DATABASE_URL, runtime);
    const config = checkSixRoomConfig(proof.rooms, proof.owner, proof.ownerVerified);
    result.vaultValid = config.valid;
    result.vaultReason = config.reason;
    if (!config.valid) throw new Error(config.reason);
    const existingAutoId = String(runtime.TELEGRAM_AUTO_TRADING_CHAT_ID ?? '').trim();
    result.autoRoomMismatch = Boolean(existingAutoId &&
      existingAutoId !== proof.rooms.TELEGRAM_AUTO_TRADING_CHAT_ID);

    const botToken = String(runtime.TELEGRAM_BOT_TOKEN ?? '').trim();
    if (!/^[0-9]{6,20}:[A-Za-z0-9_-]{20,}$/u.test(botToken)) {
      throw new Error('BOT_TOKEN_NOT_CONFIGURED');
    }
    const bot = await readTelegram(botToken, 'getMe');
    const actualName = String(bot?.username ?? '').trim().toLowerCase();
    const expectedName = String(runtime.TELEGRAM_BOT_USERNAME ?? '').trim().replace(/^@/u, '').toLowerCase();
    result.botIdentityVerified = bot?.is_bot === true && Number.isSafeInteger(bot.id)
      && bot.id > 0 && actualName.length > 0 && actualName === expectedName;
    if (!result.botIdentityVerified) throw new Error('BOT_IDENTITY_NOT_VERIFIED');

    for (const [key, label] of Object.entries(ROOM_NAMES)) {
      try {
        const roomId = proof.rooms[key];
        const chat = await readTelegram(botToken, 'getChat', { chat_id: roomId });
        if (!chat) { result.roomResults[label] = 'ROOM_UNREACHABLE'; continue; }
        if (!['group', 'supergroup', 'channel'].includes(String(chat.type))) {
          result.roomResults[label] = 'INVALID_ROOM_TYPE';
          continue;
        }
        const member = await readTelegram(botToken, 'getChatMember', {
          chat_id: roomId, user_id: bot.id,
        });
        result.roomResults[label] = member
          ? botPermissionVerdict(chat, member) : 'BOT_MEMBERSHIP_UNREACHABLE';
      } catch {
        result.roomResults[label] = 'READ_ONLY_BOT_CHECK_FAILED';
      }
    }
    result.classification = classifyPreflight(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const allowed = new Set([
      'INVALID_EXPECTED_MAIN', 'PM2_PROCESS_AMBIGUOUS', 'PRODUCTION_PM2_OFFLINE',
      'SUPABASE_PROJECT_UNVERIFIED', 'PRODUCTION_DATABASE_URL_INVALID',
      'PRODUCTION_DATABASE_PROJECT_MISMATCH', 'VAULT_READ_UNAVAILABLE',
      'VAULT_RECORD_NOT_UNIQUE', 'VAULT_ROOMS_ABSENT', 'VAULT_ROOMS_KEYS_INVALID',
      'VAULT_ROOM_ID_FORMAT_INVALID', 'VAULT_ROOM_IDS_DUPLICATED',
      'OWNER_DB_PROOF_INVALID', 'BOT_TOKEN_NOT_CONFIGURED', 'BOT_IDENTITY_NOT_VERIFIED',
    ]);
    result.classification = allowed.has(code) ? code : 'PREFLIGHT_INTERNAL_FAILED';
  }
  return result;
}

if (process.env.TELEGRAM_SIXROOM_VAULT_PREFLIGHT_EXECUTE === 'true') {
  const result = await runPreflight();
  process.stdout.write(JSON.stringify(result) + '\n');
}
