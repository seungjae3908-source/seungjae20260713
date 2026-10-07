#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const SHA40 = /^[0-9a-f]{40}$/u;
const ALLOWED_PROFILES = new Set(['forward', 'fast-historical', 'long-history']);
const ALLOWED_SHADOW_GROUPS = new Set(['crypto-futures-15m', 'crypto-futures-1h']);

function parseArgs(argv) {
  const out = {};
  const allowed = new Set(['--state-root', '--research-sha', '--paper-root', '--env-file']);
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!allowed.has(key) || !value || value.startsWith('--') || Object.hasOwn(out, key)) {
      throw new Error('RESEARCH_FORWARD_DIAGNOSTIC_ARGUMENTS_INVALID');
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { __invalidJson: true };
  }
}

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function envValue(text, key) {
  const line = String(text ?? '').split(/\r?\n/u)
    .find((row) => row.startsWith(key + '='));
  return line ? line.slice(key.length + 1).trim() : '';
}

function cleanCode(value) {
  const text = String(value ?? '').trim();
  return /^[A-Z][A-Z0-9_.:-]{0,119}$/u.test(text) ? text : 'UNKNOWN';
}

function taskProjection(task) {
  return Object.freeze({
    id: String(task?.id ?? '').slice(0, 120) || null,
    status: String(task?.status ?? '').slice(0, 32) || null,
    exitCode: Number.isSafeInteger(task?.exitCode) ? task.exitCode : null,
    timedOut: task?.timedOut === true,
  });
}

function shadowProjection(summary) {
  const groups = {};
  for (const [name, value] of Object.entries(summary?.groups ?? {})) {
    if (!ALLOWED_SHADOW_GROUPS.has(name)) continue;
    groups[name] = Object.freeze({
      status: String(value?.status ?? '').slice(0, 40) || null,
      blocker: cleanCode(value?.blocker),
      reason: cleanCode(value?.reason),
      missingRequiredFeatures: (Array.isArray(value?.missingRequiredFeatures) ? value.missingRequiredFeatures : [])
        .filter((item) => typeof item === 'string')
        .slice(0, 12),
      temporalEvidenceReadiness: value?.temporalEvidenceReadiness && typeof value.temporalEvidenceReadiness === 'object'
        ? Object.freeze({
            openInterestChange: String(value.temporalEvidenceReadiness?.openInterestChange?.status ?? '').slice(0, 80) || null,
            longShortBias: String(value.temporalEvidenceReadiness?.longShortBias?.status ?? '').slice(0, 80) || null,
            benchmarkReturn: String(value.temporalEvidenceReadiness?.benchmarkReturn?.status ?? '').slice(0, 80) || null,
            sentimentScore: String(value.temporalEvidenceReadiness?.sentimentScore?.status ?? '').slice(0, 80) || null,
            defaultFeatureFallbackAllowed: value.temporalEvidenceReadiness?.defaultFeatureFallbackAllowed === true,
            syntheticFeatureFallbackAllowed: value.temporalEvidenceReadiness?.syntheticFeatureFallbackAllowed === true,
          })
        : null,
    });
  }
  return Object.freeze(groups);
}

function paperSafetyValid(value) {
  return value?.executionAuthority === 'NONE'
    && value?.privateApiAllowed === false
    && value?.liveTrading === false
    && value?.financialMutationAllowed === false;
}

const options = parseArgs(process.argv);
const stateRoot = resolve(options['--state-root'] ?? process.env.RESEARCH_STATE_ROOT ?? '/var/lib/investment-research-production');
const researchSha = String(options['--research-sha'] ?? process.env.RESEARCH_CODE_SHA ?? '').trim().toLowerCase();
const paperRoot = resolve(options['--paper-root'] ?? '/opt/stock-app-data/paper-forward-v1');
const envFile = resolve(options['--env-file'] ?? '/etc/investment-research/research-production.env');
if (!SHA40.test(researchSha)) throw new Error('RESEARCH_FORWARD_DIAGNOSTIC_SHA_INVALID');

const blockers = [];
const forward = await readJson(join(stateRoot, 'latest', 'forward.json'));
let forwardProjection = null;
if (!forward || forward.__invalidJson) {
  blockers.push(forward?.__invalidJson ? 'FORWARD_EVIDENCE_INVALID_JSON' : 'FORWARD_EVIDENCE_MISSING');
} else {
  if (forward.schemaVersion !== 'research-production-cycle-v1' || forward.profile !== 'forward') {
    blockers.push('FORWARD_EVIDENCE_SCHEMA_INVALID');
  }
  if (String(forward.researchSha ?? '').toLowerCase() !== researchSha) blockers.push('FORWARD_SHA_MISMATCH');
  const tasks = (Array.isArray(forward.results) ? forward.results : []).map(taskProjection);
  const allSuccess = tasks.length > 0 && tasks.every((row) => row.status === 'success' && row.exitCode === 0 && row.timedOut === false);
  if (!allSuccess || Number(forward.successCount) !== Number(forward.taskCount)
    || Number(forward.blockedDataCount) !== 0 || Number(forward.failedCount) !== 0) {
    blockers.push('FORWARD_TASKS_NOT_ALL_SUCCESS');
  }
  forwardProjection = Object.freeze({
    status: String(forward.status ?? '').slice(0, 40) || null,
    researchSha: String(forward.researchSha ?? '').toLowerCase() || null,
    taskCount: Number.isSafeInteger(forward.taskCount) ? forward.taskCount : null,
    successCount: Number.isSafeInteger(forward.successCount) ? forward.successCount : null,
    blockedDataCount: Number.isSafeInteger(forward.blockedDataCount) ? forward.blockedDataCount : null,
    failedCount: Number.isSafeInteger(forward.failedCount) ? forward.failedCount : null,
    tasks,
  });
}

const bindingPath = join(paperRoot, 'publisher-binding.json');
const snapshotPath = join(paperRoot, 'publisher', 'paper-state-v2.json');
const [binding, snapshot] = await Promise.all([readJson(bindingPath), readJson(snapshotPath)]);
let paperProjection = null;
if (!binding || binding.__invalidJson) {
  blockers.push(binding?.__invalidJson ? 'PAPER_BINDING_INVALID_JSON' : 'PAPER_BINDING_MISSING');
}
if (!snapshot || snapshot.__invalidJson) {
  blockers.push(snapshot?.__invalidJson ? 'PAPER_SNAPSHOT_INVALID_JSON' : 'PAPER_SNAPSHOT_MISSING');
}
if (binding && !binding.__invalidJson && snapshot && !snapshot.__invalidJson) {
  const bindingValid = binding.schemaVersion === 'paper-state-publisher-runtime-binding-v1'
    && SHA40.test(String(binding.paperRuntimeSourceSha ?? '').toLowerCase())
    && resolve(String(binding.snapshotPath ?? '')) === snapshotPath
    && paperSafetyValid(binding);
  const snapshotValid = snapshot.schemaVersion === 'paper-trading-state-snapshot-v2'
    && SHA40.test(String(snapshot.sourceSha ?? '').toLowerCase())
    && paperSafetyValid(snapshot);
  if (!bindingValid) blockers.push('PAPER_BINDING_CONTRACT_INVALID');
  if (!snapshotValid) blockers.push('PAPER_SNAPSHOT_CONTRACT_INVALID');
  if (String(binding.paperRuntimeSourceSha ?? '').toLowerCase() !== researchSha) blockers.push('PAPER_BINDING_SHA_MISMATCH');
  if (String(snapshot.sourceSha ?? '').toLowerCase() !== researchSha) blockers.push('PAPER_SNAPSHOT_SHA_MISMATCH');
  const identityMatches = binding.paperRuntimeSourceSha === snapshot.sourceSha
    && binding.publisherAccountIdSha256 === snapshot.publisherAccountIdSha256;
  if (!identityMatches) blockers.push('PAPER_BINDING_SNAPSHOT_IDENTITY_MISMATCH');
  const observedAtMs = Number(snapshot.observedAtMs);
  const maximumAgeMs = Number(snapshot.maximumAgeMs);
  const now = Date.now();
  const fresh = Number.isFinite(observedAtMs) && observedAtMs > 0
    && Number.isFinite(maximumAgeMs) && maximumAgeMs > 0
    && observedAtMs <= now && now - observedAtMs <= maximumAgeMs;
  if (!fresh) blockers.push('PAPER_SNAPSHOT_STALE_OR_FUTURE');
  paperProjection = Object.freeze({
    bindingExists: true,
    snapshotExists: true,
    bindingSourceSha: String(binding.paperRuntimeSourceSha ?? '').toLowerCase() || null,
    snapshotSourceSha: String(snapshot.sourceSha ?? '').toLowerCase() || null,
    bindingMatchesResearchSha: String(binding.paperRuntimeSourceSha ?? '').toLowerCase() === researchSha,
    snapshotMatchesResearchSha: String(snapshot.sourceSha ?? '').toLowerCase() === researchSha,
    bindingSnapshotIdentityMatches: identityMatches,
    snapshotObservedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : null,
    snapshotMaximumAgeMs: Number.isFinite(maximumAgeMs) ? maximumAgeMs : null,
    snapshotFresh: fresh,
    executionAuthority: snapshot.executionAuthority ?? binding.executionAuthority ?? null,
    liveTrading: snapshot.liveTrading ?? binding.liveTrading ?? null,
  });
}

let envText = '';
try { envText = await readFile(envFile, 'utf8'); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
const supplementalPath = envValue(envText, 'PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH');
let supplementalStatus = 'MISSING_CONFIG';
if (supplementalPath) {
  if (!isAbsolute(supplementalPath)) {
    supplementalStatus = 'INVALID_PATH';
  } else if (!(await exists(supplementalPath))) {
    supplementalStatus = 'MISSING_FILE';
  } else {
    const supplemental = await readJson(supplementalPath);
    supplementalStatus = supplemental && !supplemental.__invalidJson ? 'READABLE_JSON' : 'INVALID_JSON';
  }
}
if (supplementalStatus !== 'READABLE_JSON') blockers.push('PAPER_SUPPLEMENTAL_COST_' + supplementalStatus);

const shadow = await readJson(join(stateRoot, 'forward', 'shadow-summary.json'));
let shadowGroups = Object.freeze({});
if (!shadow || shadow.__invalidJson) {
  blockers.push(shadow?.__invalidJson ? 'SHADOW_SUMMARY_INVALID_JSON' : 'SHADOW_SUMMARY_MISSING');
} else {
  shadowGroups = shadowProjection(shadow);
  for (const value of Object.values(shadowGroups)) {
    if (value.status !== 'pass') blockers.push('SHADOW_RUNTIME_NOT_PASS');
  }
}

const result = Object.freeze({
  schemaVersion: 'research-forward-runtime-diagnostic-v1',
  status: blockers.length === 0 ? 'READY' : 'BLOCKED',
  researchSha,
  forward: forwardProjection,
  paper: paperProjection,
  supplementalCost: Object.freeze({
    status: supplementalStatus,
    configured: Boolean(supplementalPath),
    readable: supplementalStatus === 'READABLE_JSON',
  }),
  shadow: Object.freeze({ groups: shadowGroups }),
  blockers: Object.freeze([...new Set(blockers)].sort()),
  credentialValuesExposed: false,
  publisherAccountDigestExposed: false,
  executionAuthority: 'NONE',
  liveTrading: false,
  privateTradingApiAllowed: false,
  realOrderEnabled: false,
});

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
if (result.status !== 'READY') process.exitCode = 2;
