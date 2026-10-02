#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PAPER_CANONICAL_FORWARD_OBSERVER_MATERIALIZER_VERSION =
  'paper-canonical-forward-observer-materializer-v1';
export const CANONICAL_PAPER_STATE_ROOT = '/opt/stock-app-data/paper-forward-v1';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function exactSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safetyEnvelope(value) {
  return record(value)
    && value.publicDataOnly === true
    && value.artifactOnly === true
    && value.executionAuthority === 'NONE'
    && value.financialMutationAllowed === false
    && value.liveOrderAllowed === false
    && value.privateTradingApiAllowed === false
    && value.profitabilityClaimAllowed === false;
}

function parseJson(text, code) {
  try {
    return JSON.parse(text);
  } catch {
    fail(code);
  }
}

async function readFileExact(path, code) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    fail(code);
  }
}

export async function validateForwardObserverArtifact({ sourceRoot, expectedSha }) {
  if (!exactSha(expectedSha)) fail('FORWARD_OBSERVER_MATERIALIZE_EXPECTED_SHA_INVALID');
  if (typeof sourceRoot !== 'string' || !isAbsolute(sourceRoot)) fail('FORWARD_OBSERVER_MATERIALIZE_SOURCE_ROOT_INVALID');
  const root = resolve(sourceRoot);
  const stateText = await readFileExact(join(root, 'state.json'), 'FORWARD_OBSERVER_MATERIALIZE_STATE_UNREADABLE');
  const summaryText = await readFileExact(join(root, 'summary.json'), 'FORWARD_OBSERVER_MATERIALIZE_SUMMARY_UNREADABLE');
  const manifestText = await readFileExact(join(root, 'manifest.json'), 'FORWARD_OBSERVER_MATERIALIZE_MANIFEST_UNREADABLE');
  const state = parseJson(stateText, 'FORWARD_OBSERVER_MATERIALIZE_STATE_INVALID_JSON');
  const summary = parseJson(summaryText, 'FORWARD_OBSERVER_MATERIALIZE_SUMMARY_INVALID_JSON');
  const manifest = parseJson(manifestText, 'FORWARD_OBSERVER_MATERIALIZE_MANIFEST_INVALID_JSON');

  if (!record(state) || state.schemaVersion !== 1 || state.researchCodeSha !== expectedSha || !safetyEnvelope(state.safety)) {
    fail('FORWARD_OBSERVER_MATERIALIZE_STATE_IDENTITY_INVALID');
  }
  if (!record(summary) || summary.schemaVersion !== 1 || summary.researchCodeSha !== expectedSha || !safetyEnvelope(summary.safety)) {
    fail('FORWARD_OBSERVER_MATERIALIZE_SUMMARY_IDENTITY_INVALID');
  }
  if (!record(manifest)
    || manifest.schemaVersion !== 1
    || manifest.kind !== 'forward-recommendation-observer-state'
    || manifest.researchCodeSha !== expectedSha
    || manifest.stateSha256 !== digest(stateText)
    || manifest.summarySha256 !== digest(summaryText)
    || !safetyEnvelope(manifest.safety)) {
    fail('FORWARD_OBSERVER_MATERIALIZE_MANIFEST_INVALID');
  }
  if (!Array.isArray(state.observations)
    || !record(summary.counts)
    || summary.counts.total !== state.observations.length) {
    fail('FORWARD_OBSERVER_MATERIALIZE_STATE_SUMMARY_MISMATCH');
  }

  return Object.freeze({
    root,
    expectedSha,
    files: Object.freeze({
      state: Object.freeze({ name: 'state.json', text: stateText, sha256: digest(stateText) }),
      summary: Object.freeze({ name: 'summary.json', text: summaryText, sha256: digest(summaryText) }),
      manifest: Object.freeze({ name: 'manifest.json', text: manifestText, sha256: digest(manifestText) }),
    }),
  });
}

async function atomicWrite(path, text) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export async function materializeForwardObserverArtifact({ sourceRoot, stateRoot, expectedSha, dryRun = false }) {
  const source = await validateForwardObserverArtifact({ sourceRoot, expectedSha });
  if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot)) fail('FORWARD_OBSERVER_MATERIALIZE_STATE_ROOT_INVALID');
  const targetRoot = join(resolve(stateRoot), 'forward-observer');
  if (!dryRun) {
    await mkdir(targetRoot, { recursive: true, mode: 0o700 });
    await atomicWrite(join(targetRoot, 'state.json'), source.files.state.text);
    await atomicWrite(join(targetRoot, 'summary.json'), source.files.summary.text);
    await atomicWrite(join(targetRoot, 'manifest.json'), source.files.manifest.text);
    const readback = await validateForwardObserverArtifact({ sourceRoot: targetRoot, expectedSha });
    if (readback.files.state.sha256 !== source.files.state.sha256
      || readback.files.summary.sha256 !== source.files.summary.sha256
      || readback.files.manifest.sha256 !== source.files.manifest.sha256) {
      fail('FORWARD_OBSERVER_MATERIALIZE_READBACK_MISMATCH');
    }
  }
  return Object.freeze({
    schemaVersion: PAPER_CANONICAL_FORWARD_OBSERVER_MATERIALIZER_VERSION,
    status: dryRun ? 'VALIDATED_ONLY' : 'MATERIALIZED',
    operation: 'observer-materialize',
    targetSha: expectedSha,
    targetRoot,
    filesWritten: dryRun ? 0 : 3,
    stateSha256: source.files.state.sha256,
    summarySha256: source.files.summary.sha256,
    manifestSha256: source.files.manifest.sha256,
    productionAppMutationPerformed: false,
    processRestartPerformed: false,
    environmentMutationPerformed: false,
    scheduleMutationPerformed: false,
    databaseMutationPerformed: false,
    privateApiUsed: false,
    orderSubmitted: false,
    liveTrading: false,
    executionAuthority: 'NONE',
  });
}

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? '';
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  try {
    const sourceRoot = argument('source-root');
    const expectedSha = argument('expected-sha').toLowerCase();
    const stateRoot = argument('state-root') || CANONICAL_PAPER_STATE_ROOT;
    const dryRun = process.argv.includes('--dry-run');
    if (!dryRun && resolve(stateRoot) !== CANONICAL_PAPER_STATE_ROOT) {
      fail('FORWARD_OBSERVER_MATERIALIZE_CANONICAL_STATE_ROOT_REQUIRED');
    }
    const result = await materializeForwardObserverArtifact({ sourceRoot, stateRoot, expectedSha, dryRun });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: PAPER_CANONICAL_FORWARD_OBSERVER_MATERIALIZER_VERSION,
      status: 'BLOCKED',
      code: typeof error?.code === 'string' ? error.code : 'FORWARD_OBSERVER_MATERIALIZE_FAILED',
      filesWritten: 0,
      productionAppMutationPerformed: false,
      processRestartPerformed: false,
      environmentMutationPerformed: false,
      scheduleMutationPerformed: false,
      databaseMutationPerformed: false,
      privateApiUsed: false,
      orderSubmitted: false,
      liveTrading: false,
      executionAuthority: 'NONE',
    })}\n`);
    process.exitCode = 1;
  }
}
