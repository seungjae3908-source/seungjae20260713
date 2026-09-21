#!/usr/bin/env node
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  createPaperForwardCanonicalPreparationDependencies,
  preparePaperForwardAuthoritativeRecords,
} from '../services/paper-forward-authoritative-record-preparation.service';

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function required(values: Record<string, string | boolean | undefined>, key: string): string {
  const value = values[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('MISSING_REQUIRED_ARGUMENT:' + key);
  }
  return value.trim();
}

function normalizedAbsolutePath(value: string, key: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error('PATH_MUST_BE_NORMALIZED_ABSOLUTE:' + key);
  }
  return value;
}

async function atomicWriteJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = filePath + '.tmp-' + process.pid;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, filePath);
}

async function main() {
  const { values } = parseArgs({
    options: {
      'repo-root': { type: 'string' },
      'target-sha': { type: 'string' },
      market: { type: 'string', default: 'CRYPTO_FUTURES' },
      symbol: { type: 'string' },
      'strategy-scope': { type: 'string' },
      side: { type: 'string' },
      'cost-policy-id': { type: 'string' },
      'risk-policy-input': { type: 'string' },
      'liquidity-input': { type: 'string' },
      'partial-fill-artifact': { type: 'string' },
      'partial-fill-expected': { type: 'string' },
      'risk-policy-output': { type: 'string' },
      'supplemental-output': { type: 'string' },
    },
    strict: true,
  });

  const repoRoot = normalizedAbsolutePath(required(values, 'repo-root'), 'repo-root');
  const targetSha = required(values, 'target-sha');
  const market = required(values, 'market');
  const symbol = required(values, 'symbol');
  const strategyScope = required(values, 'strategy-scope');
  const side = required(values, 'side');
  const costPolicyId = required(values, 'cost-policy-id');
  const riskPolicyInputPath = required(values, 'risk-policy-input');
  const liquidityInputPath = required(values, 'liquidity-input');
  const partialFillArtifactPath = required(values, 'partial-fill-artifact');
  const partialFillExpectedPath = required(values, 'partial-fill-expected');
  const riskPolicyOutput = normalizedAbsolutePath(
    required(values, 'risk-policy-output'),
    'risk-policy-output',
  );
  const supplementalOutput = normalizedAbsolutePath(
    required(values, 'supplemental-output'),
    'supplemental-output',
  );

  if (market !== 'CRYPTO_FUTURES') throw new Error('ONLY_CRYPTO_FUTURES_SUPPORTED');
  if (side !== 'LONG' && side !== 'SHORT') throw new Error('SIDE_MUST_BE_LONG_OR_SHORT');

  const [riskPolicyRecord, liquidityRuntimeInput, partialFillArtifact, partialFillExpected] =
    await Promise.all([
      readJson(riskPolicyInputPath),
      readJson(liquidityInputPath),
      readJson(partialFillArtifactPath),
      readJson(partialFillExpectedPath),
    ]);

  const dependencies = createPaperForwardCanonicalPreparationDependencies({ repoRoot });
  const result = await preparePaperForwardAuthoritativeRecords({
    targetSha,
    market,
    symbol,
    strategyScope,
    side,
    costPolicyId,
    riskPolicyRecord,
    liquidityRuntimeInput,
    partialFillArtifact: partialFillArtifact as never,
    partialFillExpected: partialFillExpected as never,
  }, dependencies);

  if (result.status !== 'PREPARED' || !result.riskPolicyRecord || !result.supplementalCostRecord) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = 2;
    return;
  }

  await atomicWriteJson(riskPolicyOutput, result.riskPolicyRecord);
  await atomicWriteJson(supplementalOutput, result.supplementalCostRecord);

  process.stdout.write(JSON.stringify({
    schemaVersion: 'paper-forward-authoritative-record-preparation-cli-v1',
    status: 'PREPARED',
    targetSha,
    riskPolicyOutput,
    supplementalOutput,
    economicCreditCreated: false,
    profitabilityCredit: 0,
    executionAuthority: 'NONE',
    privateTradingApiAllowed: false,
    liveTrading: false,
    realOrderEnabled: false,
    scheduleActivated: false,
    serverMutated: false,
  }, null, 2) + '\n');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
