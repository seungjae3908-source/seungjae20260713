#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { Resolver, resolve4 as systemResolve4 } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

const CONFIG_URL = new URL('./production-endpoints.json', import.meta.url);
const DNS_TIMEOUT_MS = 8_000;
const HTTP_TIMEOUT_MS = 15_000;
const SHA_RE = /^[0-9a-f]{40}$/u;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function uniqueSorted(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].sort();
}

async function resolveSystem(hostname) {
  return uniqueSorted(await withTimeout(systemResolve4(hostname), DNS_TIMEOUT_MS, 'SYSTEM_DNS'));
}

async function resolveWithServer(hostname, server, label) {
  const resolver = new Resolver();
  resolver.setServers([server]);
  return uniqueSorted(await withTimeout(resolver.resolve4(hostname), DNS_TIMEOUT_MS, `${label}_DNS`));
}

async function checkDns(hostname, expectedIpv4) {
  const resolvers = [
    ['system', () => resolveSystem(hostname)],
    ['cloudflare-1.1.1.1', () => resolveWithServer(hostname, '1.1.1.1', 'CLOUDFLARE')],
    ['google-8.8.8.8', () => resolveWithServer(hostname, '8.8.8.8', 'GOOGLE')],
  ];
  const evidence = {};
  const errors = [];

  for (const [name, run] of resolvers) {
    try {
      const addresses = await run();
      const expectedPresent = addresses.includes(expectedIpv4);
      evidence[name] = { ok: addresses.length > 0 && expectedPresent, addresses, expectedPresent };
      if (addresses.length === 0) errors.push(`${hostname}:${name}:DNS_EMPTY`);
      else if (!expectedPresent) errors.push(`${hostname}:${name}:EXPECTED_IPV4_MISSING:${expectedIpv4}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      evidence[name] = { ok: false, addresses: [], error: message };
      errors.push(`${hostname}:${name}:DNS_ERROR:${message}`);
    }
  }

  return { evidence, errors };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('HTTP_TIMEOUT')), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'investment-platform-production-domain-monitor/1.0',
        ...(options.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export function healthPayloadErrors(payload) {
  const errors = [];
  if (payload?.ok !== true) errors.push('HEALTH_OK_FALSE');
  if (payload?.route !== '/api/health') errors.push('HEALTH_ROUTE_MISMATCH');

  const deploySha = String(payload?.deploySha ?? '').toLowerCase();
  const processDeploySha = String(payload?.processDeploySha ?? '').toLowerCase();
  const deployMarkerSha = String(payload?.deployMarkerSha ?? '').toLowerCase();

  if (!SHA_RE.test(deploySha)) errors.push('DEPLOY_SHA_INVALID');
  if (!SHA_RE.test(processDeploySha)) errors.push('PROCESS_DEPLOY_SHA_INVALID');
  if (!SHA_RE.test(deployMarkerSha)) errors.push('DEPLOY_MARKER_SHA_INVALID');
  if (deploySha && processDeploySha && deploySha !== processDeploySha) errors.push('PROCESS_DEPLOY_SHA_MISMATCH');
  if (deploySha && deployMarkerSha && deploySha !== deployMarkerSha) errors.push('DEPLOY_MARKER_SHA_MISMATCH');
  if (payload?.identityMatch !== true) errors.push('IDENTITY_MATCH_FALSE');
  if (payload?.identityStatus !== 'match') errors.push('IDENTITY_STATUS_NOT_MATCH');
  return errors;
}

async function checkHttps(baseUrl) {
  try {
    const response = await fetchWithTimeout(baseUrl, { method: 'GET' });
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP_${response.status}` };
    }
    await response.arrayBuffer();
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkHealth(baseUrl) {
  const healthUrl = new URL('/api/health', baseUrl).toString();
  try {
    const response = await fetchWithTimeout(healthUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      return { ok: false, status: response.status, payload: null, errors: [`HTTP_${response.status}`] };
    }
    const payload = await response.json();
    const errors = healthPayloadErrors(payload);
    return {
      ok: errors.length === 0,
      status: response.status,
      payload,
      errors,
      deploySha: String(payload?.deploySha ?? '').toLowerCase() || null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: null, payload: null, errors: [`HEALTH_FETCH_ERROR:${message}`], deploySha: null };
  }
}

async function checkEndpoint(endpoint, expectedIpv4) {
  const dns = await checkDns(endpoint.hostname, expectedIpv4);
  const https = await checkHttps(endpoint.baseUrl);
  const health = await checkHealth(endpoint.baseUrl);
  const errors = [...dns.errors];
  if (!https.ok) errors.push(`${endpoint.hostname}:HTTPS_ERROR:${https.error ?? https.status ?? 'UNKNOWN'}`);
  if (!health.ok) errors.push(...health.errors.map((error) => `${endpoint.hostname}:${error}`));

  return {
    name: endpoint.name,
    hostname: endpoint.hostname,
    baseUrl: endpoint.baseUrl,
    dns: dns.evidence,
    https,
    health,
    errors,
    ok: errors.length === 0,
  };
}

export function parityErrors(primary, fallback) {
  const errors = [];
  const primarySha = primary?.health?.deploySha;
  const fallbackSha = fallback?.health?.deploySha;
  if (!primarySha || !fallbackSha) errors.push('DEPLOY_SHA_PARITY_UNAVAILABLE');
  else if (primarySha !== fallbackSha) errors.push(`DEPLOY_SHA_MISMATCH:${primarySha}:${fallbackSha}`);
  return errors;
}

function boolLabel(value) {
  return value ? 'PASS' : 'FAIL';
}

function dnsLabel(evidence) {
  return evidence?.ok ? `PASS (${evidence.addresses.join(',')})` : `FAIL (${evidence?.error ?? evidence?.addresses?.join(',') ?? 'unknown'})`;
}

async function writeSummary(config, primary, fallback, parity) {
  const rows = [primary, fallback];
  const lines = [
    '## Production Domain Health Monitor',
    '',
    `- Primary: \`${config.primary.baseUrl}\``,
    `- Fallback: \`${config.fallback.baseUrl}\``,
    `- Expected IPv4: \`${config.expectedIpv4}\``,
    `- Endpoint deploy SHA parity: **${parity.length === 0 ? 'PASS' : 'FAIL'}**`,
    '',
    '| endpoint | system DNS | 1.1.1.1 | 8.8.8.8 | HTTPS/TLS | /api/health | deploy SHA |',
    '|---|---|---|---|---|---|---|',
  ];

  for (const row of rows) {
    lines.push(`| ${row.name} | ${dnsLabel(row.dns.system)} | ${dnsLabel(row.dns['cloudflare-1.1.1.1'])} | ${dnsLabel(row.dns['google-8.8.8.8'])} | ${boolLabel(row.https.ok)} | ${boolLabel(row.health.ok)} | ${row.health.deploySha ?? 'N/A'} |`);
  }

  const allErrors = [...primary.errors, ...fallback.errors, ...parity];
  if (allErrors.length) {
    lines.push('', '### Failures', '', ...allErrors.map((error) => `- \`${error}\``));
  }

  lines.push('', '- Read-only checks only; no Production/DB/server/trading mutation is performed.');
  const text = `${lines.join('\n')}\n`;
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, text, 'utf8');
  }
}

export async function runMonitor(config) {
  const primary = await checkEndpoint(config.primary, config.expectedIpv4);
  const fallback = await checkEndpoint(config.fallback, config.expectedIpv4);
  const parity = parityErrors(primary, fallback);
  await writeSummary(config, primary, fallback, parity);
  return { primary, fallback, parity, ok: primary.ok && fallback.ok && parity.length === 0 };
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG_URL, 'utf8'));
  if (config?.schemaVersion !== 1) throw new Error('PRODUCTION_ENDPOINT_SCHEMA_UNSUPPORTED');
  if (config?.mode !== 'PRIMARY_WITH_MANUAL_FALLBACK') throw new Error('PRODUCTION_ENDPOINT_MODE_UNSUPPORTED');
  if (!config?.expectedIpv4) throw new Error('EXPECTED_IPV4_REQUIRED');
  if (!config?.primary?.hostname || !config?.primary?.baseUrl) throw new Error('PRIMARY_ENDPOINT_REQUIRED');
  if (!config?.fallback?.hostname || !config?.fallback?.baseUrl) throw new Error('FALLBACK_ENDPOINT_REQUIRED');

  const result = await runMonitor(config);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
