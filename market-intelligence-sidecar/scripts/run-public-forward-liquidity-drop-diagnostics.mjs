#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  analyzePublicForwardLiquidityDropQuality,
  PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY,
} from '../src/public-forward-liquidity-drop-diagnostics.mjs';

function parseArgs(argv) {
  const parsed = { input: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--input') {
      parsed.input = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    throw new Error(`DROP_DIAGNOSTIC_UNKNOWN_ARGUMENT:${token}`);
  }
  return parsed;
}

async function main() {
  try {
    const { input } = parseArgs(process.argv.slice(2));
    if (!input) throw new Error('DROP_DIAGNOSTIC_INPUT_REQUIRED');

    const raw = await readFile(resolve(input), 'utf8');
    const payload = JSON.parse(raw);
    const report = analyzePublicForwardLiquidityDropQuality(payload);
    process.stdout.write(`${JSON.stringify({ status: 'DIAGNOSTIC_COMPLETE', report })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: 'BLOCKED_DATA',
      reason: String(error?.message ?? error ?? 'DROP_DIAGNOSTIC_FAILED'),
      safety: PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY,
    })}\n`);
    process.exitCode = 1;
  }
}

await main();
