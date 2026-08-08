import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for staging watchlist verification`);
  return value;
};

const supabaseUrl = required('STAGING_SUPABASE_URL');
const supabaseSecretKey = required('STAGING_SUPABASE_SECRET_KEY');
const artifactDir = path.resolve(required('STAGING_ARTIFACT_DIR'));
const knownProductionRefs = new Set(['bawcbkoyovbeajkrnduq']);

function stagingProjectRef(raw) {
  let parsed;
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
    throw new Error('STAGING_SUPABASE_URL must use an isolated <project-ref>.supabase.co host');
  }
  const projectRef = match[1].toLowerCase();
  if (knownProductionRefs.has(projectRef)) {
    throw new Error('known production Supabase project is forbidden for staging watchlist verification');
  }
  return projectRef;
}

function safeDetail(cause) {
  return (cause instanceof Error ? cause.message : String(cause ?? 'unknown error'))
    .split(supabaseUrl).join('[REDACTED_SUPABASE_URL]')
    .split(supabaseSecretKey).join('[REDACTED_SUPABASE_KEY]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]')
    .slice(0, 1_000);
}

async function writeArtifact(value) {
  await mkdir(artifactDir, { recursive: true });
  const destination = path.join(artifactDir, 'staging-watchlist-store-verification.json');
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, destination);
}

function runToken() {
  return createHash('sha256')
    .update([
      process.env.GITHUB_RUN_ID ?? 'local',
      process.env.GITHUB_RUN_ATTEMPT ?? '1',
      process.env.STAGING_TARGET_SHA ?? 'unknown',
    ].join(':'), 'utf8')
    .digest('hex')
    .slice(0, 12);
}

const projectRef = stagingProjectRef(supabaseUrl);
const deviceId = `staging-watchlist-${runToken()}`;
const client = createClient(supabaseUrl, supabaseSecretKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});

async function deleteDeviceRows() {
  const { error } = await client
    .from('watchlist_items')
    .delete()
    .eq('device_id', deviceId);
  if (error) throw new Error(`watchlist cleanup failed: ${error.message}`);
}

async function listDeviceRows() {
  const { data, error } = await client
    .from('watchlist_items')
    .select('device_id,ticker,name,market,currency,target_price')
    .eq('device_id', deviceId)
    .order('ticker', { ascending: true });
  if (error) throw new Error(`watchlist read failed: ${error.message}`);
  return data ?? [];
}

let cleanupPassed = false;
try {
  await deleteDeviceRows();

  const initialRows = [
    {
      device_id: deviceId,
      ticker: 'AAPL',
      name: 'Apple',
      market: 'US',
      currency: 'USD',
      target_price: 225,
    },
    {
      device_id: deviceId,
      ticker: 'MSFT',
      name: 'Microsoft',
      market: 'US',
      currency: 'USD',
      target_price: null,
    },
  ];
  const { error: createError } = await client
    .from('watchlist_items')
    .upsert(initialRows, { onConflict: 'device_id,ticker' });
  if (createError) throw new Error(`watchlist upsert failed: ${createError.message}`);

  const created = await listDeviceRows();
  if (
    created.length !== 2
    || created[0]?.ticker !== 'AAPL'
    || Number(created[0]?.target_price) !== 225
    || created[1]?.ticker !== 'MSFT'
  ) {
    throw new Error('watchlist create/read verification mismatch');
  }

  const { error: updateError } = await client
    .from('watchlist_items')
    .upsert({
      device_id: deviceId,
      ticker: 'AAPL',
      name: 'Apple',
      market: 'US',
      currency: 'USD',
      target_price: 230,
    }, { onConflict: 'device_id,ticker' });
  if (updateError) throw new Error(`watchlist update failed: ${updateError.message}`);

  const { error: replaceDeleteError } = await client
    .from('watchlist_items')
    .delete()
    .eq('device_id', deviceId)
    .neq('ticker', 'AAPL');
  if (replaceDeleteError) {
    throw new Error(`watchlist replace-delete failed: ${replaceDeleteError.message}`);
  }

  const replaced = await listDeviceRows();
  if (
    replaced.length !== 1
    || replaced[0]?.ticker !== 'AAPL'
    || Number(replaced[0]?.target_price) !== 230
  ) {
    throw new Error('watchlist update/replace verification mismatch');
  }

  await deleteDeviceRows();
  const remaining = await listDeviceRows();
  if (remaining.length !== 0) {
    throw new Error('watchlist cleanup verification found remaining rows');
  }
  cleanupPassed = true;

  await writeArtifact({
    status: 'passed',
    project_ref: projectRef,
    device_id_hash: createHash('sha256').update(deviceId).digest('hex').slice(0, 16),
    create_read_rows: created.length,
    replace_rows: replaced.length,
    cleanup_rows_remaining: remaining.length,
    credentials_recorded: false,
    production_project_used: false,
  });
  process.stdout.write('[staging-watchlist] service-key CRUD and cleanup verified\n');
} catch (cause) {
  let cleanupDetail = null;
  if (!cleanupPassed) {
    try {
      await deleteDeviceRows();
      cleanupPassed = (await listDeviceRows()).length === 0;
    } catch (cleanupCause) {
      cleanupDetail = safeDetail(cleanupCause);
    }
  }
  await writeArtifact({
    status: 'failed',
    project_ref: projectRef,
    cleanup_passed: cleanupPassed,
    credentials_recorded: false,
    production_project_used: false,
    detail: safeDetail(cause),
    cleanup_detail: cleanupDetail,
  });
  throw new Error(safeDetail(cause));
}
