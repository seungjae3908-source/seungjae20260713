#!/usr/bin/env node

import { open, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../src/public-forward-liquidity-calibration.mjs';
import { buildPublicForwardLiquidityIndependentSplitSource } from '../src/public-forward-liquidity-independence-audit.mjs';

const SOURCE_MANIFEST_VERSION = 'public-forward-liquidity-bound-source-manifest-v1';

const HELP = `Usage:
  node market-intelligence-sidecar/scripts/run-public-forward-liquidity-independence-audit.mjs \\
    --source-manifest <bound-source-manifest.json> \\
    --producer-sha <exact-40-character-git-sha> \\
    [--output <new-report.json>]

This command is offline/read-only with respect to canonical Research state.
It verifies #811 ingest-receipt bindings for one or more existing #776 canonical
datasets, derives cross-batch unique/independent sample credit, and emits a
read-only split-source adapter. Frozen split integration remains NEEDS_INTEGRATION.
It performs no network, state-root, private API, order, OOS,
calibration-coefficient, or Full Cost mutation.
`;

function parse(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help' || key === '-h') return { help: true };
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`ARGUMENT_VALUE_MISSING:${key}`);
    index += 1;
    if (key === '--source-manifest') result.sourceManifest = value;
    else if (key === '--producer-sha') result.producerSha = value;
    else if (key === '--output') result.output = value;
    else throw new Error(`ARGUMENT_UNKNOWN:${key}`);
  }
  for (const key of ['sourceManifest', 'producerSha']) {
    if (!result[key]) throw new Error(`ARGUMENT_REQUIRED:${key}`);
  }
  return result;
}

async function json(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

async function sourcesFromManifest(path) {
  const manifest = await json(path);
  if (manifest?.schemaVersion !== SOURCE_MANIFEST_VERSION
    || typeof manifest.stateRoot !== 'string'
    || !Array.isArray(manifest.sources)
    || manifest.sources.length === 0) {
    throw new Error('SOURCE_MANIFEST_INVALID');
  }
  const stateRoot = resolve(manifest.stateRoot);
  return Promise.all(manifest.sources.map(async (source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || typeof source.datasetPath !== 'string'
      || typeof source.ingestReceiptPath !== 'string') {
      throw new Error('SOURCE_MANIFEST_ENTRY_INVALID');
    }
    const [dataset, ingestReceipt] = await Promise.all([
      json(source.datasetPath),
      json(source.ingestReceiptPath),
    ]);
    const datasetRelativePath = relative(stateRoot, resolve(source.datasetPath));
    if (!datasetRelativePath
      || isAbsolute(datasetRelativePath)
      || datasetRelativePath.split(/[\\/]+/u).some((segment) => segment === '..')) {
      throw new Error('SOURCE_DATASET_OUTSIDE_STATE_ROOT');
    }
    return {
      dataset,
      ingestReceipt,
      datasetRelativePath: datasetRelativePath.replace(/\\/gu, '/'),
    };
  }));
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
  const result = buildPublicForwardLiquidityIndependentSplitSource({
    sources: await sourcesFromManifest(args.sourceManifest),
    producerCodeSha: args.producerSha,
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
