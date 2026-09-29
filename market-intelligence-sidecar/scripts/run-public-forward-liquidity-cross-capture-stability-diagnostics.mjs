#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  analyzePublicForwardLiquidityCrossCaptureStability,
  PUBLIC_FORWARD_LIQUIDITY_CROSS_CAPTURE_STABILITY_SAFETY,
} from '../src/public-forward-liquidity-cross-capture-stability-diagnostics.mjs';

function parseArgs(argv) {
  const inputs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--input') {
      const value = argv[index + 1];
      if (!value) throw new Error('CROSS_CAPTURE_INPUT_PATH_REQUIRED');
      inputs.push(value);
      index += 1;
      continue;
    }
    throw new Error(`CROSS_CAPTURE_UNKNOWN_ARGUMENT:${token}`);
  }
  return inputs;
}

async function main() {
  try {
    const inputs = parseArgs(process.argv.slice(2));
    if (inputs.length < 2) throw new Error('CROSS_CAPTURE_AT_LEAST_TWO_INPUT_FILES_REQUIRED');
    const captures = await Promise.all(inputs.map(async (input) => {
      const raw = await readFile(resolve(input), 'utf8');
      return JSON.parse(raw);
    }));
    const report = analyzePublicForwardLiquidityCrossCaptureStability(captures);
    process.stdout.write(`${JSON.stringify({ status: 'DIAGNOSTIC_COMPLETE', report })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: 'BLOCKED_DATA',
      reason: String(error?.message ?? error ?? 'CROSS_CAPTURE_DIAGNOSTIC_FAILED'),
      safety: PUBLIC_FORWARD_LIQUIDITY_CROSS_CAPTURE_STABILITY_SAFETY,
    })}\n`);
    process.exitCode = 1;
  }
}

await main();
