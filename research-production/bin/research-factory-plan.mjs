#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildResearchFactoryControlPlaneV1 } from '../src/research-factory-controller.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing required argument ${name}`);
  return process.argv[index + 1];
}

try {
  const inputPath = resolve(argument('--input'));
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const result = buildResearchFactoryControlPlaneV1(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 1,
    contract: 'research-factory-control-plane/v1',
    status: 'FAILED_CLOSED',
    error: String(error?.message ?? error).slice(0, 500),
    runtimeExecutionAttempted: false,
    liveTrading: false,
    autoTrading: false,
    executionAuthority: 'NONE',
  })}\n`);
  process.exitCode = 1;
}
