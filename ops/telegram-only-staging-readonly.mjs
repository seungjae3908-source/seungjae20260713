/**
 * Strictly isolated, token-free Telegram Staging network/identity probe.
 * Never reads Production paths or Telegram tokens, sends messages, or mutates
 * Staging/Production. A TLS handshake proves networking only, NOT bot access
 * or delivery to any room.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { get as httpGet } from 'node:http';

const STAGING_ROOT = '/srv/seungjae-staging';
const STAGING_PM2 = 'seungjae-staging';
export const SAFE_NETWORK_STATUSES = Object.freeze([
  'NOT_CHECKED', 'IPV4_DNS_FAILED', 'IPV4_DNS_TIMEOUT',
  'IPV4_DNS_UNSAFE_ADDRESS',
  'IPV4_TLS_READY', 'IPV4_TCP_TIMEOUT', 'IPV4_TLS_TIMEOUT',
  'IPV4_TLS_CERT_FAILED', 'IPV4_TLS_CONNECT_FAILED',
]);
export const STAGING_REQUIRED_STATUS = 'STAGING_TELEGRAM_NETWORK_ONLY_PASS';

function safeSha(value) {
  const valueString = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/u.test(valueString) ? valueString : null;
}

/** Reject local/reserved DNS redirection without disclosing the IP address.
 * Still verify the hostname via TLS SNI and the system CA chain.
 */
export function isPublicTelegramIpv4(address) {
  if (typeof address !== 'string' || isIP(address) !== 4) return false;
  const [a,b,c] = address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  // Entire 192.0.0.0/24 is protocol-assignment/special-purpose space
  // (not a Telegram public edge); do not allow nearby .1/.8/etc as DNS.
  if (a === 192 && (b === 168 || (b === 0) || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export async function probeStagingTelegramNetwork({
  lookupImpl = dnsLookup, connectImpl = tlsConnect,
} = {}) {
  // Resolve one IPv4 address and connect to those exact DNS bytes. TLS still
  // validates api.telegram.org with SNI, never an unverified IP identity.
  const dnsResult = await new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done({ status: 'IPV4_DNS_TIMEOUT' }), 4500);
    try {
      lookupImpl('api.telegram.org', { family: 4 }, (error, address, family) => {
        if (error || family !== 4 || typeof address !== 'string' || isIP(address) !== 4) {
          done({ status: 'IPV4_DNS_FAILED' });
          return;
        }
        if (!isPublicTelegramIpv4(address)) {
          done({ status: 'IPV4_DNS_UNSAFE_ADDRESS' });
          return;
        }
        done({ status: 'IPV4_TLS_PENDING', address });
      });
    } catch {
      done({ status: 'IPV4_DNS_FAILED' });
    }
  });
  if (dnsResult.status !== 'IPV4_TLS_PENDING') return dnsResult.status;
  return await new Promise(resolve => {
    let settled = false;
    let socket = null;
    let tcpConnected = false;
    const timeoutCode = () => tcpConnected ? 'IPV4_TLS_TIMEOUT' : 'IPV4_TCP_TIMEOUT';
    const done = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket && !socket.destroyed) socket.destroy();
      resolve(code);
    };
    const timer = setTimeout(() => done(timeoutCode()), 6500);
    try {
      socket = connectImpl({
        host: dnsResult.address, port: 443, servername: 'api.telegram.org',
        family: 4, autoSelectFamily: false, rejectUnauthorized: true,
        timeout: 6000,
      });
      socket.once('connect', () => { tcpConnected = true; });
      socket.once('secureConnect', () =>
        done(socket.authorized === true ? 'IPV4_TLS_READY' : 'IPV4_TLS_CERT_FAILED'));
      socket.once('timeout', () => done(timeoutCode()));
      socket.once('error', error => {
        const code = String(error?.code ?? error?.cause?.code ?? '');
        // Native socket errors may deliver timeouts via 'error' instead of
        // the socket 'timeout' event. Preserve the TCP-vs-TLS phase split.
        if (code === 'ETIMEDOUT' || code === 'ERR_SOCKET_CONNECTION_TIMEOUT') {
          done(timeoutCode());
          return;
        }
        done(['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
          'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID',
          'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
          'UNABLE_TO_GET_ISSUER_CERT', 'CERT_NOT_YET_VALID'].includes(code)
          ? 'IPV4_TLS_CERT_FAILED' : 'IPV4_TLS_CONNECT_FAILED');
      });
    } catch {
      done('IPV4_TLS_CONNECT_FAILED');
    }
  });
}

/** Read the running *Staging* app's direct-loopback health record.
 * The deploy launcher loads DEPLOY_SHA via Node --env-file=.env.staging,
 * which is NOT necessarily visible in the PM2 supervisor environment.
 * Never print or return the full health payload (it can include worker state).
 */
export async function readStagingLoopbackHealth({ getImpl = httpGet } = {}) {
  return await new Promise(resolve => {
    let settled = false;
    let request = null;
    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      request?.destroy?.();
      done(null);
    }, 5500);
    try {
      request = getImpl('http://127.0.0.1:18083/api/health',
        { timeout: 5000 }, response => {
          if (response.statusCode !== 200) {
            response.resume?.();
            done(null);
            return;
          }
          const chunks = [];
          let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > 131072) {
              response.destroy?.();
              done(null);
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', () => done(null));
          response.on('end', () => {
            let body = null;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
            if (body?.ok !== true || body?.service !== 'api-server'
              || body?.route !== '/api/health') {
              done(null);
              return;
            }
            const runtimeSha = safeSha(body.processDeploySha);
            const markerSha = safeSha(body.deployMarkerSha);
            if (!runtimeSha || !markerSha || safeSha(body.deploySha) !== runtimeSha) {
              done(null);
              return;
            }
            done({
              runtimeSha,
              markerSha,
              identityMatch: body.identityMatch === true,
            });
          });
        });
      request.on('timeout', () => request.destroy());
      request.on('error', () => done(null));
    } catch {
      done(null);
    }
  });
}

export function stagingTelegramVerdict(report) {
  if (!report.targetSha) return 'INVALID_EXACT_MAIN_SHA';
  if (!report.pm2Online) return 'STAGING_PM2_OFFLINE';
  if (!report.runtimeSha || !report.healthMarkerSha)
    return 'STAGING_RUNTIME_HEALTH_UNAVAILABLE';
  if (!report.markerSha || report.healthMarkerSha !== report.markerSha
    || report.runtimeSha !== report.markerSha
    || report.healthIdentityMatch !== true)
    return 'STAGING_RUNTIME_SHA_MISMATCH';
  if (report.pm2Sha && report.pm2Sha !== report.runtimeSha)
    return 'STAGING_PM2_ENV_CONFLICT';
  if (report.runtimeSha !== report.targetSha) return 'STAGING_RUNTIME_NOT_AT_MAIN';
  if (report.networkPath !== 'IPV4_TLS_READY') return 'STAGING_TELEGRAM_NETWORK_BLOCKED';
  return STAGING_REQUIRED_STATUS;
}

export async function runStagingReadOnlyProbe({
  target = process.env.TELEGRAM_STAGING_TARGET_SHA,
  pm2Exec = execFileSync,
  fileRead = readFileSync,
  health = readStagingLoopbackHealth,
  network = probeStagingTelegramNetwork,
} = {}) {
  const result = {
    schemaVersion: 'telegram-only-staging-readonly-v1',
    scope: 'TELEGRAM_ONLY_STAGING_NETWORK',
    targetSha: safeSha(target),
    pm2Sha: null, markerSha: null, pm2Online: false,
    runtimeSha: null, healthMarkerSha: null, healthIdentityMatch: false,
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
  try {
    const check = await health();
    result.runtimeSha = safeSha(check?.runtimeSha);
    result.healthMarkerSha = safeSha(check?.markerSha);
    result.healthIdentityMatch = check?.identityMatch === true;
  } catch { /* no raw health response or transport errors are ever printed */ }
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
