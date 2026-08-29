#!/usr/bin/env node

import { open, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../src/public-forward-liquidity-calibration.mjs';
import {
  validatePublicForwardLiquiditySourceManifestLayout,
} from './run-public-forward-liquidity-independence-audit.mjs';
import {
  producePublicForwardLiquidityHeldOutOosArtifact,
} from '../src/public-forward-liquidity-oos-outcome-producer.mjs';

const HELP = `Usage:
  node market-intelligence-sidecar/scripts/run-public-forward-liquidity-oos-outcome-producer.mjs \\
    --split-receipt <authenticated-813-split-receipt.json> \\
    --methodology <pre-frozen-oos-methodology.json> \\
    --source-manifest <public-forward-liquidity-bound-source-manifest-v1.json> \\
    --producer-sha <exact-40-character-git-sha> \\
    [--output <new-immutable-outcome-artifact.json>]

The command is inert under --help and never auto-discovers inputs.
It reads existing receipt-bound canonical Research state only, uses genuine
post-event PUBLIC_FORWARD book observations already bound to those datasets,
and writes only an explicitly requested new local output file with O_EXCL.
It performs no network request, Research state mutation, calibration fit,
liquidity-cost production, schedule activation, private API, or order action.
`;

function parse(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help' || key === '-h') return { help: true };
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`ARGUMENT_VALUE_MISSING:${key}`);
    index += 1;
    if (key === '--split-receipt') args.splitReceipt = value;
    else if (key === '--methodology') args.methodology = value;
    else if (key === '--source-manifest') args.sourceManifest = value;
    else if (key === '--producer-sha') args.producerSha = value;
    else if (key === '--output') args.output = value;
    else throw new Error(`ARGUMENT_UNKNOWN:${key}`);
  }
  for (const key of ['splitReceipt', 'methodology', 'sourceManifest', 'producerSha']) {
    if (!args[key]) throw new Error(`ARGUMENT_REQUIRED:${key}`);
  }
  return args;
}

async function json(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

function isInside(parent, child) {
  const normalizedParent = `${resolve(parent)}${sep}`.toLowerCase();
  const normalizedChild = `${resolve(child)}${sep}`.toLowerCase();
  return normalizedChild.startsWith(normalizedParent);
}

async function sourcesFromManifest(path) {
  const manifest = await json(path);
  const { stateRoot, researchRepoRoot } = validatePublicForwardLiquiditySourceManifestLayout(manifest);
  const sources = await Promise.all(manifest.sources.map(async (source) => {
    const receiptPaths = Array.isArray(source.ingestReceiptPaths)
      ? source.ingestReceiptPaths
      : [source.ingestReceiptPath];
    const [dataset, ingestReceipts] = await Promise.all([
      json(source.datasetPath),
      Promise.all(receiptPaths.map((receiptPath) => json(receiptPath))),
    ]);
    const datasetPath = resolve(source.datasetPath);
    if (!isInside(stateRoot, datasetPath) && datasetPath !== resolve(stateRoot)) {
      throw new Error('SOURCE_DATASET_OUTSIDE_STATE_ROOT');
    }
    const datasetRelativePath = relative(stateRoot, datasetPath);
    if (!datasetRelativePath
      || isAbsolute(datasetRelativePath)
      || datasetRelativePath.split(/[\\/]+/u).some((segment) => segment === '..')) {
      throw new Error('SOURCE_DATASET_OUTSIDE_STATE_ROOT');
    }
    if (isInside(researchRepoRoot, datasetPath) || isInside(datasetPath, researchRepoRoot)) {
      throw new Error('SOURCE_STATE_ROOT_OVERLAPS_RESEARCH_CHECKOUT');
    }
    return Object.freeze({
      dataset,
      ingestReceipts: Object.freeze(ingestReceipts),
      datasetRelativePath: datasetRelativePath.replaceAll(String.fromCharCode(92), '/'),
    });
  }));
  return Object.freeze(sources);
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
  const [splitReceipt, methodology, sources] = await Promise.all([
    json(args.splitReceipt),
    json(args.methodology),
    sourcesFromManifest(args.sourceManifest),
  ]);
  const artifact = producePublicForwardLiquidityHeldOutOosArtifact({
    splitReceipt,
    methodology,
    sources,
    outcomeProducerCodeSha: args.producerSha,
  });
  if (args.output) await writeNew(args.output, artifact);
  process.stdout.write(`${canonicalJson(artifact)}\n`);
  if (artifact.status !== 'PRESENT') process.exitCode = 2;
  return artifact;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  run().catch((error) => {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
