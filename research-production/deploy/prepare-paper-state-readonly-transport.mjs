#!/usr/bin/env node
import { chmod, chown, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PAPER_STATE_READONLY_TRANSPORT_VERSION =
  'research-production-paper-state-readonly-transport-v1';

const CANONICAL_PAPER_STATE_ROOT = '/opt/stock-app-data/paper-forward-v1';
const BINDING_FILE = 'publisher-binding.json';
const SNAPSHOT_RELATIVE_PATH = join('publisher', 'paper-state-v2.json');

function controlledError(code) {
  return Object.assign(new Error(code), { code });
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function exactSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function digest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function safeEnvelope(value) {
  return record(value)
    && value.immutable === true
    && value.executionAuthority === 'NONE'
    && value.privateApiAllowed === false
    && value.liveTrading === false
    && value.financialMutationAllowed === false;
}

function parseJson(buffer, code) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw controlledError(code);
  }
}

async function optionalRead(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw controlledError('PAPER_STATE_READONLY_SOURCE_UNREADABLE');
  }
}

async function atomicLosslessCopy(path, content, owner) {
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { flag: 'wx', mode: 0o640 });
  await chmod(temporary, 0o640);
  if (process.platform !== 'win32') await chown(temporary, owner.uid, owner.gid);
  await rename(temporary, path);
}

async function removePriorTransport(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw controlledError('PAPER_STATE_READONLY_DESTINATION_RESET_FAILED');
  }
}

export async function preparePaperStateReadonlyTransport({
  profile,
  runtimeDirectory,
  sourceRoot = CANONICAL_PAPER_STATE_ROOT,
} = {}) {
  if (profile !== 'forward') {
    return Object.freeze({
      schemaVersion: PAPER_STATE_READONLY_TRANSPORT_VERSION,
      status: 'NOT_APPLICABLE',
      copiedFileCount: 0,
      sensitiveValuesEmitted: false,
    });
  }
  if (typeof runtimeDirectory !== 'string' || !isAbsolute(runtimeDirectory)) {
    throw controlledError('PAPER_STATE_READONLY_RUNTIME_DIRECTORY_REQUIRED');
  }
  if (typeof sourceRoot !== 'string' || !isAbsolute(sourceRoot)) {
    throw controlledError('PAPER_STATE_READONLY_SOURCE_ROOT_INVALID');
  }

  const resolvedSourceRoot = resolve(sourceRoot);
  const bindingSourcePath = join(resolvedSourceRoot, BINDING_FILE);
  const snapshotSourcePath = join(resolvedSourceRoot, SNAPSHOT_RELATIVE_PATH);
  const resolvedRuntimeDirectory = resolve(runtimeDirectory);
  const destinationRoot = join(resolvedRuntimeDirectory, 'paper-state');
  await Promise.all([
    removePriorTransport(join(destinationRoot, BINDING_FILE)),
    removePriorTransport(join(destinationRoot, 'paper-state-v2.json')),
  ]);
  const [bindingContent, snapshotContent] = await Promise.all([
    optionalRead(bindingSourcePath),
    optionalRead(snapshotSourcePath),
  ]);

  if (bindingContent == null || snapshotContent == null) {
    return Object.freeze({
      schemaVersion: PAPER_STATE_READONLY_TRANSPORT_VERSION,
      status: 'MISSING',
      copiedFileCount: 0,
      sensitiveValuesEmitted: false,
    });
  }

  const binding = parseJson(bindingContent, 'PAPER_STATE_READONLY_BINDING_INVALID');
  const snapshot = parseJson(snapshotContent, 'PAPER_STATE_READONLY_SNAPSHOT_INVALID');
  if (!safeEnvelope(binding)
    || binding.schemaVersion !== 'paper-state-publisher-runtime-binding-v1'
    || !exactSha(binding.paperRuntimeSourceSha)
    || !digest(binding.publisherAccountIdSha256)
    || resolve(String(binding.snapshotPath ?? '')) !== snapshotSourcePath) {
    throw controlledError('PAPER_STATE_READONLY_BINDING_INVALID');
  }
  if (!safeEnvelope(snapshot)
    || snapshot.schemaVersion !== 'paper-trading-state-snapshot-v2'
    || !exactSha(snapshot.sourceSha)
    || !digest(snapshot.publisherAccountIdSha256)) {
    throw controlledError('PAPER_STATE_READONLY_SNAPSHOT_INVALID');
  }

  await mkdir(destinationRoot, { recursive: true, mode: 0o750 });
  const owner = await stat(resolvedRuntimeDirectory);
  if (process.platform !== 'win32') await chown(destinationRoot, owner.uid, owner.gid);
  await Promise.all([
    atomicLosslessCopy(join(destinationRoot, BINDING_FILE), bindingContent, owner),
    atomicLosslessCopy(join(destinationRoot, 'paper-state-v2.json'), snapshotContent, owner),
  ]);

  return Object.freeze({
    schemaVersion: PAPER_STATE_READONLY_TRANSPORT_VERSION,
    status: 'PRESENT',
    copiedFileCount: 2,
    sensitiveValuesEmitted: false,
  });
}

const invokedAsScript = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  const profileIndex = process.argv.indexOf('--profile');
  const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : '';
  try {
    const result = await preparePaperStateReadonlyTransport({
      profile,
      runtimeDirectory: process.env.RUNTIME_DIRECTORY,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = typeof error?.code === 'string'
      ? error.code
      : 'PAPER_STATE_READONLY_TRANSPORT_FAILED';
    process.stderr.write(`${JSON.stringify({
      schemaVersion: PAPER_STATE_READONLY_TRANSPORT_VERSION,
      status: 'BLOCKED_DATA',
      code,
      sensitiveValuesEmitted: false,
    })}\n`);
    process.exitCode = 1;
  }
}
