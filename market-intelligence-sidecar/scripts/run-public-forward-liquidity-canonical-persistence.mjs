#!/usr/bin/env node

import { open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PUBLIC_FORWARD_LIQUIDITY_CANONICAL_STORE_CONTRACT,
  buildPublicForwardLiquidityCanonicalSplitSource,
  canonicalLiquidityJson,
  persistPublicForwardLiquidityCanonicalCaptures,
} from '../src/public-forward-liquidity-canonical-persistence.mjs';

const HELP = `Usage:
  node market-intelligence-sidecar/scripts/run-public-forward-liquidity-canonical-persistence.mjs \\
    --state-root <existing-absolute-path> \\
    --research-repo-root <absolute-path> \\
    --producer-sha <40-char-lowercase-sha> \\
    --capture-manifest <manifest.json> [--capture-manifest <manifest.json> ...] \\
    [--output <new-report-path>] \\
    [--split-source-output <new-independent-source-path>]

Each manifest must contain:
  schemaVersion: public-forward-liquidity-canonical-capture-manifest-v1
  expectedRepository, rawArtifact, receiptArtifact
  batchPath, captureReceiptPath, artifactReceiptPath

Referenced JSON paths must be relative to and remain inside the manifest directory.
This command uses local immutable artifact downloads only. It does not call a network,
private API, trading API, split/OOS validator, or calibration producer.
`;

function parseArguments(argv) {
  const result = { captureManifestPaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`ARGUMENT_VALUE_MISSING:${argument}`);
    index += 1;
    if (argument === '--state-root') result.stateRoot = value;
    else if (argument === '--research-repo-root') result.researchRepoRoot = value;
    else if (argument === '--producer-sha') result.producerCodeSha = value;
    else if (argument === '--capture-manifest') result.captureManifestPaths.push(value);
    else if (argument === '--output') result.outputPath = value;
    else if (argument === '--split-source-output') result.splitSourceOutputPath = value;
    else throw new Error(`ARGUMENT_UNKNOWN:${argument}`);
  }
  if (!result.stateRoot) throw new Error('STATE_ROOT_REQUIRED');
  if (!result.researchRepoRoot) throw new Error('RESEARCH_REPO_ROOT_REQUIRED');
  if (!result.producerCodeSha) throw new Error('PRODUCER_SHA_REQUIRED');
  if (result.captureManifestPaths.length === 0) throw new Error('CAPTURE_MANIFEST_REQUIRED');
  return result;
}

function containedPath(manifestPath, childPath, field) {
  if (typeof childPath !== 'string' || !childPath.trim() || isAbsolute(childPath)) {
    throw new Error(`CAPTURE_MANIFEST_${field}_MUST_BE_RELATIVE`);
  }
  const root = dirname(resolve(manifestPath));
  const target = resolve(root, childPath);
  const relation = relative(root, target);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`CAPTURE_MANIFEST_${field}_ESCAPES_DIRECTORY`);
  }
  return target;
}

async function json(path, code) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${code}:${String(error?.message ?? error)}`);
  }
}

async function loadCaptureManifest(manifestPath) {
  const absoluteManifestPath = resolve(manifestPath);
  const manifest = await json(absoluteManifestPath, 'CAPTURE_MANIFEST_READ_FAILED');
  if (manifest?.schemaVersion !== 'public-forward-liquidity-canonical-capture-manifest-v1') {
    throw new Error('CAPTURE_MANIFEST_CONTRACT_INVALID');
  }
  const [batch, captureReceipt, artifactReceipt] = await Promise.all([
    json(containedPath(absoluteManifestPath, manifest.batchPath, 'BATCH_PATH'), 'CAPTURE_BATCH_READ_FAILED'),
    json(
      containedPath(absoluteManifestPath, manifest.captureReceiptPath, 'CAPTURE_RECEIPT_PATH'),
      'CAPTURE_RECEIPT_READ_FAILED',
    ),
    json(
      containedPath(absoluteManifestPath, manifest.artifactReceiptPath, 'ARTIFACT_RECEIPT_PATH'),
      'CAPTURE_ARTIFACT_RECEIPT_READ_FAILED',
    ),
  ]);
  return {
    expectedRepository: manifest.expectedRepository,
    rawArtifact: manifest.rawArtifact,
    receiptArtifact: manifest.receiptArtifact,
    batch,
    captureReceipt,
    artifactReceipt,
  };
}

async function writeNewFile(path, value) {
  const handle = await open(resolve(path), 'wx', 0o600);
  try {
    await handle.writeFile(`${canonicalLiquidityJson(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return null;
  }
  const captures = await Promise.all(args.captureManifestPaths.map(loadCaptureManifest));
  const result = await persistPublicForwardLiquidityCanonicalCaptures({
    stateRoot: args.stateRoot,
    researchRepoRoot: args.researchRepoRoot,
    storeContract: PUBLIC_FORWARD_LIQUIDITY_CANONICAL_STORE_CONTRACT,
    producerCodeSha: args.producerCodeSha,
    captures,
  });
  const splitSource = buildPublicForwardLiquidityCanonicalSplitSource(result.dataset);
  if (args.outputPath) await writeNewFile(args.outputPath, result.report);
  if (args.splitSourceOutputPath) await writeNewFile(args.splitSourceOutputPath, splitSource);
  process.stdout.write(`${canonicalLiquidityJson(result.report)}\n`);
  return Object.freeze({ ...result, splitSource });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  run().catch((error) => {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
