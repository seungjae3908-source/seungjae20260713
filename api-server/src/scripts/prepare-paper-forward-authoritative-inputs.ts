#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  preparePaperForwardAuthoritativeInputs,
} from '../services/paper-forward-authoritative-input-preparation.service';

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() || null : null;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temp, path);
}

const usage = 'usage: prepare-paper-forward-authoritative-inputs --repo-root <absolute-repo-root> --input <absolute-json> --output-dir <absolute-dir>';
if (process.argv.includes('--help')) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}

const repoRoot = argument('--repo-root');
const inputPath = argument('--input');
const outputDir = argument('--output-dir');
if (!repoRoot || !inputPath || !outputDir
  || !isAbsolute(repoRoot) || !isAbsolute(inputPath) || !isAbsolute(outputDir)) {
  console.error(usage);
  process.exit(64);
}

const canonicalRepoRoot = resolve(repoRoot);
const liquidityModulePath = resolve(
  canonicalRepoRoot,
  'market-intelligence-sidecar/src/public-forward-liquidity-runtime-cost-evidence.mjs',
);
const liquidityModule = await import(pathToFileURL(liquidityModulePath).href);
if (typeof liquidityModule.buildPublicForwardLiquidityRuntimeCostEvidence !== 'function') {
  throw new Error('CANONICAL_LIQUIDITY_RUNTIME_BUILDER_EXPORT_MISSING');
}

const manifest = await readJson(resolve(inputPath));
const result = await preparePaperForwardAuthoritativeInputs(
  manifest as Parameters<typeof preparePaperForwardAuthoritativeInputs>[0],
  {
    buildLiquidity: liquidityModule.buildPublicForwardLiquidityRuntimeCostEvidence,
  },
);

await atomicJson(resolve(outputDir, 'preparation-receipt.json'), result);

if (result.status !== 'READY' || !result.riskPolicyRecord || !result.supplementalCostInput) {
  console.error(`PAPER_FORWARD_AUTHORITATIVE_INPUTS_BLOCKED:${result.blockers.join(',')}`);
  process.exitCode = 2;
} else {
  await atomicJson(resolve(outputDir, 'risk-policy-record.json'), result.riskPolicyRecord);
  await atomicJson(resolve(outputDir, 'supplemental-cost-evidence.json'), result.supplementalCostInput);
  process.stdout.write(`${JSON.stringify({
    status: 'READY',
    riskPolicyPath: resolve(outputDir, 'risk-policy-record.json'),
    supplementalCostPath: resolve(outputDir, 'supplemental-cost-evidence.json'),
    economicCreditCreated: false,
    executionAuthority: 'NONE',
  })}\n`);
}
