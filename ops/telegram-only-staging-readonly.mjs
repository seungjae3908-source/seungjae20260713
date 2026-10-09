/**
 * Strictly isolated, token-free Telegram Staging network/identity probe.
 * Never reads Production paths or Telegram tokens, sends messages, or mutates
 * Staging/Production. A TLS handshake proves networking only, NOT bot access
 * or delivery to any room.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns';
import { connect as tlsConnect } from 'node:tls';

const STAGING_ROOT = '/srv/seungjae-staging';
const STAGING_PM2 = 'seungjae-staging';
export const SAFE_NETWORK_STATUSES = Object.freeze([
  'NOT_CHECKED', 'IPV4_DNS_FAILED', 'IPV4_DNS_TIMEOUT',
  'IPV4_TLS_READY', 'IPV4_TLS_TIMEOUT',
  'IPV4_TLS_CERT_FAILED', 'IPV4_TLS_CONNECT_FAILED',
]);
export const STAGING_REQUIRED_STATUS = 'STAGING_TELEGRAM_NETWORK_ONLY_PASS';

function safeSha(value) {
  const valueString = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/u.test(valueString) ? valueString : null;
}

export async function probeStagingTelegramNetwork({
  lookupImpl = dnsLookup, connectImpl = tlsConnect,
} = {}) {
  const dnsStatus = await new Promise(resolve => {
    let settled = false;
    const done = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => done('IPV4_DNS_TIMEOUT'), 4500);
    try {
      lookupImpl('api.telegram.org', { family: 4 }, (error, address, family) => {
        done(!error && typeof address === 'string' && address.length > 0 && family === 4
          ? 'IPV4_TLS_PENDING' : 'IPV4_DNS_FAILED');
      });
    } catch {
      done('IPV4_DNS_FAILED');
    }
  });
  if (dnsStatus !== 'IPV4_TLS_PENDING') return dnsStatus;
  return await new Promise(resolve => {
    let settled = false;
    let socket = null;
    const done = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket && !socket.destroyed) socket.destroy();
      resolve(code);
    };
    const timer = setTimeout(() => done('IPV4_TLS_TIMEOUT'), 6500);
    try {
      socket = connectImpl({
        host: 'api.telegram.org', port: 443, servername: 'api.telegram.org',
        family: 4, autoSelectFamily: false, rejectUnauthorized: true,
        timeout: 6000,
      });
      socket.once('secureConnect', () =>
        done(socket.authorized === true ? 'IPV4_TLS_READY' : 'IPV4_TLS_CERT_FAILED'));
      socket.once('timeout', () => done('IPV4_TLS_TIMEOUT'));
      socket.once('error', error => {
        const code = String(error?.code ?? error?.cause?.code ?? '');
        done(['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
          'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code)
          ? 'IPV4_TLS_CERT_FAILED' : 'IPV4_TLS_CONNECT_FAILED');
      });
    } catch {
      done('IPV4_TLS_CONNECT_FAILED');
    }
  });
}

export function stagingTelegramVerdict(report) {
  if (!report.targetSha) return 'INVALID_EXACT_MAIN_SHA';
  if (!report.pm2Online) return 'STAGING_PM2_OFFLINE';
  if (!report.pm2Sha || !report.markerSha || report.pm2Sha !== report.markerSha)
    return 'STAGING_RUNTIME_SHA_MISMATCH';
  if (report.pm2Sha !== report.targetSha) return 'STAGING_RUNTIME_NOT_AT_MAIN';
  if (report.networkPath !== 'IPV4_TLS_READY') return 'STAGING_TELEGRAM_NETWORK_BLOCKED';
  return STAGING_REQUIRED_STATUS;
}

export async function runStagingReadOnlyProbe({
  target = process.env.TELEGRAM_STAGING_TARGET_SHA,
  pm2Exec = execFileSync,
  fileRead = readFileSync,
  network = probeStagingTelegramNetwork,
} = {}) {
  const result = {
    schemaVersion: 'telegram-only-staging-readonly-v1',
    scope: 'TELEGRAM_ONLY_STAGING_NETWORK',
    targetSha: safeSha(target),
    pm2Sha: null, markerSha: null, pm2Online: false,
    networkPath: 'NOT_CHECKED',
    classification: 'INITIAL',
    botIdentityVerified: false,
    roomPostingVerified: false,
    telegramSends: 0,
    financialMutations: 0,
    stagingDeployed: false,
    productionDeployed: false,
    secretValuesRecorded: false,
  };
  try {
    const processes = JSON.parse(pm2Exec('pm2', ['jlist'], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 20000000,
    }));
    const targets = Array.isArray(processes)
      ? processes.filter(p => p?.name === STAGING_PM2) : [];
    if (targets.length === 1) {
      const runtime = targets[0].pm2_env ?? {};
      result.pm2Online = runtime.status === 'online';
      result.pm2Sha = safeSha(runtime.DEPLOY_SHA);
    }
  } catch { /* only safe booleans and sanitized SHA leave this process */ }
  try {
    result.markerSha = safeSha(fileRead(STAGING_ROOT + '/.deploy/current-sha', 'utf8'));
  } catch { /* staging-only marker absent */ }
  if (result.targetSha) {
    try {
      const status = await network();
      result.networkPath = SAFE_NETWORK_STATUSES.includes(status)
        ? status : 'IPV4_TLS_CONNECT_FAILED';
    } catch {
      result.networkPath = 'IPV4_TLS_CONNECT_FAILED';
    }
  }
  result.classification = stagingTelegramVerdict(result);
  return result;
}

if (process.env.TELEGRAM_STAGING_READONLY_EXECUTE === 'true') {
  const result = await runStagingReadOnlyProbe();
  process.stdout.write(JSON.stringify(result) + '\n');
}
