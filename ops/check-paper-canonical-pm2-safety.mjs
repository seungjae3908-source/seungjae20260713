#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PAPER_CANONICAL_PM2_SAFETY_PROBE_VERSION =
  'paper-canonical-pm2-safety-probe-v1';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function off(value) {
  return value === undefined || value === false || value === 'false' || value === '0';
}

export function validatePaperCanonicalPm2Safety(rows, processName = 'stock-app') {
  if (!Array.isArray(rows)) fail('PAPER_CANONICAL_PM2_LIST_INVALID');
  const matches = rows.filter((row) => row?.name === processName);
  if (matches.length !== 1 || !matches[0]?.pm2_env || typeof matches[0].pm2_env !== 'object') {
    fail('PAPER_CANONICAL_PM2_PROCESS_AMBIGUOUS_OR_MISSING');
  }
  const env = matches[0].pm2_env;
  if (env.status !== 'online') fail('PAPER_CANONICAL_PM2_PROCESS_NOT_ONLINE');
  if (!off(env.LIVE_TRADING)
    || !off(env.AUTO_TRADING)
    || !off(env.REAL_ORDER_ENABLED)
    || !off(env.PRIVATE_TRADING_API_ALLOWED)) {
    fail('PAPER_CANONICAL_PM2_TRADING_SAFETY_FLAG_ELEVATED');
  }
  const authority = String(env.executionAuthority ?? env.EXECUTION_AUTHORITY ?? 'NONE').trim().toUpperCase();
  if (authority !== 'NONE') fail('PAPER_CANONICAL_PM2_EXECUTION_AUTHORITY_ELEVATED');
  return Object.freeze({
    schemaVersion: PAPER_CANONICAL_PM2_SAFETY_PROBE_VERSION,
    processOnline: true,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: 'NONE',
  });
}

const invokedAsScript = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  try {
    const raw = readFileSync(0, 'utf8');
    const rows = JSON.parse(raw);
    validatePaperCanonicalPm2Safety(rows);
    // Deliberately emit nothing: PM2 environment values stay server-side.
  } catch (error) {
    const code = typeof error?.code === 'string'
      ? error.code
      : 'PAPER_CANONICAL_PM2_SAFETY_PROBE_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
