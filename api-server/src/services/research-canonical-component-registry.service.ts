import { createHash, randomUUID } from 'node:crypto';
import { lstat, link, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1,
} from './research-canonical-bundle-assembler.service.ts';

export const RESEARCH_CANONICAL_COMPONENT_REGISTRY_CONTRACT_V1 =
  'research-canonical-component-registry/v1';

const HASH64 = /^[0-9a-f]{64}$/u;
const SHA40 = /^[0-9a-f]{40}$/u;
const SAFE_OWNER = /^[A-Za-z0-9._:/#-]{1,180}$/u;
const MAX_BYTES = 64 * 1024 * 1024;

type ComponentKey = typeof RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1[number];
type Row = Record<string, unknown>;

function row(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const r = row(value);
  if (Object.keys(r).length === 0) return value;
  return Object.fromEntries(Object.keys(r).sort().map((key) => [key, canonical(r[key])]));
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function exactSha(value: unknown): string {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA40.test(sha)) throw new Error('COMPONENT_RESEARCH_CODE_SHA_INVALID');
  return sha;
}
function exactDigest(value: unknown, name: string): string {
  const hash = String(value ?? '').trim().toLowerCase();
  if (!HASH64.test(hash)) throw new Error(`${name}_INVALID`);
  return hash;
}
function ownerRef(value: unknown): string {
  const owner = String(value ?? '').trim();
  if (!SAFE_OWNER.test(owner)) throw new Error('COMPONENT_OWNER_REF_INVALID');
  return owner;
}
function componentKey(value: unknown): ComponentKey {
  const key = String(value ?? '') as ComponentKey;
  if (!RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1.includes(key)) {
    throw new Error('CANONICAL_COMPONENT_KEY_INVALID');
  }
  return key;
}
async function safeDirectory(pathValue: string, name: string): Promise<string> {
  if (!isAbsolute(pathValue)) throw new Error(`${name}_MUST_BE_ABSOLUTE`);
  const normalized = resolve(pathValue);
  const info = await lstat(normalized);
  if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(normalized)) !== normalized) {
    throw new Error(`${name}_UNSAFE`);
  }
  return normalized;
}
async function safePayloadFile(inputRoot: string, pathValue: string): Promise<{ path: string; payload: unknown }> {
  const path = resolve(pathValue);
  const rel = relative(inputRoot, path);
  if (!isAbsolute(path) || rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('COMPONENT_PAYLOAD_OUTSIDE_INPUT_ROOT');
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_BYTES) {
    throw new Error('COMPONENT_PAYLOAD_FILE_INVALID');
  }
  if (resolve(await realpath(path)) !== path) throw new Error('COMPONENT_PAYLOAD_PATH_UNSAFE');
  return { path, payload: JSON.parse(await readFile(path, 'utf8')) };
}
async function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function publishWriteOnce(directoryPath: string, fileName: string, value: unknown) {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const finalPath = join(directoryPath, basename(fileName));
  const bytes = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('COMPONENT_REGISTRY_RECORD_TOO_LARGE');
  const temporary = join(directoryPath, `.pending-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  try {
    await link(temporary, finalPath);
    await syncDirectory(directoryPath);
    return Object.freeze({ status: 'created' as const, path: finalPath });
  } catch (error) {
    if (row(error).code !== 'EEXIST') throw error;
    const info = await lstat(finalPath);
    if (!info.isFile() || info.isSymbolicLink() || resolve(await realpath(finalPath)) !== finalPath) {
      throw new Error('COMPONENT_REGISTRY_EXISTING_PATH_UNSAFE');
    }
    const existing = JSON.parse(await readFile(finalPath, 'utf8'));
    if (digest(existing) !== digest(value)) throw new Error('COMPONENT_REGISTRY_CONTENT_CONFLICT');
    return Object.freeze({ status: 'already_present' as const, path: finalPath });
  } finally {
    try { await unlink(temporary); } catch {}
  }
}

export interface CanonicalBundleComponentBindingV1 {
  researchCodeSha: string;
  strategyIdentityDigest: string;
  datasetDigest: string;
  parameterHash: string;
}

export function canonicalBundleComponentBindingDigestV1(
  binding: CanonicalBundleComponentBindingV1,
): string {
  const normalized = Object.freeze({
    researchCodeSha: exactSha(binding?.researchCodeSha),
    strategyIdentityDigest: exactDigest(binding?.strategyIdentityDigest, 'STRATEGY_IDENTITY_DIGEST'),
    datasetDigest: exactDigest(binding?.datasetDigest, 'DATASET_DIGEST'),
    parameterHash: exactDigest(binding?.parameterHash, 'PARAMETER_HASH'),
  });
  return digest(normalized);
}

export async function registerCanonicalBundleComponentV1(input: {
  inputRoot: string;
  binding: CanonicalBundleComponentBindingV1;
  key: ComponentKey;
  ownerRef: string;
  payloadPath: string;
}) {
  const inputRoot = await safeDirectory(input.inputRoot, 'RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT');
  const key = componentKey(input.key);
  const owner = ownerRef(input.ownerRef);
  const bindingDigest = canonicalBundleComponentBindingDigestV1(input.binding);
  const { payload } = await safePayloadFile(inputRoot, input.payloadPath);
  const payloadDigest = digest(payload);
  const binding = Object.freeze({
    researchCodeSha: exactSha(input.binding.researchCodeSha),
    strategyIdentityDigest: exactDigest(input.binding.strategyIdentityDigest, 'STRATEGY_IDENTITY_DIGEST'),
    datasetDigest: exactDigest(input.binding.datasetDigest, 'DATASET_DIGEST'),
    parameterHash: exactDigest(input.binding.parameterHash, 'PARAMETER_HASH'),
  });
  const componentCore = Object.freeze({
    schemaVersion: 1,
    contract: RESEARCH_CANONICAL_COMPONENT_REGISTRY_CONTRACT_V1,
    binding,
    bindingDigest,
    key,
    ownerRef: owner,
    payloadDigest,
    executionAuthority: 'NONE' as const,
  });
  const envelope = Object.freeze({
    ...componentCore,
    envelopeDigest: digest(componentCore),
  });

  const registryDir = join(inputRoot, 'registry', bindingDigest);
  const payloadDir = join(inputRoot, 'registered-components', bindingDigest);
  const payloadWrite = await publishWriteOnce(payloadDir, `${key}.json`, payload);
  const envelopeWrite = await publishWriteOnce(registryDir, `${key}.json`, envelope);

  return Object.freeze({
    schemaVersion: 1,
    contract: 'research-canonical-component-registration/v1',
    status: payloadWrite.status === 'created' || envelopeWrite.status === 'created'
      ? 'registered'
      : 'already_present',
    bindingDigest,
    key,
    ownerRef: owner,
    payloadDigest,
    payloadPath: payloadWrite.path,
    envelopePath: envelopeWrite.path,
    executionAuthority: 'NONE' as const,
  });
}

async function readRegisteredComponent(
  inputRoot: string,
  bindingDigest: string,
  key: ComponentKey,
) {
  const registryPath = join(inputRoot, 'registry', bindingDigest, `${key}.json`);
  const payloadPath = join(inputRoot, 'registered-components', bindingDigest, `${key}.json`);
  try {
    const [envelopeInfo, payloadInfo] = await Promise.all([lstat(registryPath), lstat(payloadPath)]);
    if (!envelopeInfo.isFile() || envelopeInfo.isSymbolicLink()
      || !payloadInfo.isFile() || payloadInfo.isSymbolicLink()) {
      throw new Error('COMPONENT_REGISTRY_PATH_UNSAFE');
    }
  } catch (error) {
    if (row(error).code === 'ENOENT') return null;
    throw error;
  }
  if (resolve(await realpath(registryPath)) !== registryPath
    || resolve(await realpath(payloadPath)) !== payloadPath) {
    throw new Error('COMPONENT_REGISTRY_PATH_UNSAFE');
  }
  const envelope = row(JSON.parse(await readFile(registryPath, 'utf8')));
  const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
  const envelopeCore = { ...envelope };
  delete envelopeCore.envelopeDigest;
  if (envelope.schemaVersion !== 1
    || envelope.contract !== RESEARCH_CANONICAL_COMPONENT_REGISTRY_CONTRACT_V1
    || envelope.bindingDigest !== bindingDigest
    || envelope.key !== key
    || envelope.executionAuthority !== 'NONE'
    || !HASH64.test(String(envelope.payloadDigest ?? ''))
    || !HASH64.test(String(envelope.envelopeDigest ?? ''))
    || digest(envelopeCore) !== envelope.envelopeDigest
    || digest(payload) !== envelope.payloadDigest) {
    throw new Error('COMPONENT_REGISTRY_TAMPER_DETECTED');
  }
  return Object.freeze({
    envelope,
    payloadPath,
  });
}

export async function buildCanonicalBundleComponentReadinessV1(input: {
  inputRoot: string;
  binding: CanonicalBundleComponentBindingV1;
}) {
  const inputRoot = await safeDirectory(input.inputRoot, 'RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT');
  const bindingDigest = canonicalBundleComponentBindingDigestV1(input.binding);
  const present: string[] = [];
  const missing: string[] = [];
  const componentPaths: Record<string, string> = {};
  const ownerRefs: Record<string, string> = {};
  const payloadDigests: Record<string, string> = {};

  for (const key of RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1) {
    const row = await readRegisteredComponent(inputRoot, bindingDigest, key);
    if (!row) {
      missing.push(key);
      continue;
    }
    present.push(key);
    componentPaths[key] = row.payloadPath;
    ownerRefs[key] = String(row.envelope.ownerRef);
    payloadDigests[key] = String(row.envelope.payloadDigest);
  }

  const core = Object.freeze({
    schemaVersion: 1,
    contract: 'research-canonical-component-readiness/v1',
    bindingDigest,
    status: missing.length === 0 ? 'COMPLETE' as const : 'BLOCKED_MISSING_COMPONENTS' as const,
    presentKeys: Object.freeze(present),
    missingKeys: Object.freeze(missing),
    componentPaths: Object.freeze(componentPaths),
    ownerRefs: Object.freeze(ownerRefs),
    payloadDigests: Object.freeze(payloadDigests),
    executionAuthority: 'NONE' as const,
  });
  return Object.freeze({ ...core, readinessDigest: digest(core) });
}
