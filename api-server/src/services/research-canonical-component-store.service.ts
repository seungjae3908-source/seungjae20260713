import { createHash, randomUUID } from 'node:crypto';
import { lstat, link, mkdir, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1,
} from './research-canonical-bundle-assembler.service.ts';

export const RESEARCH_CANONICAL_COMPONENT_STORE_CONTRACT_V1 =
  'research-canonical-component-store/v1';

type ComponentKey = typeof RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1[number];
type Row = Record<string, unknown>;

const SHA40 = /^[0-9a-f]{40}$/u;
const DIGEST64 = /^[0-9a-f]{64}$/u;
const OWNER_REF = /^[A-Za-z0-9._:/#-]{1,240}$/u;
const MAX_COMPONENT_BYTES = 64 * 1024 * 1024;

function row(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const r = row(value);
  if (Object.keys(r).length === 0) return value;
  return Object.fromEntries(Object.keys(r).sort().map((key) => [key, canonical(r[key])]));
}
function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function digestBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function exactSha(value: unknown): string {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA40.test(sha)) throw new Error('RESEARCH_CODE_SHA_INVALID');
  return sha;
}
function componentKey(value: unknown): ComponentKey {
  const key = String(value ?? '') as ComponentKey;
  if (!RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1.includes(key)) {
    throw new Error('CANONICAL_COMPONENT_KEY_INVALID');
  }
  return key;
}
function ownerRef(value: unknown): string {
  const owner = String(value ?? '').trim();
  if (!OWNER_REF.test(owner)) throw new Error('CANONICAL_COMPONENT_OWNER_REF_INVALID');
  return owner;
}
async function safeDirectory(pathValue: string, name: string): Promise<string> {
  if (!isAbsolute(pathValue)) throw new Error(`${name}_MUST_BE_ABSOLUTE`);
  const normalized = resolve(pathValue);
  const info = await lstat(normalized);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name}_UNSAFE`);
  if (resolve(await realpath(normalized)) !== normalized) throw new Error(`${name}_UNSAFE`);
  return normalized;
}
async function safeSourceFile(root: string, pathValue: string): Promise<{
  absolute: string;
  bytes: Buffer;
  json: unknown;
}> {
  const absolute = resolve(pathValue);
  const rel = relative(root, absolute);
  if (!isAbsolute(absolute) || rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('CANONICAL_COMPONENT_SOURCE_OUTSIDE_ROOT');
  }
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_COMPONENT_BYTES) {
    throw new Error('CANONICAL_COMPONENT_SOURCE_INVALID');
  }
  if (resolve(await realpath(absolute)) !== absolute) throw new Error('CANONICAL_COMPONENT_SOURCE_PATH_UNSAFE');
  const bytes = await readFile(absolute);
  let json: unknown;
  try { json = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('CANONICAL_COMPONENT_SOURCE_JSON_INVALID'); }
  return { absolute, bytes, json };
}
async function writeBytesOnce(directoryPath: string, fileName: string, bytes: Buffer) {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const finalPath = join(directoryPath, basename(fileName));
  const temporary = join(directoryPath, `.pending-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await link(temporary, finalPath);
    if (process.platform !== 'win32') {
      const dir = await open(directoryPath, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
    return Object.freeze({ status: 'created' as const, path: finalPath });
  } catch (error) {
    if (row(error).code !== 'EEXIST') throw error;
    const info = await lstat(finalPath);
    if (!info.isFile() || info.isSymbolicLink() || resolve(await realpath(finalPath)) !== finalPath) {
      throw new Error('CANONICAL_COMPONENT_EXISTING_PATH_UNSAFE');
    }
    const existing = await readFile(finalPath);
    if (digestBytes(existing) !== digestBytes(bytes)) throw new Error('CANONICAL_COMPONENT_CONTENT_CONFLICT');
    return Object.freeze({ status: 'already_present' as const, path: finalPath });
  } finally {
    try { await unlink(temporary); } catch {}
  }
}
async function writeJsonOnce(directoryPath: string, fileName: string, value: unknown) {
  return writeBytesOnce(directoryPath, fileName, Buffer.from(JSON.stringify(value) + '\n', 'utf8'));
}
function recordCore(input: {
  researchCodeSha: string;
  componentKey: ComponentKey;
  ownerRef: string;
  byteDigest: string;
  jsonDigest: string;
  storedFileName: string;
}) {
  return Object.freeze({
    schemaVersion: 1,
    contract: RESEARCH_CANONICAL_COMPONENT_STORE_CONTRACT_V1,
    researchCodeSha: input.researchCodeSha,
    componentKey: input.componentKey,
    ownerRef: input.ownerRef,
    byteDigest: input.byteDigest,
    jsonDigest: input.jsonDigest,
    storedFileName: input.storedFileName,
    evidenceCredit: 0 as const,
    profitabilityProven: false as const,
    promotionEligible: false as const,
    executionAuthority: 'NONE' as const,
  });
}

export async function registerResearchCanonicalComponentV1(input: {
  sourceRoot: string;
  inputRoot: string;
  researchCodeSha: string;
  componentKey: string;
  ownerRef: string;
  sourcePath: string;
}) {
  const sourceRoot = await safeDirectory(input.sourceRoot, 'RESEARCH_COMPONENT_SOURCE_ROOT');
  const inputRoot = await safeDirectory(input.inputRoot, 'RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT');
  const researchCodeSha = exactSha(input.researchCodeSha);
  const key = componentKey(input.componentKey);
  const owner = ownerRef(input.ownerRef);
  const source = await safeSourceFile(sourceRoot, input.sourcePath);
  const byteDigest = digestBytes(source.bytes);
  const jsonDigest = digestJson(source.json);
  if (!DIGEST64.test(byteDigest) || !DIGEST64.test(jsonDigest)) throw new Error('CANONICAL_COMPONENT_DIGEST_INVALID');

  const storedFileName = `${byteDigest}.json`;
  const componentWrite = await writeBytesOnce(
    join(inputRoot, 'components', key),
    storedFileName,
    source.bytes,
  );
  const core = recordCore({
    researchCodeSha,
    componentKey: key,
    ownerRef: owner,
    byteDigest,
    jsonDigest,
    storedFileName,
  });
  const record = Object.freeze({ ...core, recordDigest: digestJson(core) });
  const recordWrite = await writeJsonOnce(
    join(inputRoot, 'component-records', key),
    `${byteDigest}.json`,
    record,
  );

  return Object.freeze({
    schemaVersion: 1,
    contract: RESEARCH_CANONICAL_COMPONENT_STORE_CONTRACT_V1,
    status: componentWrite.status === 'created' || recordWrite.status === 'created'
      ? 'registered'
      : 'already_present',
    researchCodeSha,
    componentKey: key,
    ownerRef: owner,
    componentPath: componentWrite.path,
    recordPath: recordWrite.path,
    byteDigest,
    jsonDigest,
    recordDigest: record.recordDigest,
    evidenceCredit: 0 as const,
    profitabilityProven: false as const,
    promotionEligible: false as const,
    executionAuthority: 'NONE' as const,
  });
}

export async function buildResearchCanonicalComponentManifestV1(input: {
  inputRoot: string;
  researchCodeSha: string;
  selectedComponentDigests?: Partial<Record<ComponentKey, string>>;
}) {
  const inputRoot = await safeDirectory(input.inputRoot, 'RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT');
  const researchCodeSha = exactSha(input.researchCodeSha);
  const selected = row(input.selectedComponentDigests ?? {});
  const unknown = Object.keys(selected).filter((key) =>
    !RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1.includes(key as ComponentKey));
  if (unknown.length > 0) throw new Error('CANONICAL_COMPONENT_SELECTION_KEY_INVALID');

  const componentPaths: Partial<Record<ComponentKey, string>> = {};
  const componentRecords: Partial<Record<ComponentKey, unknown>> = {};
  const missing: ComponentKey[] = [];

  for (const key of RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1) {
    const requested = selected[key];
    if (requested == null) {
      missing.push(key);
      continue;
    }
    if (typeof requested !== 'string' || !DIGEST64.test(requested)) {
      throw new Error(`CANONICAL_COMPONENT_SELECTION_DIGEST_INVALID:${key}`);
    }
    const recordPath = join(inputRoot, 'component-records', key, `${requested}.json`);
    const componentPath = join(inputRoot, 'components', key, `${requested}.json`);
    const [recordInfo, componentInfo] = await Promise.all([lstat(recordPath), lstat(componentPath)]);
    if (!recordInfo.isFile() || recordInfo.isSymbolicLink()
      || !componentInfo.isFile() || componentInfo.isSymbolicLink()) {
      throw new Error(`CANONICAL_COMPONENT_STORED_PATH_INVALID:${key}`);
    }
    const [record, bytes] = await Promise.all([
      readFile(recordPath, 'utf8').then(JSON.parse),
      readFile(componentPath),
    ]);
    const r = row(record);
    if (r.contract !== RESEARCH_CANONICAL_COMPONENT_STORE_CONTRACT_V1
      || r.schemaVersion !== 1
      || r.researchCodeSha !== researchCodeSha
      || r.componentKey !== key
      || r.byteDigest !== requested
      || r.evidenceCredit !== 0
      || r.profitabilityProven !== false
      || r.promotionEligible !== false
      || r.executionAuthority !== 'NONE') {
      throw new Error(`CANONICAL_COMPONENT_RECORD_INVALID:${key}`);
    }
    const core = { ...r };
    delete core.recordDigest;
    if (!DIGEST64.test(String(r.recordDigest ?? '')) || digestJson(core) !== r.recordDigest) {
      throw new Error(`CANONICAL_COMPONENT_RECORD_DIGEST_MISMATCH:${key}`);
    }
    if (digestBytes(bytes) !== requested) throw new Error(`CANONICAL_COMPONENT_BYTE_DIGEST_MISMATCH:${key}`);
    componentPaths[key] = componentPath;
    componentRecords[key] = record;
  }

  const complete = missing.length === 0;
  const manifestCore = Object.freeze({
    schemaVersion: 1,
    contract: 'research-canonical-component-manifest/v1',
    researchCodeSha,
    readyComponentCount: RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1.length - missing.length,
    requiredComponentCount: RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1.length,
    complete,
    missingComponents: Object.freeze(missing),
    componentPaths: Object.freeze({ ...componentPaths }),
    componentRecordDigests: Object.freeze(Object.fromEntries(
      Object.entries(componentRecords).map(([key, value]) => [key, row(value).recordDigest]),
    )),
    evidenceCredit: 0 as const,
    profitabilityProven: false as const,
    promotionEligible: false as const,
    executionAuthority: 'NONE' as const,
  });
  return Object.freeze({ ...manifestCore, manifestDigest: digestJson(manifestCore) });
}
