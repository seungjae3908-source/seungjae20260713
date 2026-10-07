#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function cleanCode(value) {
  return String(value ?? 'UNKNOWN')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 120) || 'UNKNOWN';
}

function cleanProfile(value) {
  const profile = String(value ?? '').trim();
  return ['forward', 'fast-historical', 'long-history'].includes(profile) ? profile : 'unknown';
}

function projectRows(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 12).map((row) => ({
    profile: cleanProfile(row?.profile),
    reason: cleanCode(row?.reason),
    retryAfterAt: Number.isFinite(Number(row?.retryAfterAt)) ? Number(row.retryAfterAt) : null,
    cacheHit: row?.cacheHit === true,
    status: cleanCode(row?.status),
  }));
}

function parseArgs(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error('AI_DIAGNOSTIC_ARGUMENT_INVALID');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('AI_DIAGNOSTIC_ARGUMENT_MISSING');
    options[token.slice(2)] = value;
    index += 1;
  }
  return options;
}

try {
  const options = parseArgs(process.argv);
  const stateRoot = resolve(options['state-root'] ?? process.env.RESEARCH_STATE_ROOT ?? '/var/lib/investment-research-production');
  const expectedSha = String(options['research-sha'] ?? process.env.RESEARCH_CODE_SHA ?? '').trim().toLowerCase();
  const latestPath = join(stateRoot, 'ai-review', 'latest.json');
  let latest;
  try {
    latest = JSON.parse(await readFile(latestPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.log(JSON.stringify({
        schemaVersion: 'research-production-ai-diagnostic-v1',
        status: 'MISSING',
        researchSha: expectedSha || null,
        reason: 'AI_REVIEW_LATEST_MISSING',
        providerNetworkCalls: 0,
        cacheHits: 0,
        blockedProfiles: [],
        deferredProfiles: [],
        reviews: [],
        credentialValuesExposed: false,
        executionAuthority: 'NONE',
      }, null, 2));
      process.exit(2);
    }
    throw error;
  }

  if (latest?.schemaVersion !== 'research-production-ai-scan-v1') throw new Error('AI_REVIEW_LATEST_SCHEMA_INVALID');
  if (expectedSha && latest?.researchSha !== expectedSha) throw new Error('AI_REVIEW_LATEST_SHA_MISMATCH');

  console.log(JSON.stringify({
    schemaVersion: 'research-production-ai-diagnostic-v1',
    status: cleanCode(latest?.status),
    researchSha: String(latest?.researchSha ?? '').toLowerCase() || null,
    provider: ['gemini', 'groq'].includes(String(latest?.provider ?? '')) ? latest.provider : null,
    model: String(latest?.model ?? '').slice(0, 120) || null,
    providerNetworkCalls: Number.isSafeInteger(latest?.providerNetworkCalls) ? latest.providerNetworkCalls : 0,
    cacheHits: Number.isSafeInteger(latest?.cacheHits) ? latest.cacheHits : 0,
    profileCoverage: latest?.profileCoverage ?? null,
    blockedProfiles: projectRows(latest?.blockedProfiles),
    deferredProfiles: projectRows(latest?.deferredProfiles),
    reviews: projectRows(latest?.reviews),
    credentialValuesExposed: false,
    executionAuthority: 'NONE',
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    schemaVersion: 'research-production-ai-diagnostic-v1',
    status: 'FAILED_CLOSED',
    reason: cleanCode(error?.message),
    credentialValuesExposed: false,
    executionAuthority: 'NONE',
  }, null, 2));
  process.exitCode = 1;
}
