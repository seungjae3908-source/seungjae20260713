#!/usr/bin/env node

import { open, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, sha256 } from '../src/public-forward-liquidity-calibration.mjs';
import { buildPublicForwardLiquidityIndependentSplitSource } from '../src/public-forward-liquidity-independence-audit.mjs';
import { auditPublicForwardLiquidityIndependentSplits } from '../src/public-forward-liquidity-multi-source-split-audit.mjs';

const SOURCE_MANIFEST_VERSION = 'public-forward-liquidity-bound-source-manifest-v1';
export const PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_RECEIPT_VERSION =
  'public-forward-liquidity-multi-source-split-receipt-v1';

const HELP = `Usage:
  node market-intelligence-sidecar/scripts/run-public-forward-liquidity-independence-audit.mjs \\
    --source-manifest <bound-source-manifest.json> \\
    --producer-sha <exact-40-character-git-sha> \\
    [--split-policy <frozen-split-policy.json> \\
     --scope-bindings <scope-bindings.json> \\
     --regime-bindings <regime-bindings.json>] \\
    [--output <new-report.json>]

This command is offline/read-only with respect to canonical Research state.
It verifies the complete ordered #811 ingest-receipt chain for one or more existing #776 canonical
datasets and derives cross-batch unique/independent sample credit. With the three
frozen-split inputs it also produces the authoritative read-only multi-source V2
split audit/receipt while preserving per-source dataset/receipt/collector lineage.
It never synthesizes one aggregate dataset/collector identity and performs no
network, state-root, private API, order, OOS, calibration-coefficient, or Full Cost mutation.
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
    else if (key === '--split-policy') result.splitPolicy = value;
    else if (key === '--scope-bindings') result.scopeBindings = value;
    else if (key === '--regime-bindings') result.regimeBindings = value;
    else if (key === '--output') result.output = value;
    else throw new Error(`ARGUMENT_UNKNOWN:${key}`);
  }
  for (const key of ['sourceManifest', 'producerSha']) {
    if (!result[key]) throw new Error(`ARGUMENT_REQUIRED:${key}`);
  }
  const v2Inputs = ['splitPolicy', 'scopeBindings', 'regimeBindings'];
  const supplied = v2Inputs.filter((key) => Boolean(result[key]));
  if (supplied.length !== 0 && supplied.length !== v2Inputs.length) {
    throw new Error('MULTI_SOURCE_SPLIT_INPUTS_MUST_BE_COMPLETE');
  }
  result.multiSourceSplit = supplied.length === v2Inputs.length;
  return result;
}

async function json(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

function isInside(parent, child) {
  const normalizedParent = `${resolve(parent)}${sep}`.toLowerCase();
  const normalizedChild = `${resolve(child)}${sep}`.toLowerCase();
  return normalizedChild.startsWith(normalizedParent);
}

export function validatePublicForwardLiquiditySourceManifestLayout(manifest) {
  if (manifest?.schemaVersion !== SOURCE_MANIFEST_VERSION
    || typeof manifest.stateRoot !== 'string'
    || typeof manifest.researchRepoRoot !== 'string'
    || !isAbsolute(manifest.stateRoot)
    || !isAbsolute(manifest.researchRepoRoot)
    || !Array.isArray(manifest.sources)
    || manifest.sources.length === 0) {
    throw new Error('SOURCE_MANIFEST_INVALID');
  }
  const stateRoot = resolve(manifest.stateRoot);
  const researchRepoRoot = resolve(manifest.researchRepoRoot);
  if (isInside(researchRepoRoot, stateRoot) || isInside(stateRoot, researchRepoRoot)) {
    throw new Error('SOURCE_STATE_ROOT_OVERLAPS_RESEARCH_CHECKOUT');
  }
  for (const source of manifest.sources) {
    const receiptPaths = Array.isArray(source?.ingestReceiptPaths)
      ? source.ingestReceiptPaths
      : (typeof source?.ingestReceiptPath === 'string' ? [source.ingestReceiptPath] : []);
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || typeof source.datasetPath !== 'string'
      || !isAbsolute(source.datasetPath)
      || receiptPaths.length === 0
      || receiptPaths.some((receiptPath) => typeof receiptPath !== 'string' || !isAbsolute(receiptPath))) {
      throw new Error('SOURCE_MANIFEST_ENTRY_INVALID');
    }
  }
  return Object.freeze({ stateRoot, researchRepoRoot });
}

async function sourcesFromManifest(path) {
  const manifest = await json(path);
  const { stateRoot } = validatePublicForwardLiquiditySourceManifestLayout(manifest);
  const sources = await Promise.all(manifest.sources.map(async (source) => {
    const receiptPaths = Array.isArray(source.ingestReceiptPaths)
      ? source.ingestReceiptPaths
      : [source.ingestReceiptPath];
    const [dataset, ingestReceipts] = await Promise.all([
      json(source.datasetPath),
      Promise.all(receiptPaths.map((receiptPath) => json(receiptPath))),
    ]);
    const datasetRelativePath = relative(stateRoot, resolve(source.datasetPath));
    if (!datasetRelativePath
      || isAbsolute(datasetRelativePath)
      || datasetRelativePath.split(/[\/]+/u).some((segment) => segment === '..')) {
      throw new Error('SOURCE_DATASET_OUTSIDE_STATE_ROOT');
    }
    return {
      dataset,
      ingestReceipt: ingestReceipts.at(-1),
      ingestReceipts,
      datasetRelativePath: datasetRelativePath.replaceAll(String.fromCharCode(92), '/'),
    };
  }));
  return { manifest, sources };
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

function multiSourceReceipt({ splitSourceResult, splitResult, producerCodeSha, policy, scopeBindings, regimeBindings }) {
  const splitAudit = splitResult.audit ?? null;
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_RECEIPT_VERSION,
    status: splitResult.status,
    blockers: Object.freeze([...(splitResult.blockers ?? [])]),
    producerCodeSha,
    independenceAuditDigest: splitSourceResult.audit?.auditDigest ?? null,
    independentSplitSourceDigest: splitSourceResult.splitSource?.splitSourceDigest ?? null,
    splitAuditDigest: splitAudit?.auditDigest ?? null,
    upstreamLineageDigest: splitAudit?.upstreamLineageDigest ?? null,
    datasetDigests: Object.freeze([...(splitAudit?.datasetDigests ?? [])]),
    receiptDigests: Object.freeze([...(splitAudit?.receiptDigests ?? [])]),
    collectorCodeShas: Object.freeze([...(splitAudit?.collectorCodeShas ?? [])]),
    splitPolicyDigest: policy?.policyDigest ?? null,
    scopeBindingsDigest: sha256(canonicalJson(scopeBindings)),
    regimeBindingsDigest: sha256(canonicalJson(regimeBindings)),
    splitAudit,
    syntheticAggregateDataset: false,
    syntheticSingleCollector: false,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    evidenceCompleteCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    fullCostReady: false,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
  };
  return Object.freeze({ ...body, receiptDigest: sha256(canonicalJson(body)) });
}

export async function run(argv = process.argv.slice(2)) {
  const args = parse(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return null;
  }
  const { sources } = await sourcesFromManifest(args.sourceManifest);
  const splitSourceResult = buildPublicForwardLiquidityIndependentSplitSource({
    sources,
    producerCodeSha: args.producerSha,
  });

  let result = splitSourceResult;
  if (args.multiSourceSplit && splitSourceResult.status === 'PRESENT') {
    const [policy, scopeBindings, regimeBindings] = await Promise.all([
      json(args.splitPolicy),
      json(args.scopeBindings),
      json(args.regimeBindings),
    ]);
    if (!Array.isArray(scopeBindings) || !Array.isArray(regimeBindings)) {
      throw new Error('MULTI_SOURCE_BINDINGS_MUST_BE_ARRAYS');
    }
    const splitResult = auditPublicForwardLiquidityIndependentSplits({
      splitSource: splitSourceResult.splitSource,
      scopeBindings,
      regimeBindings,
      policy,
    });
    result = Object.freeze({
      status: splitResult.status,
      blockers: splitResult.blockers,
      receipt: multiSourceReceipt({
        splitSourceResult,
        splitResult,
        producerCodeSha: args.producerSha,
        policy,
        scopeBindings,
        regimeBindings,
      }),
    });
  }

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
