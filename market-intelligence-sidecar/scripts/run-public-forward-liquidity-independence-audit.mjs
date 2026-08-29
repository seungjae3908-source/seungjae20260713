#!/usr/bin/env node

import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../src/public-forward-liquidity-calibration.mjs';
import { auditPublicForwardLiquidityIndependentSplits } from '../src/public-forward-liquidity-independence-audit.mjs';

const HELP = `Usage:
  node market-intelligence-sidecar/scripts/run-public-forward-liquidity-independence-audit.mjs \\
    --dataset <canonical-dataset.json> \\
    --scope-bindings <scope-bindings.json> \\
    --regime-bindings <regime-bindings.json> \\
    --policy <frozen-split-policy.json> \\
    [--output <new-report.json>]

This command is offline/read-only with respect to canonical Research state.
It verifies the existing #776 canonical dataset, derives effective-independent
sample credit, then delegates chronological split/sufficiency to the merged
canonical split auditor. It performs no network, state-root, private API,
order, OOS, calibration-coefficient, or Full Cost mutation.
`;

function parse(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help' || key === '-h') return { help: true };
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`ARGUMENT_VALUE_MISSING:${key}`);
    index += 1;
    if (key === '--dataset') result.dataset = value;
    else if (key === '--scope-bindings') result.scopeBindings = value;
    else if (key === '--regime-bindings') result.regimeBindings = value;
    else if (key === '--policy') result.policy = value;
    else if (key === '--output') result.output = value;
    else throw new Error(`ARGUMENT_UNKNOWN:${key}`);
  }
  for (const key of ['dataset', 'scopeBindings', 'regimeBindings', 'policy']) {
    if (!result[key]) throw new Error(`ARGUMENT_REQUIRED:${key}`);
  }
  return result;
}

async function json(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

async function writeNew(path, value) {
  const handle = await open(resolve(path), 'wx', 0o600);
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function run(argv = process.argv.slice(2)) {
  const args = parse(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return null;
  }
  const [dataset, scopeBindings, regimeBindings, policy] = await Promise.all([
    json(args.dataset),
    json(args.scopeBindings),
    json(args.regimeBindings),
    json(args.policy),
  ]);
  const result = auditPublicForwardLiquidityIndependentSplits({
    dataset,
    scopeBindings,
    regimeBindings,
    policy,
  });
  if (args.output) await writeNew(args.output, result);
  process.stdout.write(`${canonicalJson(result)}\n`);
  if (result.status !== 'PRESENT') process.exitCode = 2;
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  run().catch((error) => {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
