import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import {
  provisionEphemeralStagingAccounts,
  type StagingAccountLifecycle,
} from './support/staging-account-lifecycle';

const enabled = process.env.STAGING_ACCOUNT_READONLY_E2E === 'true';
test.skip(!enabled, 'isolated Staging account runtime evidence is opt-in only');
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for isolated account-runtime evidence`);
  return value;
}

function internalEmail(loginName: string) {
  const normalized = loginName.trim().normalize('NFKC').toLowerCase();
  const digest = createHash('sha256')
    .update(`seungjae-stock-account:${normalized}`, 'utf8')
    .digest('hex')
    .slice(0, 40);
  return `${digest}@accounts.seungjae-stock.com`;
}

async function requestJson(
  baseUrl: string,
  accessToken: string,
  method: 'GET' | 'PUT',
  route: string,
  body?: Record<string, unknown>,
) {
  const response = await fetch(new URL(route, baseUrl), {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  let payload: Record<string, unknown> = {};
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    // Status is sufficient evidence when a provider did not return JSON.
  }
  return { status: response.status, payload };
}

function safeProviderEvidence(provider: 'upbit' | 'bitget', status: number, payload: Record<string, unknown>) {
  const balances = Array.isArray(payload.balances) ? payload.balances.length : null;
  const positions = Array.isArray(payload.positions) ? payload.positions.length : null;
  return {
    provider,
    http_status: status,
    connected: payload.connected === true,
    runtime_status: typeof payload.status === 'string' ? payload.status : null,
    stale: payload.stale === true,
    checked_at_present: typeof payload.checkedAt === 'string' && payload.checkedAt.length > 0,
    balances_count: balances,
    positions_count: positions,
    error_code: typeof payload.errorCode === 'string' ? payload.errorCode : null,
    credentials_returned: payload.credentialsReturned === true,
    order_requests: Number(payload.orderRequests ?? 0),
    cancel_requests: Number(payload.cancelRequests ?? 0),
    amend_requests: Number(payload.amendRequests ?? 0),
    transfer_requests: Number(payload.transferRequests ?? 0),
    withdrawal_requests: Number(payload.withdrawalRequests ?? 0),
    live_trading_enabled: payload.liveTradingEnabled === true,
    auto_trading_enabled: payload.autoTradingEnabled === true,
  };
}

async function remainingConnectionRows(supabaseUrl: string, serviceKey: string, userId: string) {
  const url = new URL('/rest/v1/trading_connections', supabaseUrl);
  url.searchParams.set('select', 'id');
  url.searchParams.set('user_id', `eq.${userId}`);
  const response = await fetch(url, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`credential cleanup query failed with HTTP ${response.status}`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows.length : -1;
}

async function writeEvidence(artifactDir: string, evidence: Record<string, unknown>) {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    path.join(artifactDir, 'staging-account-readonly-runtime.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

test('ephemeral user proves real Upbit and Bitget GET-only account runtime without mutation authority', async () => {
  const baseUrl = required('STAGING_BASE_URL');
  const supabaseUrl = required('STAGING_SUPABASE_URL');
  const supabaseAnonKey = required('STAGING_SUPABASE_ANON_KEY');
  const supabaseServiceKey = required('STAGING_SUPABASE_SECRET_KEY');
  const artifactDir = required('STAGING_ARTIFACT_DIR');
  const upbitAccessKey = required('STAGING_UPBIT_ACCESS_KEY');
  const upbitSecretKey = required('STAGING_UPBIT_SECRET_KEY');
  const bitgetApiKey = required('STAGING_BITGET_API_KEY');
  const bitgetSecretKey = required('STAGING_BITGET_SECRET_KEY');
  const bitgetPassphrase = required('STAGING_BITGET_PASSPHRASE');

  let lifecycle: StagingAccountLifecycle | null = null;
  let regularUserId = '';
  let loopbackBindVerified = false;
  let upbitEvidence: Record<string, unknown> | null = null;
  let bitgetEvidence: Record<string, unknown> | null = null;
  let cleanupRowsRemaining: number | null = null;

  try {
    lifecycle = await provisionEphemeralStagingAccounts({
      supabaseUrl,
      supabaseSecretKey: supabaseServiceKey,
      artifactDir,
    });
    const regular = lifecycle.accounts.regular;
    const auth = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const { data, error } = await auth.auth.signInWithPassword({
      email: internalEmail(regular.loginName),
      password: regular.password,
    });
    if (error || !data.session?.access_token || !data.user?.id) {
      throw new Error(`ephemeral regular account login failed: ${error?.message ?? 'missing session'}`);
    }
    regularUserId = data.user.id;
    const token = data.session.access_token;

    const health = await requestJson(baseUrl, token, 'GET', '/api/health');
    expect(health.status).toBe(200);
    expect(health.payload.ok).toBe(true);
    expect(health.payload.bindHost).toBe('127.0.0.1');
    loopbackBindVerified = true;

    const vaultStatus = await requestJson(baseUrl, token, 'GET', '/api/accounts/read-only/credentials/status');
    expect(vaultStatus.status).toBe(200);
    expect(vaultStatus.payload.encryptionConfigured).toBe(true);
    expect(vaultStatus.payload.credentialsReturned).toBe(false);

    const upbitSave = await requestJson(baseUrl, token, 'PUT', '/api/accounts/read-only/credentials/upbit', {
      purpose: 'read_only',
      permissions: ['read'],
      credentials: { accessKey: upbitAccessKey, secretKey: upbitSecretKey },
    });
    expect(upbitSave.status).toBe(200);
    expect(upbitSave.payload.credentialsReturned).toBe(false);
    expect(upbitSave.payload.privateProviderRequests).toBe(0);
    expect(upbitSave.payload.orderRequests).toBe(0);

    const bitgetSave = await requestJson(baseUrl, token, 'PUT', '/api/accounts/read-only/credentials/bitget', {
      purpose: 'read_only',
      permissions: ['read'],
      credentials: { apiKey: bitgetApiKey, secretKey: bitgetSecretKey, passphrase: bitgetPassphrase },
    });
    expect(bitgetSave.status).toBe(200);
    expect(bitgetSave.payload.credentialsReturned).toBe(false);
    expect(bitgetSave.payload.privateProviderRequests).toBe(0);
    expect(bitgetSave.payload.orderRequests).toBe(0);

    const upbitRead = await requestJson(baseUrl, token, 'GET', '/api/accounts/read-only/upbit');
    upbitEvidence = safeProviderEvidence('upbit', upbitRead.status, upbitRead.payload);
    expect(upbitRead.status).toBe(200);
    expect(upbitRead.payload.status).toBe('CONNECTED');
    expect(upbitRead.payload.connected).toBe(true);
    expect(upbitRead.payload.credentialsReturned).toBe(false);
    expect(upbitRead.payload.orderRequests).toBe(0);
    expect(upbitRead.payload.cancelRequests).toBe(0);
    expect(upbitRead.payload.amendRequests).toBe(0);
    expect(upbitRead.payload.transferRequests).toBe(0);
    expect(upbitRead.payload.withdrawalRequests).toBe(0);
    expect(upbitRead.payload.liveTradingEnabled).toBe(false);
    expect(upbitRead.payload.autoTradingEnabled).toBe(false);

    const bitgetRead = await requestJson(baseUrl, token, 'GET', '/api/accounts/read-only/bitget');
    bitgetEvidence = safeProviderEvidence('bitget', bitgetRead.status, bitgetRead.payload);
    expect(bitgetRead.status).toBe(200);
    expect(bitgetRead.payload.status).toBe('CONNECTED');
    expect(bitgetRead.payload.connected).toBe(true);
    expect(bitgetRead.payload.credentialsReturned).toBe(false);
    expect(bitgetRead.payload.orderRequests).toBe(0);
    expect(bitgetRead.payload.cancelRequests).toBe(0);
    expect(bitgetRead.payload.amendRequests).toBe(0);
    expect(bitgetRead.payload.transferRequests).toBe(0);
    expect(bitgetRead.payload.withdrawalRequests).toBe(0);
    expect(bitgetRead.payload.liveTradingEnabled).toBe(false);
    expect(bitgetRead.payload.autoTradingEnabled).toBe(false);
  } finally {
    if (lifecycle) await lifecycle.cleanup();
    if (regularUserId) {
      cleanupRowsRemaining = await remainingConnectionRows(supabaseUrl, supabaseServiceKey, regularUserId);
      expect(cleanupRowsRemaining).toBe(0);
    }
    await writeEvidence(artifactDir, {
      status: loopbackBindVerified
        && upbitEvidence?.connected === true
        && bitgetEvidence?.connected === true
        && cleanupRowsRemaining === 0
        ? 'passed'
        : 'failed',
      loopback_bind_verified: loopbackBindVerified,
      upbit: upbitEvidence,
      bitget: bitgetEvidence,
      credential_rows_remaining_after_ephemeral_user_cleanup: cleanupRowsRemaining,
      credentials_recorded: false,
      account_identifiers_recorded: false,
      account_values_recorded: false,
      mutation_requests_expected: 0,
      production_changed: false,
    });
  }
});
