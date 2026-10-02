#!/usr/bin/env node
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PAPER_CANONICAL_VALIDATION_FRESHNESS_PUBLISHER_VERSION =
  'paper-canonical-validation-freshness-publisher-v1';
export const POLICY_SCHEMA_VERSION =
  'paper-canonical-validation-receipt-freshness-policy-v1';
export const CANONICAL_PAPER_STATE_ROOT = '/opt/stock-app-data/paper-forward-v1';
export const POLICY_FILENAME = 'validation-receipt-policy.json';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function buildValidationFreshnessPolicy(maximumAgeMs) {
  if (!positiveSafeInteger(maximumAgeMs)) fail('VALIDATION_FRESHNESS_MAXIMUM_AGE_INVALID');
  return Object.freeze({
    schemaVersion: POLICY_SCHEMA_VERSION,
    maximumAgeMs,
    evidenceSource: 'FORWARD_RECOMMENDATION_OBSERVER',
    immutable: true,
    executionAuthority: 'NONE',
    financialMutationAllowed: false,
    replayBackfillSyntheticManualCredit: 0,
  });
}

function validatePolicy(value) {
  const expected = buildValidationFreshnessPolicy(Number(value?.maximumAgeMs));
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== expected.schemaVersion
    || value.evidenceSource !== expected.evidenceSource
    || value.immutable !== true
    || value.executionAuthority !== 'NONE'
    || value.financialMutationAllowed !== false
    || value.replayBackfillSyntheticManualCredit !== 0) {
    fail('VALIDATION_FRESHNESS_POLICY_INVALID');
  }
  return expected;
}

async function atomicWrite(path, text) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export async function publishValidationFreshnessPolicy({ stateRoot, maximumAgeMs }) {
  if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot)) fail('VALIDATION_FRESHNESS_STATE_ROOT_INVALID');
  const root = resolve(stateRoot);
  const target = join(root, POLICY_FILENAME);
  const policy = buildValidationFreshnessPolicy(maximumAgeMs);
  const serialized = `${JSON.stringify(policy, null, 2)}\n`;

  let status = 'PUBLISHED';
  let filesWritten = 1;
  try {
    const existingText = await readFile(target, 'utf8');
    let existing;
    try {
      existing = validatePolicy(JSON.parse(existingText));
    } catch {
      fail('VALIDATION_FRESHNESS_EXISTING_POLICY_INVALID');
    }
    if (JSON.stringify(existing) !== JSON.stringify(policy)) {
      fail('VALIDATION_FRESHNESS_POLICY_CHANGE_REQUIRES_NEW_VERSION');
    }
    status = 'ALREADY_PRESENT';
    filesWritten = 0;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(root, { recursive: true, mode: 0o700 });
    await atomicWrite(target, serialized);
  }

  const readback = validatePolicy(JSON.parse(await readFile(target, 'utf8')));
  if (JSON.stringify(readback) !== JSON.stringify(policy)) fail('VALIDATION_FRESHNESS_READBACK_MISMATCH');

  return Object.freeze({
    schemaVersion: PAPER_CANONICAL_VALIDATION_FRESHNESS_PUBLISHER_VERSION,
    status,
    operation: 'freshness-policy-publish',
    maximumAgeMs,
    targetPath: target,
    filesWritten,
    productionAppMutationPerformed: false,
    processRestartPerformed: false,
    environmentMutationPerformed: false,
    scheduleMutationPerformed: false,
    databaseMutationPerformed: false,
    privateApiUsed: false,
    orderSubmitted: false,
    liveTrading: false,
    executionAuthority: 'NONE',
  });
}

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? '';
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  try {
    const stateRoot = argument('state-root') || CANONICAL_PAPER_STATE_ROOT;
    const maximumAgeMs = Number(argument('maximum-age-ms'));
    if (resolve(stateRoot) !== CANONICAL_PAPER_STATE_ROOT) {
      fail('VALIDATION_FRESHNESS_CANONICAL_STATE_ROOT_REQUIRED');
    }
    const result = await publishValidationFreshnessPolicy({ stateRoot, maximumAgeMs });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: PAPER_CANONICAL_VALIDATION_FRESHNESS_PUBLISHER_VERSION,
      status: 'BLOCKED',
      code: typeof error?.code === 'string' ? error.code : 'VALIDATION_FRESHNESS_PUBLISH_FAILED',
      filesWritten: 0,
      productionAppMutationPerformed: false,
      processRestartPerformed: false,
      environmentMutationPerformed: false,
      scheduleMutationPerformed: false,
      databaseMutationPerformed: false,
      privateApiUsed: false,
      orderSubmitted: false,
      liveTrading: false,
      executionAuthority: 'NONE',
    })}\n`);
    process.exitCode = 1;
  }
}
