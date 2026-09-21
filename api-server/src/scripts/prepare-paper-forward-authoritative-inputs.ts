#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

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

const inputPath = argument('--input');
const outputDir = argument('--output-dir');
if (!inputPath || !outputDir || !isAbsolute(inputPath) || !isAbsolute(outputDir)) {
  console.error('usage: prepare-paper-forward-authoritative-inputs --input <absolute-json> --output-dir <absolute-dir>');
  process.exit(64);
}

const manifest = await readJson(resolve(inputPath));
const result = await preparePaperForwardAuthoritativeInputs(manifest as Parameters<typeof preparePaperForwardAuthoritativeInputs>[0]);

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
