#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  V3LiquidityIndependencePublisherError,
  publishV3LiquidityIndependenceSummary,
  validateV3LiquidityIndependenceSummary,
} from '../src/v3-liquidity-independence-state-publisher.mjs';

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DANGEROUS_ENV_KEYS = Object.freeze([
  'LIVE_TRADING',
  'LIVE_TRADING_ENABLED',
  'REAL_ORDER_ENABLED',
  'REAL_TRADING_ENABLED',
  'PRIVATE_API_ENABLED',
  'PRIVATE_ACCOUNT_ACCESS',
  'PRIVATE_TRADING_API_ALLOWED',
  'ORDER_AUTHORITY',
  'ORDER_SUBMISSION_ENABLED',
]);
const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enabled']);

export class V3IndependenceProductionCallerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'V3IndependenceProductionCallerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new V3IndependenceProductionCallerError(code, message);
}

function assertNoAuthorityEscalation(environment) {
  for (const key of DANGEROUS_ENV_KEYS) {
    const value = String(environment?.[key] ?? '').trim().toLowerCase();
    if (TRUTHY.has(value)) {
      fail('AUTHORITY_ESCALATION_BLOCKED', `${key} must not be enabled for Research publication`);
    }
  }
}

async function verifyCodeIdentity(repoRoot, expectedCodeSha) {
  if (!SHA_PATTERN.test(String(expectedCodeSha ?? ''))) {
    fail('CODE_IDENTITY_INVALID', 'expectedCodeSha must be an exact lowercase 40-character SHA');
  }
  if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot)) {
    fail('CODE_IDENTITY_INVALID', 'repoRoot must be an absolute path');
  }
  const resolvedInput = resolve(repoRoot);
  let metadata;
  try {
    metadata = await lstat(resolvedInput);
  } catch {
    fail('CODE_IDENTITY_INVALID', 'repoRoot does not exist');
  }
  if (!metadata.isDirectory()) {
    fail('CODE_IDENTITY_INVALID', 'repoRoot must be a directory');
  }
  const physicalRoot = await realpath(resolvedInput);
  let stdout;
  try {
    ({ stdout } = await execFileAsync('git', ['-C', physicalRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      windowsHide: true,
    }));
  } catch {
    fail('CODE_IDENTITY_INVALID', 'repoRoot is not a readable Git checkout');
  }
  const actualSha = String(stdout ?? '').trim().toLowerCase();
  if (actualSha !== expectedCodeSha) {
    fail('CODE_IDENTITY_MISMATCH', `Research caller checkout mismatch: expected=${expectedCodeSha} actual=${actualSha}`);
  }
  return Object.freeze({ repoRoot: physicalRoot, codeSha: actualSha });
}

async function readJsonObject(path, label) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    fail('INPUT_UNREADABLE', `${label} is not readable`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('INPUT_INVALID', `${label} is not valid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INPUT_INVALID', `${label} must contain a JSON object`);
  }
  return Object.freeze({ text, value });
}

export async function runV3IndependenceProductionPublication({
  stateRoot,
  summaryFile,
  sourceFile,
  repoRoot,
  expectedCodeSha,
  environment = process.env,
}) {
  assertNoAuthorityEscalation(environment);
  const identity = await verifyCodeIdentity(repoRoot, expectedCodeSha);
  const summaryInput = await readJsonObject(summaryFile, 'summaryFile');
  const sourceInput = await readJsonObject(sourceFile, 'sourceFile');
  const validatedSummary = validateV3LiquidityIndependenceSummary(summaryInput.value);

  const publication = await publishV3LiquidityIndependenceSummary({
    stateRoot,
    summaryText: summaryInput.text,
    authenticatedSource: sourceInput.value,
  });

  const exactTarget = resolve(
    stateRoot,
    'forward',
    'liquidity',
    'v3-authoritative-independence-summary.json',
  );
  if (resolve(publication.targetPath) !== exactTarget) {
    fail('TARGET_PATH_MISMATCH', 'publisher returned an unexpected Research state target path');
  }

  return Object.freeze({
    schemaVersion: 'research-v3-independence-production-publication-result-v1',
    status: publication.status,
    codeSha: identity.codeSha,
    stateRoot: resolve(stateRoot),
    targetPath: publication.targetPath,
    targetSlotIndex: validatedSummary.targetSlotIndex,
    reportDigest: validatedSummary.reportDigest,
    fileDigest: publication.fileDigest,
    effectiveIndependentN: validatedSummary.effectiveIndependentN,
    independentBuyN: validatedSummary.independentBuyN,
    independentSellN: validatedSummary.independentSellN,
    frozenSplitCounts: validatedSummary.frozenSplitCounts,
    oosOutcomeCredit: 0,
    calibrationArtifactProduced: false,
    fullCostReady: false,
    evidenceComplete: 0,
    executionAuthority: 'NONE',
    liveTrading: false,
    privateApi: false,
    realOrders: 0,
    source: publication.source,
  });
}

function parseArgs(argv) {
  const args = {};
  const allowed = new Set([
    '--state-root',
    '--summary-file',
    '--source-file',
    '--repo-root',
    '--expected-code-sha',
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || value === undefined) {
      fail(
        'ARGUMENT_INVALID',
        'Usage: publish-v3-independence.mjs --state-root <path> --summary-file <path> --source-file <path> --repo-root <path> --expected-code-sha <sha>',
      );
    }
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      fail('ARGUMENT_INVALID', `duplicate argument: ${key}`);
    }
    args[key] = value;
  }
  for (const key of allowed) {
    if (!args[key]) fail('ARGUMENT_INVALID', `missing required argument: ${key}`);
  }
  return Object.freeze({
    stateRoot: args['--state-root'],
    summaryFile: args['--summary-file'],
    sourceFile: args['--source-file'],
    repoRoot: args['--repo-root'],
    expectedCodeSha: args['--expected-code-sha'],
  });
}

function failurePayload(error) {
  const code = error instanceof V3LiquidityIndependencePublisherError
    ? error.code
    : error instanceof V3IndependenceProductionCallerError
      ? error.code
      : 'UNEXPECTED_FAILURE';
  return {
    schemaVersion: 'research-v3-independence-production-publication-result-v1',
    status: 'FAILED',
    errorCode: code,
    message: String(error?.message ?? 'unknown error').slice(0, 600),
    executionAuthority: 'NONE',
    liveTrading: false,
    privateApi: false,
    realOrders: 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runV3IndependenceProductionPublication(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(failurePayload(error))}\n`);
    process.exitCode = 1;
  });
}
